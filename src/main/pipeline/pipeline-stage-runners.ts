import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { logger } from '../logger'
import { loadConfig } from '../config'
import { normalizeApiKey } from '../utils/api-key'
import { transcribeAudio } from '../transcriber'
import { buildEditPlan } from '../planner'
import { generateCaptionPlan, loadCaptionPlan } from '../captions/caption-planner'
import { analyzeGlobalContext } from '../stock/global-context-analyzer'
import { runContextAwareStockEngine } from '../stock/context-stock-engine'
import { runStockEngine } from '../stock/stock-engine'
import { runAudioDirector, loadAudioPlan } from '../audio/audio-director'
import { runRenderPreflight } from '../qa/render-preflight'
import { renderVideo } from '../renderer'
import { runHealthVisualEngine } from '../health/health-visual-engine'
import { HealthSfxDirector, SfxDirectorSceneInput } from '../health/health-sfx-director'
import type { HealthSfxCuePlan } from '../health/health-visual-types'
import type { ManualAiWaitInfo } from '../../../shared/types'
import { resolveGeminiApiKey, validatePipelinePrerequisites } from './pipeline-validator'
import {
  isTranscriptionValid,
  isPlanningValid,
  isCaptionsValid,
  isGlobalContextValid,
  checkStockCompletion,
  isAudioValid
} from './pipeline-artifacts'
import { loadProductionSettings } from '../production-intelligence/production-settings'
import {
  extractDocumentaryClaims,
  exportClaimManifests
} from '../production-intelligence/claim-evidence-ledger'
import { flattenEditPlanScenes } from '../utils/scene-plan'
import type {
  AutoPipelineOptions,
  CaptionPlan,
  TranscriptResult,
  RenderQaReport
} from './pipeline-types'

/** Optional structured metadata attached to a progress event (null clears it). */
export interface StageProgressMeta {
  manualAiWait?: ManualAiWaitInfo | null
}

export type StageProgressCallback = (
  message: string,
  progress: number,
  meta?: StageProgressMeta
) => void

export interface StageRunResult<T = unknown> {
  success: boolean
  cached?: boolean
  needsAttention?: boolean
  warning?: string
  error?: string
  artifactPath?: string
  data?: T
  stats?: Record<string, unknown>
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Pipeline execution was cancelled.')
  }
}

// ─── Stage 1: Validation ─────────────────────────────────────────────────────

export async function runValidationStage(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult> {
  checkAborted(signal)
  onProgress('Validating inputs and environment...', 0.1)

  const result = await validatePipelinePrerequisites(options)
  checkAborted(signal)

  if (!result.valid) {
    const errorMsg = result.fatalErrors.join('; ')
    return {
      success: false,
      error: errorMsg,
      warning: result.warnings.join('; ')
    }
  }

  onProgress('Validation completed successfully', 1.0)
  return {
    success: true,
    warning: result.warnings.length > 0 ? result.warnings.join('; ') : undefined,
    data: result
  }
}

// ─── Stage 2: Transcription ──────────────────────────────────────────────────

export async function runTranscriptionStage(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult<TranscriptResult>> {
  checkAborted(signal)
  const transcriptPath = path.join(options.projectDir, 'analysis', 'transcript.json')
  const cacheMetaPath = path.join(options.projectDir, 'analysis', 'transcript-meta.json')

  // Check cache
  if (isTranscriptionValid(options.projectDir, options.voiceoverPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(cacheMetaPath, 'utf-8'))
      if (meta.model === (options.whisperModel || 'base')) {
        const cached = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')) as TranscriptResult
        onProgress('Using cached transcript', 1.0)
        return {
          success: true,
          cached: true,
          artifactPath: transcriptPath,
          data: cached
        }
      }
    } catch {
      /* ignore */
    }
  }

  onProgress('Initializing transcription engine...', 0.05)
  checkAborted(signal)

  const transcript = await transcribeAudio(
    options.voiceoverPath,
    options.whisperModel || 'base',
    (msg, prog) => {
      checkAborted(signal)
      onProgress(msg, prog ?? 0.3)
    }
  )

  checkAborted(signal)

  fs.mkdirSync(path.join(options.projectDir, 'analysis'), { recursive: true })
  fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2), 'utf-8')

  const stat = fs.statSync(options.voiceoverPath)
  fs.writeFileSync(
    cacheMetaPath,
    JSON.stringify({
      hash: `${options.voiceoverPath}:${stat.size}:${stat.mtimeMs}`,
      model: options.whisperModel || 'base',
      generatedAt: new Date().toISOString()
    }),
    'utf-8'
  )

  onProgress(`Transcript generated (${transcript.segments.length} segments)`, 1.0)
  return {
    success: true,
    cached: false,
    artifactPath: transcriptPath,
    data: transcript,
    stats: {
      segments: transcript.segments.length,
      duration: transcript.duration
    }
  }
}

// ─── Stage 3: AI Edit Planning ───────────────────────────────────────────────

export async function runPlanningStage(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult> {
  checkAborted(signal)
  const planPath = path.join(options.projectDir, 'analysis', 'master-edit-plan.json')

  // Check cache
  if (isPlanningValid(options.projectDir)) {
    try {
      const cached = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
      onProgress('Using cached master edit plan', 1.0)
      return {
        success: true,
        cached: true,
        artifactPath: planPath,
        data: cached,
        stats: { totalScenes: cached.totalScenes }
      }
    } catch {
      /* ignore */
    }
  }

  const apiKey = resolveGeminiApiKey()
  onProgress('Building master edit plan...', 0.05)
  checkAborted(signal)

  const plan = await buildEditPlan({
    projectDir: options.projectDir,
    apiKey,
    model: options.geminiModel,
    onProgress: (msg, prog) => {
      checkAborted(signal)
      onProgress(msg, prog)
    }
  })

  checkAborted(signal)

  return {
    success: true,
    cached: false,
    artifactPath: planPath,
    data: plan,
    stats: { totalScenes: plan.totalScenes }
  }
}

// ─── Stage 4: Captions ───────────────────────────────────────────────────────

export async function runCaptionsStage(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult<CaptionPlan>> {
  checkAborted(signal)
  const captionPlanPath = path.join(options.projectDir, 'analysis', 'caption-plan.json')

  // Check cache nếu không yêu cầu forceRegenerate
  if (!options.forceRegenerateCaptions && isCaptionsValid(options.projectDir)) {
    try {
      const cached = loadCaptionPlan(options.projectDir)
      if (cached) {
        onProgress('Using cached caption plan', 1.0)
        return {
          success: true,
          cached: true,
          artifactPath: captionPlanPath,
          data: cached,
          stats: { phrases: cached.phrases.length, enabled: cached.enabled }
        }
      }
    } catch {
      /* ignore */
    }
  }

  const apiKey = resolveGeminiApiKey()
  onProgress('Generating dynamic kinetic captions...', 0.05)
  checkAborted(signal)

  let warning: string | undefined
  const plan = await generateCaptionPlan({
    projectDir: options.projectDir,
    apiKey,
    model: options.geminiModel,
    forceRegenerate: options.forceRegenerateCaptions ?? false,
    onProgress: (msg, prog) => {
      checkAborted(signal)
      onProgress(msg, prog)
    }
  })

  checkAborted(signal)

  if (plan.generatedByFallback) {
    warning = 'Caption plan was generated using rule-based fallback algorithm.'
  }

  onProgress(`Captions plan ready (${plan.phrases.length} phrases)`, 1.0)
  return {
    success: true,
    cached: false,
    warning,
    artifactPath: captionPlanPath,
    data: plan,
    stats: { phrases: plan.phrases.length, enabled: plan.enabled }
  }
}

// ─── Stage 5: Global Visual Context ──────────────────────────────────────────

export async function runGlobalContextStage(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult> {
  checkAborted(signal)
  const contextPath = path.join(options.projectDir, 'analysis', 'global-script-context.json')

  let scriptText: string | null = null
  if (options.scriptPath && fs.existsSync(options.scriptPath)) {
    try {
      scriptText = fs.readFileSync(options.scriptPath, 'utf-8')
    } catch {
      /* ignore */
    }
  }

  let transcript: TranscriptResult | null = null
  const transcriptPath = path.join(options.projectDir, 'analysis', 'transcript.json')
  if (fs.existsSync(transcriptPath)) {
    try {
      transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'))
    } catch {
      /* ignore */
    }
  }

  let ctx: any = null
  let isCached = false

  // Check cache
  if (isGlobalContextValid(options.projectDir)) {
    try {
      ctx = JSON.parse(fs.readFileSync(contextPath, 'utf-8'))
      isCached = true
      onProgress('Using cached global script context', 0.5)
    } catch {
      /* ignore */
    }
  }

  const apiKey = resolveGeminiApiKey()

  if (!ctx) {
    onProgress('Analyzing script for Global Visual Context...', 0.05)
    checkAborted(signal)

    ctx = await analyzeGlobalContext({
      projectDir: options.projectDir,
      apiKey,
      model: options.geminiModel,
      scriptText,
      transcript,
      forceRegenerate: false,
      onProgress: (msg, pct) => {
        checkAborted(signal)
        onProgress(msg, pct * 0.7)
      }
    })
    checkAborted(signal)
  }

  // ── Claim & Evidence Analysis (runs right after Global Visual Context) ─────
  const prodSettings = loadProductionSettings(options.projectDir)
  const isClaimEnabled =
    prodSettings.claimEvidenceEnabled ??
    prodSettings.productionIntelligence?.claimEvidenceEnabled ??
    true

  let claimStats: { totalClaims: number; unsourced: number } | undefined

  if (isClaimEnabled) {
    const planPath = path.join(options.projectDir, 'analysis', 'master-edit-plan.json')
    if (fs.existsSync(planPath)) {
      try {
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
        const flattened = flattenEditPlanScenes(plan)
        const sceneInputs = flattened.map((e) => ({
          sceneId: e.sceneId,
          sceneIndex: e.scene.sceneIndex,
          narration: e.scene.narrativeText ?? '',
          visualIntent: e.scene.visualIntent,
          chapterId: `CH${e.chapterIndex}`,
          chapterTitle: e.chapterTitle
        }))

        if (sceneInputs.length > 0) {
          onProgress('Analyzing script for Claim & Evidence Ledger...', 0.75)
          checkAborted(signal)
          const ledger = await extractDocumentaryClaims({
            projectDir: options.projectDir,
            scriptText,
            globalContext: ctx,
            scenes: sceneInputs,
            apiKey,
            model: options.geminiModel,
            onProgress: (msg, prog) => {
              checkAborted(signal)
              onProgress(`[ClaimLedger] ${msg}`, 0.75 + prog * 0.23)
            }
          })
          claimStats = {
            totalClaims: ledger.claims.length,
            unsourced: ledger.summary.unsourced
          }
        }
      } catch (claimErr) {
        logger.warn(`[ClaimLedger] Claim analysis warning: ${String(claimErr)}, continuing pipeline.`)
      }
    }
  }

  onProgress('Global Visual Context & Claim Analysis completed', 1.0)

  return {
    success: true,
    cached: isCached,
    artifactPath: contextPath,
    data: ctx,
    stats: {
      primarySubject: ctx?.primarySubject,
      anchorsCount: ctx?.exactTopicAnchors?.length ?? 0,
      claimsCount: claimStats?.totalClaims ?? 0,
      unsourcedClaims: claimStats?.unsourced ?? 0
    }
  }
}

import { resolveVisualMixConfig } from '../visual-mix/visual-mix-config'
import { runMixedVisualEngine } from '../visual-mix/mixed-visual-engine'
import {
  detectOrResolveContentProfile,
  loadContentProfileArtifact
} from '../visual-mix/content-profile-detector'
import { resolveContentProfileMode } from '../../../shared/types'

// ─── Stage 6: Stock Search & Candidate Ranking ───────────────────────────────

export async function runStockSearchStage(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult> {
  checkAborted(signal)

  const mix = resolveVisualMixConfig(options)

  if (mix.mode === 'custom-mix') {
    const mode = options.contentProfileMode ?? resolveContentProfileMode(options)
    onProgress('Resolving content profile...', 0.02)
    const detection = await detectOrResolveContentProfile({
      projectDir: options.projectDir,
      mode
    })
    const profile = detection.resolvedProfile

    return runMixedVisualEngine({
      options,
      profile,
      mix,
      onProgress,
      signal
    })
  }

  // Đảm bảo Global Context đã tồn tại trước khi chạy stock
  if (!isGlobalContextValid(options.projectDir)) {
    return {
      success: false,
      error: 'Global Visual Context must complete before Stock Search can run.'
    }
  }

  // Pre-check: Kiểm tra artifact stock thực tế trên đĩa trước khi gọi engine
  // Nếu đã đủ 100% scenes hợp lệ, hoàn tất ngay lập tức mà không gọi Pexels/Pixabay
  const initialStockSummary = checkStockCompletion(options.projectDir)
  if (
    initialStockSummary.totalScenes > 0 &&
    initialStockSummary.assignedScenes === initialStockSummary.totalScenes &&
    initialStockSummary.missingScenes === 0
  ) {
    logger.info(
      `[StockStage] Reconciled stock on disk: all ${initialStockSummary.totalScenes}/${initialStockSummary.totalScenes} scenes assigned & verified. Reusing.`
    )
    const completionMsg = `Stock search completed — ${initialStockSummary.totalScenes}/${initialStockSummary.totalScenes} scenes assigned`
    onProgress(completionMsg, 1.0)
    return {
      success: true,
      cached: true,
      stats: {
        totalScenes: initialStockSummary.totalScenes,
        assignedScenes: initialStockSummary.assignedScenes,
        downloadedScenes: initialStockSummary.downloadedScenes,
        missingScenes: 0,
        failedScenes: 0,
        percent: 100,
        completionMessage: completionMsg,
        lowConfidenceScenes: initialStockSummary.lowConfidenceScenes
      }
    }
  }

  const appCfg = loadConfig()
  const apiKey = resolveGeminiApiKey()
  const pexelsKey = normalizeApiKey(appCfg.pexelsApiKey ?? '')
  const pixabayKey = normalizeApiKey(appCfg.pixabayApiKey ?? '')

  onProgress('Starting context-aware stock search...', 0.05)
  checkAborted(signal)

  if (apiKey) {
    await runContextAwareStockEngine(
      {
        projectDir: options.projectDir,
        pexelsApiKey: pexelsKey,
        pixabayApiKey: pixabayKey,
        preferredAspectRatio: (options.resolution?.width ?? 1920) >= (options.resolution?.height ?? 1080) ? '16:9' : '9:16',
        apiKey,
        model: options.geminiModel,
        forceReanalysis: false // Tái sử dụng Global Context cache, không gọi trùng lặp
      },
      (msg, pct) => {
        checkAborted(signal)
        onProgress(msg, pct)
      }
    )
  } else {
    await runStockEngine(
      {
        projectDir: options.projectDir,
        pexelsApiKey: pexelsKey,
        pixabayApiKey: pixabayKey,
        preferredAspectRatio: '16:9'
      },
      (msg, pct) => {
        checkAborted(signal)
        onProgress(msg, pct)
      }
    )
  }

  checkAborted(signal)

  // Kiểm tra điều kiện hoàn thành stock từ file thực tế trên đĩa (Single source of truth)
  const stockSummary = checkStockCompletion(options.projectDir)

  if (stockSummary.missingScenes > 0) {
    const errorMsg = `${stockSummary.missingScenes}/${stockSummary.totalScenes} scenes lack downloadable stock media.`
    logger.warn(`[StockStage] Needs attention: ${errorMsg}`)
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
        lowConfidenceScenes: stockSummary.lowConfidenceScenes
      }
    }
  }

  let warning: string | undefined
  if (stockSummary.lowConfidenceScenes > 0) {
    warning = `${stockSummary.lowConfidenceScenes} scenes have low-confidence stock matches.`
  }

  // Đảm bảo message và stats chính xác 100%, không bị kẹt ở progress trung gian
  const finalMsg = `Stock search completed — ${stockSummary.totalScenes}/${stockSummary.totalScenes} scenes assigned`
  onProgress(finalMsg, 1.0)
  return {
    success: true,
    warning,
    stats: {
      totalScenes: stockSummary.totalScenes,
      assignedScenes: stockSummary.assignedScenes,
      downloadedScenes: stockSummary.downloadedScenes,
      missingScenes: 0,
      failedScenes: 0,
      percent: 100,
      completionMessage: finalMsg,
      lowConfidenceScenes: stockSummary.lowConfidenceScenes
    }
  }
}

// ─── Stage 7: Background Music & Audio ───────────────────────────────────────

export async function runAudioSearchStage(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult> {
  checkAborted(signal)
  const audioPlanPath = path.join(options.projectDir, 'analysis', 'audio-plan.json')

  const profileArtifact = loadContentProfileArtifact(options.projectDir)
  const isHealthAudio = profileArtifact
    ? profileArtifact.resolvedProfile === 'health'
    : (options.contentProfileMode === 'health' || options.contentType === 'health')

  // Check cache nếu audio plan đã tồn tại và hợp lệ
  if (isAudioValid(options.projectDir, options.requireBackgroundMusic, isHealthAudio ? 'health' : 'default')) {
    const cachedPlan = loadAudioPlan(options.projectDir)
    if (cachedPlan) {
      const downloadedMusicCount = cachedPlan.sections.filter(
        (s) => s.approved && s.approvedLocalPath && fs.existsSync(s.approvedLocalPath)
      ).length
      onProgress(`Using existing audio plan (${downloadedMusicCount} music tracks)`, 1.0)
      return {
        success: true,
        cached: true,
        artifactPath: audioPlanPath,
        data: cachedPlan,
        stats: {
          sectionsCount: cachedPlan.sections.length,
          downloadedMusicCount,
          sfxCount: cachedPlan.sfxAssignments?.length ?? 0
        }
      }
    }
  }

  onProgress('Searching and downloading background music & SFX...', 0.05)
  checkAborted(signal)

  const result = await runAudioDirector(
    options.projectDir,
    (msg, pct) => {
      checkAborted(signal)
      onProgress(msg, pct)
    }
  )

  checkAborted(signal)

  // Health Mode: Auto-plan, auto-approve, and download Health cinematic SFX only when profile === 'health'
  if (isHealthAudio) {
    const healthPlanPath = path.join(options.projectDir, 'analysis', 'health-visual-plan.json')
    if (fs.existsSync(healthPlanPath)) {
      try {
        const healthPlan = JSON.parse(fs.readFileSync(healthPlanPath, 'utf-8'))
        const sfxCues = new Map<number, HealthSfxCuePlan>()
        const sfxScenes: SfxDirectorSceneInput[] = []
        for (const sc of healthPlan.scenes || []) {
          if (sc.sfxCue) {
            sfxCues.set(sc.sceneIndex, sc.sfxCue)
            sfxScenes.push({
              sceneIndex: sc.sceneIndex,
              startTime: sc.startTime,
              endTime: sc.endTime,
              duration: sc.duration,
              category: sc.category,
              narration: sc.narration,
              visualIntent: sc.visualIntent,
              motionPreset: sc.motionPreset
            })
          }
        }
        if (sfxCues.size > 0) {
          onProgress('Planning and downloading Health cinematic SFX...', 0.90)
          await HealthSfxDirector.applyHealthSfxToAudioPlan(
            options.projectDir,
            sfxCues,
            sfxScenes,
            options.openverseToken
          )
        }
      } catch (err) {
        logger.warn(`[HealthSFX] Failed to apply Health SFX: ${err}`)
      }
    }
  }

  const plan = loadAudioPlan(options.projectDir)
  const downloadedMusicCount = plan?.sections.filter(
    (s) => s.approved && s.approvedLocalPath && fs.existsSync(s.approvedLocalPath)
  ).length ?? 0
  const downloadedSfxCount = plan?.sfxAssignments.filter(
    (s) => s.approved && s.approvedLocalPath && fs.existsSync(s.approvedLocalPath)
  ).length ?? 0

  if (downloadedMusicCount === 0 && options.requireBackgroundMusic) {
    return {
      success: false,
      needsAttention: true,
      error: 'No background music found, but requireBackgroundMusic option is enabled.'
    }
  }

  let warning: string | undefined
  if (downloadedMusicCount === 0) {
    warning = 'No background music tracks were downloaded. Video will render voiceover-only.'
  }

  onProgress(`Audio plan ready (${downloadedMusicCount} music tracks, ${downloadedSfxCount} SFX)`, 1.0)
  return {
    success: true,
    warning,
    artifactPath: audioPlanPath,
    data: plan || result,
    stats: {
      sectionsCount: plan?.sections.length ?? result.sections.length,
      downloadedMusicCount,
      sfxCount: plan?.sfxAssignments.length ?? result.sfxAssignments.length
    }
  }
}

// ─── Stage 8: Render Preflight QA ────────────────────────────────────────────

export async function runPreflightStage(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult<RenderQaReport>> {
  checkAborted(signal)
  onProgress('Running render preflight inspection...', 0.1)

  let captionPlan: CaptionPlan | undefined
  try {
    const loaded = loadCaptionPlan(options.projectDir)
    if (loaded?.enabled && loaded.phrases.length > 0) {
      captionPlan = loaded
    }
  } catch {
    /* ignore */
  }

  checkAborted(signal)

  const report = await runRenderPreflight({
    projectDir: options.projectDir,
    voiceoverPath: options.voiceoverPath,
    captionPlan
  })

  checkAborted(signal)

  const preflightPath = path.join(options.projectDir, 'analysis', 'render-preflight.json')

  if (report.status === 'failed') {
    const fatalIssues = report.issues.filter((i) => i.severity === 'fatal')
    const msg = fatalIssues.map((i) => i.message).join('; ')
    logger.warn(`[PreflightStage] Preflight QA failed with fatal issues: ${msg}`)
    return {
      success: false,
      needsAttention: true,
      error: `Preflight checks failed: ${msg}`,
      artifactPath: preflightPath,
      data: report
    }
  }

  const warnings = report.issues.filter((i) => i.severity === 'warning').map((i) => i.message)
  onProgress('Preflight QA checks passed', 1.0)

  return {
    success: true,
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
    artifactPath: preflightPath,
    data: report,
    stats: {
      status: report.status,
      issuesCount: report.issues.length
    }
  }
}

// ─── Stage 9: Render ─────────────────────────────────────────────────────────

export async function runRenderStage(
  options: AutoPipelineOptions,
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult<{ outputPath: string; durationSecs: number; fileSizeBytes: number }>> {
  checkAborted(signal)

  const outputDir = path.join(options.projectDir, 'output')
  fs.mkdirSync(outputDir, { recursive: true })

  // Clean up any stale partial files from an interrupted prior run
  try {
    const outputFiles = fs.readdirSync(outputDir)
    for (const file of outputFiles) {
      if (file.endsWith('.partial.mp4') || file.includes('_working.mp4')) {
        const partialPath = path.join(outputDir, file)
        try {
          fs.unlinkSync(partialPath)
          logger.info(`[RenderStage] Cleaned up stale partial file from interrupted run: ${file}`)
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }

  // Kiểm tra xem đã có video render hoàn chỉnh và hợp lệ trên đĩa chưa
  const baseTargetName = options.outputName || 'final_output'
  const defaultCompletedVideo = path.join(outputDir, `${baseTargetName}.mp4`)
  if (fs.existsSync(defaultCompletedVideo)) {
    try {
      const stat = fs.statSync(defaultCompletedVideo)
      if (stat.size > 1024 * 1024) {
        onProgress('Found valid completed video output, skipping render', 1.0)
        return {
          success: true,
          cached: true,
          artifactPath: defaultCompletedVideo,
          data: {
            outputPath: defaultCompletedVideo,
            durationSecs: 0,
            fileSizeBytes: stat.size
          },
          stats: {
            outputPath: defaultCompletedVideo,
            fileSizeBytes: stat.size,
            reused: true
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Load CaptionPlan nếu có
  let captionPlan: CaptionPlan | undefined
  try {
    const loaded = loadCaptionPlan(options.projectDir)
    if (loaded?.enabled && loaded.phrases.length > 0) {
      captionPlan = loaded
    }
  } catch {
    /* ignore */
  }

  // Đảm bảo không ghi đè file output đang tồn tại
  let targetName = baseTargetName
  let candidatePath = path.join(outputDir, `${targetName}.mp4`)
  let counter = 1
  while (fs.existsSync(candidatePath)) {
    targetName = `${baseTargetName}_${counter}`
    candidatePath = path.join(outputDir, `${targetName}.mp4`)
    counter++
  }

  onProgress(`Starting render (${targetName}.mp4)...`, 0.02)
  checkAborted(signal)

  const result = await renderVideo({
    projectDir: options.projectDir,
    voiceoverPath: options.voiceoverPath,
    outputName: targetName,
    resolution: options.resolution,
    fps: options.fps,
    transitionSettings: options.transitionSettings,
    captionPlan,
    onProgress: (p) => {
      checkAborted(signal)
      onProgress(p.stage, p.progress)
    }
  })

  checkAborted(signal)

  return {
    success: true,
    artifactPath: result.outputPath,
    data: result,
    stats: {
      outputPath: result.outputPath,
      durationSecs: result.durationSecs,
      fileSizeBytes: result.fileSizeBytes
    }
  }
}

// ─── Stage 10: Postflight QA ─────────────────────────────────────────────────

export async function runPostflightStage(
  options: AutoPipelineOptions,
  renderResult: { outputPath: string },
  onProgress: StageProgressCallback,
  signal?: AbortSignal
): Promise<StageRunResult> {
  checkAborted(signal)
  onProgress('Validating final rendered video...', 0.2)

  const { outputPath } = renderResult
  if (!outputPath || !fs.existsSync(outputPath)) {
    return {
      success: false,
      error: `Render output file does not exist: ${outputPath || '(none)'}`
    }
  }

  const stat = fs.statSync(outputPath)
  if (stat.size === 0) {
    return {
      success: false,
      error: `Render output file is empty: ${outputPath}`
    }
  }

  // Đọc report postflight từ render nếu có
  const qaPath = path.join(options.projectDir, 'analysis', 'render-qa.json')
  let qaReport: RenderQaReport | null = null
  if (fs.existsSync(qaPath)) {
    try {
      qaReport = JSON.parse(fs.readFileSync(qaPath, 'utf-8')) as RenderQaReport
    } catch {
      /* ignore */
    }
  }

  // ── Manifest Export (sources.csv, licenses.json, claim-evidence-ledger.json)
  let exportWarning: string | undefined
  try {
    const exportRes = exportClaimManifests(options.projectDir)
    if (!exportRes.success) {
      exportWarning = `Source manifest export warning: ${exportRes.error}`
      logger.warn(`[EvidenceExport] ${exportWarning}`)
    }
  } catch (expErr) {
    exportWarning = `Source manifest export error: ${String(expErr)}`
    logger.warn(`[EvidenceExport] ${exportWarning}`)
  }

  onProgress('Video production completed successfully!', 1.0)
  return {
    success: true,
    warning: exportWarning,
    artifactPath: outputPath,
    data: {
      outputPath,
      fileSizeMB: (stat.size / (1024 * 1024)).toFixed(2),
      qaReport
    },
    stats: {
      fileSizeMB: (stat.size / (1024 * 1024)).toFixed(2),
      qaStatus: qaReport?.status ?? 'passed'
    }
  }
}
