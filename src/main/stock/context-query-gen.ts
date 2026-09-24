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
  const location = globalCtx.geography.primaryRegion ?? globalCtx.geography.primaryCountry ?? ""

  return {
    visualIntent: `${anchor} ${action}`,
    exactQueries: [
      `${anchor} ${action} ${location}`.trim(),
      `${anchor} ${action}`.trim(),
      `${anchor} community ${env}`.trim()
    ],
    subjectQueries: [
      `${anchor} ${env}`,
      `${anchor} community`
    ],
    contextualQueries: [
      `${env} community ${action}`,
      `rural ${action}`,
      packet.chapterContext.chapterTitle.toLowerCase()
    ],
    fallbackQueries: [
      action,
      env + " landscape"
    ],
    requiredTerms: [anchor],
    preferredTerms: globalCtx.contextualAnchors.slice(0, 3),
    negativeTerms: globalCtx.negativeKeywords,
    targetMediaType: "video",
    desiredShotTypes: ["wide shot", "medium shot"],
    desiredOrientation: "landscape"
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
  const modelId = params.model ?? "gemini-2.0-flash"

  const cacheKey = makeCacheKey(globalContext, sceneId, packet.localContext.narration)
  const cache = useCache ? loadQueryCache(projectDir) : {}

  // Cache hit
  if (useCache && cache[cacheKey] && cache[cacheKey].contextVersion === globalContext.version) {
    logger.info(`[QueryGen] Cache hit for scene ${sceneId}`)
    return cache[cacheKey].plan
  }

  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } })
  const prompt = buildScenePrompt(packet, globalContext)
  const fallbackModels = [modelId, "gemini-2.0-flash", "gemini-1.5-flash"].filter((v, i, a) => a.indexOf(v) === i)
  let rawJson = ""

  for (let attempt = 1; attempt <= 3; attempt++) {
    const currentModel = fallbackModels[Math.min(attempt - 1, fallbackModels.length - 1)]
    try {
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: [{ role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0.25, maxOutputTokens: 2048 }
      })
      rawJson = response.text ?? ""
      break
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const overloaded = msg.includes("503") || msg.includes("429") || msg.includes("UNAVAILABLE")
      if (overloaded && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt))
        continue
      }
      logger.warn(`[QueryGen] Scene ${sceneId} AI failed (${msg}), using rule-based fallback`)
      return buildFallbackPlan(packet, globalContext)
    }
  }

  let plan: StockSearchPlan
  try {
    const clean = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim()
    plan = JSON.parse(clean) as StockSearchPlan
    // Validate required fields
    if (!plan.exactQueries?.length) throw new Error("Missing exactQueries")
  } catch {
    logger.warn(`[QueryGen] Scene ${sceneId} JSON parse failed, using rule-based fallback`)
    plan = buildFallbackPlan(packet, globalContext)
  }

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
