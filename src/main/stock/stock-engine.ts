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

/** Perform provider search for a single scene's queries across Pexels and Pixabay */
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

  for (const query of queries) {
    if (pexelsApiKey) {
      const cached = cache.get(`pexels_v:${query}`)
      if (cached) {
        addCandidates(cached)
      } else {
        const res = await pexelsSearchVideos(query, pexelsApiKey, 8, preferredOrientation)
        cache.set(`pexels_v:${query}`, res)
        addCandidates(res)
      }
    }

    if (pixabayApiKey) {
      const cached = cache.get(`pixabay_v:${query}`)
      if (cached) {
        addCandidates(cached)
      } else {
        const orientation = preferredOrientation === 'portrait' ? 'vertical' : 'horizontal'
        const res = await pixabaySearchVideos(query, pixabayApiKey, 8, orientation)
        cache.set(`pixabay_v:${query}`, res)
        addCandidates(res)
      }
    }

    if (allCandidates.length >= 10) break
  }

  // Photo fallback if few video candidates
  if (allCandidates.length < 3) {
    for (const query of queries.slice(0, 2)) {
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

      if (pixabayApiKey) {
        const cached = cache.get(`pixabay_p:${query}`)
        if (cached) {
          addCandidates(cached)
        } else {
          const orientation = preferredOrientation === 'portrait' ? 'vertical' : 'horizontal'
          const res = await pixabaySearchPhotos(query, pixabayApiKey, 6, orientation)
          cache.set(`pixabay_p:${query}`, res)
          addCandidates(res)
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
  const { projectDir, pexelsApiKey, pixabayApiKey, preferredAspectRatio = '16:9' } = params

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
    const existing = existingMap.get(scene.sceneIndex)
    if (scene.locked || existing?.locked) return false
    if (existing?.manualOverride) return false
    if (existing?.approvalStatus === 'approved') return false
    return true
  })

  const assignments: StockSceneAssignment[] = []
  let assignedCount = 0
  let failedCount = 0
  const orientation = toOrientation(preferredAspectRatio)

  // Preserve locked/approved assignments first
  for (const entry of flattenedEntries) {
    const existing = existingMap.get(entry.sceneIndex)
    const isLocked = entry.scene.locked || existing?.locked || existing?.manualOverride || existing?.approvalStatus === 'approved'
    if (isLocked && existing) {
      assignments.push(existing)
      if (existing.status === 'assigned') assignedCount++
    }
  }

  onProgress(`Starting stock search for ${scenesToProcess.length} scenes…`, 0.01)

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
      `[${i + 1}/${scenesToProcess.length}] Scene ${scene.sceneIndex} — "${queries[0]}"`,
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
  atomicWriteJson(reviewPath, assignments)
  if (prodSettings.enabled && prodSettings.candidateRankingEnabled) {
    saveStockCandidates(projectDir, stockCandidatesStore)
  }

  onProgress(
    `Done — ${assignedCount}/${flattenedEntries.length} scenes assigned, ${failedCount} failed`,
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

  const candidates = await searchForScene(
    [newQuery], pexelsApiKey, pixabayApiKey, orientation, cache
  )
  if (candidates.length === 0) throw new Error(`No results for query "${newQuery}"`)

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

