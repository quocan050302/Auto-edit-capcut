/**
 * Stock Media Engine — main pipeline orchestrator.
 *
 * For each scene that lacks a localPath, runs:
 *   Pexels Video → Pixabay Video → Pexels Photo → Pixabay Photo
 * Ranks candidates, downloads the winner, stamps the edit plan.
 */

import { join, basename } from 'path'
import * as fs from 'fs'
import type {
  StockRunParams,
  StockRunResult,
  StockSceneAssignment,
  StockSearchResult,
  StockAsset
} from '../../../shared/types'
import { pexelsSearchVideos, pexelsSearchPhotos } from './providers/pexels'
import { pixabaySearchVideos, pixabaySearchPhotos } from './providers/pixabay'
import {
  setPixabayProjectDir,
  isPixabayPaused,
  getPixabayPauseRemainingSecs
} from './providers/pixabay-rate-limiter'
import { sanitizeStockQuery, dedupeStockQueries } from './query-sanitizer'
import { QueryCache } from './query-cache'
import { rankCandidates } from './ranker'
import { downloadAsset, loadAssetsManifest, saveAssetsManifest } from './downloader'
import { loadProductionSettings } from '../production-intelligence/production-settings'
import {
  rankCandidatesForScene,
  loadStockCandidates,
  saveStockCandidates
} from '../production-intelligence/candidate-ranking'
import { HistoricalAssignmentSummary } from '../production-intelligence/diversity-engine'
import { atomicWriteJson, readJsonSafe } from '../production-intelligence/json-store'
import { flattenEditPlanScenes } from '../utils/scene-plan'
import { logger } from '../logger'

export type ProgressCallback = (msg: string, pct: number) => void

// ─── Internal helpers ─────────────────────────────────────────────────────────

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
  mediaType?: 'video' | 'image'
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

/** Perform provider search for a single scene's queries across Pexels and Pixabay with waterfall */
async function searchForScene(
  queries: string[],
  pexelsApiKey: string,
  pixabayApiKey: string | undefined,
  preferredOrientation: 'landscape' | 'portrait' | 'square',
  cache: QueryCache
): Promise<StockSearchResult[]> {
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

  // Sanitize all queries
  const cleanQueries = dedupeStockQueries(queries.map((q) => sanitizeStockQuery(q)))

  // 1. Search Pexels videos first
  if (pexelsApiKey) {
    for (const query of cleanQueries) {
      const cached = cache.get(`pexels_v:${query}`)
      if (cached) {
        addCandidates(cached)
      } else {
        const res = await pexelsSearchVideos(query, pexelsApiKey, 8, preferredOrientation)
        cache.set(`pexels_v:${query}`, res)
        addCandidates(res)
      }
      if (allCandidates.length >= 10) break
    }
  }

  // 2. If Pexels has enough candidates, skip Pixabay to preserve quota
  if (allCandidates.length >= 3) {
    logger.info(`[StockEngine] Pexels returned enough candidates (${allCandidates.length}). Pixabay skipped to preserve API quota.`)
    return allCandidates
  }

  // 3. Fallback to Pixabay if needed
  if (pixabayApiKey) {
    if (isPixabayPaused()) {
      const waitSec = getPixabayPauseRemainingSecs()
      logger.info(`[Pixabay] Rate limit paused (${waitSec}s remaining). Skipping Pixabay for this scene.`)
    } else {
      const pxOrientation = preferredOrientation === 'portrait' ? 'vertical' : 'horizontal'
      // Limit to top 2 queries for Pixabay
      const pixabayQueries = cleanQueries.slice(0, 2)
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
    }
  }

  // Photo fallback if few video candidates
  if (allCandidates.length < 3) {
    for (const query of cleanQueries.slice(0, 2)) {
      if (pexelsApiKey) {
        const cached = cache.get(`pexels_p:${query}`)
        if (cached) {
          addCandidates(cached)
        } else {
          const res = await pexelsSearchPhotos(query, pexelsApiKey, 6, preferredOrientation)
          cache.set(`pexels_p:${query}`, res)
          addCandidates(res)
        }
      }

      if (pixabayApiKey && !isPixabayPaused() && allCandidates.length < 2) {
        const cached = cache.get(`pixabay_p:${query}`)
        if (cached) {
          addCandidates(cached)
        } else {
          try {
            const orientation = preferredOrientation === 'portrait' ? 'vertical' : 'horizontal'
            const res = await pixabaySearchPhotos(query, pixabayApiKey, 6, orientation)
            cache.set(`pixabay_p:${query}`, res)
            addCandidates(res)
          } catch (pxErr) {
            logger.warn(`[Pixabay] Photo search failed for query "${query}": ${pxErr}`)
          }
        }
      }
    }
  }

  return allCandidates
}

// ─── Orientation helper ───────────────────────────────────────────────────────

function toOrientation(ar: string | undefined): 'landscape' | 'portrait' | 'square' {
  if (ar === '9:16') return 'portrait'
  if (ar === '1:1') return 'square'
  return 'landscape'
}

// ─── Main engine function ─────────────────────────────────────────────────────

export async function runStockEngine(
  params: StockRunParams,
  onProgress: ProgressCallback = () => {}
): Promise<StockRunResult> {
  const { projectDir, pexelsApiKey, pixabayApiKey, preferredAspectRatio = '16:9', targetSceneIndices } = params

  // Set project dir for persistent Pixabay cache
  setPixabayProjectDir(projectDir)

  const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
  if (!fs.existsSync(planPath)) {
    return {
      success: false,
      totalScenes: 0,
      assignedScenes: 0,
      failedScenes: 0,
      assignments: [],
      error: 'No edit plan found. Run AI Planning first.'
    }
  }

  const plan: EditPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
  const stockDir = join(projectDir, 'assets', 'stock')
  fs.mkdirSync(stockDir, { recursive: true })

  const prodSettings = loadProductionSettings(projectDir)
  const stockCandidatesStore = loadStockCandidates(projectDir)

  const cache = new QueryCache(stockDir)
  let manifest = loadAssetsManifest(stockDir)
  const usedAssetIds = new Set<string>(manifest.map((a) => a.assetId))

  const reviewPath = join(projectDir, 'analysis', 'stock-assignments.json')
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
    if (targetSceneIndices && !targetSceneIndices.includes(scene.sceneIndex)) {
      return false
    }
    const existing = existingMap.get(scene.sceneIndex)
    if (scene.locked || existing?.locked) return false
    if (existing?.manualOverride) return false
    if (existing?.approvalStatus === 'approved') return false
    if (!targetSceneIndices && existing?.asset?.provider === 'google-flow' && existing?.status === 'assigned' && existing?.asset?.localPath && fs.existsSync(existing.asset.localPath)) {
      return false
    }
    return true
  })

  if (targetSceneIndices) {
    const expectedTargetCount = targetSceneIndices.length
    const actualEligibleTargetCount = scenesToProcess.length
    const totalProjectScenes = flattenedEntries.length

    logger.info(
      `[VisualMix] Stock ownership: expected=${expectedTargetCount} actualEligible=${actualEligibleTargetCount} totalProjectScenes=${totalProjectScenes}`
    )

    if (expectedTargetCount < totalProjectScenes && actualEligibleTargetCount > expectedTargetCount) {
      throw new Error(
        `VISUAL_MIX_STOCK_SCOPE_VIOLATION: Expected at most ${expectedTargetCount} scenes but stock engine targeted ${actualEligibleTargetCount} scenes out of ${totalProjectScenes}.`
      )
    }
  }

  const assignments: StockSceneAssignment[] = []
  let assignedCount = 0
  let failedCount = 0
  const orientation = toOrientation(preferredAspectRatio)

  // Preserve locked/approved/unprocessed assignments first
  for (const entry of flattenedEntries) {
    const existing = existingMap.get(entry.sceneIndex)
    const isLocked = entry.scene.locked || existing?.locked || existing?.manualOverride || existing?.approvalStatus === 'approved'
    const isExcluded = targetSceneIndices && !targetSceneIndices.includes(entry.scene.sceneIndex)
    if ((isLocked || isExcluded) && existing) {
      assignments.push(existing)
      if (existing.status === 'assigned') assignedCount++
    }
  }

  onProgress(`Starting stock search for ${scenesToProcess.length} scenes...`, 0.01)

  for (let i = 0; i < scenesToProcess.length; i++) {
    const entry = scenesToProcess[i]
    const { scene, sceneId, chapterTitle, chapterPurpose } = entry
    const pct = 0.05 + (i / scenesToProcess.length) * 0.85
    const queries: string[] = scene.searchQueries?.length
      ? scene.searchQueries
      : [scene.visualIntent ?? scene.narrativeText ?? 'nature background'].slice(0, 4)

    const visualIntent = scene.visualIntent ?? queries[0] ?? ''
    const narrationText = scene.narrativeText ?? ''
    const sceneDuration = scene.duration ?? (scene.endTime - scene.startTime)

    onProgress(
      `[${i + 1}/${scenesToProcess.length}] Scene ${scene.sceneIndex} - "${queries[0]}"`,
      pct
    )

    const assignment: StockSceneAssignment = {
      sceneId,
      sceneIndex: scene.sceneIndex,
      narrationText,
      startTime: scene.startTime,
      endTime: scene.endTime,
      visualIntent,
      searchQueries: queries,
      usedQuery: queries[0],
      asset: null,
      score: 0,
      locked: false,
      manualOverride: false,
      status: 'searching'
    }

    try {
      const candidates = await searchForScene(
        queries, pexelsApiKey, pixabayApiKey, orientation, cache
      )

      if (candidates.length === 0) {
        assignment.status = 'failed'
        assignment.errorMessage = 'No candidates found from any provider'
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
          const scoringCtx = {
            narration: narrationText,
            visualIntent,
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
          const usedQuery = queries[0]
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
          scene.mediaType = downloadedAsset.mediaType === 'photo' ? 'image' : 'video'

          assignment.asset = downloadedAsset
          assignment.score = winner.score.totalScore
          assignment.usedQuery = usedQuery
          assignment.status = 'assigned'
          assignment.candidates = topCandidates
          assignment.selectedCandidateId = winner.candidateId
          assignment.approvalStatus = 'auto_selected'
          assignment.scoreBreakdown = winner.score as unknown as StockSceneAssignment['scoreBreakdown']
          assignedCount++
        } else {
          const ranked = rankCandidates(candidates, {
            visualIntent,
            narrationText,
            sceneDurationSecs: sceneDuration,
            preferredAspectRatio,
            usedAssetIds
          })

          const winner = ranked[0]
          const usedQuery = queries.find((q) =>
            winner.searchQuery !== undefined ? winner.searchQuery === q : true
          ) ?? queries[0]

          const downloadedAsset = await downloadAsset(
            winner,
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
          scene.mediaType = downloadedAsset.mediaType === 'photo' ? 'image' : 'video'

          assignment.asset = downloadedAsset
          assignment.score = winner.score
          assignment.usedQuery = usedQuery
          assignment.status = 'assigned'
          assignedCount++
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[StockEngine] Scene ${scene.sceneIndex} failed: ${msg}`)
      assignment.status = 'failed'
      assignment.errorMessage = msg
      failedCount++
    }

    assignments.push(assignment)
    cache.save()
    saveAssetsManifest(stockDir, manifest)
  }

  assignments.sort((a, b) => a.sceneIndex - b.sceneIndex)

  atomicWriteJson(planPath, plan)
  if (params.assignmentSink) {
    const owned = targetSceneIndices
      ? assignments.filter((a) => targetSceneIndices.includes(a.sceneIndex))
      : assignments
    await params.assignmentSink(owned)
  } else {
    atomicWriteJson(reviewPath, assignments)
  }
  if (prodSettings.enabled && prodSettings.candidateRankingEnabled) {
    saveStockCandidates(projectDir, stockCandidatesStore)
  }

  onProgress(
    `Done - ${assignedCount}/${flattenedEntries.length} scenes assigned, ${failedCount} failed`,
    1.0
  )

  return {
    success: true,
    totalScenes: flattenedEntries.length,
    assignedScenes: assignedCount,
    failedScenes: failedCount,
    assignments
  }
}

/** Re-search a single scene with a custom query */
export async function replaceSceneAsset(
  projectDir: string,
  sceneIndex: number,
  newQuery: string,
  pexelsApiKey: string,
  pixabayApiKey: string | undefined,
  preferredAspectRatio = '16:9'
): Promise<StockAsset> {
  const stockDir = join(projectDir, 'assets', 'stock')
  const cache = new QueryCache(stockDir)
  const manifest = loadAssetsManifest(stockDir)
  const orientation = toOrientation(preferredAspectRatio)
  const sanitizedQuery = sanitizeStockQuery(newQuery)

  const candidates = await searchForScene(
    [sanitizedQuery], pexelsApiKey, pixabayApiKey, orientation, cache
  )
  if (candidates.length === 0) throw new Error(`No results for query "${sanitizedQuery}"`)

  const usedIds = new Set(manifest.map((a) => a.assetId))
  const ranked = rankCandidates(candidates, {
    visualIntent: newQuery,
    narrationText: newQuery,
    sceneDurationSecs: 10,
    preferredAspectRatio,
    usedAssetIds: usedIds
  })

  const winner = ranked[0]
  const asset = await downloadAsset(winner, sceneIndex, newQuery, stockDir, manifest)

  // Update manifest + plan
  const updatedManifest = manifest.filter((a) => a.assetId !== asset.assetId)
  updatedManifest.push(asset)
  saveAssetsManifest(stockDir, updatedManifest)
  cache.save()

  const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
  if (fs.existsSync(planPath)) {
    const plan: EditPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
    const flat = flattenEditPlanScenes<ScenePlanWithIntent>(plan)
    const sceneEntry = flat.find((s) => s.sceneIndex === sceneIndex)
    if (sceneEntry) {
      sceneEntry.scene.localPath = asset.localPath
      sceneEntry.scene.mediaFile = basename(asset.localPath)
      sceneEntry.scene.mediaType = asset.mediaType === 'photo' ? 'image' : 'video'
      atomicWriteJson(planPath, plan)
    }
  }

  return asset
}

