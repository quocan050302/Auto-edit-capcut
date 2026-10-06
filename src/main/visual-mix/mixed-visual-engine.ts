import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { loadConfig } from '../config'
import { normalizeApiKey } from '../utils/api-key'
import { resolveGeminiApiKey } from '../pipeline/pipeline-validator'
import { checkVisualCompletion } from '../pipeline/pipeline-artifacts'
import { runContextAwareStockEngine } from '../stock/context-stock-engine'
import { runStockEngine } from '../stock/stock-engine'
import { flowkitRuntimeManager } from '../thumbnail/flowkit-runtime-manager'
import { googleFlowClient } from '../thumbnail/google-flow-client'
import type {
  AiVisualFailureStage,
  AutoPipelineOptions,
  StockSceneAssignment,
  StockAsset,
  StockRunParams,
  StockRunResult,
  VisualMixProfile,
  VisualMixConfig,
  VisualMixScenePlan,
  GlobalScriptContext
} from '../../../shared/types'
import type { StageRunResult, StageProgressCallback } from '../pipeline/pipeline-stage-runners'
import { VisualMixPlanner } from './visual-mix-planner'
import { FlowImagePool, flowImagePool, GenerationPoolItem } from './flow-image-pool'
import { getCachedVisualAsset, recordVisualAssetQueued } from './visual-mix-cache'
import { VisualAssignmentStore } from './visual-assignment-store'
import {
  assertStockAllowed,
  resolveAiFailureBehavior,
  validateFinalVisualAssignments
} from './visual-mix-validator'

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Pipeline execution was cancelled.')
  }
}

/** Optional injection points (used by tests; production uses the real engines). */
export interface MixedVisualEngineDeps {
  /** Replaces both context-aware and basic stock engines. Must honour targetSceneIndices + assignmentSink. */
  stockRunner?: (
    params: StockRunParams & { apiKey?: string; model?: string; forceReanalysis?: boolean },
    onProgress: StageProgressCallback
  ) => Promise<StockRunResult>
  /** Skip the FlowKit/Google Flow readiness probe (tests with a mocked flow pool). */
  skipFlowReadiness?: boolean
}

export interface MixedVisualEngineParams {
  options: AutoPipelineOptions
  profile: VisualMixProfile
  mix: VisualMixConfig
  onProgress: StageProgressCallback
  signal?: AbortSignal
  flowPool?: FlowImagePool
  deps?: MixedVisualEngineDeps
}

interface AiFailureInfo {
  sceneIndex: number
  stage: AiVisualFailureStage
  reason: string
}

export async function runMixedVisualEngine(
  params: MixedVisualEngineParams
): Promise<StageRunResult> {
  const { options, profile, mix, onProgress, signal, deps } = params
  const pool = params.flowPool || flowImagePool
  const projectDir = options.projectDir
  const phase2StartTime = Date.now()

  checkAborted(signal)

  const isHealth = profile === 'health'
  const targetAiRatio = mix.aiImageRatio
  const failureBehavior = resolveAiFailureBehavior(mix)
  const requestedAiPercent = Math.round(mix.aiImageRatio * 100)
  const requestedStockPercent = Math.round(mix.stockFootageRatio * 100)

  // 1. Snapshot Visual Input
  const analysisDir = path.join(projectDir, 'analysis')
  if (!fs.existsSync(analysisDir)) {
    fs.mkdirSync(analysisDir, { recursive: true })
  }

  // 2. Validate Config Consistency
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

        if (setupAi !== requestedAiPercent || setupStock !== requestedStockPercent) {
          const err = `VISUAL_MIX_CONFIG_MISMATCH: Setup requested AI=${setupAi} Stock=${setupStock}, pipeline received AI=${requestedAiPercent} Stock=${requestedStockPercent}.`
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

  // 3. Google Flow readiness check: ONLY if AI ratio > 0
  if (targetAiRatio > 0 && !deps?.skipFlowReadiness) {
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

  // 5. Build authoritative Visual Mix Plan (USER INTENT; never rewritten after AI failures)
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
  const stockSceneIndices = plan.stockSceneIndices || initialStockScenes.map((s) => s.sceneIndex)

  // Runtime assertions against ratio inversion
  if (aiScenes.length !== plan.targetAiScenes) {
    throw new Error(
      `VISUAL_MIX_AI_COUNT_MISMATCH expected=${plan.targetAiScenes} actual=${aiScenes.length}`
    )
  }
  if (stockSceneIndices.length !== plan.targetStockScenes) {
    throw new Error(
      `VISUAL_MIX_STOCK_COUNT_MISMATCH expected=${plan.targetStockScenes} actual=${stockSceneIndices.length}`
    )
  }

  // Write visual-input-snapshot.json
  const inputSnapshot = {
    visualSourceMode: mix.mode || 'custom-mix',
    requestedAiPercent,
    requestedStockPercent,
    aiImageRatio: mix.aiImageRatio,
    stockFootageRatio: mix.stockFootageRatio,
    imageOutputResolution: mix.imageOutputResolution || '1080p',
    aiFailureBehavior: failureBehavior,
    profileMode: options.contentProfileMode || 'auto',
    resolvedProfile: profile,
    contentType: profile,
    totalScenes
  }
  fs.writeFileSync(
    path.join(analysisDir, 'visual-input-snapshot.json'),
    JSON.stringify(inputSnapshot, null, 2),
    'utf-8'
  )

  logger.info(
    `[VisualMixInput] profile=${profile} mode=${mix.mode} AI=${requestedAiPercent}% Stock=${requestedStockPercent}% failureBehavior=${failureBehavior} quality=${inputSnapshot.imageOutputResolution}`
  )
  logger.info(
    `[VisualMixPlan] total=${totalScenes} targetAI=${aiScenes.length} targetStock=${initialStockScenes.length}`
  )
  logger.info(
    `[VisualMixOwnership] aiSceneIndices=${aiScenes.length} stockSceneIndices=${stockSceneIndices.length}`
  )

  // 6. Initialize VisualAssignmentStore (single serialized writer of stock-assignments.json)
  const store = new VisualAssignmentStore(projectDir)

  // Reconcile assignments against the CURRENT plan. The plan is authoritative: stale assignments
  // from previous runs with a different mix must never stay active. Files stay on disk (cache),
  // but unused cached file != active assignment.
  for (const s of initialStockScenes) {
    const existing = store.get(s.sceneIndex)
    if (existing?.asset?.provider === 'google-flow') {
      store.delete(s.sceneIndex)
    }
  }
  for (const s of aiScenes) {
    const existing = store.get(s.sceneIndex)
    if (existing && existing.asset?.provider !== 'google-flow') {
      logger.info(
        `[VisualMixReconcile] scene=${s.sceneIndex} is AI-owned; deactivating stale ${existing.asset?.provider ?? 'unknown'} assignment`
      )
      store.delete(s.sceneIndex)
    }
  }
  await store.flushAtomic()

  // 7. Parallel Execution: AI and Stock acquisition start simultaneously
  let aiBranchTimeMs = 0
  let stockBranchTimeMs = 0
  let totalFlowCalls = 0
  let stockEngineInvocations = 0
  let stockSceneTargetsTotal = 0
  let stockDownloadCount = 0

  // ─── Branch A: AI Visual Acquisition ─────────────────────────────────────
  const runAiBranch = async (): Promise<{
    newlyGenerated: number
    cached: number
    failedScenes: VisualMixScenePlan[]
    failures: AiFailureInfo[]
    totalGenMs: number
    totalExpMs: number
    totalNormMs: number
  }> => {
    const t0 = Date.now()

    // 0/100 MUST MEAN ZERO GOOGLE FLOW CALLS
    if (aiScenes.length === 0) {
      aiBranchTimeMs = Date.now() - t0
      logger.info('[VisualMix] 0% AI requested: Skipping AI generation completely.')
      return {
        newlyGenerated: 0,
        cached: 0,
        failedScenes: [],
        failures: [],
        totalGenMs: 0,
        totalExpMs: 0,
        totalNormMs: 0
      }
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
        // Cache miss (new scene, changed prompt/hash, or previously failed): any stale
        // Google Flow assignment for this scene must not remain active.
        store.delete(sc.sceneIndex)
        uncached.push({
          scene: sc,
          config: mix,
          profile,
          projectDir
        })
      }
    }

    await store.flushAtomic()

    logger.info(`[CACHE_SCAN] AI cache hits=${reusedCount} misses=${uncached.length}`)
    logger.info(
      `[VisualMixExecution] AI planned=${aiScenes.length} AI cached=${reusedCount} AI queue=${uncached.length} Stock initial targets=${initialStockScenes.length}`
    )

    totalFlowCalls = uncached.length
    let newlyGenerated = 0
    const failedScenes: VisualMixScenePlan[] = []
    const failures: AiFailureInfo[] = []
    let totalGenMs = 0
    let totalExpMs = 0
    let totalNormMs = 0

    if (uncached.length > 0) {
      const poolResults = await pool.processBatch(
        uncached,
        (msg, prog, stats) => {
          checkAborted(signal)
          const completedTotal = reusedCount + stats.completed
          const failedNote = stats.failed > 0 ? `, ${stats.failed} failed` : ''
          onProgress(
            `AI Visuals: [${completedTotal}/${aiScenes.length}] complete (${stats.generating} generating, ${stats.exporting} exporting${failedNote}) — ${msg}`,
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
          // The scene REMAINS AI-owned (plan untouched); remaining AI work keeps going.
          failedScenes.push(sc)
          failures.push({
            sceneIndex: sc.sceneIndex,
            stage: res.failureStage ?? 'generation',
            reason: res.reason ?? 'AI visual was not produced'
          })
        }
      }

      await store.flushAtomic()
    }

    aiBranchTimeMs = Date.now() - t0
    return {
      newlyGenerated,
      cached: reusedCount,
      failedScenes,
      failures,
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

    // 100/0 MUST MEAN ZERO INITIAL FOOTAGE: return before loading keys / planners / network.
    if (targetIndices.length === 0) {
      if (!isFallback) {
        logger.info('[VisualMix:Stock] initialTargets=0 action=SKIP')
        logger.info('[VisualMix] 0 stock scenes targeted: Skipping stock search completely.')
      }
      return { assigned: 0, failed: 0 }
    }

    // Hard zero-stock guard: strict 100/0 can never reach the Stock engine.
    assertStockAllowed({ config: mix, isFallback, sceneIndices: targetIndices })

    stockEngineInvocations++
    stockSceneTargetsTotal += targetIndices.length

    logger.info(
      `[STOCK_SEARCH] Launching Stock acquisition for ${targetIndices.length} scenes: ${targetIndices.join(', ')} (isFallback=${isFallback})`
    )

    const stockProgressBridge: StageProgressCallback = (msg, pct) => {
      checkAborted(signal)
      onProgress(msg, 0.55 + pct * 0.40)
    }

    // The Stock engine hands its results to the VisualAssignmentStore (single serialized writer)
    // instead of rewriting stock-assignments.json, so concurrent AI results can never be lost.
    let sinkAssigned = 0
    let sinkFailed = 0
    const assignmentSink = async (owned: StockSceneAssignment[]): Promise<void> => {
      store.setMany(owned, true)
      for (const a of owned) {
        if (a.status === 'assigned' && a.asset) sinkAssigned++
        else sinkFailed++
      }
      await store.flushAtomic()
    }

    const baseParams: StockRunParams = {
      projectDir,
      pexelsApiKey: '',
      pixabayApiKey: '',
      preferredAspectRatio:
        (options.resolution?.width ?? 1920) >= (options.resolution?.height ?? 1080)
          ? '16:9'
          : '9:16',
      targetSceneIndices: targetIndices,
      assignmentSink
    }

    if (deps?.stockRunner) {
      await deps.stockRunner(baseParams, stockProgressBridge)
    } else {
      const appCfg = loadConfig()
      const apiKey = resolveGeminiApiKey()
      baseParams.pexelsApiKey = normalizeApiKey(appCfg.pexelsApiKey ?? '')
      baseParams.pixabayApiKey = normalizeApiKey(appCfg.pixabayApiKey ?? '')

      if (apiKey) {
        await runContextAwareStockEngine(
          {
            ...baseParams,
            apiKey,
            model: options.geminiModel,
            forceReanalysis: false
          },
          stockProgressBridge
        )
      } else {
        await runStockEngine({ ...baseParams, preferredAspectRatio: '16:9' }, stockProgressBridge)
      }
    }

    stockDownloadCount += sinkAssigned
    logger.info(`[STOCK_DOWNLOAD] assigned=${sinkAssigned} failed=${sinkFailed} (isFallback=${isFallback})`)

    stockBranchTimeMs += Date.now() - t0
    return { assigned: sinkAssigned, failed: sinkFailed }
  }

  // Launch AI and Stock branches in parallel
  const [aiRes] = await Promise.all([runAiBranch(), runStockBranch(stockSceneIndices, false)])

  checkAborted(signal)

  // 8. AI Failure Handling — STRICT BY DEFAULT.
  const failedAiIndices = aiRes.failedScenes.map((s) => s.sceneIndex)
  let aiFallbackCount = 0
  let strictModeBlockedStockScenes = 0
  const approvedFallbackIndices: number[] = []

  if (failedAiIndices.length > 0) {
    if (failureBehavior === 'stock-fallback') {
      logger.warn(
        `[VisualMix:FallbackDecision] failedAiScenes=${failedAiIndices.length} behavior=stock-fallback action=RUN_STOCK_FALLBACK`
      )
      logger.info(
        `[VisualMixFallback] failedAI=${failedAiIndices.length} behavior=stock-fallback stockFallbackTargets=${failedAiIndices.length}`
      )
      onProgress(`Running stock fallback for ${failedAiIndices.length} failed AI scenes...`, 0.90)

      // Fallback is now actually approved: only now may these scenes be recorded as Stock.
      for (const sc of aiRes.failedScenes) {
        const f = aiRes.failures.find((x) => x.sceneIndex === sc.sceneIndex)
        await recordVisualAssetQueued(projectDir, {
          sceneIndex: sc.sceneIndex,
          strategy: 'stock',
          profile,
          promptHash: sc.generationHash || 'hash',
          status: 'fallback-stock',
          failureStage: f?.stage,
          error: f?.reason,
          generatedAt: new Date().toISOString()
        })
      }

      await runStockBranch(failedAiIndices, true)

      for (const idx of failedAiIndices) {
        const a = store.get(idx)
        if (a && a.status === 'assigned' && a.asset && a.asset.provider !== 'google-flow') {
          approvedFallbackIndices.push(idx)
        }
      }
      aiFallbackCount = approvedFallbackIndices.length
    } else {
      strictModeBlockedStockScenes = failedAiIndices.length
      logger.warn(
        `[VisualMix:FallbackDecision] failedAiScenes=${failedAiIndices.length} behavior=strict requestedAI=${requestedAiPercent} requestedStock=${requestedStockPercent} action=NO_STOCK_FALLBACK`
      )
      logger.info(
        `[VisualMixFallback] failedAI=${failedAiIndices.length} behavior=strict stockFallbackTargets=0`
      )
    }
  }

  checkAborted(signal)

  // 9. Final validation against the authoritative plan (never trust stale assignments).
  await store.flushAtomic()
  const validation = validateFinalVisualAssignments({
    plan,
    assignments: store.getAll(),
    config: mix,
    approvedFallbackSceneIndices: approvedFallbackIndices
  })

  const completion = checkVisualCompletion(projectDir)

  // Provider distribution from the authoritative store
  let completedAiCount = 0
  let completedStockCount = 0
  let googleFlowCount = 0
  let pexelsCount = 0
  let pixabayCount = 0
  let localCount = 0
  const planOwner = new Map<number, string>(plan.scenes.map((s) => [s.sceneIndex, s.strategy]))
  for (const a of store.getAll()) {
    if (!planOwner.has(a.sceneIndex)) continue
    if (a.status !== 'assigned' || !a.asset) continue
    const provider = a.asset.provider
    if (provider === 'google-flow') {
      completedAiCount++
      googleFlowCount++
    } else if (provider === 'pexels') {
      completedStockCount++
      pexelsCount++
    } else if (provider === 'pixabay') {
      completedStockCount++
      pixabayCount++
    } else {
      completedStockCount++
      localCount++
    }
  }

  const failedAiFinal = validation.missingAiSceneIndices
  const needsAttention =
    !validation.valid || completion.missingScenes > 0 || failedAiFinal.length > 0
  const finalStatus = needsAttention ? 'needs-attention' : 'success'

  logger.info(
    `[VisualMixFinal] requestedAI=${aiScenes.length} requestedStock=${initialStockScenes.length} completedAI=${completedAiCount} completedStock=${completedStockCount} failedAI=${failedAiFinal.length} fallbackStock=${aiFallbackCount} status=${finalStatus} (googleFlow=${googleFlowCount} pexels=${pexelsCount} pixabay=${pixabayCount} local=${localCount})`
  )

  const phase2WallTimeMs = Date.now() - phase2StartTime

  // 10. Write visual-performance-report.json
  let flowThrottleInfo = { maxConcurrent: 1, minIntervalS: 3, cooldownActive: false }
  if (!deps?.skipFlowReadiness && aiScenes.length > 0) {
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
  }

  const countStage = (stage: AiVisualFailureStage): number =>
    aiRes.failures.filter((f) => f.stage === stage).length

  const perfReport = {
    resolvedProfile: profile,
    failureBehavior,
    requestedRatio: { ai: requestedAiPercent, stock: requestedStockPercent },
    plannedRatio: { ai: aiScenes.length, stock: initialStockScenes.length },
    requestedAiScenes: aiScenes.length,
    requestedStockScenes: initialStockScenes.length,
    completedAiScenes: completedAiCount,
    completedStockScenes: completedStockCount,
    failedAiScenes: failedAiFinal.length,
    failedAiSceneIndices: failedAiFinal,
    finalRatio: { ai: completedAiCount, stock: completedStockCount },
    providerCounts: {
      googleFlow: googleFlowCount,
      pexels: pexelsCount,
      pixabay: pixabayCount,
      local: localCount
    },
    totalScenes,
    status: finalStatus,
    aiCacheHits: aiRes.cached,
    flowCalls: totalFlowCalls,
    flowSuccessfulCalls: aiRes.newlyGenerated,
    aiGenerationFailures: countStage('generation'),
    aiExportFailures: countStage('export'),
    aiQualityGateFailures: countStage('quality-gate'),
    aiNormalizationFailures: countStage('normalization'),
    stockFallbackAllowed: failureBehavior === 'stock-fallback',
    stockFallbackCount: aiFallbackCount,
    aiFallbackCount,
    strictModeBlockedStockCalls: strictModeBlockedStockScenes,
    stockEngineInvocations,
    stockSceneTargets: stockSceneTargetsTotal,
    // Provider search calls are not individually instrumented; 0 is exact when the Stock engine never ran.
    pexelsSearchCalls: stockEngineInvocations === 0 ? 0 : null,
    pixabaySearchCalls: stockEngineInvocations === 0 ? 0 : null,
    stockDownloadCount,
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

  const baseStats = {
    totalScenes: completion.totalScenes,
    assignedScenes: completion.assignedScenes,
    downloadedScenes: completion.downloadedScenes,
    aiGeneratedScenes: completedAiCount,
    stockScenes: completedStockCount,
    aiFallbackToStock: aiFallbackCount,
    cachedAiScenes: aiRes.cached,
    detectedProfile: isHealth ? 'Health Explainer' : 'General Documentary',
    resolvedProfile: profile,
    requestedAiPercent,
    requestedStockPercent,
    targetAiScenes: aiScenes.length,
    targetStockScenes: initialStockScenes.length,
    failureBehavior,
    failedAiScenes: failedAiFinal.length,
    failedAiSceneIndices: failedAiFinal
  }

  if (!validation.valid) {
    const errorMsg = `VISUAL_MIX_STRICT_ASSIGNMENT_VIOLATION: ${validation.violations
      .map((v) => v.message)
      .join('; ')}`
    logger.error(`[MixedVisualEngine] ${errorMsg}`)
    return {
      success: false,
      needsAttention: true,
      error: errorMsg,
      stats: {
        ...baseStats,
        missingScenes: completion.missingScenes,
        missingSceneIndices: completion.missingSceneIndices
      }
    }
  }

  if (needsAttention) {
    let errorMsg: string
    if (failedAiFinal.length > 0 && failureBehavior === 'strict') {
      const disconnected = aiRes.failures.some((f) => /FLOW_EXTENSION_DISCONNECTED/.test(f.reason))
      const head = disconnected
        ? 'Google Flow disconnected while generating AI visuals. Stock fallback is disabled because selected mix is strict. Completed AI images are preserved.'
        : `${failedAiFinal.length} AI visuals failed and Stock fallback is disabled.`
      errorMsg =
        `${head}\n\nFailed scenes:\n${failedAiFinal.join(', ')}\n\n` +
        `Requested Visual Mix:\nAI ${requestedAiPercent}%\nStock ${requestedStockPercent}%\n\n` +
        'Action:\nRetry failed AI visuals.'
    } else {
      errorMsg = `${completion.missingScenes}/${completion.totalScenes} scenes lack usable visual media (missing: ${completion.missingSceneIndices.join(', ')}).`
    }
    logger.warn(`[MixedVisualEngine] Needs attention: ${errorMsg}`)
    return {
      success: false,
      needsAttention: true,
      error: errorMsg,
      stats: {
        ...baseStats,
        missingScenes: completion.missingScenes,
        missingSceneIndices: completion.missingSceneIndices
      }
    }
  }

  const completionMsg = `${isHealth ? 'Health' : 'Mixed'} visuals completed — ${completion.totalScenes}/${completion.totalScenes} scenes ready · ${completedAiCount} AI stills · ${completedStockCount} stock`
  logger.info(`[MixedVisualEngine] ${completionMsg}`)
  onProgress(completionMsg, 1.0)

  return {
    success: true,
    stats: {
      ...baseStats,
      missingScenes: 0,
      failedScenes: 0,
      percent: 100,
      completionMessage: completionMsg
    }
  }
}
