import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { loadConfig } from '../config'
import { normalizeApiKey } from '../utils/api-key'
import { resolveGeminiApiKey } from '../pipeline/pipeline-validator'
import { checkStockCompletion } from '../pipeline/pipeline-artifacts'
import { runContextAwareStockEngine } from '../stock/context-stock-engine'
import { runStockEngine } from '../stock/stock-engine'
import type {
  AutoPipelineOptions,
  StockSceneAssignment,
  StockAsset
} from '../../../shared/types'
import type { StageRunResult, StageProgressCallback } from '../pipeline/pipeline-stage-runners'
import { HealthVisualPlanner } from './health-visual-planner'
import { healthImageGenerator, HealthImageGenerator } from './health-image-generator'
import { loadHealthGeneratedManifest } from './health-visual-cache'
import { resolveVisualMixConfig } from '../visual-mix/visual-mix-config'
import { runMixedVisualEngine } from '../visual-mix/mixed-visual-engine'

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Pipeline execution was cancelled.')
  }
}

export async function runHealthVisualEngine(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal,
  imageGenerator: HealthImageGenerator = healthImageGenerator
): Promise<StageRunResult> {
  checkAborted(signal)

  if (imageGenerator === healthImageGenerator) {
    const mix = resolveVisualMixConfig(options)
    return runMixedVisualEngine({
      options,
      profile: 'health',
      mix,
      onProgress,
      signal
    })
  }

  const projectDir = options.projectDir

  // 1. Check Google Flow readiness before starting any work
  onProgress('Checking Google Flow readiness...', 0.02)
  const readiness = await imageGenerator.ensureReadiness()
  if (!readiness.ready) {
    const errorMsg = readiness.error || 'Google Flow / FlowKit is not ready.'
    logger.warn(`[HealthVisual] Readiness check failed: ${errorMsg}`)
    return {
      success: false,
      needsAttention: true,
      error: errorMsg
    }
  }

  checkAborted(signal)

  // 2. Build or load HealthVisualPlan
  onProgress('Planning Health visuals...', 0.05)
  const rawScenes = HealthVisualPlanner.loadScenesFromEditPlan(projectDir)
  if (rawScenes.length === 0) {
    return {
      success: false,
      error: 'No scenes found in edit plan for Health Visual Planning.'
    }
  }

  const plan = HealthVisualPlanner.buildPlan(projectDir, rawScenes, options.healthVisualConfig)
  checkAborted(signal)

  const aiScenes = plan.scenes.filter((s) => s.strategy === 'ai-still')
  const initialStockScenes = plan.scenes.filter((s) => s.strategy === 'stock')

  logger.info(
    `[HealthVisual] Execution start: ${aiScenes.length} AI still candidates, ${initialStockScenes.length} stock candidates`
  )

  // Load existing stock assignments to merge/preserve
  const reviewPath = path.join(projectDir, 'analysis', 'stock-assignments.json')
  let existingAssignments: StockSceneAssignment[] = []
  if (fs.existsSync(reviewPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(reviewPath, 'utf-8'))
      if (Array.isArray(parsed)) {
        existingAssignments = parsed
      }
    } catch {
      /* ignore */
    }
  }
  const assignmentMap = new Map<number, StockSceneAssignment>()
  for (const a of existingAssignments) {
    if (a && typeof a.sceneIndex === 'number') {
      assignmentMap.set(a.sceneIndex, a)
    }
  }

  const stockScenesToSearch = new Set<number>(initialStockScenes.map((s) => s.sceneIndex))
  let completedAiCount = 0
  let reusedAiCount = 0
  let aiFallbackCount = 0

  // 3. Generate AI Stills with Concurrency = 1
  for (let i = 0; i < aiScenes.length; i++) {
    checkAborted(signal)
    const sc = aiScenes[i]
    const sceneProgress = 0.05 + (i / aiScenes.length) * 0.55 // 0.05 -> 0.60

    onProgress(
      `Generating medical visual ${i + 1}/${aiScenes.length} (Scene ${sc.sceneIndex})...`,
      sceneProgress
    )

    const genResult = await imageGenerator.generateSceneAsset(
      projectDir,
      sc,
      options.healthVisualConfig
    )

    checkAborted(signal)

    if (genResult.success && genResult.assetPath) {
      completedAiCount++
      const stat = fs.statSync(genResult.assetPath)

      // Build unified StockSceneAssignment
      const asset: StockAsset = {
        assetId: `flow_${(sc.generationHash || 'gen').slice(0, 12)}`,
        provider: 'google-flow',
        mediaType: 'photo',
        localPath: genResult.assetPath,
        thumbnailUrl: `file://${genResult.assetPath}`,
        downloadUrl: '',
        creator: 'Google Flow AI',
        searchQuery: sc.imagePrompt || '',
        downloadedAt: new Date().toISOString(),
        fileSizeBytes: stat.size
      }

      const assignment: StockSceneAssignment = {
        sceneId: `scene_${sc.sceneIndex}`,
        sceneIndex: sc.sceneIndex,
        narrationText: sc.narration,
        startTime: sc.startTime,
        endTime: sc.endTime,
        visualIntent: sc.visualIntent,
        searchQueries: [],
        usedQuery: 'AI Medical Still (Google Flow)',
        score: 95,
        locked: true,
        manualOverride: false,
        status: 'assigned',
        asset
      }

      assignmentMap.set(sc.sceneIndex, assignment)
      logger.info(`[HealthVisual] Scene ${sc.sceneIndex} assigned AI still asset`)
    } else {
      // Fallback to stock for this scene
      aiFallbackCount++
      stockScenesToSearch.add(sc.sceneIndex)
      logger.warn(
        `[HealthVisual] Scene ${sc.sceneIndex} added to stock search due to AI fallback (${genResult.reason})`
      )
    }
  }

  // Count how many AI scenes were reused from cache
  const manifest = loadHealthGeneratedManifest(projectDir)
  for (const sc of aiScenes) {
    const rec = manifest.scenes[String(sc.sceneIndex)]
    if (rec && rec.status === 'completed') {
      reusedAiCount++
    }
  }

  // 4. Save intermediate assignments before stock search
  const currentAssignments = Array.from(assignmentMap.values()).sort(
    (a, b) => a.sceneIndex - b.sceneIndex
  )
  const dir = path.dirname(reviewPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const tmpReview = `${reviewPath}.tmp.${Date.now()}`
  fs.writeFileSync(tmpReview, JSON.stringify(currentAssignments, null, 2), 'utf-8')
  fs.renameSync(tmpReview, reviewPath)

  // 5. Run stock search for the stock scenes + fallback scenes
  const stockSceneIndices = Array.from(stockScenesToSearch).sort((a, b) => a - b)

  if (stockSceneIndices.length > 0) {
    logger.info(
      `[HealthVisual] Running stock search for ${stockSceneIndices.length} scenes (planned + fallbacks): ${stockSceneIndices.join(', ')}`
    )
    onProgress(`Finding real footage 1/${stockSceneIndices.length}...`, 0.65)

    const appCfg = loadConfig()
    const apiKey = resolveGeminiApiKey()
    const pexelsKey = normalizeApiKey(appCfg.pexelsApiKey ?? '')
    const pixabayKey = normalizeApiKey(appCfg.pixabayApiKey ?? '')

    const stockProgressBridge: StageProgressCallback = (msg, pct) => {
      checkAborted(signal)
      const mappedPct = 0.65 + pct * 0.3 // 0.65 -> 0.95
      onProgress(msg, mappedPct)
    }

    if (apiKey) {
      await runContextAwareStockEngine(
        {
          projectDir,
          pexelsApiKey: pexelsKey,
          pixabayApiKey: pixabayKey,
          preferredAspectRatio:
            (options.resolution?.width ?? 1920) >= (options.resolution?.height ?? 1080)
              ? '16:9'
              : '9:16',
          apiKey,
          model: options.geminiModel,
          forceReanalysis: false,
          targetSceneIndices: stockSceneIndices
        },
        stockProgressBridge
      )
    } else {
      await runStockEngine(
        {
          projectDir,
          pexelsApiKey: pexelsKey,
          pixabayApiKey: pixabayKey,
          preferredAspectRatio: '16:9',
          targetSceneIndices: stockSceneIndices
        },
        stockProgressBridge
      )
    }
  }

  checkAborted(signal)

  // 6. Reconcile final visual completion using checkStockCompletion
  const stockSummary = checkStockCompletion(projectDir)

  if (stockSummary.missingScenes > 0) {
    const errorMsg = `${stockSummary.missingScenes}/${stockSummary.totalScenes} scenes lack downloadable stock media.`
    logger.warn(`[HealthVisual] Needs attention: ${errorMsg}`)
    return {
      success: false,
      needsAttention: true,
      error: errorMsg,
      stats: {
        totalScenes: stockSummary.totalScenes,
        assignedScenes: stockSummary.assignedScenes,
        downloadedScenes: stockSummary.downloadedScenes,
        missingScenes: stockSummary.missingScenes,
        missingSceneIndices: stockSummary.missingSceneIndices,
        aiGeneratedScenes: completedAiCount,
        aiFallbackToStock: aiFallbackCount
      }
    }
  }

  // Count AI stills vs stock
  let finalAiCount = 0
  let finalStockCount = 0
  if (fs.existsSync(reviewPath)) {
    try {
      const finalAssigns: StockSceneAssignment[] = JSON.parse(
        fs.readFileSync(reviewPath, 'utf-8')
      )
      for (const a of finalAssigns) {
        if (a.asset?.provider === 'google-flow') {
          finalAiCount++
        } else {
          finalStockCount++
        }
      }
    } catch {
      /* ignore */
    }
  }

  const completionMsg = `Health visuals completed — ${stockSummary.totalScenes}/${stockSummary.totalScenes} scenes ready · ${finalAiCount} AI stills · ${finalStockCount} stock`
  logger.info(`[HealthVisual] ${completionMsg}`)
  onProgress(completionMsg, 1.0)

  return {
    success: true,
    stats: {
      totalScenes: stockSummary.totalScenes,
      assignedScenes: stockSummary.assignedScenes,
      downloadedScenes: stockSummary.downloadedScenes,
      missingScenes: 0,
      failedScenes: 0,
      percent: 100,
      aiGeneratedScenes: finalAiCount,
      stockScenes: finalStockCount,
      aiFallbackToStock: aiFallbackCount,
      cachedAiScenes: reusedAiCount,
      completionMessage: completionMsg
    }
  }
}
