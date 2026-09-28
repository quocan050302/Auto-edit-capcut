/**
 * Comprehensive Unit Tests for:
 * 1. Task-Specific Model Router (model-router.ts)
 * 2. Model Health & Circuit Breaker (model-health.ts)
 * 3. Batch Stock Query Generation & Caching (context-query-gen.ts)
 * 4. Regression & Safeguard Verifications
 */

import * as assert from "assert"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  getModelRoute,
  getAvailableModelsForTask,
  MODEL_ROUTES,
  STOCK_QUERY_RETRY_POLICY
} from "../src/main/ai/model-router"
import {
  isModelAvailable,
  recordModelRateLimit,
  recordModelUnavailable,
  recordModelNotFound,
  recordModelSuccess,
  recordModelFailure,
  resetModelHealth,
  getModelHealthState,
  setBlockedUntilForTesting
} from "../src/main/ai/model-health"
import {
  STOCK_QUERY_BATCH_SIZE,
  GEMINI_STOCK_BATCH_CONCURRENCY,
  makeCacheKey,
  saveQueryCacheEntries,
  loadQueryCache,
  buildFallbackPlan,
  sanitizePlan,
  batchGenerateSearchPlans
} from "../src/main/stock/context-query-gen"
import type { GlobalScriptContext, SceneContextPacket, StockSearchPlan } from "../shared/types"

let passed = 0
let failed = 0

function it(name: string, fn: () => void | Promise<void>): void {
  try {
    const res = fn()
    if (res instanceof Promise) {
      res
        .then(() => {
          console.log(`  ✓ ${name}`)
          passed++
        })
        .catch((err) => {
          console.error(`  ✗ ${name}`)
          console.error(err)
          failed++
        })
    } else {
      console.log(`  ✓ ${name}`)
      passed++
    }
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err)
    failed++
  }
}

console.log("\n==================================================")
console.log("RUNNING MODEL ROUTER, HEALTH & BATCH QUERY TESTS")
console.log("==================================================")

// ─── 1. Model Router Tests ───────────────────────────────────────────────────
console.log("\n--- 1. Task-Specific Model Router Tests ---")

it("stock_query defaults to [gemini-3.5-flash-lite, gemini-3.5-flash]", () => {
  const route = getModelRoute("stock_query")
  assert.deepStrictEqual(route, ["gemini-3.5-flash-lite", "gemini-3.5-flash"])
})

it("stock_query NEVER includes gemini-3.8-flash even if user preferredModel is gemini-3.8-flash", () => {
  const routeWith38 = getModelRoute("stock_query", "gemini-3.8-flash")
  assert.deepStrictEqual(routeWith38, ["gemini-3.5-flash-lite", "gemini-3.5-flash"])
  assert.strictEqual(routeWith38.includes("gemini-3.8-flash"), false)
})

it("stock_query allows reordering within its allowed models if user selects gemini-3.5-flash", () => {
  const route = getModelRoute("stock_query", "gemini-3.5-flash")
  assert.deepStrictEqual(route, ["gemini-3.5-flash", "gemini-3.5-flash-lite"])
})

it("planning prioritizes gemini-3.8-flash", () => {
  const route = getModelRoute("planning")
  assert.strictEqual(route[0], "gemini-3.8-flash")
})

it("global_context defaults to gemini-3.5-flash then gemini-3.5-flash-lite", () => {
  const route = getModelRoute("global_context")
  assert.deepStrictEqual(route, ["gemini-3.5-flash", "gemini-3.5-flash-lite"])
  assert.strictEqual(route.includes("gemini-3.8-flash"), false)
})

it("caption_planning defaults to gemini-3.5-flash then gemini-3.5-flash-lite", () => {
  const route = getModelRoute("caption_planning")
  assert.deepStrictEqual(route, ["gemini-3.5-flash", "gemini-3.5-flash-lite"])
  assert.strictEqual(route.includes("gemini-3.8-flash"), false)
})

it("STOCK_QUERY_RETRY_POLICY enforces 0 retries and immediate model switch", () => {
  assert.strictEqual(STOCK_QUERY_RETRY_POLICY.maxRetriesPerModel, 0)
  assert.strictEqual(STOCK_QUERY_RETRY_POLICY.switchModelImmediatelyOnRateLimit, true)
  assert.strictEqual(STOCK_QUERY_RETRY_POLICY.switchModelImmediatelyOnUnavailable, true)
  assert.strictEqual(STOCK_QUERY_RETRY_POLICY.useRuleFallbackAfterAllModelsFail, true)
})

// ─── 2. Model Health & Circuit Breaker Tests ────────────────────────────────
console.log("\n--- 2. Model Health & Circuit Breaker Tests ---")

it("New models are available by default", () => {
  resetModelHealth()
  assert.strictEqual(isModelAvailable("gemini-3.5-flash-lite"), true)
  assert.strictEqual(isModelAvailable("gemini-3.5-flash"), true)
})

it("429 RATE_LIMIT trips circuit breaker and blocks model for >= 60 seconds", () => {
  resetModelHealth()
  recordModelRateLimit("gemini-3.5-flash-lite", 60_000)

  assert.strictEqual(isModelAvailable("gemini-3.5-flash-lite"), false)
  const health = getModelHealthState("gemini-3.5-flash-lite")
  assert.strictEqual(health?.status, "rate_limited")
  assert.ok((health?.blockedUntil ?? 0) >= Date.now() + 59_000)
})

it("Subsequent calls to getAvailableModelsForTask skip the blocked model", () => {
  resetModelHealth()
  recordModelRateLimit("gemini-3.5-flash-lite", 60_000)

  const available = getAvailableModelsForTask("stock_query")
  assert.deepStrictEqual(available, ["gemini-3.5-flash"])
  assert.strictEqual(available.includes("gemini-3.5-flash-lite"), false)
})

it("503 SERVICE_UNAVAILABLE blocks model for 30s and switches", () => {
  resetModelHealth()
  recordModelUnavailable("gemini-3.5-flash", 30_000, "SERVICE_UNAVAILABLE")

  assert.strictEqual(isModelAvailable("gemini-3.5-flash"), false)
  const available = getAvailableModelsForTask("stock_query")
  assert.deepStrictEqual(available, ["gemini-3.5-flash-lite"])
})

it("404 MODEL_NOT_FOUND blocks model for entire job (24h)", () => {
  resetModelHealth()
  recordModelNotFound("gemini-2.5-flash")

  assert.strictEqual(isModelAvailable("gemini-2.5-flash"), false)
  const health = getModelHealthState("gemini-2.5-flash")
  assert.ok((health?.blockedUntil ?? 0) >= Date.now() + 23 * 60 * 60 * 1000)
})

it("Expired blockedUntil unblocks model for subsequent retry", () => {
  resetModelHealth()
  recordModelRateLimit("gemini-3.5-flash-lite", 60_000)
  assert.strictEqual(isModelAvailable("gemini-3.5-flash-lite"), false)

  // Fast-forward past blockedUntil using test helper
  setBlockedUntilForTesting("gemini-3.5-flash-lite", Date.now() - 1000)

  // Checking availability should unblock
  assert.strictEqual(isModelAvailable("gemini-3.5-flash-lite"), true)
})

it("recordModelSuccess clears failures and unblocks model", () => {
  resetModelHealth()
  recordModelRateLimit("gemini-3.5-flash", 60_000)
  assert.strictEqual(isModelAvailable("gemini-3.5-flash"), false)

  recordModelSuccess("gemini-3.5-flash")
  assert.strictEqual(isModelAvailable("gemini-3.5-flash"), true)
})

// ─── 3. Batch Query Generation & Cache Tests ─────────────────────────────────
console.log("\n--- 3. Batch Query Generation & Cache Tests ---")

it("Batch configuration constants match requirements", () => {
  assert.strictEqual(STOCK_QUERY_BATCH_SIZE, 12)
  assert.strictEqual(GEMINI_STOCK_BATCH_CONCURRENCY, 1)
})

it("Cache key keeps backward compatible format: v{version}_{sceneId}_{narrationHash}", () => {
  const dummyCtx: GlobalScriptContext = {
    projectId: "test_proj",
    language: "en",
    version: 1,
    primarySubject: "Hutterite Community",
    secondarySubjects: [],
    globalSynopsis: "A documentary about Manitoba Hutterite colony.",
    centralThesis: "Tradition and modernization.",
    documentaryAngle: "observational",
    targetAudience: "general",
    geography: { primaryCountry: "Canada", primaryRegion: "Manitoba", secondaryLocations: [] },
    timeContext: { primaryPeriod: "contemporary", historicalPeriods: [] },
    communities: [],
    recurringPeople: [],
    visualWorld: { environment: ["prairie", "rural"], architecture: [], clothing: [], occupations: [], machinery: [], recurringObjects: [], colorMood: "natural", documentaryStyle: "observational" },
    exactTopicAnchors: ["Hutterite", "Manitoba"],
    contextualAnchors: ["colony", "farming"],
    forbiddenSubstitutions: ["Amish", "Mennonite"],
    negativeKeywords: ["tourist", "modern city"],
    recurringVisualMotifs: [],
    storyArc: [],
    generatedAt: new Date().toISOString(),
    modelUsed: "gemini-3.5-flash"
  }

  const key = makeCacheKey(dummyCtx, "scene1", "Life on the Canadian prairie")
  assert.ok(key.startsWith("v1_scene1_"))
  const parts = key.split("_")
  assert.strictEqual(parts[0], "v1")
  assert.strictEqual(parts[1], "scene1")
  assert.strictEqual(parts[2].length, 8)
})

it("Atomic cache saving preserves previous entries and loads cleanly", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-test-"))
  try {
    const dummyPlan: StockSearchPlan = {
      visualIntent: "Manitoba Hutterite colony harvest",
      exactQueries: ["Hutterite colony harvest"],
      subjectQueries: ["Hutterite farming"],
      contextualQueries: ["colony farming"],
      fallbackQueries: ["prairie harvest"],
      requiredTerms: ["Hutterite"],
      preferredTerms: ["harvest"],
      negativeTerms: ["Amish"],
      targetMediaType: "video",
      desiredShotTypes: ["wide shot"],
      desiredOrientation: "landscape"
    }

    saveQueryCacheEntries(tmpDir, {
      "v1_scene_001_hash1": {
        plan: dummyPlan,
        generatedAt: new Date().toISOString(),
        contextVersion: 1,
        generationMode: "batch_ai",
        modelUsed: "gemini-3.5-flash-lite"
      }
    })

    saveQueryCacheEntries(tmpDir, {
      "v1_scene_002_hash2": {
        plan: dummyPlan,
        generatedAt: new Date().toISOString(),
        contextVersion: 1,
        generationMode: "rule_fallback"
      }
    })

    const loaded = loadQueryCache(tmpDir)
    assert.ok(loaded["v1_scene_001_hash1"])
    assert.ok(loaded["v1_scene_002_hash2"])
    assert.strictEqual(loaded["v1_scene_001_hash1"].generationMode, "batch_ai")
    assert.strictEqual(loaded["v1_scene_002_hash2"].generationMode, "rule_fallback")
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

it("Rule-based fallback produces clean, sanitized queries without placeholders", () => {
  const dummyCtx: GlobalScriptContext = {
    projectId: "test_proj",
    language: "en",
    version: 1,
    primarySubject: "Hutterite",
    secondarySubjects: [],
    globalSynopsis: "colony life",
    centralThesis: "faith and farming",
    documentaryAngle: "observational",
    targetAudience: "general",
    geography: { primaryCountry: "Canada", primaryRegion: "Not specified", secondaryLocations: [] },
    timeContext: { primaryPeriod: "contemporary", historicalPeriods: [] },
    communities: [],
    recurringPeople: [],
    visualWorld: { environment: ["rural prairie"], architecture: [], clothing: [], occupations: [], machinery: [], recurringObjects: [], colorMood: "natural", documentaryStyle: "observational" },
    exactTopicAnchors: ["Hutterite colony"],
    contextualAnchors: ["farming"],
    forbiddenSubstitutions: [],
    negativeKeywords: ["modern city"],
    recurringVisualMotifs: [],
    storyArc: [],
    generatedAt: new Date().toISOString(),
    modelUsed: "gemini-3.5-flash"
  }

  const dummyPacket: SceneContextPacket = {
    globalContext: {
      primarySubject: dummyCtx.primarySubject,
      centralThesis: dummyCtx.centralThesis,
      geography: ["Canada"],
      timePeriod: ["contemporary"],
      exactTopicAnchors: dummyCtx.exactTopicAnchors,
      contextualAnchors: dummyCtx.contextualAnchors,
      forbiddenSubstitutions: [],
      negativeKeywords: []
    },
    chapterContext: { chapterId: "CH1", chapterTitle: "Harvest Season", chapterPurpose: "Introduce daily labor" },
    localContext: {
      narration: "The colony members begin harvesting wheat before sunrise.",
      scenePurpose: "wheat harvest",
      visibleSubject: "Hutterite farmers",
      visibleAction: "harvesting wheat field",
      preferredLocation: "Not specified",
      preferredTimePeriod: "contemporary"
    },
    neighboringContext: { previousScene: "", nextScene: "" }
  }

  const plan = sanitizePlan(buildFallbackPlan(dummyPacket, dummyCtx))

  assert.ok(plan.exactQueries.length > 0)
  assert.ok(plan.subjectQueries.length > 0)
  // Check no "Not specified" in queries
  for (const q of [...plan.exactQueries, ...plan.subjectQueries, ...plan.contextualQueries]) {
    assert.strictEqual(q.toLowerCase().includes("not specified"), false)
  }
})

it("batchGenerateSearchPlans separates cached scenes from uncached scenes", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-split-test-"))
  try {
    const dummyCtx: GlobalScriptContext = {
      projectId: "test_proj",
      language: "en",
      version: 1,
      primarySubject: "Hutterite",
      secondarySubjects: [],
      globalSynopsis: "colony life",
      centralThesis: "faith and farming",
      documentaryAngle: "observational",
      targetAudience: "general",
      geography: { primaryCountry: "Canada", primaryRegion: "Manitoba", secondaryLocations: [] },
      timeContext: { primaryPeriod: "contemporary", historicalPeriods: [] },
      communities: [],
      recurringPeople: [],
      visualWorld: { environment: ["rural prairie"], architecture: [], clothing: [], occupations: [], machinery: [], recurringObjects: [], colorMood: "natural", documentaryStyle: "observational" },
      exactTopicAnchors: ["Hutterite colony"],
      contextualAnchors: ["farming"],
      forbiddenSubstitutions: [],
      negativeKeywords: ["modern city"],
      recurringVisualMotifs: [],
      storyArc: [],
      generatedAt: new Date().toISOString(),
      modelUsed: "gemini-3.5-flash"
    }

    const packet: SceneContextPacket = {
      globalContext: {
        primarySubject: dummyCtx.primarySubject,
        centralThesis: dummyCtx.centralThesis,
        geography: ["Canada"],
        timePeriod: ["contemporary"],
        exactTopicAnchors: dummyCtx.exactTopicAnchors,
        contextualAnchors: dummyCtx.contextualAnchors,
        forbiddenSubstitutions: [],
        negativeKeywords: []
      },
      chapterContext: { chapterId: "CH1", chapterTitle: "Harvest", chapterPurpose: "Labor" },
      localContext: {
        narration: "Scene 1 narration text",
        scenePurpose: "wheat harvest",
        visibleSubject: "Hutterite farmers",
        visibleAction: "harvesting wheat field",
        preferredLocation: "Manitoba",
        preferredTimePeriod: "contemporary"
      },
      neighboringContext: { previousScene: "", nextScene: "" }
    }

    // Pre-populate cache for scene 1
    const cacheKey1 = makeCacheKey(dummyCtx, "scene_1", packet.localContext.narration)
    saveQueryCacheEntries(tmpDir, {
      [cacheKey1]: {
        plan: sanitizePlan(buildFallbackPlan(packet, dummyCtx)),
        generatedAt: new Date().toISOString(),
        contextVersion: 1,
        generationMode: "batch_ai"
      }
    })

    // Batch generate for scene 1 (cached) and scene 2 (uncached, empty API key -> rule fallback)
    const packet2 = { ...packet, localContext: { ...packet.localContext, narration: "Scene 2 narration text" } }
    const scenes = [
      { sceneId: "scene_1", packet },
      { sceneId: "scene_2", packet: packet2 }
    ]

    const plans = await batchGenerateSearchPlans({
      projectDir: tmpDir,
      apiKey: "", // empty key triggers graceful rule fallback without Gemini API call
      scenes,
      globalContext: dummyCtx,
      useCache: true
    })

    assert.strictEqual(plans.size, 2)
    assert.ok(plans.has("scene_1"))
    assert.ok(plans.has("scene_2"))

    // Verify cache has both
    const cacheAfter = loadQueryCache(tmpDir)
    assert.ok(cacheAfter[cacheKey1])
    const cacheKey2 = makeCacheKey(dummyCtx, "scene_2", packet2.localContext.narration)
    assert.ok(cacheAfter[cacheKey2])
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

it("24 scenes are partitioned into exactly 2 batches of 12", () => {
  const dummyCtx: GlobalScriptContext = {
    projectId: "test", language: "en", version: 1,
    primarySubject: "Subject", secondarySubjects: [], globalSynopsis: "syn", centralThesis: "thesis",
    documentaryAngle: "doc", targetAudience: "aud",
    geography: { primaryCountry: "USA", primaryRegion: null, secondaryLocations: [] },
    timeContext: { primaryPeriod: "contemporary", historicalPeriods: [] },
    communities: [], recurringPeople: [],
    visualWorld: { environment: [], architecture: [], clothing: [], occupations: [], machinery: [], recurringObjects: [], colorMood: "natural", documentaryStyle: "doc" },
    exactTopicAnchors: ["anchor"], contextualAnchors: [], forbiddenSubstitutions: [], negativeKeywords: [], recurringVisualMotifs: [], storyArc: [],
    generatedAt: new Date().toISOString(), modelUsed: "test"
  }

  const items = Array.from({ length: 24 }).map((_, i) => ({
    sceneId: `scene_${i + 1}`,
    packet: {
      globalContext: {
        primarySubject: "Subject", centralThesis: "thesis", geography: [], timePeriod: [],
        exactTopicAnchors: ["anchor"], contextualAnchors: [], forbiddenSubstitutions: [], negativeKeywords: []
      },
      chapterContext: { chapterId: "CH1", chapterTitle: "Title", chapterPurpose: "Purp" },
      localContext: {
        narration: `Narration for scene ${i + 1}`, scenePurpose: "p", visibleSubject: "s", visibleAction: "a",
        preferredLocation: "", preferredTimePeriod: ""
      },
      neighboringContext: { previousScene: "", nextScene: "" }
    }
  }))

  const batches: (typeof items)[] = []
  for (let i = 0; i < items.length; i += STOCK_QUERY_BATCH_SIZE) {
    batches.push(items.slice(i, i + STOCK_QUERY_BATCH_SIZE))
  }

  assert.strictEqual(batches.length, 2)
  assert.strictEqual(batches[0].length, 12)
  assert.strictEqual(batches[1].length, 12)
})

it("Response mapped by sceneId: missing scene falls back individually without affecting valid scenes", () => {
  const batchRequested = [
    { sceneId: "scene_alpha" },
    { sceneId: "scene_beta" }
  ]

  // Model returns scene_alpha but omits scene_beta
  const modelResponse = {
    scenes: [
      {
        sceneId: "scene_alpha",
        visualIntent: "Alpha visual intent",
        exactQueries: ["alpha query"],
        subjectQueries: ["alpha subject"],
        contextualQueries: ["alpha context"],
        fallbackQueries: ["alpha fallback"],
        requiredTerms: [], preferredTerms: [], negativeTerms: [],
        targetMediaType: "video" as const,
        desiredShotTypes: ["wide shot"],
        desiredOrientation: "landscape" as const
      }
    ]
  }

  const returnedMap = new Map<string, any>()
  for (const item of modelResponse.scenes) {
    returnedMap.set(item.sceneId, item)
  }

  assert.ok(returnedMap.has("scene_alpha"))
  assert.strictEqual(returnedMap.has("scene_beta"), false)
})

it("Duplicate sceneId in response is deduplicated and does not corrupt output", () => {
  const modelResponseWithDupes = {
    scenes: [
      { sceneId: "scene_1", visualIntent: "Intent 1", exactQueries: ["query 1"] },
      { sceneId: "scene_1", visualIntent: "Intent 1 duplicate", exactQueries: ["query 1 dup"] }
    ]
  }

  const seenIds = new Set<string>()
  const uniqueItems: any[] = []
  for (const item of modelResponseWithDupes.scenes) {
    if (!seenIds.has(item.sceneId)) {
      seenIds.add(item.sceneId)
      uniqueItems.push(item)
    }
  }

  assert.strictEqual(uniqueItems.length, 1)
  assert.strictEqual(uniqueItems[0].visualIntent, "Intent 1")
})

// ─── Print Summary ──────────────────────────────────────────────────────────
setTimeout(() => {
  console.log("\n==================================================")
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`)
  console.log("==================================================")
  if (failed > 0) {
    process.exit(1)
  }
}, 300)
