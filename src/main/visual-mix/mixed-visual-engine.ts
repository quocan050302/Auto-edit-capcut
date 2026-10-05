import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { loadConfig } from '../config'
import { normalizeApiKey } from '../utils/api-key'
import { resolveGeminiApiKey } from '../pipeline/pipeline-validator'
import { checkStockCompletion } from '../pipeline/pipeline-artifacts'
import { runContextAwareStockEngine } from '../stock/context-stock-engine'
import { runStockEngine } from '../stock/stock-engine'
import { flowkitRuntimeManager } from '../thumbnail/flowkit-runtime-manager'
import { googleFlowClient } from '../thumbnail/google-flow-client'
import type {
  AutoPipelineOptions,
  StockSceneAssignment,
  StockAsset,
  VisualMixProfile,
  VisualMixConfig,
  GlobalScriptContext
} from '../../../shared/types'
import type { StageRunResult, StageProgressCallback } from '../pipeline/pipeline-stage-runners'
import { VisualMixPlanner } from './visual-mix-planner'
import { FlowImagePool, flowImagePool, GenerationPoolItem } from './flow-image-pool'
import { getCachedVisualAsset } from './visual-mix-cache'

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Pipeline execution was cancelled.')
  }
}

export interface MixedVisualEngineParams {
  options: AutoPipelineOptions
  profile: VisualMixProfile
  mix: VisualMixConfig
  onProgress: StageProgressCallback
  signal?: AbortSignal
  flowPool?: FlowImagePool
}

export async function runMixedVisualEngine(
  params: MixedVisualEngineParams
): Promise<StageRunResult> {
  const { options, profile, mix, onProgress, signal } = params
  const pool = params.flowPool || flowImagePool
  const projectDir = options.projectDir

  checkAborted(signal)

  const isHealth = profile === 'health'
  const targetAiRatio = mix.aiImageRatio

  // 1. Google Flow readiness check: ONLY if AI ratio > 0 (Section 34)
  if (targetAiRatio > 0) {
    onProgress('Checking Google Flow readiness...', 0.02)
    try {
      const bridgeUrl = googleFlowClient.getBridgeUrl()
      const readiness = await flowkitRuntimeManager.ensureFlowReady(bridgeUrl)
      if (!readiness.ready) {
        let msg = readiness.message || 'FlowKit bridge or Google Flow is not ready.'
        if (!readiness.bridgeReachable) {
          msg = `Visual mix requires Google Flow AI generation, but FlowKit is unreachable at ${bridgeUrl}. Ensure FlowKit is running.`
        } else if (!readiness.extensionConnected) {
          msg = 'Visual mix requires Google Flow AI generation, but Chrome extension is disconnected. Open Google Flow in Chrome and reconnect the FlowKit extension.'
        } else if (!readiness.flowConnected) {
          msg = 'Visual mix requires Google Flow AI generation, but Google Flow is not signed in. Open Google Flow in Chrome and log in.'
        }
        logger.warn(`[MixedVisualEngine] FlowKit readiness failed: ${msg}`)
        return {
          success: false,
          needsAttention: true,
          error: msg
        }
      }

      const health = await googleFlowClient.checkHealth()
      if (!health.reachable || !health.extensionConnected) {
        return {
          success: false,
          needsAttention: true,
          error: health.message || 'FlowKit is not reachable or Chrome extension is disconnected.'
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        needsAttention: true,
        error: `Google Flow readiness check error: ${msg}. Open Google Flow in Chrome and reconnect the extension.`
      }
    }
  }

  checkAborted(signal)

  // 2. Load Edit Plan & Global Context
  onProgress('Planning visuals...', 0.05)
  const rawScenes = VisualMixPlanner.loadScenesFromEditPlan(projectDir)
  if (rawScenes.length === 0) {
    return {
      success: false,
      error: 'No scenes found in edit plan for Visual Planning.'
    }
  }

  let globalContext: GlobalScriptContext | undefined
  const contextPath = path.join(projectDir, 'analysis', 'global-script-context.json')
  if (fs.existsSync(contextPath)) {
    try {
      globalContext = JSON.parse(fs.readFileSync(contextPath, 'utf-8'))
    } catch {
      /* ignore */
    }
  }

  const plan = VisualMixPlanner.buildPlan({
    projectDir,
    rawScenes,
    config: mix,
    profile,
    globalContext
  })

  checkAborted(signal)

  const aiScenes = plan.scenes.filter((s) => s.strategy === 'ai-still')
  const initialStockScenes = plan.scenes.filter((s) => s.strategy === 'stock')

  logger.info(
    `[MixedVisualEngine] Execution plan: ${aiScenes.length} AI scenes, ${initialStockScenes.length} stock scenes (profile=${profile})`
  )

  // Load existing stock assignments
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
  let reusedAiCount = 0
  let newlyGeneratedAiCount = 0
  let aiFallbackCount = 0

  // 3. Separate cached AI items vs uncached AI items (Section 44)
  const uncachedItems: GenerationPoolItem[] = []

  for (const sc of aiScenes) {
    const hash = sc.generationHash || 'hash'
    const cached = getCachedVisualAsset(projectDir, sc.sceneIndex, hash, profile)

    if (cached && cached.outputPath && fs.existsSync(cached.outputPath)) {
      reusedAiCount++
      const stat = fs.statSync(cached.outputPath)
      const asset: StockAsset = {
        assetId: `flow_${hash.slice(0, 12)}`,
        provider: 'google-flow',
        mediaType: 'photo',
        localPath: cached.outputPath,
        thumbnailUrl: `file://${cached.outputPath}`,
        downloadUrl: '',
        creator: 'Google Flow AI',
        searchQuery: sc.imagePrompt || '',
        downloadedAt: cached.generatedAt || new Date().toISOString(),
        fileSizeBytes: stat.size
      }

      assignmentMap.set(sc.sceneIndex, {
        sceneId: `scene_${sc.sceneIndex}`,
        sceneIndex: sc.sceneIndex,
        narrationText: sc.narration,
        startTime: sc.startTime,
        endTime: sc.endTime,
        visualIntent: sc.visualIntent,
        searchQueries: [],
        usedQuery: isHealth ? 'AI Medical Still (Google Flow)' : 'AI Still (Google Flow)',
        score: 95,
        locked: true,
        manualOverride: false,
        status: 'assigned',
        asset
      })
    } else {
      uncachedItems.push({
        scene: sc,
        config: mix,
        profile,
        projectDir
      })
    }
  }

  logger.info(
    `[MixedVisualEngine] AI scenes breakdown: ${reusedAiCount} cached on disk, ${uncachedItems.length} queued for generation`
  )

  // 4. Generate uncached AI scenes with continuous sliding worker pool (concurrency 6)
  if (uncachedItems.length > 0) {
    onProgress(
      `Starting concurrent AI visual generation (${uncachedItems.length} scenes, max 6 concurrent)...`,
      0.10
    )

    const poolResults = await pool.processBatch(
      uncachedItems,
      (msg, prog, stats) => {
        checkAborted(signal)
        const mappedPct = 0.10 + prog * 0.50 // 0.10 -> 0.60
        onProgress(
          `AI Visuals: ${stats.completed}/${stats.total} complete (${stats.generating} active, ${stats.postProcessing} normalizing) — ${msg}`,
          mappedPct
        )
      },
      signal
    )

    checkAborted(signal)

    for (const res of poolResults) {
      const sc = aiScenes.find((s) => s.sceneIndex === res.sceneIndex)
      if (!sc) continue

      if (res.success && res.assetPath && fs.existsSync(res.assetPath)) {
        newlyGeneratedAiCount++
        const stat = fs.statSync(res.assetPath)
        const asset: StockAsset = {
          assetId: `flow_${(sc.generationHash || 'gen').slice(0, 12)}`,
          provider: 'google-flow',
          mediaType: 'photo',
          localPath: res.assetPath,
          thumbnailUrl: `file://${res.assetPath}`,
          downloadUrl: '',
          creator: 'Google Flow AI',
          searchQuery: sc.imagePrompt || '',
          downloadedAt: new Date().toISOString(),
          fileSizeBytes: stat.size
        }

        assignmentMap.set(sc.sceneIndex, {
          sceneId: `scene_${sc.sceneIndex}`,
          sceneIndex: sc.sceneIndex,
          narrationText: sc.narration,
          startTime: sc.startTime,
          endTime: sc.endTime,
          visualIntent: sc.visualIntent,
          searchQueries: [],
          usedQuery: isHealth ? 'AI Medical Still (Google Flow)' : 'AI Still (Google Flow)',
          score: 95,
          locked: true,
          manualOverride: false,
          status: 'assigned',
          asset
        })
      } else {
        // Individual scene fallback to stock (Section 46)
        aiFallbackCount++
        stockScenesToSearch.add(sc.sceneIndex)
        logger.warn(
          `[MixedVisualEngine] Scene ${sc.sceneIndex} falling back to stock footage (${res.reason})`
        )
      }
    }
  }

  // 5. Reconciliation for scenes changing AI -> Stock (Section 30, 31)
  // If a scene is planned as stock, remove any obsolete Google Flow locked assignment
  for (const stockIdx of stockScenesToSearch) {
    const existing = assignmentMap.get(stockIdx)
    if (existing && existing.asset?.provider === 'google-flow') {
      assignmentMap.delete(stockIdx)
    }
  }

  // 6. Save intermediate stock assignments
  const currentAssignments = Array.from(assignmentMap.values()).sort(
    (a, b) => a.sceneIndex - b.sceneIndex
  )
  const dir = path.dirname(reviewPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmpReview = `${reviewPath}.tmp.${Date.now()}`
  fs.writeFileSync(tmpReview, JSON.stringify(currentAssignments, null, 2), 'utf-8')
  fs.renameSync(tmpReview, reviewPath)

  // 7. Run stock search for planned stock scenes + fallbacks (Section 32, 46)
  const stockSceneIndices = Array.from(stockScenesToSearch).sort((a, b) => a - b)

  if (stockSceneIndices.length > 0) {
    logger.info(
      `[MixedVisualEngine] Running stock search for ${stockSceneIndices.length} scenes: ${stockSceneIndices.join(', ')}`
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

  // 8. Reconcile final visual completion using checkStockCompletion
  const stockSummary = checkStockCompletion(projectDir)

  if (stockSummary.missingScenes > 0) {
    const errorMsg = `${stockSummary.missingScenes}/${stockSummary.totalScenes} scenes lack downloadable stock media.`
    logger.warn(`[MixedVisualEngine] Needs attention: ${errorMsg}`)
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
        aiGeneratedScenes: reusedAiCount + newlyGeneratedAiCount,
        aiFallbackToStock: aiFallbackCount
      }
    }
  }

  // Count final AI stills vs stock
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

  const completionMsg = `${isHealth ? 'Health' : 'Mixed'} visuals completed — ${stockSummary.totalScenes}/${stockSummary.totalScenes} scenes ready · ${finalAiCount} AI stills · ${finalStockCount} stock`
  logger.info(`[MixedVisualEngine] ${completionMsg}`)
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
