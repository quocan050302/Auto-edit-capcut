/**
 * Context-Aware Query Generator -- Phase 4
 *
 * Given SceneContextPacket(s), calls Gemini to produce tiered StockSearchPlan(s)
 * (Tier A = exact, B = subject, C = contextual, D = illustrative fallback).
 *
 * High-Throughput Architecture:
 * - Default model: gemini-3.5-flash-lite (STRICT: gemini-3.8-flash is NEVER used for stock queries)
 * - Batching: groups uncached scenes into batches of 12 (8-12 per request)
 * - Circuit breaker: immediately blocks 429 rate-limited models for >=60s across the whole job
 * - Immediate failover: switches immediately on 429/503 without per-scene retry backoff loops
 * - Preserves existing cache backward compatibility (.context-query-cache.json)
 */

import { GoogleGenAI } from "@google/genai"
import * as fs from "fs"
import { join } from "path"
import { createHash as cryptoHash } from "crypto"
import { logger } from "../logger"
import { normalizeApiKey } from "../utils/api-key"
import { classifyGeminiErrorKind } from "../utils/gemini-fallback"
import { getAvailableModelsForTask, STOCK_QUERY_RETRY_POLICY } from "../ai/model-router"
import {
  recordModelRateLimit,
  recordModelUnavailable,
  recordModelNotFound,
  recordModelSuccess,
  recordModelFailure
} from "../ai/model-health"
import { sanitizeStockQuery, dedupeStockQueries } from "./query-sanitizer"
import type { GlobalScriptContext, SceneContextPacket, StockSearchPlan } from "../../../shared/types"

export const STOCK_QUERY_BATCH_SIZE = 12
export const GEMINI_STOCK_BATCH_CONCURRENCY = 1

export interface BatchQueryProgressData {
  phase: "query_generation" | "stock_search" | "download"
  currentBatch: number
  totalBatches: number
  processedScenes: number
  totalScenes: number
  cachedScenes: number
  modelUsed?: string
}

export type QueryProgressCallback = (
  msg: string,
  pct: number,
  data?: BatchQueryProgressData
) => void

// ------ Cache ---------------------------------------------------------------

export interface QueryCacheEntry {
  plan: StockSearchPlan
  generatedAt: string
  contextVersion: number
  modelUsed?: string
  generationMode?: "batch_ai" | "single_ai" | "rule_fallback"
}

export type QueryCacheFile = Record<string, QueryCacheEntry>

export function getQueryCachePath(projectDir: string): string {
  return join(projectDir, "assets", "stock", ".context-query-cache.json")
}

export function loadQueryCache(projectDir: string): QueryCacheFile {
  const p = getQueryCachePath(projectDir)
  if (!fs.existsSync(p)) return {}
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as QueryCacheFile
  } catch {
    return {}
  }
}

/** Atomically save entries to cache via temporary file and atomic rename */
export function saveQueryCacheEntries(
  projectDir: string,
  newEntries: Record<string, QueryCacheEntry>
): void {
  const p = getQueryCachePath(projectDir)
  const dir = join(projectDir, "assets", "stock")
  fs.mkdirSync(dir, { recursive: true })

  const cache = loadQueryCache(projectDir)
  for (const [k, v] of Object.entries(newEntries)) {
    cache[k] = v
  }

  const tmpPath = `${p}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf-8")
  try {
    fs.renameSync(tmpPath, p)
  } catch {
    try {
      fs.copyFileSync(tmpPath, p)
      fs.unlinkSync(tmpPath)
    } catch {
      fs.writeFileSync(p, JSON.stringify(cache, null, 2), "utf-8")
    }
  }
}

export function saveQueryCache(projectDir: string, cache: QueryCacheFile): void {
  const p = getQueryCachePath(projectDir)
  const dir = join(projectDir, "assets", "stock")
  fs.mkdirSync(dir, { recursive: true })

  const tmpPath = `${p}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf-8")
  try {
    fs.renameSync(tmpPath, p)
  } catch {
    try {
      fs.copyFileSync(tmpPath, p)
      fs.unlinkSync(tmpPath)
    } catch {
      fs.writeFileSync(p, JSON.stringify(cache, null, 2), "utf-8")
    }
  }
}

export function makeCacheKey(
  globalContext: GlobalScriptContext,
  sceneId: string,
  narration: string
): string {
  const narrationHash = cryptoHash("md5").update(narration).digest("hex").slice(0, 8)
  return `v${globalContext.version}_${sceneId}_${narrationHash}`
}

// ------ Gemini Prompts -------------------------------------------------------

const SYSTEM_PROMPT = `You are the Context-Aware Visual Research Engine for a documentary video editor.

You must NEVER interpret a scene in isolation.
Every scene belongs to a complete documentary with a defined primary subject, central thesis, geography, historical period, community, visual identity and story arc.

Analyze each scene using four levels:
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

function buildBatchPrompt(
  scenes: Array<{ sceneId: string; packet: SceneContextPacket }>,
  globalCtx: GlobalScriptContext
): string {
  const globalContextData = {
    primarySubject: globalCtx.primarySubject,
    centralThesis: globalCtx.centralThesis,
    geography: [
      globalCtx.geography.primaryCountry,
      globalCtx.geography.primaryRegion,
      ...globalCtx.geography.secondaryLocations
    ].filter(Boolean),
    timePeriod: [globalCtx.timeContext.primaryPeriod, ...globalCtx.timeContext.historicalPeriods].filter(Boolean),
    exactTopicAnchors: globalCtx.exactTopicAnchors,
    negativeKeywords: globalCtx.negativeKeywords
  }

  const scenesData = scenes.map((s) => ({
    sceneId: s.sceneId,
    chapterTitle: s.packet.chapterContext.chapterTitle,
    chapterPurpose: s.packet.chapterContext.chapterPurpose,
    previousScene: s.packet.neighboringContext.previousScene || "none",
    narration: s.packet.localContext.narration,
    nextScene: s.packet.neighboringContext.nextScene || "none",
    scenePurpose: s.packet.localContext.scenePurpose,
    visibleSubject: s.packet.localContext.visibleSubject,
    visibleAction: s.packet.localContext.visibleAction
  }))

  return `GLOBAL SCRIPT CONTEXT:
${JSON.stringify(globalContextData, null, 2)}

REQUESTED SCENES (${scenes.length} scenes):
${JSON.stringify(scenesData, null, 2)}

Generate a context-aware StockSearchPlan for EACH requested scene.
Every scene in the response MUST map accurately to its requested sceneId.
Return ONLY valid JSON matching this exact structure:
{
  "scenes": [
    {
      "sceneId": "exact sceneId matching requested scene",
      "visualIntent": "short visual concept (5-12 words)",
      "exactQueries": ["Tier A query 1", "Tier A query 2"],
      "subjectQueries": ["Tier B query 1", "Tier B query 2"],
      "contextualQueries": ["Tier C query 1", "Tier C query 2"],
      "fallbackQueries": ["Tier D query 1", "Tier D query 2"],
      "requiredTerms": ["term that must appear in Tier A"],
      "preferredTerms": ["preferred search term"],
      "negativeTerms": ["term to exclude"],
      "targetMediaType": "video",
      "desiredShotTypes": ["medium shot", "close-up"],
      "desiredOrientation": "landscape"
    }
  ]
}`
}

// ------ Fallback (rule-based) -----------------------------------------------

export function buildFallbackPlan(packet: SceneContextPacket, globalCtx: GlobalScriptContext): StockSearchPlan {
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

export function sanitizePlan(plan: StockSearchPlan): StockSearchPlan {
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

/** Validate whether a parsed object has the minimum required structure for StockSearchPlan */
function isValidScenePlan(obj: unknown, expectedSceneId?: string): boolean {
  if (!obj || typeof obj !== "object") return false
  const p = obj as Record<string, unknown>
  if (expectedSceneId && p.sceneId !== expectedSceneId) return false
  if (typeof p.visualIntent !== "string" || !p.visualIntent.trim()) return false
  if (p.visualIntent.toLowerCase().includes("not specified")) return false

  const allQueries = [
    ...(Array.isArray(p.exactQueries) ? p.exactQueries : []),
    ...(Array.isArray(p.subjectQueries) ? p.subjectQueries : []),
    ...(Array.isArray(p.contextualQueries) ? p.contextualQueries : []),
    ...(Array.isArray(p.fallbackQueries) ? p.fallbackQueries : [])
  ].filter((q): q is string => typeof q === "string" && q.trim().length > 0 && !q.toLowerCase().includes("not specified"))

  return allQueries.length > 0
}

// ------ Single Scene Generator (kept for targeted individual calls & fallback) --

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

  const cacheKey = makeCacheKey(globalContext, sceneId, packet.localContext.narration)
  const cache = useCache ? loadQueryCache(projectDir) : {}

  // Cache hit
  if (useCache && cache[cacheKey] && cache[cacheKey].contextVersion === globalContext.version) {
    logger.info(`[QueryGen] Cache hit for scene ${sceneId}`)
    return sanitizePlan(cache[cacheKey].plan)
  }

  // Get healthy models for stock_query (gemini-3.5-flash-lite -> gemini-3.5-flash)
  const candidateModels = getAvailableModelsForTask("stock_query", rawModel)
  const cleanKey = normalizeApiKey(apiKey)
  let rawJson = ""
  let modelUsed = ""

  if (cleanKey.length > 0 && candidateModels.length > 0) {
    const ai = new GoogleGenAI({ apiKey: cleanKey, httpOptions: { apiVersion: "v1beta" } })
    const prompt = buildScenePrompt(packet, globalContext)

    for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
      const currentModel = candidateModels[mIdx]
      try {
        const response = await ai.models.generateContent({
          model: currentModel,
          contents: [{ role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }],
          config: { responseMimeType: "application/json", temperature: 0.25, maxOutputTokens: 2048 }
        })
        rawJson = response.text ?? ""
        if (rawJson) {
          modelUsed = currentModel
          recordModelSuccess(currentModel)
          logger.info(`[QueryGen] Scene ${sceneId} generated successfully with ${currentModel}.`)
          break
        }
      } catch (err: unknown) {
        const { kind, message } = classifyGeminiErrorKind(err)
        recordModelFailure(currentModel, kind)

        if (kind === "MODEL_NOT_FOUND") {
          logger.warn(`[QueryGen] Model ${currentModel} not found for this account. Switching model immediately.`)
        } else if (kind === "RATE_LIMIT") {
          logger.warn(`[QueryGen] Model ${currentModel} rate-limited. Circuit breaker tripped. Switching immediately.`)
        } else if (kind === "SERVICE_UNAVAILABLE") {
          logger.warn(`[QueryGen] Model ${currentModel} service unavailable. Switching immediately.`)
        } else if (kind === "AUTH_ERROR") {
          logger.error(`[QueryGen] Gemini authentication error. Check API key.`)
          break
        } else {
          logger.warn(`[QueryGen] Model ${currentModel} failed (${kind}): ${message.slice(0, 100)}`)
        }
        // In high-throughput stock query mode, do not retry same model on failure
      }
    }
  }

  let plan: StockSearchPlan
  let generationMode: "single_ai" | "rule_fallback" = "single_ai"

  if (rawJson) {
    try {
      const clean = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim()
      const parsed = JSON.parse(clean) as StockSearchPlan
      if (!isValidScenePlan(parsed)) throw new Error("Parsed search plan failed validation")
      plan = parsed
    } catch {
      logger.warn(`[QueryGen] Scene ${sceneId} JSON parse failed, using rule-based fallback`)
      plan = buildFallbackPlan(packet, globalContext)
      generationMode = "rule_fallback"
    }
  } else {
    logger.warn(`[QueryGen] Scene ${sceneId} AI failed or models blocked, using rule-based fallback`)
    plan = buildFallbackPlan(packet, globalContext)
    generationMode = "rule_fallback"
  }

  plan = sanitizePlan(plan)

  // Save to cache atomically
  if (useCache) {
    saveQueryCacheEntries(projectDir, {
      [cacheKey]: {
        plan,
        generatedAt: new Date().toISOString(),
        contextVersion: globalContext.version,
        modelUsed: modelUsed || undefined,
        generationMode
      }
    })
  }

  return plan
}

// ------ Batch Query Generation (High-Throughput) -----------------------------

interface BatchSceneItem {
  sceneId: string
  packet: SceneContextPacket
  cacheKey: string
}

/**
 * Execute a single batch of scenes with Gemini AI models.
 * If model fails with rate-limit or unavailable, switches immediately to next model.
 * If invalid JSON / payload too large, attempts batch split down to 2 scenes.
 */
async function processBatchChunk(params: {
  projectDir: string
  apiKey: string
  model?: string
  batch: BatchSceneItem[]
  globalContext: GlobalScriptContext
  batchIndex: number
  totalBatches: number
  onProgress?: QueryProgressCallback
}): Promise<Map<string, { plan: StockSearchPlan; modelUsed?: string; mode: "batch_ai" | "rule_fallback" }>> {
  const { projectDir, apiKey, model, batch, globalContext, batchIndex, totalBatches, onProgress } = params
  const results = new Map<string, { plan: StockSearchPlan; modelUsed?: string; mode: "batch_ai" | "rule_fallback" }>()

  const candidateModels = getAvailableModelsForTask("stock_query", model)
  const cleanKey = normalizeApiKey(apiKey)

  let batchSuccess = false
  let rawJson = ""
  let successfulModel = ""

  if (cleanKey.length > 0 && candidateModels.length > 0) {
    const ai = new GoogleGenAI({ apiKey: cleanKey, httpOptions: { apiVersion: "v1beta" } })
    const prompt = buildBatchPrompt(batch, globalContext)

    for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
      const currentModel = candidateModels[mIdx]
      const modelNotice = `Using ${currentModel} for batch ${batchIndex + 1}/${totalBatches} (${batch.length} scenes)...`
      logger.info(`[QueryGen] ${modelNotice}`)
      onProgress?.(modelNotice, (batchIndex / totalBatches), {
        phase: "query_generation",
        currentBatch: batchIndex + 1,
        totalBatches,
        processedScenes: batchIndex * STOCK_QUERY_BATCH_SIZE,
        totalScenes: totalBatches * STOCK_QUERY_BATCH_SIZE,
        cachedScenes: 0,
        modelUsed: currentModel
      })

      try {
        const response = await ai.models.generateContent({
          model: currentModel,
          contents: [{ role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }],
          config: { responseMimeType: "application/json", temperature: 0.25, maxOutputTokens: 8192 }
        })

        rawJson = response.text ?? ""
        if (rawJson) {
          successfulModel = currentModel
          recordModelSuccess(currentModel)
          batchSuccess = true
          logger.info(`[QueryGen] Batch ${batchIndex + 1}/${totalBatches} generated successfully with ${currentModel}.`)
          break
        }
      } catch (err: unknown) {
        const { kind, message } = classifyGeminiErrorKind(err)
        recordModelFailure(currentModel, kind)

        const nextModel = candidateModels[mIdx + 1]
        if (kind === "RATE_LIMIT") {
          const switchMsg = nextModel
            ? `${currentModel} temporarily rate-limited. Switching to ${nextModel}...`
            : `${currentModel} rate-limited. No other AI models available, using rule-based fallback...`
          logger.warn(`[QueryGen] ${switchMsg}`)
          onProgress?.(switchMsg, (batchIndex / totalBatches))
        } else if (kind === "SERVICE_UNAVAILABLE") {
          const switchMsg = nextModel
            ? `${currentModel} high demand/unavailable. Switching to ${nextModel}...`
            : `${currentModel} unavailable. Using rule-based fallback...`
          logger.warn(`[QueryGen] ${switchMsg}`)
          onProgress?.(switchMsg, (batchIndex / totalBatches))
        } else if (kind === "MODEL_NOT_FOUND") {
          logger.warn(`[QueryGen] Model ${currentModel} not found for this account.`)
        } else if (kind === "AUTH_ERROR") {
          logger.error(`[QueryGen] Gemini authentication error. Check API key.`)
          break
        } else {
          logger.warn(`[QueryGen] Batch call with ${currentModel} error (${kind}): ${message.slice(0, 100)}`)
        }
      }
    }
  }

  // Parse batch JSON if available
  if (batchSuccess && rawJson) {
    try {
      const clean = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim()
      const parsed = JSON.parse(clean) as { scenes?: Array<Record<string, unknown>> }

      if (Array.isArray(parsed.scenes)) {
        // Map returned scenes by sceneId (do NOT map by array index)
        const returnedMap = new Map<string, Record<string, unknown>>()
        const seenIds = new Set<string>()

        for (const item of parsed.scenes) {
          const sId = typeof item.sceneId === "string" ? item.sceneId.trim() : ""
          if (sId && !seenIds.has(sId)) {
            seenIds.add(sId)
            returnedMap.set(sId, item)
          }
        }

        // Validate each requested scene
        for (const item of batch) {
          const found = returnedMap.get(item.sceneId)
          if (found && isValidScenePlan(found, item.sceneId)) {
            const sanitized = sanitizePlan(found as unknown as StockSearchPlan)
            results.set(item.sceneId, { plan: sanitized, modelUsed: successfulModel, mode: "batch_ai" })
          } else {
            logger.warn(`[QueryGen] Missing or invalid response for scene ${item.sceneId}, falling back to rule-based plan`)
            const fb = sanitizePlan(buildFallbackPlan(item.packet, globalContext))
            results.set(item.sceneId, { plan: fb, mode: "rule_fallback" })
          }
        }
        return results
      }
    } catch {
      logger.warn(`[QueryGen] Batch ${batchIndex + 1} JSON parse failed. Attempting batch split fallback.`)
    }
  }

  // If batch call failed (or JSON corrupted) and batch size >= 4, attempt split in half
  if (batch.length >= 4) {
    const mid = Math.floor(batch.length / 2)
    const firstHalf = batch.slice(0, mid)
    const secondHalf = batch.slice(mid)
    logger.info(`[QueryGen] Splitting batch of ${batch.length} into two sub-batches (${firstHalf.length} and ${secondHalf.length})...`)

    const half1Res = await processBatchChunk({
      ...params,
      batch: firstHalf
    })
    const half2Res = await processBatchChunk({
      ...params,
      batch: secondHalf
    })

    for (const [k, v] of half1Res.entries()) results.set(k, v)
    for (const [k, v] of half2Res.entries()) results.set(k, v)
    return results
  }

  // All AI attempts failed: apply individual rule-based fallback for every scene in this batch
  logger.warn(`[QueryGen] All AI models failed for batch ${batchIndex + 1}, using rule-based fallback for ${batch.length} scenes.`)
  for (const item of batch) {
    const fb = sanitizePlan(buildFallbackPlan(item.packet, globalContext))
    results.set(item.sceneId, { plan: fb, mode: "rule_fallback" })
  }

  return results
}

/**
 * Batch Stock Query Generator -- Phase 4 Main Entry
 *
 * 1. Checks disk cache first.
 * 2. Only uncached scenes are batched into requests of 12.
 * 3. Enforces GEMINI_STOCK_BATCH_CONCURRENCY = 1 (strictly sequential).
 * 4. Saves cache atomically per scene.
 */
export async function batchGenerateSearchPlans(params: {
  projectDir: string
  apiKey: string
  model?: string
  scenes: Array<{ sceneId: string; packet: SceneContextPacket }>
  globalContext: GlobalScriptContext
  useCache?: boolean
  onProgress?: QueryProgressCallback
}): Promise<Map<string, StockSearchPlan>> {
  const { projectDir, apiKey, model, scenes, globalContext, useCache = true, onProgress } = params
  const plans = new Map<string, StockSearchPlan>()

  if (scenes.length === 0) {
    return plans
  }

  // 1. Load cache and separate cache hits from misses
  const existingCache = useCache ? loadQueryCache(projectDir) : {}
  const uncachedScenes: BatchSceneItem[] = []
  let cachedCount = 0

  for (const s of scenes) {
    const cacheKey = makeCacheKey(globalContext, s.sceneId, s.packet.localContext.narration)
    const entry = existingCache[cacheKey]

    if (useCache && entry && entry.contextVersion === globalContext.version) {
      plans.set(s.sceneId, sanitizePlan(entry.plan))
      cachedCount++
    } else {
      uncachedScenes.push({
        sceneId: s.sceneId,
        packet: s.packet,
        cacheKey
      })
    }
  }

  if (cachedCount > 0) {
    logger.info(`[QueryGen] ${cachedCount} cached scenes found out of ${scenes.length}.`)
  }

  // If all scenes were cached, return immediately
  if (uncachedScenes.length === 0) {
    onProgress?.(`All ${cachedCount} scenes loaded from cache.`, 1.0, {
      phase: "query_generation",
      currentBatch: 0,
      totalBatches: 0,
      processedScenes: scenes.length,
      totalScenes: scenes.length,
      cachedScenes: cachedCount
    })
    return plans
  }

  // 2. Partition uncached scenes into batches of STOCK_QUERY_BATCH_SIZE (12)
  const batches: BatchSceneItem[][] = []
  for (let i = 0; i < uncachedScenes.length; i += STOCK_QUERY_BATCH_SIZE) {
    batches.push(uncachedScenes.slice(i, i + STOCK_QUERY_BATCH_SIZE))
  }

  const totalBatches = batches.length
  logger.info(`[QueryGen] Generating stock queries: ${uncachedScenes.length} uncached scenes partitioned into ${totalBatches} batches (batch size ${STOCK_QUERY_BATCH_SIZE}).`)
  onProgress?.(`Preparing stock queries... ${cachedCount} cached scenes found. Generating ${totalBatches} batches...`, 0.02, {
    phase: "query_generation",
    currentBatch: 0,
    totalBatches,
    processedScenes: cachedCount,
    totalScenes: scenes.length,
    cachedScenes: cachedCount
  })

  // 3. Process batches sequentially (concurrency = 1)
  let processedScenesCount = cachedCount

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const currentBatch = batches[bIdx]
    const batchProgressPct = (bIdx / totalBatches) * 0.95

    onProgress?.(
      `Generating stock queries: batch ${bIdx + 1}/${totalBatches} (${currentBatch.length} scenes)...`,
      batchProgressPct,
      {
        phase: "query_generation",
        currentBatch: bIdx + 1,
        totalBatches,
        processedScenes: processedScenesCount,
        totalScenes: scenes.length,
        cachedScenes: cachedCount
      }
    )

    const batchResults = await processBatchChunk({
      projectDir,
      apiKey,
      model,
      batch: currentBatch,
      globalContext,
      batchIndex: bIdx,
      totalBatches,
      onProgress
    })

    // 4. Save results to output and atomic cache
    const cacheEntriesToSave: Record<string, QueryCacheEntry> = {}

    for (const item of currentBatch) {
      const res = batchResults.get(item.sceneId)
      if (res) {
        plans.set(item.sceneId, res.plan)
        cacheEntriesToSave[item.cacheKey] = {
          plan: res.plan,
          generatedAt: new Date().toISOString(),
          contextVersion: globalContext.version,
          modelUsed: res.modelUsed,
          generationMode: res.mode
        }
      } else {
        // Fallback safety net
        const fb = sanitizePlan(buildFallbackPlan(item.packet, globalContext))
        plans.set(item.sceneId, fb)
        cacheEntriesToSave[item.cacheKey] = {
          plan: fb,
          generatedAt: new Date().toISOString(),
          contextVersion: globalContext.version,
          generationMode: "rule_fallback"
        }
      }
      processedScenesCount++
    }

    if (useCache && Object.keys(cacheEntriesToSave).length > 0) {
      saveQueryCacheEntries(projectDir, cacheEntriesToSave)
    }

    onProgress?.(
      `Stock query batch ${bIdx + 1}/${totalBatches} completed.`,
      ((bIdx + 1) / totalBatches) * 0.95,
      {
        phase: "query_generation",
        currentBatch: bIdx + 1,
        totalBatches,
        processedScenes: processedScenesCount,
        totalScenes: scenes.length,
        cachedScenes: cachedCount
      }
    )
  }

  onProgress?.(`All ${scenes.length} stock query plans ready.`, 1.0, {
    phase: "query_generation",
    currentBatch: totalBatches,
    totalBatches,
    processedScenes: scenes.length,
    totalScenes: scenes.length,
    cachedScenes: cachedCount
  })

  return plans
}
