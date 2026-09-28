/**
 * Context-Aware Stock Engine -- replaces naive scene-by-scene pipeline.
 *
 * Flow:
 *  1. Load/generate GlobalScriptContext (Phase 1)
 *  2. Flatten scenes with chapter context + neighboring context (Phase 2-3)
 *  3. For each scene, build SceneContextPacket and call Gemini for tiered
 *     StockSearchPlan (Phase 4)
 *  4. Search Pexels/Pixabay using tiered queries A->B->C->D (Phase 6)
 *  5. Rank candidates with context-aware 100-point scorer (Phase 7)
 *  6. Post-process: sequence-level continuity check (Phase 8)
 *  7. Stamp plan + save assignments
 */

import { join, basename } from "path"
import * as fs from "fs"
import type {
  StockRunParams,
  StockRunResult,
  StockSceneAssignment,
  StockSearchResult,
  GlobalScriptContext,
  SceneContextPacket,
  StockSearchPlan,
  TranscriptResult
} from "../../../shared/types"
import { pexelsSearchVideos, pexelsSearchPhotos } from "./providers/pexels"
import { pixabaySearchVideos, pixabaySearchPhotos } from "./providers/pixabay"
import {
  setPixabayProjectDir,
  isPixabayPaused,
  getPixabayPauseRemainingSecs
} from "./providers/pixabay-rate-limiter"
import { sanitizeStockQuery, dedupeStockQueries } from "./query-sanitizer"
import { QueryCache } from "./query-cache"
import { downloadAsset, loadAssetsManifest, saveAssetsManifest } from "./downloader"
import { analyzeGlobalContext, loadGlobalContext } from "./global-context-analyzer"
import { generateContextAwareSearchPlan } from "./context-query-gen"
import { rankContextCandidates } from "./context-ranker"
import { loadProductionSettings } from "../production-intelligence/production-settings"
import {
  rankCandidatesForScene,
  loadStockCandidates,
  saveStockCandidates
} from "../production-intelligence/candidate-ranking"
import { HistoricalAssignmentSummary } from "../production-intelligence/diversity-engine"
import { atomicWriteJson, readJsonSafe } from "../production-intelligence/json-store"
import { flattenEditPlanScenes } from "../utils/scene-plan"
import { logger } from "../logger"

export type ProgressCallback = (msg: string, pct: number) => void

// ------ Internal types -------------------------------------------------------

interface ScenePlanWithIntent {
  sceneIndex: number
  sceneId?: string
  narrativeText?: string
  visualIntent?: string
  searchQueries?: string[]
  startTime: number
  endTime: number
  duration: number
  localPath?: string
  locked?: boolean
  manualOverride?: boolean
  mediaFile?: string
  mediaType?: "video" | "image"
  chapterId?: string
  chapterTitle?: string
  chapterPurpose?: string
  continuityGroup?: string
}

interface EditPlan {
  chapters: Array<{
    chapterIndex?: number
    title?: string
    purpose?: string
    sequences?: Array<{ scenes?: ScenePlanWithIntent[] }>
    chapters_seq?: Array<{ scenes?: ScenePlanWithIntent[] }>
  }>
  [key: string]: unknown
}

function toOrientation(ar: string | undefined): "landscape" | "portrait" | "square" {
  if (ar === "9:16") return "portrait"
  if (ar === "1:1") return "square"
  return "landscape"
}

export const MIN_ACCEPTABLE_CANDIDATE_SCORE = 55
export const TARGET_CANDIDATES_PER_SCENE = 3
export const MAX_PIXABAY_QUERIES_PER_SCENE = 2

// ------ Tiered search (A->B->C->D) with Provider Waterfall -----------------

async function searchWithTieredPlan(
  plan: StockSearchPlan,
  pexelsApiKey: string,
  pixabayApiKey: string | undefined,
  orientation: "landscape" | "portrait" | "square",
  cache: QueryCache,
  onProgressMsg?: (msg: string) => void,
  scoreEvaluator?: (candidates: StockSearchResult[]) => number
): Promise<{ candidates: StockSearchResult[]; tierUsed: "A" | "B" | "C" | "D" }> {
  const allCandidates: StockSearchResult[] = []
  const seenIds = new Set<string>()

  const addCandidates = (results: StockSearchResult[]): void => {
    for (const r of results) {
      if (!seenIds.has(r.assetId)) {
        seenIds.add(r.assetId)
        allCandidates.push(r)
      }
    }
  }

  // 1. Sanitize all queries
  const fallback = sanitizeStockQuery(plan.visualIntent || "documentary footage")
  const sanitizedPlan: StockSearchPlan = {
    ...plan,
    exactQueries: dedupeStockQueries((plan.exactQueries || []).map((q) => sanitizeStockQuery(q, fallback))),
    subjectQueries: dedupeStockQueries((plan.subjectQueries || []).map((q) => sanitizeStockQuery(q, fallback))),
    contextualQueries: dedupeStockQueries((plan.contextualQueries || []).map((q) => sanitizeStockQuery(q, fallback))),
    fallbackQueries: dedupeStockQueries((plan.fallbackQueries || []).map((q) => sanitizeStockQuery(q, fallback)))
  }

  const searchPexelsList = async (queries: string[]): Promise<void> => {
    if (!pexelsApiKey) return
    for (const query of queries) {
      const cached = cache.get(`pexels_v:${query}`)
      if (cached) {
        addCandidates(cached)
      } else {
        const res = await pexelsSearchVideos(query, pexelsApiKey, 8, orientation)
        cache.set(`pexels_v:${query}`, res)
        addCandidates(res)
      }
      if (allCandidates.length >= 10) break
    }
  }

  const pexelsPhotoFallback = async (queries: string[]): Promise<void> => {
    if (!pexelsApiKey) return
    for (const query of queries.slice(0, 2)) {
      const cached = cache.get(`pexels_p:${query}`)
      if (cached) {
        addCandidates(cached)
      } else {
        const res = await pexelsSearchPhotos(query, pexelsApiKey, 6, orientation)
        cache.set(`pexels_p:${query}`, res)
        addCandidates(res)
      }
    }
  }

  // 2. Search Pexels across tiers first
  let pexelsTier: "A" | "B" | "C" | "D" = "D"

  // Tier A -- exact
  await searchPexelsList(sanitizedPlan.exactQueries)
  if (allCandidates.length > 0) pexelsTier = "A"

  // Tier B -- subject
  if (allCandidates.length < TARGET_CANDIDATES_PER_SCENE) {
    await searchPexelsList(sanitizedPlan.subjectQueries)
    if (pexelsTier === "D" && allCandidates.length > 0) pexelsTier = "B"
  }

  // Tier C -- contextual
  if (allCandidates.length < TARGET_CANDIDATES_PER_SCENE) {
    await searchPexelsList(sanitizedPlan.contextualQueries)
    if (pexelsTier === "D" && allCandidates.length > 0) pexelsTier = "C"
  }

  // Photo fallback if still few candidates
  if (allCandidates.length < 2) {
    await pexelsPhotoFallback([...sanitizedPlan.exactQueries, ...sanitizedPlan.subjectQueries])
  }

  // Check if Pexels returned enough candidates of acceptable quality
  const bestScore = scoreEvaluator ? scoreEvaluator(allCandidates) : 60
  const hasEnoughCandidates =
    allCandidates.length >= TARGET_CANDIDATES_PER_SCENE && bestScore >= MIN_ACCEPTABLE_CANDIDATE_SCORE

  if (hasEnoughCandidates) {
    onProgressMsg?.("Pexels returned enough candidates. Pixabay skipped to preserve API quota.")
    logger.info(`[StockEngine] Pexels returned enough candidates (${allCandidates.length}, best score ${bestScore}). Pixabay skipped to preserve API quota.`)
    return { candidates: allCandidates, tierUsed: pexelsTier }
  }

  // 3. Fallback to Pixabay if needed
  if (pixabayApiKey) {
    if (isPixabayPaused()) {
      const waitSec = getPixabayPauseRemainingSecs()
      if (waitSec > 0) {
        onProgressMsg?.(`Pixabay rate limit reached. Waiting ${waitSec} seconds while Pexels continues...`)
        logger.info(`[Pixabay] Rate limit paused (${waitSec}s remaining). Skipping Pixabay for this scene.`)
      } else {
        onProgressMsg?.("Pixabay temporarily unavailable. Continuing with Pexels and cached assets.")
        logger.info("[Pixabay] Provider temporarily unavailable. Continuing with Pexels and cached assets.")
      }
    } else {
      // Limit to at most MAX_PIXABAY_QUERIES_PER_SCENE
      const pixabayQueries = dedupeStockQueries([
        ...sanitizedPlan.exactQueries,
        ...sanitizedPlan.subjectQueries,
        ...sanitizedPlan.contextualQueries,
        ...sanitizedPlan.fallbackQueries
      ]).slice(0, MAX_PIXABAY_QUERIES_PER_SCENE)

      const pxOrientation = orientation === "portrait" ? "vertical" : "horizontal"

      for (const query of pixabayQueries) {
        if (isPixabayPaused()) break
        const cached = cache.get(`pixabay_v:${query}`)
        if (cached) {
          addCandidates(cached)
        } else {
          try {
            const res = await pixabaySearchVideos(query, pixabayApiKey, 8, pxOrientation)
            cache.set(`pixabay_v:${query}`, res)
            addCandidates(res)
          } catch (pxErr) {
            logger.warn(`[Pixabay] Video search failed for query "${query}": ${pxErr}`)
          }
        }
        if (allCandidates.length >= 10) break
      }

      if (allCandidates.length < 2 && pixabayQueries.length > 0 && !isPixabayPaused()) {
        const topQuery = pixabayQueries[0]
        const cached = cache.get(`pixabay_p:${topQuery}`)
        if (cached) {
          addCandidates(cached)
        } else {
          try {
            const res = await pixabaySearchPhotos(topQuery, pixabayApiKey, 6, pxOrientation)
            cache.set(`pixabay_p:${topQuery}`, res)
            addCandidates(res)
          } catch (pxErr) {
            logger.warn(`[Pixabay] Photo search failed for query "${topQuery}": ${pxErr}`)
          }
        }
      }
    }
  }

  // If still empty, try fallbackQueries on Pexels
  if (allCandidates.length === 0 && pexelsApiKey) {
    await searchPexelsList(sanitizedPlan.fallbackQueries)
    await pexelsPhotoFallback(sanitizedPlan.fallbackQueries)
  }

  return { candidates: allCandidates, tierUsed: pexelsTier }
}

// ------ Main engine ----------------------------------------------------------

export async function runContextAwareStockEngine(
  params: StockRunParams & { apiKey?: string; model?: string; forceReanalysis?: boolean },
  onProgress: ProgressCallback = () => {}
): Promise<StockRunResult> {
  const {
    projectDir,
    pexelsApiKey,
    pixabayApiKey,
    preferredAspectRatio = "16:9",
    apiKey,
    model,
    forceReanalysis = false
  } = params

  // Set project dir for persistent Pixabay cache
  setPixabayProjectDir(projectDir)

  // Load edit plan
  const planPath = join(projectDir, "analysis", "master-edit-plan.json")
  if (!fs.existsSync(planPath)) {
    return {
      success: false,
      totalScenes: 0,
      assignedScenes: 0,
      failedScenes: 0,
      assignments: [],
      error: "No edit plan found. Run AI Planning first."
    }
  }
  const plan: EditPlan = JSON.parse(fs.readFileSync(planPath, "utf-8"))

  const stockDir = join(projectDir, "assets", "stock")
  fs.mkdirSync(stockDir, { recursive: true })

  const prodSettings = loadProductionSettings(projectDir)
  const stockCandidatesStore = loadStockCandidates(projectDir)

  const cache = new QueryCache(stockDir)
  let manifest = loadAssetsManifest(stockDir)
  const usedAssetIds = new Set<string>(manifest.map((a) => a.assetId))

  const reviewPath = join(projectDir, "analysis", "stock-assignments.json")
  const existingAssignments = fs.existsSync(reviewPath)
    ? readJsonSafe<StockSceneAssignment[]>(reviewPath, [])
    : []
  const existingMap = new Map<number, StockSceneAssignment>()
  for (const a of existingAssignments) {
    existingMap.set(a.sceneIndex, a)
  }

  const flattenedEntries = flattenEditPlanScenes<ScenePlanWithIntent>(plan)

  // Identify locked/approved scenes that must NOT be overwritten
  const scenesToProcess = flattenedEntries.filter(({ scene }) => {
    const existing = existingMap.get(scene.sceneIndex)
    if (scene.locked || existing?.locked) return false
    if (existing?.manualOverride) return false
    if (existing?.approvalStatus === "approved") return false
    return true
  })

  onProgress(`Starting context-aware stock search for ${scenesToProcess.length} scenes...`, 0.01)

  // -- Phase 1: Load or generate GlobalScriptContext --
  let globalContext: GlobalScriptContext | null = null
  if (apiKey) {
    try {
      onProgress("Phase 1: Analyzing full script for global context...", 0.02)

      let scriptText: string | null = null
      let transcript: TranscriptResult | null = null

      const transcriptPath = join(projectDir, "analysis", "transcript.json")
      if (fs.existsSync(transcriptPath)) {
        transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8")) as TranscriptResult
      }
      try {
        const stateFile = fs.existsSync(join(projectDir, "project-state.json"))
          ? join(projectDir, "project-state.json")
          : join(projectDir, "project.json")
        const st = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
        const scriptPath = st?.inputs?.scriptPath as string | undefined
        if (scriptPath && fs.existsSync(scriptPath)) {
          scriptText = fs.readFileSync(scriptPath, "utf-8")
        }
      } catch {
        /* ignore */
      }

      globalContext = await analyzeGlobalContext({
        projectDir,
        apiKey,
        model,
        scriptText,
        transcript,
        forceRegenerate: forceReanalysis,
        onProgress: (msg, pct) => onProgress(`[GlobalContext] ${msg}`, pct * 0.08)
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`[StockEngine] GlobalContext analysis failed (${msg}), falling back to basic mode`)
      globalContext = loadGlobalContext(projectDir)
    }
  } else {
    globalContext = loadGlobalContext(projectDir)
  }

  const hasGlobalContext = globalContext !== null
  if (!hasGlobalContext) {
    logger.warn("[StockEngine] No GlobalContext available. Running in basic query mode.")
    onProgress("Warning: No global context. Running in basic query mode.", 0.05)
  }

  const orientation = toOrientation(preferredAspectRatio)
  const assignments: StockSceneAssignment[] = []
  let assignedCount = 0
  let failedCount = 0

  // Preserve locked/approved assignments first
  for (const entry of flattenedEntries) {
    const existing = existingMap.get(entry.sceneIndex)
    const isLocked = entry.scene.locked || existing?.locked || existing?.manualOverride || existing?.approvalStatus === "approved"
    if (isLocked && existing) {
      assignments.push(existing)
      if (existing.status === "assigned") assignedCount++
    }
  }

  // Process remaining scenes
  for (let i = 0; i < scenesToProcess.length; i++) {
    const entry = scenesToProcess[i]
    const { scene, sceneId, chapterTitle, chapterPurpose } = entry
    const pct = 0.1 + (i / scenesToProcess.length) * 0.85
    const narration = scene.narrativeText ?? ""
    const sceneDuration = scene.duration ?? (scene.endTime - scene.startTime)

    onProgress(`[${i + 1}/${scenesToProcess.length}] Scene ${scene.sceneIndex} - candidate search...`, pct)

    const prevEntry = i > 0 ? scenesToProcess[i - 1] : null
    const nextEntry = i < scenesToProcess.length - 1 ? scenesToProcess[i + 1] : null
    const previousSceneSummary = prevEntry ? (prevEntry.scene.narrativeText ?? "").slice(0, 100) : ""
    const nextSceneSummary = nextEntry ? (nextEntry.scene.narrativeText ?? "").slice(0, 100) : ""

    let searchPlan: StockSearchPlan | null = null
    let tierUsed: "A" | "B" | "C" | "D" = "D"

    if (hasGlobalContext && apiKey) {
      const packet: SceneContextPacket = {
        globalContext: {
          primarySubject: globalContext!.primarySubject,
          centralThesis: globalContext!.centralThesis,
          geography: [
            globalContext!.geography.primaryCountry,
            globalContext!.geography.primaryRegion,
            ...globalContext!.geography.secondaryLocations
          ].filter(Boolean) as string[],
          timePeriod: [globalContext!.timeContext.primaryPeriod, ...globalContext!.timeContext.historicalPeriods],
          exactTopicAnchors: globalContext!.exactTopicAnchors,
          contextualAnchors: globalContext!.contextualAnchors,
          forbiddenSubstitutions: globalContext!.forbiddenSubstitutions,
          negativeKeywords: globalContext!.negativeKeywords
        },
        chapterContext: { chapterId: `CH${entry.chapterIndex}`, chapterTitle, chapterPurpose },
        localContext: {
          narration,
          scenePurpose: scene.visualIntent ?? "",
          visibleSubject: scene.visualIntent ?? globalContext!.primarySubject,
          visibleAction: scene.visualIntent ?? "community activity",
          preferredLocation: globalContext!.geography.primaryRegion ?? globalContext!.geography.primaryCountry ?? "",
          preferredTimePeriod: globalContext!.timeContext.primaryPeriod
        },
        neighboringContext: { previousScene: previousSceneSummary, nextScene: nextSceneSummary }
      }

      try {
        searchPlan = await generateContextAwareSearchPlan({
          projectDir,
          apiKey,
          model,
          packet,
          globalContext: globalContext!,
          sceneId,
          useCache: true
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(`[StockEngine] QueryGen failed for scene ${scene.sceneIndex}: ${msg}`)
      }
    }

    const legacyQueries = scene.searchQueries?.length
      ? scene.searchQueries
      : [scene.visualIntent ?? narration ?? "documentary b-roll"].slice(0, 3)

    const planToUse: StockSearchPlan = searchPlan ?? {
      visualIntent: scene.visualIntent ?? "",
      exactQueries: legacyQueries.slice(0, 2),
      subjectQueries: legacyQueries.slice(0, 2),
      contextualQueries: legacyQueries,
      fallbackQueries: legacyQueries,
      requiredTerms: [],
      preferredTerms: [],
      negativeTerms: [],
      targetMediaType: "video",
      desiredShotTypes: ["wide shot"],
      desiredOrientation: "landscape"
    }

    const assignment: StockSceneAssignment = {
      sceneId,
      sceneIndex: scene.sceneIndex,
      narrationText: narration,
      startTime: scene.startTime,
      endTime: scene.endTime,
      visualIntent: planToUse.visualIntent || (scene.visualIntent ?? ""),
      searchQueries: [...planToUse.exactQueries, ...planToUse.subjectQueries, ...planToUse.contextualQueries],
      usedQuery: planToUse.exactQueries[0] ?? legacyQueries[0] ?? "",
      asset: null,
      score: 0,
      locked: false,
      manualOverride: false,
      status: "searching",
      chapterId: `CH${entry.chapterIndex}`,
      chapterTitle,
      scenePurpose: scene.visualIntent ?? "",
      searchPlan: planToUse
    }

    try {
      const scoreEvaluator = (candidatesToScore: StockSearchResult[]): number => {
        if (!candidatesToScore.length) return 0
        if (hasGlobalContext && globalContext) {
          const evalCtx = {
            globalContext: globalContext!,
            chapterTitle,
            chapterPurpose,
            narration,
            visualIntent: planToUse.visualIntent,
            scenePurpose: scene.visualIntent ?? "",
            sceneDurationSecs: sceneDuration,
            preferredAspectRatio,
            usedAssetIds
          }
          const ranked = rankContextCandidates(candidatesToScore, evalCtx)
          return ranked[0]?.contextScore.totalScore ?? 0
        }
        return 60
      }

      const { candidates, tierUsed: tu } = await searchWithTieredPlan(
        planToUse,
        pexelsApiKey,
        pixabayApiKey,
        orientation,
        cache,
        (msg) => onProgress(`[Scene ${scene.sceneIndex}] ${msg}`, pct),
        scoreEvaluator
      )
      tierUsed = tu

      if (candidates.length === 0) {
        assignment.status = "failed"
        assignment.errorMessage = "No candidates found from any provider or tier"
        failedCount++
      } else {
        const assignmentHistory: HistoricalAssignmentSummary[] = assignments.map((a) => ({
          sceneIndex: a.sceneIndex,
          provider: a.asset?.provider,
          assetId: a.asset?.assetId,
          creator: a.asset?.creator,
          title: a.asset?.searchQuery,
          downloadUrl: a.asset?.downloadUrl,
          thumbnailUrl: a.asset?.thumbnailUrl,
          isLocked: a.locked
        }))

        if (prodSettings.enabled && prodSettings.candidateRankingEnabled) {
          // Candidate Stock Ranking
          const scoringCtx = {
            narration,
            visualIntent: planToUse.visualIntent,
            searchPlan: planToUse,
            globalContext,
            chapterTitle,
            chapterPurpose,
            sceneDurationSecs: sceneDuration,
            preferredAspectRatio,
            assignmentHistory,
            isLocked: scene.locked
          }

          const topCandidates = rankCandidatesForScene(
            sceneId,
            scene.sceneIndex,
            candidates,
            scoringCtx,
            prodSettings.candidatesPerScene || 3
          )

          stockCandidatesStore[sceneId] = topCandidates

          const winner = topCandidates.find((c) => c.selected) || topCandidates[0]
          const usedQuery = planToUse.exactQueries[0] ?? legacyQueries[0]
          const downloadedAsset = await downloadAsset(
            winner.result,
            scene.sceneIndex,
            usedQuery,
            stockDir,
            manifest
          )

          manifest = manifest.filter((a) => a.assetId !== downloadedAsset.assetId)
          manifest.push(downloadedAsset)
          usedAssetIds.add(downloadedAsset.assetId)

          scene.localPath = downloadedAsset.localPath
          scene.mediaFile = basename(downloadedAsset.localPath)
          scene.mediaType = downloadedAsset.mediaType === "photo" ? "image" : "video"

          assignment.asset = downloadedAsset
          assignment.score = winner.score.totalScore
          assignment.usedQuery = usedQuery
          assignment.status = "assigned"
          assignment.tierUsed = tierUsed
          assignment.matchLabel =
            winner.score.totalScore >= 80 ? "STRONG_MATCH" : winner.score.totalScore >= 60 ? "ACCEPTABLE" : "ILLUSTRATIVE"
          assignment.visualTruthLabel = winner.score.globalContextFit >= 15 ? "EXACT_SUBJECT" : "CONTEXTUAL_MATCH"
          assignment.scoreBreakdown = winner.score as unknown as StockSceneAssignment["scoreBreakdown"]
          assignment.candidates = topCandidates
          assignment.selectedCandidateId = winner.candidateId
          assignment.approvalStatus = "auto_selected"
          assignment.rejectedCandidates = topCandidates.slice(1).map((c) => ({
            title: c.result.title,
            score: c.score.totalScore,
            reason: c.score.rejectionReasons[0] || c.score.reasons[0] || "Lower rank"
          }))
          assignedCount++
        } else {
          // Legacy ranking fallback
          let ranked: Array<typeof candidates[0] & { contextScore?: { totalScore: number; matchLabel: string; visualTruthLabel: string; penaltyReasons: string[] } }>
          if (hasGlobalContext) {
            const ctx = {
              globalContext: globalContext!,
              chapterTitle,
              chapterPurpose,
              narration,
              visualIntent: planToUse.visualIntent,
              scenePurpose: scene.visualIntent ?? "",
              sceneDurationSecs: sceneDuration,
              preferredAspectRatio,
              usedAssetIds
            }
            ranked = rankContextCandidates(candidates, ctx)
            if (ranked.length === 0) {
              ranked = candidates.map((c) => ({ ...c, contextScore: undefined })) as typeof ranked
            }
          } else {
            ranked = candidates as typeof ranked
          }

          const winner = ranked[0]
          const usedQuery = planToUse.exactQueries[0] ?? legacyQueries[0]
          const downloadedAsset = await downloadAsset(winner, scene.sceneIndex, usedQuery, stockDir, manifest)

          manifest = manifest.filter((a) => a.assetId !== downloadedAsset.assetId)
          manifest.push(downloadedAsset)
          usedAssetIds.add(downloadedAsset.assetId)

          scene.localPath = downloadedAsset.localPath
          scene.mediaFile = basename(downloadedAsset.localPath)
          scene.mediaType = downloadedAsset.mediaType === "photo" ? "image" : "video"

          const contextScore = (winner as { contextScore?: { totalScore: number; matchLabel: string; visualTruthLabel: string; penaltyReasons: string[] } }).contextScore

          assignment.asset = downloadedAsset
          assignment.score = contextScore?.totalScore ?? 75
          assignment.usedQuery = usedQuery
          assignment.status = "assigned"
          assignment.tierUsed = tierUsed
          assignment.matchLabel = contextScore?.matchLabel
          assignment.visualTruthLabel = contextScore?.visualTruthLabel
          assignment.scoreBreakdown = contextScore as StockSceneAssignment["scoreBreakdown"]
          assignment.rejectedCandidates = ranked.slice(1, 4).map((c) => ({
            title: c.title,
            score: (c as { contextScore?: { totalScore: number } }).contextScore?.totalScore ?? 0,
            reason: (c as { contextScore?: { penaltyReasons: string[] } }).contextScore?.penaltyReasons?.[0] ?? "lower score"
          }))
          assignedCount++
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[StockEngine] Scene ${scene.sceneIndex} failed: ${msg}`)
      assignment.status = "failed"
      assignment.errorMessage = msg
      failedCount++
    }

    assignments.push(assignment)
    cache.save()
    saveAssetsManifest(stockDir, manifest)
  }

  // Sort assignments by sceneIndex
  assignments.sort((a, b) => a.sceneIndex - b.sceneIndex)

  // Atomic saves
  atomicWriteJson(planPath, plan)
  atomicWriteJson(reviewPath, assignments)
  if (prodSettings.enabled && prodSettings.candidateRankingEnabled) {
    saveStockCandidates(projectDir, stockCandidatesStore)
  }

  onProgress(`Done -- ${assignedCount}/${flattenedEntries.length} scenes assigned, ${failedCount} failed`, 1.0)

  return {
    success: true,
    totalScenes: flattenedEntries.length,
    assignedScenes: assignedCount,
    failedScenes: failedCount,
    assignments
  }
}

