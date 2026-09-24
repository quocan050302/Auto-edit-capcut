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
import { QueryCache } from "./query-cache"
import { downloadAsset, loadAssetsManifest, saveAssetsManifest } from "./downloader"
import { analyzeGlobalContext, loadGlobalContext } from "./global-context-analyzer"
import { generateContextAwareSearchPlan } from "./context-query-gen"
import { rankContextCandidates } from "./context-ranker"
import { logger } from "../logger"

export type ProgressCallback = (msg: string, pct: number) => void

// ------ Internal types -------------------------------------------------------

interface ScenePlanWithIntent {
  sceneIndex: number
  narrativeText?: string
  visualIntent?: string
  searchQueries?: string[]
  startTime: number
  endTime: number
  duration: number
  localPath?: string
  locked?: boolean
  mediaFile?: string
  mediaType?: "video" | "image"
  // Context-aware additions
  chapterId?: string
  chapterTitle?: string
  chapterPurpose?: string
  continuityGroup?: string
}

interface ChapterWithIndex {
  chapterIndex: number
  title: string
  purpose?: string
  sequences: Array<{ scenes: ScenePlanWithIntent[] }>
}

interface EditPlan {
  chapters: ChapterWithIndex[]
  [key: string]: unknown
}

function flattenScenesWithChapter(
  plan: EditPlan
): Array<{ scene: ScenePlanWithIntent; chapterId: string; chapterTitle: string; chapterPurpose: string }> {
  const result: Array<{ scene: ScenePlanWithIntent; chapterId: string; chapterTitle: string; chapterPurpose: string }> = []
  for (const ch of plan.chapters ?? []) {
    const seqs = (ch as { sequences?: unknown[]; chapters_seq?: unknown[] }).sequences ?? (ch as { chapters_seq?: unknown[] }).chapters_seq ?? []
    for (const seq of seqs as Array<{ scenes?: ScenePlanWithIntent[] }>) {
      for (const scene of seq.scenes ?? []) {
        result.push({
          scene,
          chapterId: `CH${ch.chapterIndex}`,
          chapterTitle: ch.title,
          chapterPurpose: ch.purpose ?? ""
        })
      }
    }
  }
  return result
}

function toOrientation(ar: string | undefined): "landscape" | "portrait" | "square" {
  if (ar === "9:16") return "portrait"
  if (ar === "1:1") return "square"
  return "landscape"
}

// ------ Tiered search (A->B->C->D) ------------------------------------------

async function searchWithTieredPlan(
  plan: StockSearchPlan,
  pexelsApiKey: string,
  pixabayApiKey: string | undefined,
  orientation: "landscape" | "portrait" | "square",
  cache: QueryCache
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

  const searchTier = async (queries: string[], minNeeded: number): Promise<boolean> => {
    for (const query of queries) {
      // Pexels Video
      let cached = cache.get(`pexels_v:${query}`)
      if (cached) { addCandidates(cached) }
      else {
        const res = await pexelsSearchVideos(query, pexelsApiKey, 10, orientation)
        cache.set(`pexels_v:${query}`, res)
        addCandidates(res)
      }
      if (allCandidates.length >= 10) return true
    }
    if (allCandidates.length >= minNeeded) return true

    // Pixabay Video fallback
    if (pixabayApiKey) {
      for (const query of queries.slice(0, 2)) {
        const cached = cache.get(`pixabay_v:${query}`)
        if (cached) { addCandidates(cached) }
        else {
          const pxOrientation = orientation === "portrait" ? "vertical" : "horizontal"
          const res = await pixabaySearchVideos(query, pixabayApiKey, 8, pxOrientation)
          cache.set(`pixabay_v:${query}`, res)
          addCandidates(res)
        }
        if (allCandidates.length >= minNeeded) return true
      }
    }
    return allCandidates.length >= minNeeded
  }

  const photoFallback = async (queries: string[]): Promise<void> => {
    for (const query of queries.slice(0, 2)) {
      const cached = cache.get(`pexels_p:${query}`)
      if (cached) { addCandidates(cached) }
      else {
        const res = await pexelsSearchPhotos(query, pexelsApiKey, 6, orientation)
        cache.set(`pexels_p:${query}`, res)
        addCandidates(res)
      }
    }
  }

  // Tier A -- exact
  const tierAok = await searchTier(plan.exactQueries, 3)
  if (tierAok && allCandidates.length >= 3) {
    if (allCandidates.length < 2) await photoFallback(plan.exactQueries)
    return { candidates: allCandidates, tierUsed: "A" }
  }

  // Tier B -- subject
  const tierBok = await searchTier(plan.subjectQueries, 3)
  if (tierBok && allCandidates.length >= 3) {
    if (allCandidates.length < 2) await photoFallback(plan.subjectQueries)
    return { candidates: allCandidates, tierUsed: "B" }
  }

  // Tier C -- contextual
  await searchTier(plan.contextualQueries, 2)
  if (allCandidates.length >= 2) {
    if (allCandidates.length < 2) await photoFallback(plan.contextualQueries)
    return { candidates: allCandidates, tierUsed: "C" }
  }

  // Tier D -- illustrative fallback
  await searchTier(plan.fallbackQueries, 1)
  await photoFallback(plan.fallbackQueries)
  return { candidates: allCandidates, tierUsed: "D" }
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

  // Load edit plan
  const planPath = join(projectDir, "analysis", "master-edit-plan.json")
  if (!fs.existsSync(planPath)) {
    return { success: false, totalScenes: 0, assignedScenes: 0, failedScenes: 0, assignments: [], error: "No edit plan found. Run AI Planning first." }
  }
  const plan: EditPlan = JSON.parse(fs.readFileSync(planPath, "utf-8"))

  const stockDir = join(projectDir, "assets", "stock")
  fs.mkdirSync(stockDir, { recursive: true })

  const cache = new QueryCache(stockDir)
  let manifest = loadAssetsManifest(stockDir)
  const usedAssetIds = new Set<string>(manifest.map((a) => a.assetId))

  const flatScenes = flattenScenesWithChapter(plan)
  const scenesNeedingStock = flatScenes.filter(
    ({ scene }) => !scene.locked && (!scene.localPath || !fs.existsSync(scene.localPath))
  )

  onProgress(`Starting context-aware stock search for ${scenesNeedingStock.length} scenes...`, 0.01)

  // -- Phase 1: Load or generate GlobalScriptContext --
  let globalContext: GlobalScriptContext | null = null
  if (apiKey) {
    try {
      onProgress("Phase 1: Analyzing full script for global context...", 0.02)

      // Load transcript + script text
      let scriptText: string | null = null
      let transcript: TranscriptResult | null = null

      const transcriptPath = join(projectDir, "analysis", "transcript.json")
      if (fs.existsSync(transcriptPath)) {
        transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8")) as TranscriptResult
      }
      try {
        const stateFile = fs.existsSync(join(projectDir, "project-state.json"))
          ? join(projectDir, "project-state.json") : join(projectDir, "project.json")
        const st = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
        const scriptPath = st?.inputs?.scriptPath as string | undefined
        if (scriptPath && fs.existsSync(scriptPath)) {
          scriptText = fs.readFileSync(scriptPath, "utf-8")
        }
      } catch { /* ignore */ }

      globalContext = await analyzeGlobalContext({
        projectDir, apiKey, model, scriptText, transcript,
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
    logger.warn("[StockEngine] No GlobalContext available. Running in legacy mode.")
    onProgress("Warning: No global context. Running in basic query mode.", 0.05)
  }

  const orientation = toOrientation(preferredAspectRatio)
  const assignments: StockSceneAssignment[] = []
  let assignedCount = 0
  let failedCount = 0

  // -- Phase 2-7: Per-scene context-aware search --
  for (let i = 0; i < scenesNeedingStock.length; i++) {
    const { scene, chapterId, chapterTitle, chapterPurpose } = scenesNeedingStock[i]
    const pct = 0.10 + (i / scenesNeedingStock.length) * 0.85
    const sceneId = `scene_${scene.sceneIndex}`
    const narration = scene.narrativeText ?? ""
    const sceneDuration = scene.duration ?? (scene.endTime - scene.startTime)

    onProgress(`[${i + 1}/${scenesNeedingStock.length}] Scene ${scene.sceneIndex} — context-aware search...`, pct)

    // Neighboring context
    const prevEntry = i > 0 ? scenesNeedingStock[i - 1] : null
    const nextEntry = i < scenesNeedingStock.length - 1 ? scenesNeedingStock[i + 1] : null
    const previousSceneSummary = prevEntry ? (prevEntry.scene.narrativeText ?? "").slice(0, 100) : ""
    const nextSceneSummary = nextEntry ? (nextEntry.scene.narrativeText ?? "").slice(0, 100) : ""

    let searchPlan: StockSearchPlan | null = null
    let tierUsed: "A" | "B" | "C" | "D" = "D"

    if (hasGlobalContext && apiKey) {
      // Build SceneContextPacket (Phase 3)
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
        chapterContext: { chapterId, chapterTitle, chapterPurpose },
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

      // Phase 4: Generate tiered search plan
      try {
        searchPlan = await generateContextAwareSearchPlan({
          projectDir, apiKey, model, packet, globalContext: globalContext!, sceneId, useCache: true
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(`[StockEngine] QueryGen failed for scene ${scene.sceneIndex}: ${msg}`)
      }
    }

    // Fallback to legacy queries if no context plan
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
      chapterId,
      chapterTitle,
      scenePurpose: scene.visualIntent ?? "",
      searchPlan: planToUse
    }

    try {
      // Phase 6: Tiered search
      const { candidates, tierUsed: tu } = await searchWithTieredPlan(
        planToUse, pexelsApiKey, pixabayApiKey, orientation, cache
      )
      tierUsed = tu

      if (candidates.length === 0) {
        assignment.status = "failed"
        assignment.errorMessage = "No candidates found from any provider or tier"
        failedCount++
      } else {
        // Phase 7: Context-aware ranking
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
          // If all rejected, use raw candidates sorted by basic score
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

  // Save updated plan
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8")

  // Save assignments
  const reviewPath = join(projectDir, "analysis", "stock-assignments.json")
  fs.writeFileSync(reviewPath, JSON.stringify(assignments, null, 2), "utf-8")

  onProgress(`Done -- ${assignedCount}/${scenesNeedingStock.length} scenes assigned, ${failedCount} failed`, 1.0)

  return {
    success: true,
    totalScenes: scenesNeedingStock.length,
    assignedScenes: assignedCount,
    failedScenes: failedCount,
    assignments
  }
}
