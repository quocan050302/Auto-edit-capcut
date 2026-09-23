/**
 * Stock Media Engine — main pipeline orchestrator.
 *
 * For each scene that lacks a localPath, runs:
 *   Pexels Video → Pixabay Video → Pexels Photo → Pixabay Photo
 * Ranks candidates, downloads the winner, stamps the edit plan.
 */

import { join } from 'path'
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
import { logger } from '../logger'

export type ProgressCallback = (msg: string, pct: number) => void

// ─── Internal helpers ─────────────────────────────────────────────────────────

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
}

interface EditPlan {
  chapters: Array<{
    sequences: Array<{
      scenes: ScenePlanWithIntent[]
    }>
  }>
  [key: string]: unknown
}

function flattenScenes(plan: EditPlan): ScenePlanWithIntent[] {
  return plan.chapters.flatMap((ch) => ch.chapters_seq ?? ch.sequences ?? [])
    .flatMap((seq: { scenes?: ScenePlanWithIntent[] }) => seq.scenes ?? [])
}

/** Perform provider fallback search for a single scene's queries */
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
    // 1. Pexels Video
    let cached = cache.get(`pexels_v:${query}`)
    if (cached) {
      addCandidates(cached)
    } else {
      const res = await pexelsSearchVideos(query, pexelsApiKey, 8, preferredOrientation)
      cache.set(`pexels_v:${query}`, res)
      addCandidates(res)
    }

    if (allCandidates.length >= 6) break
  }

  // 2. If we need more, search Pixabay Video
  if (allCandidates.length < 3 && pixabayApiKey) {
    for (const query of queries.slice(0, 2)) {
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
  }

  // 3. Photo fallback — Pexels Photo
  if (allCandidates.length < 2) {
    for (const query of queries.slice(0, 2)) {
      const cached = cache.get(`pexels_p:${query}`)
      if (cached) {
        addCandidates(cached)
      } else {
        const res = await pexelsSearchPhotos(query, pexelsApiKey, 6, preferredOrientation)
        cache.set(`pexels_p:${query}`, res)
        addCandidates(res)
      }
    }
  }

  // 4. Photo fallback — Pixabay Photo
  if (allCandidates.length < 2 && pixabayApiKey) {
    for (const query of queries.slice(0, 1)) {
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

  // Load edit plan
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

  const cache = new QueryCache(stockDir)
  let manifest = loadAssetsManifest(stockDir)
  const usedAssetIds = new Set<string>(manifest.map((a) => a.assetId))

  // Flatten scenes across all chapters → sequences
  const allScenes = flattenScenes(plan)
  const scenesNeedingStock = allScenes.filter(
    (s) => !s.locked && (!s.localPath || !fs.existsSync(s.localPath))
  )

  const assignments: StockSceneAssignment[] = []
  let assignedCount = 0
  let failedCount = 0
  const orientation = toOrientation(preferredAspectRatio)

  onProgress(`Starting stock search for ${scenesNeedingStock.length} scenes…`, 0.01)

  for (let i = 0; i < scenesNeedingStock.length; i++) {
    const scene = scenesNeedingStock[i]
    const pct = 0.05 + (i / scenesNeedingStock.length) * 0.85
    const queries: string[] = scene.searchQueries?.length
      ? scene.searchQueries
      : [scene.visualIntent ?? scene.narrativeText ?? 'nature background'].slice(0, 4)

    const visualIntent = scene.visualIntent ?? queries[0] ?? ''
    const narrationText = scene.narrativeText ?? ''
    const sceneDuration = scene.duration ?? (scene.endTime - scene.startTime)

    onProgress(
      `[${i + 1}/${scenesNeedingStock.length}] Scene ${scene.sceneIndex} — "${queries[0]}"`,
      pct
    )

    const assignment: StockSceneAssignment = {
      sceneId: `scene_${scene.sceneIndex}`,
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

        // Update manifest
        manifest = manifest.filter((a) => a.assetId !== downloadedAsset.assetId)
        manifest.push(downloadedAsset)
        usedAssetIds.add(downloadedAsset.assetId)

        // Stamp the plan scene
        scene.localPath = downloadedAsset.localPath

        assignment.asset = downloadedAsset
        assignment.score = winner.score
        assignment.usedQuery = usedQuery
        assignment.status = 'assigned'
        assignedCount++
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

  // Save updated plan with localPaths stamped in
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')

  // Save assignments for review UI
  const reviewPath = join(projectDir, 'analysis', 'stock-assignments.json')
  fs.writeFileSync(reviewPath, JSON.stringify(assignments, null, 2), 'utf-8')

  onProgress(
    `Done — ${assignedCount}/${scenesNeedingStock.length} scenes assigned, ${failedCount} failed`,
    1.0
  )

  return {
    success: true,
    totalScenes: scenesNeedingStock.length,
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
    const scene = flattenScenes(plan).find((s) => s.sceneIndex === sceneIndex)
    if (scene) {
      scene.localPath = asset.localPath
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')
    }
  }

  return asset
}
