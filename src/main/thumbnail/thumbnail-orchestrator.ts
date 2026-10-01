import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { logger } from '../logger'
import { IPC_CHANNELS } from '../../../shared/types'
import { thumbnailPlanner } from './thumbnail-planner'
import { googleFlowProvider, GoogleFlowProvider } from './providers/google-flow-provider'
import { flowkitRuntimeManager, FlowReadinessResult } from './flowkit-runtime-manager'
import {
  loadThumbnailJobState,
  saveThumbnailJobStateAtomic,
  createInitialThumbnailJobState,
  createCandidatesFromPlan,
  isThumbnailLeaseStale
} from './thumbnail-state'
import {
  getCandidateImagePath,
  getRoundDirectory,
  reconcileThumbnailArtifacts,
  saveThumbnailManifest,
  selectThumbnailCandidate
} from './thumbnail-artifacts'
import {
  loadProjectThumbnailSettings,
  saveProjectThumbnailSettings,
  computeSha256
} from './thumbnail-settings-manager'
import type {
  ThumbnailJobState,
  ThumbnailCandidate,
  ThumbnailProgressPayload,
  ThumbnailPlan
} from '../../../shared/types'

// ─── Error types ──────────────────────────────────────────────────────────────

/** Structured error thrown by generation pipeline */
export class ThumbnailFlowError extends Error {
  public readonly code: string
  public readonly retryable: boolean
  public readonly scope: 'connector' | 'candidate' | 'job'

  constructor(code: string, message: string, retryable: boolean, scope: 'connector' | 'candidate' | 'job') {
    super(message)
    this.name = 'ThumbnailFlowError'
    this.code = code
    this.retryable = retryable
    this.scope = scope
  }
}

export class ThumbnailCancelledError extends Error {
  constructor() {
    super('THUMBNAIL_JOB_CANCELLED: Generation was cancelled.')
    this.name = 'ThumbnailCancelledError'
  }
}

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface ThumbnailStartJobParams {
  projectDir: string
  renderOutputPath?: string
  scriptPath?: string
  templateId?: string
  templateSnapshot?: string
  preferredModel?: string
  generationRound?: number
  forceRestart?: boolean
  cooldownMs?: number
}

/** Minimal interface for testability — production uses FlowKitRuntimeManager */
export interface ReadinessChecker {
  ensureFlowReady(bridgeUrl?: string): Promise<FlowReadinessResult>
  isBridgeStillReachable(bridgeUrl?: string): Promise<boolean>
  getSettings(): { bridgeUrl: string }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Abortable delay. Resolves immediately if signal is already aborted.
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ThumbnailCancelledError())
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ThumbnailCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Classify raw fetch/generation errors into structured ThumbnailFlowError.
 * Extracts ECONNREFUSED from error.cause so the user sees the real reason.
 */
function classifyGenerationError(err: unknown, bridgeUrl: string): ThumbnailFlowError {
  const rawMsg = err instanceof Error ? err.message : String(err)

  // Extract Node.js cause (ECONNREFUSED, ETIMEDOUT etc.)
  const cause = err instanceof Error
    ? (err as Error & { cause?: { code?: string } }).cause
    : undefined
  const causeCode = cause?.code || ''

  // Already classified
  if (rawMsg.startsWith('FLOWKIT_BRIDGE_OFFLINE') || causeCode === 'ECONNREFUSED' || rawMsg.includes('ECONNREFUSED')) {
    return new ThumbnailFlowError(
      'FLOWKIT_BRIDGE_OFFLINE',
      `FlowKit is not running at ${bridgeUrl}. Start FlowKit with: python -m agent.main`,
      false,
      'connector'
    )
  }
  if (rawMsg.includes('fetch failed') || rawMsg.includes('Failed to fetch') || rawMsg.includes('ENOTFOUND')) {
    return new ThumbnailFlowError(
      'FLOWKIT_BRIDGE_OFFLINE',
      `FlowKit bridge is not running at ${bridgeUrl}. Start FlowKit with: python -m agent.main`,
      false,
      'connector'
    )
  }
  if (rawMsg.startsWith('FLOWKIT_TIMEOUT') || rawMsg.includes('ETIMEDOUT') || rawMsg.includes('timed out')) {
    return new ThumbnailFlowError(
      'FLOWKIT_TIMEOUT',
      'FlowKit bridge request timed out. The bridge may be overloaded or unresponsive.',
      true,
      'candidate'
    )
  }
  if (rawMsg.startsWith('FLOW_EXTENSION_DISCONNECTED') || rawMsg.includes('FLOW_EXTENSION_DISCONNECTED')) {
    return new ThumbnailFlowError(
      'FLOW_EXTENSION_DISCONNECTED',
      'Chrome extension is disconnected. Open Google Flow in Chrome and reconnect the extension.',
      false,
      'connector'
    )
  }
  if (rawMsg.startsWith('FLOW_RATE_LIMITED')) {
    return new ThumbnailFlowError(
      'FLOW_RATE_LIMITED',
      rawMsg.replace('FLOW_RATE_LIMITED:', '').trim() || 'Google Flow rate limit reached.',
      true,
      'candidate'
    )
  }
  if (rawMsg.startsWith('FLOW_RECAPTCHA_FAILED')) {
    return new ThumbnailFlowError(
      'FLOW_RECAPTCHA_FAILED',
      rawMsg.replace('FLOW_RECAPTCHA_FAILED:', '').trim() || 'reCAPTCHA verification failed.',
      true,
      'candidate'
    )
  }
  if (rawMsg.startsWith('FLOW_GENERATION_FAILED') || rawMsg.startsWith('FLOW_EXPORT_FAILED')) {
    const [code, ...rest] = rawMsg.split(':')
    return new ThumbnailFlowError(code, rest.join(':').trim() || rawMsg, false, 'candidate')
  }
  if (rawMsg.includes('THUMBNAIL_JOB_CANCELLED') || err instanceof ThumbnailCancelledError) {
    return new ThumbnailFlowError('THUMBNAIL_JOB_CANCELLED', 'Generation was cancelled.', false, 'job')
  }

  return new ThumbnailFlowError('FLOW_GENERATION_FAILED', rawMsg, false, 'candidate')
}

/**
 * Add a diagnostic string to an array only if not already present (by prefix match).
 */
function addUniqueDiagnostic(arr: string[], message: string): boolean {
  // Use first 60 chars as key (ignore timestamp/count suffix)
  const key = message.substring(0, 60)
  const exists = arr.some((e) => e.substring(0, 60) === key)
  if (!exists) {
    arr.push(message)
    return true
  }
  return false
}

/**
 * Reconcile candidate statuses after loading from disk or when bridge goes offline.
 * - generating/exporting without active run → pending
 * - completed with valid file → keep
 * - completed with missing file → pending
 */
function reconcileCandidatesForResume(
  state: ThumbnailJobState,
  projectDir: string,
  hasActiveRun: boolean
): boolean {
  let changed = false
  for (const c of state.candidates) {
    if (c.status === 'generating' || c.status === 'exporting') {
      if (!hasActiveRun) {
        c.status = 'pending'
        c.error = undefined
        changed = true
      }
    } else if (c.status === 'completed') {
      const filePath = c.exportedImagePath || getCandidateImagePath(projectDir, c.round, c.optionId, c.revision)
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        c.status = 'pending'
        c.error = undefined
        changed = true
      }
    }
  }
  return changed
}

/**
 * Derive overall job status from candidates.
 */
function deriveJobStatus(
  state: ThumbnailJobState,
  hasActiveRun: boolean
): ThumbnailJobState['status'] {
  const candidates = state.candidates
  const completedCount = candidates.filter((c) => c.status === 'completed').length
  const failedCount = candidates.filter((c) => c.status === 'failed').length
  const runningCount = candidates.filter((c) => c.status === 'generating' || c.status === 'exporting').length
  const pendingCount = candidates.filter((c) => c.status === 'pending').length
  const total = candidates.length

  if (state.status === 'cancelled') return 'cancelled'

  if (completedCount === total && total > 0) return 'completed'

  if (runningCount > 0 || (pendingCount > 0 && hasActiveRun)) return 'generating'

  if (completedCount > 0 && (failedCount > 0 || pendingCount > 0)) return 'partial'

  if (pendingCount > 0 && !hasActiveRun) return 'interrupted'

  if (failedCount > 0) {
    const allConnectorFailed = candidates
      .filter((c) => c.status === 'failed')
      .every((c) => c.error && (
        c.error.includes('FLOWKIT_BRIDGE_OFFLINE') ||
        c.error.includes('ECONNREFUSED') ||
        c.error.includes('fetch failed') ||
        c.error.includes('FLOW_EXTENSION_DISCONNECTED')
      ))
    return allConnectorFailed ? 'needs-attention' : 'failed'
  }

  return state.status
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class ThumbnailOrchestrator {
  /** Single-flight map: projectDir → active run. Only ONE run per project allowed. */
  private activeJobs = new Map<string, { abortController: AbortController; promise: Promise<ThumbnailJobState>; jobId: string }>()
  private provider: GoogleFlowProvider
  private defaultCooldownMs = 8000
  private runtimeManager: ReadinessChecker

  constructor(provider?: GoogleFlowProvider, runtimeManager?: ReadinessChecker) {
    this.provider = provider || googleFlowProvider
    this.runtimeManager = runtimeManager || flowkitRuntimeManager
  }

  public setRuntimeManager(rm: ReadinessChecker): void {
    this.runtimeManager = rm
  }

  public setCooldownMs(ms: number): void {
    this.defaultCooldownMs = ms
  }

  // ─── getJobState ─────────────────────────────────────────────────────────

  public async getJobState(projectDir: string): Promise<ThumbnailJobState | null> {
    const state = loadThumbnailJobState(projectDir)
    if (!state) return null

    const hasActiveRun = this.activeJobs.has(projectDir)

    // Reconcile with disk artifacts
    const changed1 = reconcileThumbnailArtifacts(projectDir, state)

    // Reconcile stale generating/exporting candidates
    const changed2 = reconcileCandidatesForResume(state, projectDir, hasActiveRun)

    // Reconcile stuck job status: if state says 'generating' but no runner active
    let changed3 = false
    if (state.status === 'generating' && !hasActiveRun) {
      const derived = deriveJobStatus(state, false)
      if (derived !== state.status) {
        logger.info(`[ThumbnailOrchestrator] Reconciled stuck job for ${projectDir}: ${state.status}→${derived}`)
        state.status = derived
        changed3 = true
      }
    }

    if (changed1 || changed2 || changed3) {
      saveThumbnailJobStateAtomic(projectDir, state)
    }

    return state
  }

  // ─── startJob ────────────────────────────────────────────────────────────

  public async startJob(params: ThumbnailStartJobParams): Promise<ThumbnailJobState> {
    const { projectDir } = params

    // SINGLE-FLIGHT LOCK — refuse duplicate starts
    const existing = this.activeJobs.get(projectDir)
    if (existing) {
      logger.info(`[ThumbnailOrchestrator] Job already actively running for ${projectDir} (jobId=${existing.jobId}). Returning existing.`)
      return existing.promise
    }

    // Load settings & script
    const settings = await loadProjectThumbnailSettings(projectDir)
    const script = this.resolveScriptText(projectDir, params.scriptPath)
    const scriptHash = computeSha256(script || 'no-script')
    const templateSnapshot = params.templateSnapshot || settings.templateSnapshot || ''
    const templateSnapshotHash = computeSha256(templateSnapshot)

    const renderOutputPath = params.renderOutputPath || this.resolveRenderOutputPath(projectDir)
    let renderFileSize = 0
    let renderMtimeMs = 0
    if (renderOutputPath && fs.existsSync(renderOutputPath)) {
      const st = fs.statSync(renderOutputPath)
      renderFileSize = st.size
      renderMtimeMs = st.mtimeMs
    }

    const round = params.generationRound || 1

    // Idempotency: if already completed for this round, just return it
    const existingState = loadThumbnailJobState(projectDir)
    if (existingState && !params.forceRestart) {
      if (existingState.status === 'completed' && existingState.generationRound === round) {
        logger.info(`[ThumbnailOrchestrator] Completed job found for round ${round}. Skipping.`)
        return existingState
      }
      // Stale lease from previous crash → reconcile to 'interrupted' and return.
      // Do NOT auto-resume here (would trigger preflight/generation without user intent).
      // The user will click Resume manually when FlowKit is ready.
      if (existingState.status === 'generating' && isThumbnailLeaseStale(existingState.lease)) {
        logger.info(`[ThumbnailOrchestrator] Stale lease detected. Reconciling to interrupted state.`)
        existingState.status = 'interrupted'
        // Reset in-flight candidates to pending
        for (const c of existingState.candidates) {
          if (c.status === 'generating' || c.status === 'exporting') {
            c.status = 'pending'
            c.error = undefined
          }
        }
        if (existingState.lease) delete existingState.lease
        saveThumbnailJobStateAtomic(projectDir, existingState)
        return existingState
      }
    }

    // ── PREFLIGHT — must pass before any generation starts ────────────────────
    const readiness = await this.runtimeManager.ensureFlowReady()
    if (!readiness.ready) {
      logger.warn(`[ThumbnailOrchestrator] startJob preflight failed: ${readiness.blockingCode} — ${readiness.message}`)
      return this.markNeedsAttention(projectDir, readiness, { renderOutputPath, renderFileSize, renderMtimeMs, scriptHash, templateSnapshotHash, round, params, settings, templateSnapshot })
    }

    // ── Create abort controller and register BEFORE execution starts ──────────
    const abortController = new AbortController()
    const jobIdPlaceholder = `job-${Date.now()}`

    const executionPromise = (async (): Promise<ThumbnailJobState> => {
      try {
        // Step A: Planning
        let state: ThumbnailJobState

        // If existing state already has candidates for this round, reuse them
        if (existingState && existingState.candidates.length === 5 && existingState.generationRound === round && !params.forceRestart) {
          state = existingState
          // Reconcile stale candidates (was 'generating' from previous crashed run)
          reconcileCandidatesForResume(state, projectDir, true)
          state.status = 'generating'
          state.updatedAt = new Date().toISOString()
          saveThumbnailJobStateAtomic(projectDir, state)
        } else {
          this.broadcastProgress({
            projectDir,
            jobId: jobIdPlaceholder,
            status: 'planning',
            stage: 'planning',
            completedCount: 0,
            totalCount: 5,
            progress: 0.1,
            message: 'Generating 5 distinct thumbnail concepts from script...'
          })

          const plan = await thumbnailPlanner.plan({
            projectDir,
            templateId: params.templateId || settings.selectedTemplateId,
            templateSnapshot,
            preferredModel: params.preferredModel,
            generationRound: round
          })

          state = createInitialThumbnailJobState({
            projectDir,
            renderOutputPath,
            renderFileSize,
            renderMtimeMs,
            scriptHash,
            templateSnapshotHash,
            generationRound: round,
            plan
          })

          saveThumbnailJobStateAtomic(projectDir, state)
        }

        // Reconcile artifacts
        reconcileThumbnailArtifacts(projectDir, state)
        saveThumbnailJobStateAtomic(projectDir, state)

        // Step B: Sequential generation
        const cooldown = params.cooldownMs ?? this.defaultCooldownMs
        await this.runSequentialCandidates(state, abortController.signal, cooldown)

        // Step C: Finalize
        return this.finalizeJob(state, projectDir)
      } finally {
        this.activeJobs.delete(projectDir)
      }
    })()

    this.activeJobs.set(projectDir, { abortController, promise: executionPromise, jobId: jobIdPlaceholder })
    return executionPromise
  }

  // ─── resumeJob ───────────────────────────────────────────────────────────

  public async resumeJob(projectDir: string): Promise<ThumbnailJobState> {
    // SINGLE-FLIGHT LOCK — refuse duplicate resumes
    const existing = this.activeJobs.get(projectDir)
    if (existing) {
      logger.info(`[ThumbnailOrchestrator] Resume requested but job already running (jobId=${existing.jobId}). Returning existing.`)
      return existing.promise
    }

    const state = loadThumbnailJobState(projectDir)
    if (!state) {
      throw new Error(`No thumbnail job state found to resume for ${projectDir}`)
    }

    // Reconcile disk artifacts and stale candidates BEFORE preflight
    reconcileThumbnailArtifacts(projectDir, state)
    reconcileCandidatesForResume(state, projectDir, false) // no active run yet

    const incomplete = state.candidates.filter((c) => c.status !== 'completed')
    if (incomplete.length === 0) {
      state.status = 'completed'
      state.completedAt = state.completedAt || new Date().toISOString()
      saveThumbnailJobStateAtomic(projectDir, state)
      return state
    }

    // ── PREFLIGHT — MUST run before any candidate status is changed ───────────
    const readiness = await this.runtimeManager.ensureFlowReady()
    if (!readiness.ready) {
      logger.warn(`[ThumbnailOrchestrator] Resume preflight failed: ${readiness.blockingCode}`)

      // Reconcile: any candidate still 'generating'/'exporting' → 'pending'
      for (const c of state.candidates) {
        if (c.status === 'generating' || c.status === 'exporting') {
          c.status = 'pending'
          c.error = undefined
        }
      }
      state.status = 'needs-attention'
      state.errors = state.errors || []
      addUniqueDiagnostic(state.errors, `[${readiness.blockingCode}] ${readiness.message}`)
      saveThumbnailJobStateAtomic(projectDir, state)

      this.broadcastProgress({
        projectDir,
        jobId: state.jobId,
        status: 'needs-attention',
        stage: 'idle',
        completedCount: state.candidates.filter((c) => c.status === 'completed').length,
        totalCount: 5,
        progress: 0,
        message: readiness.message,
        jobState: state
      })
      return state
    }

    // ── Preflight passed. Now reset failed candidates to pending ──────────────
    for (const c of incomplete) {
      if (c.status === 'failed') {
        // Only reset connector-level failures (bridge was offline); keep content failures
        const isConnectorError = c.error && (
          c.error.includes('FLOWKIT_BRIDGE_OFFLINE') ||
          c.error.includes('ECONNREFUSED') ||
          c.error.includes('fetch failed') ||
          c.error.includes('FLOW_EXTENSION_DISCONNECTED')
        )
        if (isConnectorError || !c.error) {
          c.status = 'pending'
          c.error = undefined
        }
      }
    }

    state.status = 'generating'
    state.updatedAt = new Date().toISOString()
    saveThumbnailJobStateAtomic(projectDir, state)

    const abortController = new AbortController()

    const executionPromise = (async (): Promise<ThumbnailJobState> => {
      try {
        await this.runSequentialCandidates(state, abortController.signal, this.defaultCooldownMs)
        return this.finalizeJob(state, projectDir)
      } finally {
        this.activeJobs.delete(projectDir)
      }
    })()

    this.activeJobs.set(projectDir, { abortController, promise: executionPromise, jobId: state.jobId })
    return executionPromise
  }

  // ─── cancelJob ───────────────────────────────────────────────────────────

  public async cancelJob(projectDir: string): Promise<boolean> {
    const active = this.activeJobs.get(projectDir)
    if (active) {
      active.abortController.abort()
      // Don't delete from map here — the finally block in the promise will do it
    }

    const state = loadThumbnailJobState(projectDir)
    if (state && (state.status === 'generating' || state.status === 'planning')) {
      state.status = 'cancelled'
      // Mark in-flight candidates as pending (not lost)
      for (const c of state.candidates) {
        if (c.status === 'generating' || c.status === 'exporting') {
          c.status = 'pending'
        }
      }
      saveThumbnailJobStateAtomic(projectDir, state)
      this.broadcastProgress({
        projectDir,
        jobId: state.jobId,
        status: 'cancelled',
        stage: 'idle',
        completedCount: state.candidates.filter((c) => c.status === 'completed').length,
        totalCount: 5,
        progress: 0,
        message: 'Thumbnail generation cancelled by user.',
        jobState: state
      })
      return true
    }

    return false
  }

  // ─── generateMore ─────────────────────────────────────────────────────────

  public async generateMore(
    projectDir: string,
    templateId?: string,
    templateSnapshot?: string
  ): Promise<ThumbnailJobState> {
    // SINGLE-FLIGHT LOCK
    if (this.activeJobs.has(projectDir)) {
      const state = loadThumbnailJobState(projectDir)
      if (state) return state
      throw new Error('THUMBNAIL_JOB_ALREADY_RUNNING: Generation already in progress.')
    }

    const existing = loadThumbnailJobState(projectDir)
    const nextRound = (existing?.generationRound || 1) + 1

    const previousConceptsList: string[] = []
    if (existing?.candidates) {
      for (const c of existing.candidates) {
        previousConceptsList.push(`- [${c.optionId}] ${c.conceptName}: "${c.yellowText} / ${c.whiteText}"`)
      }
    }

    logger.info(`[ThumbnailOrchestrator] Generating 5 More thumbnails for round ${nextRound}...`)

    return this.startJob({
      projectDir,
      templateId,
      templateSnapshot,
      generationRound: nextRound,
      forceRestart: true
    })
  }

  // ─── retryCandidate ───────────────────────────────────────────────────────

  public async retryCandidate(projectDir: string, candidateId: string): Promise<ThumbnailCandidate> {
    // SINGLE-FLIGHT LOCK: don't retry while batch is active
    if (this.activeJobs.has(projectDir)) {
      throw new Error('THUMBNAIL_JOB_ALREADY_RUNNING: Cannot retry individual candidate while batch is running.')
    }

    const state = loadThumbnailJobState(projectDir)
    if (!state) throw new Error('No thumbnail job found')

    const candidate = state.candidates.find((c) => c.id === candidateId)
    if (!candidate) throw new Error(`Candidate not found: ${candidateId}`)

    // Preflight before retry
    const readiness = await this.runtimeManager.ensureFlowReady()
    if (!readiness.ready) {
      throw new ThumbnailFlowError(
        readiness.blockingCode || 'FLOWKIT_BRIDGE_OFFLINE',
        readiness.message || 'FlowKit is not ready.',
        false,
        'connector'
      )
    }

    logger.info(`[ThumbnailOrchestrator] Retrying candidate ${candidate.optionId}...`)
    candidate.status = 'generating'
    candidate.attempts = (candidate.attempts || 0) + 1
    candidate.error = undefined
    saveThumbnailJobStateAtomic(projectDir, state)

    const abortController = new AbortController()
    try {
      await this.processSingleCandidate(state, candidate, abortController.signal)
    } catch (err) {
      const structured = classifyGenerationError(err, this.runtimeManager.getSettings().bridgeUrl)
      candidate.status = 'failed'
      candidate.error = `${structured.code}: ${structured.message}`
    }

    saveThumbnailJobStateAtomic(projectDir, state)
    saveThumbnailManifest(projectDir, state)
    return candidate
  }

  // ─── regenerateCandidate ─────────────────────────────────────────────────

  public async regenerateCandidate(
    projectDir: string,
    candidateId: string,
    customPrompt?: string
  ): Promise<ThumbnailCandidate> {
    // SINGLE-FLIGHT LOCK: don't regenerate while batch is active
    if (this.activeJobs.has(projectDir)) {
      throw new Error('THUMBNAIL_JOB_ALREADY_RUNNING: Cannot regenerate individual candidate while batch is running.')
    }

    const state = loadThumbnailJobState(projectDir)
    if (!state) throw new Error('No thumbnail job found')

    const candidate = state.candidates.find((c) => c.id === candidateId)
    if (!candidate) throw new Error(`Candidate not found: ${candidateId}`)

    // Preflight before regenerate
    const readiness = await this.runtimeManager.ensureFlowReady()
    if (!readiness.ready) {
      throw new ThumbnailFlowError(
        readiness.blockingCode || 'FLOWKIT_BRIDGE_OFFLINE',
        readiness.message || 'FlowKit is not ready.',
        false,
        'connector'
      )
    }

    candidate.revision = (candidate.revision || 1) + 1
    if (customPrompt) {
      candidate.imagePrompt = customPrompt.trim()
    }
    candidate.status = 'generating'
    candidate.error = undefined
    saveThumbnailJobStateAtomic(projectDir, state)

    const abortController = new AbortController()
    try {
      await this.processSingleCandidate(state, candidate, abortController.signal)
    } catch (err) {
      const structured = classifyGenerationError(err, this.runtimeManager.getSettings().bridgeUrl)
      candidate.status = 'failed'
      candidate.error = `${structured.code}: ${structured.message}`
    }

    saveThumbnailJobStateAtomic(projectDir, state)
    saveThumbnailManifest(projectDir, state)
    return candidate
  }

  // ─── exportCandidate4k ────────────────────────────────────────────────────

  public async exportCandidate4k(projectDir: string, candidateId: string): Promise<ThumbnailCandidate> {
    const state = loadThumbnailJobState(projectDir)
    if (!state) throw new Error('No thumbnail job found')

    const candidate = state.candidates.find((c) => c.id === candidateId)
    if (!candidate) throw new Error(`Candidate not found: ${candidateId}`)

    if (!candidate.mediaId) {
      throw new Error(`Candidate ${candidate.optionId} does not have a mediaId yet. Generate it first.`)
    }

    candidate.status = 'exporting'
    saveThumbnailJobStateAtomic(projectDir, state)

    const destPath = getCandidateImagePath(projectDir, candidate.round, candidate.optionId, candidate.revision)

    const exportRes = await this.provider.exportImage({
      mediaId: candidate.mediaId,
      projectId: state.flowProjectId,
      quality: '4k',
      fallbackToOriginalUrl: candidate.originalImagePath,
      destinationPath: destPath
    })

    candidate.status = 'completed'
    candidate.exportedImagePath = exportRes.filePath
    candidate.actualWidth = exportRes.width
    candidate.actualHeight = exportRes.height
    candidate.exportQuality = exportRes.actualQuality

    saveThumbnailJobStateAtomic(projectDir, state)
    saveThumbnailManifest(projectDir, state)
    return candidate
  }

  // ─── selectCandidate ─────────────────────────────────────────────────────

  public selectCandidate(
    projectDir: string,
    candidateId: string
  ): { success: boolean; selectedPath?: string; error?: string } {
    const state = loadThumbnailJobState(projectDir)
    if (!state) throw new Error('No thumbnail job found')
    return selectThumbnailCandidate(projectDir, state, candidateId)
  }

  // ─── handleAppQuit ────────────────────────────────────────────────────────

  public handleAppQuit(): void {
    logger.info('[ThumbnailOrchestrator] App quitting. Marking running thumbnail jobs as interrupted...')
    for (const [projectDir, active] of this.activeJobs.entries()) {
      active.abortController.abort()
      const state = loadThumbnailJobState(projectDir)
      if (state && (state.status === 'generating' || state.status === 'planning')) {
        state.status = 'interrupted'
        // Mark in-flight candidates as pending so they can be resumed
        for (const c of state.candidates) {
          if (c.status === 'generating' || c.status === 'exporting') {
            c.status = 'pending'
          }
        }
        if (state.lease) delete state.lease
        saveThumbnailJobStateAtomic(projectDir, state)
      }
    }
    this.activeJobs.clear()
  }

  // ─── Private: runSequentialCandidates ─────────────────────────────────────

  /**
   * Run candidates strictly sequentially, one at a time.
   * Uses ONE retry loop here in the orchestrator. GoogleFlowClient does NOT retry.
   */
  private async runSequentialCandidates(
    state: ThumbnailJobState,
    signal: AbortSignal,
    cooldownMs: number
  ): Promise<void> {
    const candidates = state.candidates
    const MAX_CANDIDATE_ATTEMPTS = 4

    for (let i = 0; i < candidates.length; i++) {
      if (signal.aborted) {
        logger.info('[ThumbnailOrchestrator] Abort signal received. Stopping candidate loop.')
        state.status = 'cancelled'
        saveThumbnailJobStateAtomic(state.projectDir, state)
        return
      }

      const candidate = candidates[i]

      // Skip already completed
      if (candidate.status === 'completed') {
        logger.info(`[ThumbnailOrchestrator] Candidate ${candidate.optionId} already completed, skipping.`)
        continue
      }

      // ── Per-candidate bridge liveness check ───────────────────────────────
      if (!(await this.runtimeManager.isBridgeStillReachable())) {
        logger.warn(`[ThumbnailOrchestrator] Bridge went offline before candidate ${candidate.optionId}. Pausing batch.`)
        this.pauseBatchForBridgeOffline(state, i, candidates)
        return
      }

      this.broadcastProgress({
        projectDir: state.projectDir,
        jobId: state.jobId,
        status: 'generating',
        stage: 'generating',
        currentOptionId: candidate.optionId,
        completedCount: candidates.filter((c) => c.status === 'completed').length,
        totalCount: 5,
        progress: (candidates.filter((c) => c.status === 'completed').length + 0.1) / 5,
        message: `Generating image for Option ${candidate.optionId}: "${candidate.conceptName}"...`,
        candidate,
        jobState: state
      })

      // ── Single orchestrator retry loop (client does NOT retry) ────────────
      let succeeded = false
      let lastError: ThumbnailFlowError | null = null

      // How many attempts has this candidate had across all runs?
      const attemptsAtStart = candidate.attempts || 0

      for (let attempt = 1; attempt <= MAX_CANDIDATE_ATTEMPTS; attempt++) {
        if (signal.aborted) {
          state.status = 'cancelled'
          saveThumbnailJobStateAtomic(state.projectDir, state)
          return
        }

        logger.info(`[ThumbnailOrchestrator] Candidate ${candidate.optionId} attempt ${attempt}/${MAX_CANDIDATE_ATTEMPTS} (runId=${state.jobId})`)

        try {
          await this.processSingleCandidate(state, candidate, signal)
          succeeded = true
          break
        } catch (err) {
          if (err instanceof ThumbnailCancelledError) {
            state.status = 'cancelled'
            saveThumbnailJobStateAtomic(state.projectDir, state)
            return
          }

          const structured = classifyGenerationError(err, this.runtimeManager.getSettings().bridgeUrl)
          lastError = structured

          logger.error(
            `[ThumbnailOrchestrator] Candidate ${candidate.optionId} attempt ${attempt}/${MAX_CANDIDATE_ATTEMPTS} failed: [${structured.code}] ${structured.message}`
          )

          // Connector errors (bridge offline, extension disconnected) → STOP entire batch immediately
          if (structured.scope === 'connector') {
            logger.warn(`[ThumbnailOrchestrator] Connector error on candidate ${candidate.optionId}. Aborting batch.`)
            // Mark this candidate as pending (not failed — connector issue)
            candidate.status = 'pending'
            candidate.error = undefined
            candidate.attempts = attemptsAtStart // restore attempts (don't count connector retries)
            this.pauseBatchForBridgeOffline(state, i, candidates, structured)
            return
          }

          // Non-retryable candidate errors → stop retrying this candidate
          if (!structured.retryable) {
            break
          }

          // Retryable → back off with abort support
          if (attempt < MAX_CANDIDATE_ATTEMPTS) {
            const backoffMs = Math.min(3000 * attempt, 15000)
            logger.warn(`[ThumbnailOrchestrator] Retryable error. Waiting ${backoffMs}ms before attempt ${attempt + 1}...`)
            try {
              await abortableDelay(backoffMs, signal)
            } catch {
              state.status = 'cancelled'
              saveThumbnailJobStateAtomic(state.projectDir, state)
              return
            }
          }
        }
      }

      if (!succeeded && lastError) {
        candidate.status = 'failed'
        candidate.error = `${lastError.code}: ${lastError.message}`
        addUniqueDiagnostic(state.errors, `Option ${candidate.optionId}: ${lastError.code}: ${lastError.message}`)
        logger.error(`[ThumbnailOrchestrator] Candidate ${candidate.optionId} exhausted all ${MAX_CANDIDATE_ATTEMPTS} attempts.`)
      }

      // Checkpoint save after each candidate
      saveThumbnailJobStateAtomic(state.projectDir, state)
      saveThumbnailManifest(state.projectDir, state)

      const updatedCompleted = candidates.filter((c) => c.status === 'completed').length
      this.broadcastProgress({
        projectDir: state.projectDir,
        jobId: state.jobId,
        status: 'generating',
        stage: candidate.status === 'completed' ? 'exporting' : 'generating',
        currentOptionId: candidate.optionId,
        completedCount: updatedCompleted,
        totalCount: 5,
        progress: updatedCompleted / 5,
        message: candidate.status === 'completed'
          ? `Option ${candidate.optionId} ready (${candidate.exportQuality || '4K'})`
          : `Option ${candidate.optionId} failed. Proceeding with remaining options...`,
        candidate,
        jobState: state
      })

      // Cooldown before next candidate (abortable)
      if (i < candidates.length - 1 && !signal.aborted) {
        logger.info(`[ThumbnailOrchestrator] Cooldown ${cooldownMs}ms before next candidate...`)
        try {
          await abortableDelay(cooldownMs, signal)
        } catch {
          state.status = 'cancelled'
          saveThumbnailJobStateAtomic(state.projectDir, state)
          return
        }
      }
    }
  }

  // ─── Private: processSingleCandidate ──────────────────────────────────────

  /**
   * Process a single candidate: generate + export.
   * DOES NOT retry. Orchestrator owns retry policy.
   * Accepts AbortSignal to stop immediately.
   */
  private async processSingleCandidate(
    state: ThumbnailJobState,
    candidate: ThumbnailCandidate,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new ThumbnailCancelledError()

    candidate.status = 'generating'
    candidate.attempts = (candidate.attempts || 0) + 1
    saveThumbnailJobStateAtomic(state.projectDir, state)

    // 1. Generate image via FlowKit (no retry inside client)
    const genRes = await this.provider.generateImage({
      prompt: candidate.imagePrompt,
      projectId: state.flowProjectId,
      candidateId: candidate.id,
      optionId: candidate.optionId
    })

    if (signal?.aborted) throw new ThumbnailCancelledError()

    candidate.mediaId = genRes.mediaId
    candidate.originalImagePath = genRes.fifeUrl
    if (genRes.projectId && !state.flowProjectId) {
      state.flowProjectId = genRes.projectId
    }

    // 2. Export 4K
    candidate.status = 'exporting'
    saveThumbnailJobStateAtomic(state.projectDir, state)

    if (signal?.aborted) throw new ThumbnailCancelledError()

    const destPath = getCandidateImagePath(state.projectDir, candidate.round, candidate.optionId, candidate.revision)

    const exportRes = await this.provider.exportImage({
      mediaId: genRes.mediaId,
      projectId: state.flowProjectId,
      quality: '4k',
      fallbackToOriginalUrl: genRes.fifeUrl,
      destinationPath: destPath
    })

    // Verify
    if (!fs.existsSync(exportRes.filePath) || fs.statSync(exportRes.filePath).size === 0) {
      throw new Error(`Downloaded image file is missing or 0 bytes: ${exportRes.filePath}`)
    }

    candidate.status = 'completed'
    candidate.exportedImagePath = exportRes.filePath
    candidate.actualWidth = exportRes.width
    candidate.actualHeight = exportRes.height
    candidate.exportQuality = exportRes.actualQuality
    candidate.error = undefined
  }

  // ─── Private: pauseBatchForBridgeOffline ─────────────────────────────────

  private pauseBatchForBridgeOffline(
    state: ThumbnailJobState,
    fromIndex: number,
    candidates: ThumbnailCandidate[],
    error?: ThumbnailFlowError
  ): void {
    // Mark remaining (not completed) candidates as pending
    for (let j = fromIndex; j < candidates.length; j++) {
      if (candidates[j].status !== 'completed') {
        candidates[j].status = 'pending'
        candidates[j].error = undefined
      }
    }
    state.status = 'needs-attention'
    state.errors = state.errors || []
    const errMsg = error
      ? `${error.code}: ${error.message}`
      : 'FLOWKIT_BRIDGE_OFFLINE: Bridge went offline during generation.'
    addUniqueDiagnostic(state.errors, errMsg)

    saveThumbnailJobStateAtomic(state.projectDir, state)
    saveThumbnailManifest(state.projectDir, state)

    this.broadcastProgress({
      projectDir: state.projectDir,
      jobId: state.jobId,
      status: 'needs-attention',
      stage: 'idle',
      completedCount: candidates.filter((c) => c.status === 'completed').length,
      totalCount: 5,
      progress: candidates.filter((c) => c.status === 'completed').length / 5,
      message: error?.message || 'FlowKit connection lost. Fix the connection and click Resume.',
      jobState: state
    })
  }

  // ─── Private: finalizeJob ─────────────────────────────────────────────────

  private finalizeJob(state: ThumbnailJobState, projectDir: string): ThumbnailJobState {
    reconcileThumbnailArtifacts(projectDir, state)
    saveThumbnailManifest(projectDir, state)

    const completedCount = state.candidates.filter((c) => c.status === 'completed').length
    const failedCount = state.candidates.filter((c) => c.status === 'failed').length
    const pendingCount = state.candidates.filter((c) => c.status === 'pending').length

    const allConnectorFailed = failedCount > 0 && state.candidates
      .filter((c) => c.status === 'failed')
      .every((c) => c.error && (
        c.error.includes('FLOWKIT_BRIDGE_OFFLINE') ||
        c.error.includes('ECONNREFUSED') ||
        c.error.includes('fetch failed') ||
        c.error.includes('FLOW_EXTENSION_DISCONNECTED')
      ))

    if (state.status !== 'cancelled' && state.status !== 'needs-attention') {
      state.status = completedCount === 5
        ? 'completed'
        : completedCount > 0
          ? 'partial'
          : pendingCount > 0
            ? 'needs-attention' // interrupted mid-batch
            : allConnectorFailed
              ? 'needs-attention'
              : 'failed'
    }

    if (completedCount === 5) {
      state.completedAt = new Date().toISOString()
    }

    saveThumbnailJobStateAtomic(projectDir, state)

    this.broadcastProgress({
      projectDir,
      jobId: state.jobId,
      status: state.status,
      stage: completedCount === 5 ? 'completed' : state.status === 'needs-attention' ? 'idle' : 'failed',
      completedCount,
      totalCount: 5,
      progress: completedCount / 5,
      message: completedCount === 5
        ? 'All 5 thumbnails generated and exported successfully.'
        : state.status === 'needs-attention'
          ? 'FlowKit connection failed. Fix the connection and click Resume.'
          : `${completedCount}/5 thumbnails generated. Some candidates require attention.`,
      jobState: state
    })

    return state
  }

  // ─── Private: markNeedsAttention ─────────────────────────────────────────

  private async markNeedsAttention(
    projectDir: string,
    readiness: FlowReadinessResult,
    ctx: {
      renderOutputPath: string
      renderFileSize: number
      renderMtimeMs: number
      scriptHash: string
      templateSnapshotHash: string
      round: number
      params: ThumbnailStartJobParams
      settings: Awaited<ReturnType<typeof loadProjectThumbnailSettings>>
      templateSnapshot: string
    }
  ): Promise<ThumbnailJobState> {
    let state: ThumbnailJobState
    const loadedState = loadThumbnailJobState(projectDir)
    if (loadedState && loadedState.candidates.length === 5) {
      state = loadedState
      // Reconcile stale generating candidates
      for (const c of state.candidates) {
        if (c.status === 'generating' || c.status === 'exporting') {
          c.status = 'pending'
          c.error = undefined
        }
      }
    } else {
      // Try to plan so we have concepts even if we can't generate
      const plan = await thumbnailPlanner.plan({
        projectDir,
        templateId: ctx.params.templateId || ctx.settings.selectedTemplateId,
        templateSnapshot: ctx.templateSnapshot,
        preferredModel: ctx.params.preferredModel,
        generationRound: ctx.round
      }).catch(() => undefined)

      state = createInitialThumbnailJobState({
        projectDir,
        renderOutputPath: ctx.renderOutputPath,
        renderFileSize: ctx.renderFileSize,
        renderMtimeMs: ctx.renderMtimeMs,
        scriptHash: ctx.scriptHash,
        templateSnapshotHash: ctx.templateSnapshotHash,
        generationRound: ctx.round,
        plan
      })
    }

    state.status = 'needs-attention'
    state.errors = state.errors || []
    addUniqueDiagnostic(state.errors, `[${readiness.blockingCode}] ${readiness.message}`)
    saveThumbnailJobStateAtomic(projectDir, state)

    this.broadcastProgress({
      projectDir,
      jobId: state.jobId,
      status: 'needs-attention',
      stage: 'idle',
      completedCount: state.candidates.filter((c) => c.status === 'completed').length,
      totalCount: 5,
      progress: 0,
      message: readiness.message,
      jobState: state
    })

    return state
  }

  // ─── Private: resolve helpers ─────────────────────────────────────────────

  private resolveScriptText(projectDir: string, customPath?: string): string {
    if (customPath && fs.existsSync(customPath)) {
      try { return fs.readFileSync(customPath, 'utf-8') } catch { /* ignore */ }
    }
    const candidates = [
      path.join(projectDir, 'script.txt'),
      path.join(projectDir, 'inputs', 'script.txt'),
      path.join(projectDir, 'project-state.json'),
      path.join(projectDir, 'project.json')
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        if (c.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(c, 'utf-8')
            const st = JSON.parse(raw) as { inputs?: { scriptPath?: string } }
            if (st?.inputs?.scriptPath && fs.existsSync(st.inputs.scriptPath)) {
              return fs.readFileSync(st.inputs.scriptPath, 'utf-8')
            }
          } catch { /* ignore */ }
        } else {
          return fs.readFileSync(c, 'utf-8')
        }
      }
    }
    return ''
  }

  private resolveRenderOutputPath(projectDir: string): string {
    const candidates = [
      path.join(projectDir, 'output', 'final_video.mp4'),
      path.join(projectDir, 'output', 'video.mp4'),
      path.join(projectDir, 'output', 'render.mp4')
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
    return candidates[0]
  }

  private broadcastProgress(payload: ThumbnailProgressPayload): void {
    try {
      if (typeof BrowserWindow !== 'undefined' && BrowserWindow?.getAllWindows) {
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.THUMBNAIL_PROGRESS, payload)
          }
        }
      }
    } catch {
      // Ignore in headless/test environments
    }
  }
}

export const thumbnailOrchestrator = new ThumbnailOrchestrator()
