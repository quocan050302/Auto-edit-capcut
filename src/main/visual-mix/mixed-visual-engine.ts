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
import { VisualAssignmentStore } from './visual-assignment-store'

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
  const phase2StartTime = Date.now()

  checkAborted(signal)

  const isHealth = profile === 'health'
  const targetAiRatio = mix.aiImageRatio
  const targetStockRatio = mix.stockFootageRatio

  // 1. Snapshot Visual Input (Section 34)
  const analysisDir = path.join(projectDir, 'analysis')
  if (!fs.existsSync(analysisDir)) {
    fs.mkdirSync(analysisDir, { recursive: true })
  }

  // 2. Validate Config Consistency (Section 37 & 73)
  const statePath = path.join(projectDir, 'project-state.json')
  const projectJsonPath = path.join(projectDir, 'project.json')
  const activeJsonPath = fs.existsSync(statePath)
    ? statePath
    : fs.existsSync(projectJsonPath)
      ? projectJsonPath
      : null

  if (activeJsonPath) {
    try {
      const proj = JSON.parse(fs.readFileSync(activeJsonPath, 'utf-8'))
      const projInputs = proj?.inputs
      if (projInputs?.visualSourceMode === 'custom-mix' && projInputs?.visualMixConfig) {
        const setupAi = Math.round((projInputs.visualMixConfig.aiImageRatio ?? 0) * 100)
        const setupStock = Math.round((projInputs.visualMixConfig.stockFootageRatio ?? 0) * 100)
        const pipelineAi = Math.round(mix.aiImageRatio * 100)
        const pipelineStock = Math.round(mix.stockFootageRatio * 100)

        if (setupAi !== pipelineAi || setupStock !== pipelineStock) {
          const err = `VISUAL_MIX_CONFIG_MISMATCH: Setup requested AI=${setupAi} Stock=${setupStock}, pipeline received AI=${pipelineAi} Stock=${pipelineStock}.`
          logger.error(`[MixedVisualEngine] ${err}`)
          return {
            success: false,
            needsAttention: true,
            error: err
          }
        }
      }
    } catch {
      /* non-fatal if project-state is not parseable */
    }
  }

  // 3. Google Flow readiness check: ONLY if AI ratio > 0 (Section 20 & 34)
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

  // 4. Load Edit Plan & Global Context
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

  // 5. Build authoritative Visual Mix Plan (Sections 15, 16, 17, 35)
  const plan = VisualMixPlanner.buildPlan({
    projectDir,
    rawScenes,
    config: mix,
    profile,
    globalContext
  })

  checkAborted(signal)

  const totalScenes = rawScenes.length
  const aiScenes = plan.scenes.filter((s) => s.strategy === 'ai-still')
  const initialStockScenes = plan.scenes.filter((s) => s.strategy === 'stock')
  const aiSceneIndices = plan.aiSceneIndices || aiScenes.map((s) => s.sceneIndex)
  const stockSceneIndices = plan.stockSceneIndices || initialStockScenes.map((s) => s.sceneIndex)

  // Section 34: Write visual-input-snapshot.json
  const inputSnapshot = {
    contentType: profile,
    visualSourceMode: mix.mode || 'custom-mix',
    aiImagePercent: Math.round(mix.aiImageRatio * 100),
    stockFootagePercent: Math.round(mix.stockFootageRatio * 100),
    aiImageRatio: mix.aiImageRatio,
    stockFootageRatio: mix.stockFootageRatio,
    imageOutputResolution: mix.imageOutputResolution || '1080p',
    totalScenes
  }
  fs.writeFileSync(
    path.join(analysisDir, 'visual-input-snapshot.json'),
    JSON.stringify(inputSnapshot, null, 2),
    'utf-8'
  )

  // Section 72: Logging mix
  logger.info(
    `[VisualMixInput] profile=${profile} mode=${mix.mode} AI=${inputSnapshot.aiImagePercent}% Stock=${inputSnapshot.stockFootagePercent}% quality=${inputSnapshot.imageOutputResolution}`
  )
  logger.info(
    `[VisualMixPlan] total=${totalScenes} AI=${aiScenes.length} Stock=${initialStockScenes.length}`
  )

  // 6. Initialize VisualAssignmentStore (Section 28 & 29)
  const store = new VisualAssignmentStore(projectDir)

  // Reconcile assignments: remove obsolete entries if ownership flipped
  for (const s of initialStockScenes) {
    const existing = store.get(s.sceneIndex)
    if (existing?.asset?.provider === 'google-flow') {
      store.delete(s.sceneIndex)
    }
  }
  for (const s of aiScenes) {
    const existing = store.get(s.sceneIndex)
    if (existing && existing.asset?.provider !== 'google-flow') {
      store.delete(s.sceneIndex)
    }
  }
  await store.flushAtomic()

  // 7. Parallel Execution: Run AI and Stock simultaneous pipelines (Section 21 & 47)
  let aiBranchTimeMs = 0
  let stockBranchTimeMs = 0
  let totalFlowCalls = 0

  // ─── Branch A: AI Visual Acquisition ─────────────────────────────────────
  const runAiBranch = async (): Promise<{
    newlyGenerated: number
    cached: number
    failedScenes: VisualMixScenePlan[]
    totalGenMs: number
    totalExpMs: number
    totalNormMs: number
  }> => {
    const t0 = Date.now()

    // Section 20: 0/100 MUST MEAN ZERO GOOGLE FLOW CALLS
    if (aiScenes.length === 0) {
      aiBranchTimeMs = Date.now() - t0
      logger.info('[VisualMix] 0% AI requested: Skipping AI generation completely.')
      return { newlyGenerated: 0, cached: 0, failedScenes: [], totalGenMs: 0, totalExpMs: 0, totalNormMs: 0 }
    }

    let reusedCount = 0
    const uncached: GenerationPoolItem[] = []

    for (const sc of aiScenes) {
      const hash = sc.generationHash || 'hash'
      const cached = getCachedVisualAsset(projectDir, sc.sceneIndex, hash, profile)

      if (cached && cached.outputPath && fs.existsSync(cached.outputPath)) {
        reusedCount++
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

        store.set(sc.sceneIndex, {
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
        uncached.push({
          scene: sc,
          config: mix,
          profile,
          projectDir
        })
      }
    }

    await store.flushAtomic()

    // Section 72 Logging
    logger.info(
      `[VisualMixExecution] AI queue=${uncached.length} AI cache hits=${reusedCount} Stock initial targets=${initialStockScenes.length}`
    )
    logger.info(
      `[VisualMix] AI ownership: target=${aiScenes.length} queue=${uncached.length} cached=${reusedCount}`
    )

    totalFlowCalls = uncached.length
    let newlyGenerated = 0
    const failedScenes: VisualMixScenePlan[] = []
    let totalGenMs = 0
    let totalExpMs = 0
    let totalNormMs = 0

    if (uncached.length > 0) {
      const poolResults = await pool.processBatch(
        uncached,
        (msg, prog, stats) => {
          checkAborted(signal)
          // Progress reporting: accurately show completed / aiScenes.length (Section 55)
          const completedTotal = reusedCount + stats.completed
          onProgress(
            `AI Visuals: [${completedTotal}/${aiScenes.length}] complete (${stats.generating} generating, ${stats.exporting} exporting) — ${msg}`,
            0.10 + prog * 0.45
          )
        },
        signal
      )

      for (const res of poolResults) {
        const sc = aiScenes.find((s) => s.sceneIndex === res.sceneIndex)
        if (!sc) continue

        if (res.performance) {
          totalGenMs += res.performance.generateMs
          totalExpMs += res.performance.exportMs
          totalNormMs += res.performance.normalizeMs
        }

        if (res.success && res.assetPath && fs.existsSync(res.assetPath)) {
          newlyGenerated++
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

          store.set(sc.sceneIndex, {
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
          failedScenes.push(sc)
        }
      }

      await store.flushAtomic()
    }

    aiBranchTimeMs = Date.now() - t0
    return {
      newlyGenerated,
      cached: reusedCount,
      failedScenes,
      totalGenMs,
      totalExpMs,
      totalNormMs
    }
  }

  // ─── Branch B: Stock Acquisition ─────────────────────────────────────────
  const runStockBranch = async (
    targetIndices: number[],
    isFallback = false
  ): Promise<{ assigned: number; failed: number }> => {
    const t0 = Date.now()

    // Section 19: 100/0 MUST MEAN ZERO INITIAL FOOTAGE
    if (targetIndices.length === 0) {
      stockBranchTimeMs = Date.now() - t0
      logger.info('[VisualMix] 0 stock scenes targeted: Skipping stock search completely.')
      return { assigned: 0, failed: 0 }
    }

    logger.info(
      `[MixedVisualEngine] Launching Stock acquisition for ${targetIndices.length} scenes: ${targetIndices.join(', ')} (isFallback=${isFallback})`
    )

    const appCfg = loadConfig()
    const apiKey = resolveGeminiApiKey()
    const pexelsKey = normalizeApiKey(appCfg.pexelsApiKey ?? '')
    const pixabayKey = normalizeApiKey(appCfg.pixabayApiKey ?? '')

    const stockProgressBridge: StageProgressCallback = (msg, pct) => {
      checkAborted(signal)
      onProgress(msg, 0.55 + pct * 0.40)
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
          targetSceneIndices: targetIndices
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
          targetSceneIndices: targetIndices
        },
        stockProgressBridge
      )
    }

    // Refresh store from disk to incorporate stock engine results
    store.load()
    await store.flushAtomic()

    stockBranchTimeMs = Date.now() - t0
    return { assigned: targetIndices.length, failed: 0 }
  }

  // Launch AI and Stock branches in parallel (Section 21 & 47)
  const [aiRes] = await Promise.all([
    runAiBranch(),
    runStockBranch(stockSceneIndices, false)
  ])

  checkAborted(signal)

  // 8. AI Failure Fallback (Section 25)
  // If any AI scenes failed, run a small fallback stock search ONLY for those scene indices!
  let aiFallbackCount = 0
  if (aiRes.failedScenes.length > 0) {
    const fallbackIndices = aiRes.failedScenes.map((s) => s.sceneIndex)
    aiFallbackCount = fallbackIndices.length
    logger.warn(
      `[MixedVisualEngine] ${aiFallbackCount} AI scenes failed generation. Running fallback stock search on scenes: ${fallbackIndices.join(', ')}`
    )
    onProgress(`Running stock fallback for ${aiFallbackCount} failed AI scenes...`, 0.90)
    await runStockBranch(fallbackIndices, true)
  }

  checkAborted(signal)

  // 9. Reconcile final visual completion using checkStockCompletion
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
        aiGeneratedScenes: aiRes.cached + aiRes.newlyGenerated,
        aiFallbackToStock: aiFallbackCount
      }
    }
  }

  // Count final AI stills vs stock
  let finalAiCount = 0
  let finalStockCount = 0
  const reviewPath = path.join(projectDir, 'analysis', 'stock-assignments.json')
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

  const phase2WallTimeMs = Date.now() - phase2StartTime

  // 10. Write visual-performance-report.json (Section 70)
  let flowThrottleInfo = { maxConcurrent: 1, minIntervalS: 3, cooldownActive: false }
  try {
    const t = await googleFlowClient.getFlowThrottle()
    flowThrottleInfo = {
      maxConcurrent: t.maxConcurrent,
      minIntervalS: t.minIntervalS,
      cooldownActive: t.cooldownActive
    }
  } catch {
    /* ignore */
  }

  const perfReport = {
    requestedMix: {
      aiPercent: Math.round(mix.aiImageRatio * 100),
      stockPercent: Math.round(mix.stockFootageRatio * 100)
    },
    plannedMix: {
      ai: aiScenes.length,
      stock: initialStockScenes.length
    },
    actualMix: {
      ai: finalAiCount,
      stock: finalStockCount
    },
    totalScenes,
    aiCacheHits: aiRes.cached,
    flowCalls: totalFlowCalls,
    flowSuccessfulCalls: aiRes.newlyGenerated,
    aiFallbackCount,
    timings: {
      phase2WallTimeMs,
      aiBranchTimeMs,
      stockBranchTimeMs,
      totalAiGenerationTimeMs: aiRes.totalGenMs,
      totalAiExportTimeMs: aiRes.totalExpMs,
      totalAiNormalizationTimeMs: aiRes.totalNormMs
    },
    flowThrottleSettings: flowThrottleInfo
  }
  fs.writeFileSync(
    path.join(analysisDir, 'visual-performance-report.json'),
    JSON.stringify(perfReport, null, 2),
    'utf-8'
  )

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
      cachedAiScenes: aiRes.cached,
      completionMessage: completionMsg
    }
  }
}
