/**
 * Context-Aware Query Generator -- Phase 4
 *
 * Given a SceneContextPacket, calls Gemini to produce a tiered StockSearchPlan
 * (Tier A = exact, B = subject, C = contextual, D = illustrative fallback).
 * Results are cached per (projectId + contextVersion + sceneId + narrationHash).
 */

import { GoogleGenAI } from "@google/genai"
import * as fs from "fs"
import { join } from "path"
import { createHash as cryptoHash } from "crypto"
import { logger } from "../logger"
import { normalizeApiKey } from "../utils/api-key"
import {
  normalizePreferredTextModel,
  buildFallbackModelList,
  classifyGeminiErrorKind,
  DEPRECATED_TEXT_MODELS
} from "../utils/gemini-fallback"
import { sanitizeStockQuery, dedupeStockQueries } from "./query-sanitizer"
import type { GlobalScriptContext, SceneContextPacket, StockSearchPlan } from "../../../shared/types"

export type QueryProgressCallback = (msg: string, pct: number) => void

// ------ Cache ---------------------------------------------------------------

interface QueryCacheEntry {
  plan: StockSearchPlan
  generatedAt: string
  contextVersion: number
}
type QueryCacheFile = Record<string, QueryCacheEntry>

function getQueryCachePath(projectDir: string): string {
  return join(projectDir, "assets", "stock", ".context-query-cache.json")
}

function loadQueryCache(projectDir: string): QueryCacheFile {
  const p = getQueryCachePath(projectDir)
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as QueryCacheFile }
  catch { return {} }
}

function saveQueryCache(projectDir: string, cache: QueryCacheFile): void {
  const p = getQueryCachePath(projectDir)
  fs.mkdirSync(join(projectDir, "assets", "stock"), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(cache, null, 2), "utf-8")
}

function makeCacheKey(
  globalContext: GlobalScriptContext,
  sceneId: string,
  narration: string
): string {
  const narrationHash = cryptoHash("md5").update(narration).digest("hex").slice(0, 8)
  return `v${globalContext.version}_${sceneId}_${narrationHash}`
}

// ------ Gemini prompt -------------------------------------------------------

const SYSTEM_PROMPT = `You are the Context-Aware Visual Research Engine for a documentary video editor.

You must NEVER interpret a scene in isolation.
Every scene belongs to a complete documentary with a defined primary subject, central thesis, geography, historical period, community, visual identity and story arc.

Analyze the current scene using four levels:
1. Complete script context (GlobalScriptContext).
2. Current chapter context.
3. Exact current narration.
4. Previous and next scene context.

Produce stock-media search queries in four tiers:
- Tier A (exactQueries): subject name + action + geography. These MUST contain the primary community/subject proper noun.
- Tier B (subjectQueries): subject name only, broader action or location.
- Tier C (contextualQueries): no exact proper noun, uses environment/setting descriptors.
- Tier D (fallbackQueries): purely illustrative, concept-level only. Use ONLY as last resort.

Rules:
- NEVER start with Tier D.
- Every Tier A and B query must contain at least one exact topic anchor from GlobalScriptContext.
- negativeTerms must include all negativeKeywords from GlobalScriptContext plus any scene-specific ones.
- Return ONLY valid JSON. No markdown. No explanation.`

function buildScenePrompt(packet: SceneContextPacket, globalCtx: GlobalScriptContext): string {
  return `GLOBAL SCRIPT CONTEXT:
Primary Subject: ${globalCtx.primarySubject}
Central Thesis: ${globalCtx.centralThesis}
Geography: ${[globalCtx.geography.primaryCountry, globalCtx.geography.primaryRegion, ...globalCtx.geography.secondaryLocations].filter(Boolean).join(", ")}
Time Period: ${globalCtx.timeContext.primaryPeriod}
Exact Topic Anchors: ${globalCtx.exactTopicAnchors.join(", ")}
Contextual Anchors: ${globalCtx.contextualAnchors.join(", ")}
Forbidden Substitutions: ${globalCtx.forbiddenSubstitutions.join("; ")}
Negative Keywords: ${globalCtx.negativeKeywords.join(", ")}
Visual World: ${[...globalCtx.visualWorld.environment, ...globalCtx.visualWorld.occupations].join(", ")}

CHAPTER CONTEXT:
Title: ${packet.chapterContext.chapterTitle}
Purpose: ${packet.chapterContext.chapterPurpose}

PREVIOUS SCENE: ${packet.neighboringContext.previousScene || "none"}
CURRENT NARRATION: "${packet.localContext.narration}"
NEXT SCENE: ${packet.neighboringContext.nextScene || "none"}

CURRENT SCENE PURPOSE: ${packet.localContext.scenePurpose}
VISIBLE SUBJECT: ${packet.localContext.visibleSubject}
VISIBLE ACTION: ${packet.localContext.visibleAction}
PREFERRED LOCATION: ${packet.localContext.preferredLocation}
PREFERRED TIME PERIOD: ${packet.localContext.preferredTimePeriod}

Generate a context-aware StockSearchPlan. Return ONLY this JSON:
{
  "visualIntent": "short visual concept (5-12 words)",
  "exactQueries": ["Tier A query 1", "Tier A query 2", "Tier A query 3"],
  "subjectQueries": ["Tier B query 1", "Tier B query 2"],
  "contextualQueries": ["Tier C query 1", "Tier C query 2"],
  "fallbackQueries": ["Tier D query 1", "Tier D query 2"],
  "requiredTerms": ["term that must appear in Tier A"],
  "preferredTerms": ["preferred search term"],
  "negativeTerms": ["term to exclude"],
  "targetMediaType": "video",
  "desiredShotTypes": ["wide shot", "medium shot"],
  "desiredOrientation": "landscape"
}`
}

// ------ Fallback (rule-based) -----------------------------------------------

function buildFallbackPlan(packet: SceneContextPacket, globalCtx: GlobalScriptContext): StockSearchPlan {
  const anchor = globalCtx.exactTopicAnchors[0] ?? globalCtx.primarySubject
  const env = globalCtx.visualWorld.environment[0] ?? "rural"
  const action = packet.localContext.visibleAction || "community life"
  const locRaw = globalCtx.geography.primaryRegion ?? globalCtx.geography.primaryCountry ?? ""
  const location = locRaw.toLowerCase().includes("not specified") ? "" : locRaw

  const plan: StockSearchPlan = {
    visualIntent: sanitizeStockQuery(`${anchor} ${action}`),
    exactQueries: dedupeStockQueries([
      sanitizeStockQuery(`${anchor} ${action} ${location}`.trim()),
      sanitizeStockQuery(`${anchor} ${action}`.trim()),
      sanitizeStockQuery(`${anchor} community ${env}`.trim())
    ]),
    subjectQueries: dedupeStockQueries([
      sanitizeStockQuery(`${anchor} ${env}`),
      sanitizeStockQuery(`${anchor} community`)
    ]),
    contextualQueries: dedupeStockQueries([
      sanitizeStockQuery(`${env} community ${action}`),
      sanitizeStockQuery(`rural ${action}`),
      sanitizeStockQuery(packet.chapterContext.chapterTitle.toLowerCase())
    ]),
    fallbackQueries: dedupeStockQueries([
      sanitizeStockQuery(action),
      sanitizeStockQuery(env + " landscape")
    ]),
    requiredTerms: [anchor],
    preferredTerms: globalCtx.contextualAnchors.slice(0, 3),
    negativeTerms: globalCtx.negativeKeywords,
    targetMediaType: "video",
    desiredShotTypes: ["wide shot", "medium shot"],
    desiredOrientation: "landscape"
  }
  return plan
}

function sanitizePlan(plan: StockSearchPlan): StockSearchPlan {
  const fallback = sanitizeStockQuery(plan.visualIntent || "documentary footage")
  return {
    ...plan,
    visualIntent: sanitizeStockQuery(plan.visualIntent, fallback),
    exactQueries: dedupeStockQueries((plan.exactQueries || []).map((q) => sanitizeStockQuery(q, fallback))).slice(0, 5),
    subjectQueries: dedupeStockQueries((plan.subjectQueries || []).map((q) => sanitizeStockQuery(q, fallback))).slice(0, 5),
    contextualQueries: dedupeStockQueries((plan.contextualQueries || []).map((q) => sanitizeStockQuery(q, fallback))).slice(0, 5),
    fallbackQueries: dedupeStockQueries((plan.fallbackQueries || []).map((q) => sanitizeStockQuery(q, fallback))).slice(0, 5)
  }
}

// ------ Main export ---------------------------------------------------------

export async function generateContextAwareSearchPlan(params: {
  projectDir: string
  apiKey: string
  model?: string
  packet: SceneContextPacket
  globalContext: GlobalScriptContext
  sceneId: string
  useCache?: boolean
  onProgress?: QueryProgressCallback
}): Promise<StockSearchPlan> {
  const { projectDir, apiKey, packet, globalContext, sceneId, useCache = true } = params
  const rawModel = params.model

  if (rawModel && DEPRECATED_TEXT_MODELS.has(rawModel)) {
    logger.warn(`[GeminiModel] Saved model ${rawModel} is unavailable for this account.`)
    logger.info(`[GeminiModel] Falling back to ${normalizePreferredTextModel(rawModel)}.`)
  }

  const fallbackModels = buildFallbackModelList(rawModel)
  const cacheKey = makeCacheKey(globalContext, sceneId, packet.localContext.narration)
  const cache = useCache ? loadQueryCache(projectDir) : {}

  // Cache hit
  if (useCache && cache[cacheKey] && cache[cacheKey].contextVersion === globalContext.version) {
    logger.info(`[QueryGen] Cache hit for scene ${sceneId}`)
    return sanitizePlan(cache[cacheKey].plan)
  }

  const cleanKey = normalizeApiKey(apiKey)
  let rawJson = ""

  if (cleanKey.length > 0) {
    const ai = new GoogleGenAI({ apiKey: cleanKey, httpOptions: { apiVersion: "v1beta" } })
    const prompt = buildScenePrompt(packet, globalContext)

    for (let mIdx = 0; mIdx < fallbackModels.length; mIdx++) {
      const currentModel = fallbackModels[mIdx]
      let retryCount = 0
      const maxRetries = 2

      while (retryCount <= maxRetries) {
        try {
          const response = await ai.models.generateContent({
            model: currentModel,
            contents: [{ role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }],
            config: { responseMimeType: "application/json", temperature: 0.25, maxOutputTokens: 2048 }
          })
          rawJson = response.text ?? ""
          if (rawJson) {
            logger.info(`[QueryGen] Scene ${sceneId} generated successfully with ${currentModel}.`)
            break
          }
        } catch (err: unknown) {
          const { kind, message } = classifyGeminiErrorKind(err)

          if (kind === "MODEL_NOT_FOUND") {
            const nextModel = fallbackModels[mIdx + 1]
            logger.warn(`[GeminiModel] Saved model ${currentModel} is unavailable for this account. Falling back to ${nextModel ?? "rule-based fallback"}.`)
            break // switch immediately to next model without retry
          }

          if (kind === "AUTH_ERROR") {
            logger.error(`[QueryGen] Gemini authentication error. Check API key.`)
            mIdx = fallbackModels.length // stop further model attempts
            break
          }

          if (kind === "BAD_REQUEST") {
            logger.warn(`[QueryGen] Gemini bad request: ${message.slice(0, 100)}`)
            break
          }

          // RATE_LIMIT or SERVICE_UNAVAILABLE or UNKNOWN
          retryCount++
          if (retryCount <= maxRetries) {
            const delay = Math.pow(2, retryCount) * 1000 + Math.floor(Math.random() * 500)
            logger.warn(`[QueryGen] Gemini ${currentModel} error (${kind}), retrying in ${delay}ms...`)
            await new Promise((r) => setTimeout(r, delay))
          } else {
            logger.warn(`[QueryGen] Gemini ${currentModel} exhausted retries, switching model...`)
            break
          }
        }
      }

      if (rawJson) {
        break
      }
    }
  }

  let plan: StockSearchPlan
  if (rawJson) {
    try {
      const clean = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim()
      plan = JSON.parse(clean) as StockSearchPlan
      if (!plan.exactQueries?.length) throw new Error("Missing exactQueries")
    } catch {
      logger.warn(`[QueryGen] Scene ${sceneId} JSON parse failed, using rule-based fallback`)
      plan = buildFallbackPlan(packet, globalContext)
    }
  } else {
    logger.warn(`[QueryGen] Scene ${sceneId} AI failed, using rule-based fallback`)
    plan = buildFallbackPlan(packet, globalContext)
  }

  plan = sanitizePlan(plan)

  // Save to cache
  if (useCache) {
    cache[cacheKey] = { plan, generatedAt: new Date().toISOString(), contextVersion: globalContext.version }
    saveQueryCache(projectDir, cache)
  }

  return plan
}

// ------ Batch generator (pre-generate all scenes before searching) -----------

export async function batchGenerateSearchPlans(params: {
  projectDir: string
  apiKey: string
  model?: string
  scenes: Array<{ sceneId: string; packet: SceneContextPacket }>
  globalContext: GlobalScriptContext
  useCache?: boolean
  onProgress?: QueryProgressCallback
}): Promise<Map<string, StockSearchPlan>> {
  const { scenes, globalContext, onProgress } = params
  const plans = new Map<string, StockSearchPlan>()

  for (let i = 0; i < scenes.length; i++) {
    const { sceneId, packet } = scenes[i]
    const pct = (i + 1) / scenes.length
    onProgress?.(`[${i + 1}/${scenes.length}] Generating search plan for scene ${sceneId}...`, pct)

    const plan = await generateContextAwareSearchPlan({
      ...params,
      packet,
      sceneId
    })
    plans.set(sceneId, plan)
  }

  return plans
}
