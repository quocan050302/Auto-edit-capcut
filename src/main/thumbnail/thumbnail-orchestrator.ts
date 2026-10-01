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

export class ThumbnailOrchestrator {
  private activeJobs = new Map<string, { abortController: AbortController; promise: Promise<ThumbnailJobState> }>()
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

  public async getJobState(projectDir: string): Promise<ThumbnailJobState | null> {
    const state = loadThumbnailJobState(projectDir)
    if (state) {
      // Reconcile with disk artifacts in case external files appeared
      const changed = reconcileThumbnailArtifacts(projectDir, state)
      let stateChanged = changed

      // Reconcile stuck jobs: if state says 'generating' but no active runner
      // and no candidates are actually running, fix the status
      if (state.status === 'generating' && !this.activeJobs.has(projectDir)) {
        const runningCount = state.candidates.filter((c) => c.status === 'generating' || c.status === 'exporting').length
        const pendingCount = state.candidates.filter((c) => c.status === 'pending').length
        const completedCount = state.candidates.filter((c) => c.status === 'completed').length
        const failedCount = state.candidates.filter((c) => c.status === 'failed').length

        if (runningCount === 0 && pendingCount === 0) {
          // Nothing actually running — reconcile
          const bridgeOfflineFailed = failedCount > 0 && state.candidates
            .filter((c) => c.status === 'failed')
            .every((c) => c.error && (
              c.error.includes('ECONNREFUSED') ||
              c.error.includes('FLOWKIT_BRIDGE_OFFLINE') ||
              c.error.includes('fetch failed') ||
              c.error.includes('Failed to fetch')
            ))

          if (bridgeOfflineFailed || (completedCount === 0 && failedCount === 0)) {
            state.status = 'needs-attention'
            logger.info(`[ThumbnailOrchestrator] Reconciled stuck job for ${projectDir}: generating→needs-attention`)
          } else if (completedCount === 5) {
            state.status = 'completed'
          } else if (completedCount > 0) {
            state.status = 'partial'
          } else if (failedCount > 0) {
            state.status = 'needs-attention' // prefer recoverable over terminal failed
          }
          stateChanged = true
        }
      }

      if (stateChanged) {
        saveThumbnailJobStateAtomic(projectDir, state)
      }
    }
    return state
  }

  public async startJob(params: ThumbnailStartJobParams): Promise<ThumbnailJobState> {
    const { projectDir } = params

    // 1. Double-start protection: if active run already in progress, return existing promise
    const existing = this.activeJobs.get(projectDir)
    if (existing) {
      logger.info(`[ThumbnailOrchestrator] Job already actively running for ${projectDir}. Returning active job.`)
      return existing.promise
    }

    // 2. Load settings
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

    // 3. Idempotency check: if existing job is already completed for same key, return it
    const existingState = loadThumbnailJobState(projectDir)
    if (existingState && !params.forceRestart) {
      if (existingState.status === 'completed' && existingState.generationRound === round) {
        logger.info(`[ThumbnailOrchestrator] Completed job found for round ${round}. Skipping recreation.`)
        return existingState
      }

      // Check if stale lease from previous crash
      if (existingState.status === 'generating' && isThumbnailLeaseStale(existingState.lease)) {
        logger.info(`[ThumbnailOrchestrator] Stale lease detected on existing job. Reconciling and resuming...`)
        return this.resumeJob(projectDir)
      }
    }

    const abortController = new AbortController()

    const executionPromise = (async (): Promise<ThumbnailJobState> => {
      try {
        // Step Pre: Connection preflight — MUST pass before any generation
        const readiness = await this.runtimeManager.ensureFlowReady()
        if (!readiness.ready) {
          logger.warn(`[ThumbnailOrchestrator] Connection preflight failed: ${readiness.blockingCode} — ${readiness.message}`)

          // Load or create state, mark as needs-attention — do NOT launch 5 requests
          let state: ThumbnailJobState
          const loadedState = loadThumbnailJobState(projectDir)
          if (loadedState && loadedState.candidates.length === 5) {
            state = loadedState
          } else {
            // Plan first so we have concepts, but don't generate
            const plan = await thumbnailPlanner.plan({
              projectDir,
              templateId: params.templateId || settings.selectedTemplateId,
              templateSnapshot,
              preferredModel: params.preferredModel,
              generationRound: round
            }).catch(() => undefined)

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
          }

          state.status = 'needs-attention'
          state.errors = state.errors || []
          state.errors.push(`[${readiness.blockingCode}] ${readiness.message}`)
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

        // Step A: Planning
        let state: ThumbnailJobState
        let plan: ThumbnailPlan | undefined

        // If existing state already has candidates for this round, reuse them
        if (existingState && existingState.candidates.length === 5 && existingState.generationRound === round && !params.forceRestart) {
          state = existingState
          state.status = 'generating'
          state.updatedAt = new Date().toISOString()
          saveThumbnailJobStateAtomic(projectDir, state)
        } else {
          this.broadcastProgress({
            projectDir,
            jobId: 'init',
            status: 'planning',
            stage: 'planning',
            completedCount: 0,
            totalCount: 5,
            progress: 0.1,
            message: 'Generating 5 distinct thumbnail concepts from script...'
          })

          plan = await thumbnailPlanner.plan({
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

        // Reconcile artifacts in case some already exist
        reconcileThumbnailArtifacts(projectDir, state)
        saveThumbnailJobStateAtomic(projectDir, state)

        // Step B: Sequential Generation & 4K Export
        const cooldown = params.cooldownMs ?? this.defaultCooldownMs
        await this.runSequentialCandidates(state, abortController.signal, cooldown)

        // Step C: Manifest and finalize
        reconcileThumbnailArtifacts(projectDir, state)
        saveThumbnailManifest(projectDir, state)
        saveThumbnailJobStateAtomic(projectDir, state)

        const completedCount = state.candidates.filter((c) => c.status === 'completed').length
        const failedCount = state.candidates.filter((c) => c.status === 'failed').length
        const isAllComplete = completedCount === 5
        const isAllFailed = failedCount === 5

        // Distinguish: if all failed due to bridge connectivity, mark needs-attention, not failed
        const bridgeOfflineFailed = isAllFailed && state.candidates.every(
          (c) => c.error && (
            c.error.includes('ECONNREFUSED') ||
            c.error.includes('FLOWKIT_BRIDGE_OFFLINE') ||
            c.error.includes('fetch failed') ||
            c.error.includes('Failed to fetch')
          )
        )

        state.status = isAllComplete
          ? 'completed'
          : completedCount > 0
            ? 'partial'
            : bridgeOfflineFailed
              ? 'needs-attention'
              : 'failed'

        if (isAllComplete) {
          state.completedAt = new Date().toISOString()
        }
        saveThumbnailJobStateAtomic(projectDir, state)

        this.broadcastProgress({
          projectDir,
          jobId: state.jobId,
          status: state.status,
          stage: isAllComplete ? 'completed' : state.status === 'needs-attention' ? 'idle' : 'failed',
          completedCount,
          totalCount: 5,
          progress: completedCount / 5,
          message: isAllComplete
            ? 'All 5 thumbnails generated and exported successfully.'
            : state.status === 'needs-attention'
              ? 'FlowKit connection failed. Fix the connection and click Resume.'
              : `${completedCount}/5 thumbnails generated. Some candidates require attention.`,
          jobState: state
        })

        return state
      } finally {
        this.activeJobs.delete(projectDir)
      }
    })()

    this.activeJobs.set(projectDir, { abortController, promise: executionPromise })
    return executionPromise
  }

  public async resumeJob(projectDir: string): Promise<ThumbnailJobState> {
    const existing = this.activeJobs.get(projectDir)
    if (existing) {
      return existing.promise
    }

    const state = loadThumbnailJobState(projectDir)
    if (!state) {
      throw new Error(`No thumbnail job state found to resume for ${projectDir}`)
    }

    // Reconcile what was already completed on disk
    reconcileThumbnailArtifacts(projectDir, state)
    saveThumbnailJobStateAtomic(projectDir, state)

    const incomplete = state.candidates.filter((c) => c.status !== 'completed')
    if (incomplete.length === 0) {
      state.status = 'completed'
      state.completedAt = state.completedAt || new Date().toISOString()
      saveThumbnailJobStateAtomic(projectDir, state)
      return state
    }

    // Preflight before resuming
    const readiness = await this.runtimeManager.ensureFlowReady()
    if (!readiness.ready) {
      logger.warn(`[ThumbnailOrchestrator] Resume preflight failed: ${readiness.blockingCode}`)
      state.status = 'needs-attention'
      state.errors = state.errors || []
      if (!state.errors.includes(readiness.message)) {
        state.errors.push(`[${readiness.blockingCode}] ${readiness.message}`)
      }
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

    // Reset failed candidates to pending so they will be retried
    for (const c of incomplete) {
      if (c.status === 'failed') {
        c.status = 'pending'
        c.error = undefined
      }
    }

    state.status = 'generating'
    saveThumbnailJobStateAtomic(projectDir, state)

    const abortController = new AbortController()

    const executionPromise = (async (): Promise<ThumbnailJobState> => {
      try {
        await this.runSequentialCandidates(state, abortController.signal, this.defaultCooldownMs)
        reconcileThumbnailArtifacts(projectDir, state)
        saveThumbnailManifest(projectDir, state)
        saveThumbnailJobStateAtomic(projectDir, state)

        const completedCount = state.candidates.filter((c) => c.status === 'completed').length
        const failedCount = state.candidates.filter((c) => c.status === 'failed').length
        const bridgeOfflineFailed = failedCount > 0 && failedCount === (5 - completedCount) &&
          state.candidates.filter((c) => c.status === 'failed').every(
            (c) => c.error && (c.error.includes('ECONNREFUSED') || c.error.includes('FLOWKIT_BRIDGE_OFFLINE') || c.error.includes('fetch failed'))
          )
        state.status = completedCount === 5
          ? 'completed'
          : completedCount > 0
            ? 'partial'
            : bridgeOfflineFailed
              ? 'needs-attention'
              : 'failed'
        saveThumbnailJobStateAtomic(projectDir, state)

        return state
      } finally {
        this.activeJobs.delete(projectDir)
      }
    })()

    this.activeJobs.set(projectDir, { abortController, promise: executionPromise })
    return executionPromise
  }

  public async cancelJob(projectDir: string): Promise<boolean> {
    const active = this.activeJobs.get(projectDir)
    if (active) {
      active.abortController.abort()
      this.activeJobs.delete(projectDir)
    }

    const state = loadThumbnailJobState(projectDir)
    if (state && (state.status === 'generating' || state.status === 'planning')) {
      state.status = 'cancelled'
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

  public async generateMore(
    projectDir: string,
    templateId?: string,
    templateSnapshot?: string
  ): Promise<ThumbnailJobState> {
    const existing = loadThumbnailJobState(projectDir)
    const nextRound = (existing?.generationRound || 1) + 1

    // Collect previous concepts from round 1..N
    const previousConceptsList: string[] = []
    if (existing?.candidates) {
      for (const c of existing.candidates) {
        previousConceptsList.push(`- [${c.optionId}] ${c.conceptName}: "${c.yellowText} / ${c.whiteText}"`)
      }
    }
    const previousConcepts = previousConceptsList.join('\n')

    logger.info(`[ThumbnailOrchestrator] Generating 5 More thumbnails for round ${nextRound}...`)

    return this.startJob({
      projectDir,
      templateId,
      templateSnapshot,
      generationRound: nextRound,
      forceRestart: true
    })
  }

  public async retryCandidate(projectDir: string, candidateId: string): Promise<ThumbnailCandidate> {
    const state = loadThumbnailJobState(projectDir)
    if (!state) throw new Error('No thumbnail job found')

    const candidate = state.candidates.find((c) => c.id === candidateId)
    if (!candidate) throw new Error(`Candidate not found: ${candidateId}`)

    logger.info(`[ThumbnailOrchestrator] Retrying candidate ${candidate.optionId}...`)
    candidate.status = 'generating'
    candidate.attempts = (candidate.attempts || 0) + 1
    candidate.error = undefined
    saveThumbnailJobStateAtomic(projectDir, state)

    try {
      await this.processSingleCandidate(state, candidate)
    } catch (err) {
      candidate.status = 'failed'
      candidate.error = err instanceof Error ? err.message : String(err)
    }

    saveThumbnailJobStateAtomic(projectDir, state)
    saveThumbnailManifest(projectDir, state)
    return candidate
  }

  public async regenerateCandidate(
    projectDir: string,
    candidateId: string,
    customPrompt?: string
  ): Promise<ThumbnailCandidate> {
    const state = loadThumbnailJobState(projectDir)
    if (!state) throw new Error('No thumbnail job found')

    const candidate = state.candidates.find((c) => c.id === candidateId)
    if (!candidate) throw new Error(`Candidate not found: ${candidateId}`)

    candidate.revision = (candidate.revision || 1) + 1
    if (customPrompt) {
      candidate.imagePrompt = customPrompt.trim()
    }
    candidate.status = 'generating'
    candidate.error = undefined
    saveThumbnailJobStateAtomic(projectDir, state)

    try {
      await this.processSingleCandidate(state, candidate)
    } catch (err) {
      candidate.status = 'failed'
      candidate.error = err instanceof Error ? err.message : String(err)
    }

    saveThumbnailJobStateAtomic(projectDir, state)
    saveThumbnailManifest(projectDir, state)
    return candidate
  }

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

  public selectCandidate(
    projectDir: string,
    candidateId: string
  ): { success: boolean; selectedPath?: string; error?: string } {
    const state = loadThumbnailJobState(projectDir)
    if (!state) throw new Error('No thumbnail job found')
    return selectThumbnailCandidate(projectDir, state, candidateId)
  }

  public handleAppQuit(): void {
    logger.info('[ThumbnailOrchestrator] App quitting. Marking running thumbnail jobs as interrupted...')
    for (const [projectDir, active] of this.activeJobs.entries()) {
      active.abortController.abort()
      const state = loadThumbnailJobState(projectDir)
      if (state && (state.status === 'generating' || state.status === 'planning')) {
        state.status = 'interrupted'
        if (state.lease) {
          delete state.lease
        }
        saveThumbnailJobStateAtomic(projectDir, state)
      }
    }
    this.activeJobs.clear()
  }

  private async runSequentialCandidates(
    state: ThumbnailJobState,
    signal: AbortSignal,
    cooldownMs: number
  ): Promise<void> {
    const candidates = state.candidates

    for (let i = 0; i < candidates.length; i++) {
      if (signal.aborted) {
        state.status = 'cancelled'
        saveThumbnailJobStateAtomic(state.projectDir, state)
        break
      }

      const candidate = candidates[i]

      // If already completed, skip
      if (candidate.status === 'completed') {
        logger.info(`[ThumbnailOrchestrator] Candidate ${candidate.optionId} already completed, skipping.`)
        continue
      }

      // Per-candidate bridge liveness check (lightweight)
      if (!(await this.runtimeManager.isBridgeStillReachable())) {
        logger.warn(`[ThumbnailOrchestrator] Bridge went offline before candidate ${candidate.optionId}. Pausing job.`)
        // Mark remaining candidates as pending (not failed — they haven't tried)
        for (let j = i; j < candidates.length; j++) {
          if (candidates[j].status !== 'completed') {
            candidates[j].status = 'pending'
          }
        }
        state.status = 'needs-attention'
        state.errors = state.errors || []
        state.errors.push(`FLOWKIT_BRIDGE_OFFLINE: Bridge went offline during generation.`)
        saveThumbnailJobStateAtomic(state.projectDir, state)
        this.broadcastProgress({
          projectDir: state.projectDir,
          jobId: state.jobId,
          status: 'needs-attention',
          stage: 'idle',
          completedCount: candidates.filter((c) => c.status === 'completed').length,
          totalCount: 5,
          progress: candidates.filter((c) => c.status === 'completed').length / 5,
          message: 'FlowKit bridge went offline during generation. Fix connection and click Resume.',
          jobState: state
        })
        return
      }

      const completedSoFar = candidates.filter((c) => c.status === 'completed').length
      this.broadcastProgress({
        projectDir: state.projectDir,
        jobId: state.jobId,
        status: 'generating',
        stage: 'generating',
        currentOptionId: candidate.optionId,
        completedCount: completedSoFar,
        totalCount: 5,
        progress: (completedSoFar + 0.1) / 5,
        message: `Generating image for Option ${candidate.optionId}: "${candidate.conceptName}"...`,
        candidate,
        jobState: state
      })

      try {
        await this.processSingleCandidate(state, candidate)
      } catch (candErr) {
        const rawMsg = candErr instanceof Error ? candErr.message : String(candErr)
        // Classify the error
        const structuredMsg = this.classifyGenerationError(rawMsg)
        logger.error(`[ThumbnailOrchestrator] Candidate ${candidate.optionId} failed: ${structuredMsg}`)
        candidate.status = 'failed'
        candidate.error = structuredMsg
        state.errors.push(`Option ${candidate.optionId}: ${structuredMsg}`)
        saveThumbnailJobStateAtomic(state.projectDir, state)

        // If this looks like a bridge failure, stop the whole batch
        if (
          rawMsg.includes('ECONNREFUSED') ||
          rawMsg.includes('FLOWKIT_BRIDGE_OFFLINE') ||
          rawMsg.includes('fetch failed') ||
          rawMsg.includes('Failed to fetch')
        ) {
          logger.warn(`[ThumbnailOrchestrator] Bridge connectivity failure on candidate ${candidate.optionId}. Aborting batch.`)
          for (let j = i + 1; j < candidates.length; j++) {
            if (candidates[j].status !== 'completed') {
              candidates[j].status = 'pending' // Not failed — they never tried
            }
          }
          state.status = 'needs-attention'
          saveThumbnailJobStateAtomic(state.projectDir, state)
          this.broadcastProgress({
            projectDir: state.projectDir,
            jobId: state.jobId,
            status: 'needs-attention',
            stage: 'idle',
            completedCount: candidates.filter((c) => c.status === 'completed').length,
            totalCount: 5,
            progress: candidates.filter((c) => c.status === 'completed').length / 5,
            message: 'FlowKit connection lost. Fix the connection and click Resume.',
            jobState: state
          })
          return
        }
      }

      // Checkpoint save after every candidate
      saveThumbnailJobStateAtomic(state.projectDir, state)
      saveThumbnailManifest(state.projectDir, state)

      const updatedCompleted = candidates.filter((c) => c.status === 'completed').length
      this.broadcastProgress({
        projectDir: state.projectDir,
        jobId: state.jobId,
        status: 'generating',
        stage: 'exporting',
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

      // Cooldown before next candidate to prevent burst throttling (unless last candidate)
      if (i < candidates.length - 1 && !signal.aborted) {
        logger.info(`[ThumbnailOrchestrator] Cooldown ${cooldownMs}ms before next candidate...`)
        await new Promise((resolve) => setTimeout(resolve, cooldownMs))
      }
    }
  }

  /**
   * Classify a raw fetch/generation error into a user-friendly structured message.
   * Preserves the original error code for log filtering.
   */
  private classifyGenerationError(rawMsg: string): string {
    if (rawMsg.includes('ECONNREFUSED')) {
      return `FLOWKIT_BRIDGE_OFFLINE: FlowKit bridge refused connection. Ensure FlowKit is running at ${this.runtimeManager.getSettings().bridgeUrl}.`
    }
    if (rawMsg.includes('ETIMEDOUT') || rawMsg.includes('timed out')) {
      return `FLOWKIT_TIMEOUT: FlowKit bridge request timed out. The bridge may be overloaded.`
    }
    if (rawMsg.includes('FLOW_EXTENSION_DISCONNECTED')) {
      return rawMsg
    }
    if (rawMsg.includes('FLOW_RATE_LIMITED')) {
      return rawMsg
    }
    if (rawMsg.includes('fetch failed') || rawMsg.includes('Failed to fetch')) {
      return `FLOWKIT_BRIDGE_OFFLINE: Network error connecting to FlowKit. Ensure the bridge is running.`
    }
    return rawMsg
  }

  private async processSingleCandidate(
    state: ThumbnailJobState,
    candidate: ThumbnailCandidate
  ): Promise<void> {
    candidate.status = 'generating'
    candidate.attempts = (candidate.attempts || 0) + 1
    saveThumbnailJobStateAtomic(state.projectDir, state)

    // 1. Generate image via FlowKit
    const genRes = await this.provider.generateImage({
      prompt: candidate.imagePrompt,
      projectId: state.flowProjectId,
      candidateId: candidate.id,
      optionId: candidate.optionId
    })

    candidate.mediaId = genRes.mediaId
    candidate.originalImagePath = genRes.fifeUrl
    if (genRes.projectId && !state.flowProjectId) {
      state.flowProjectId = genRes.projectId
    }

    // 2. Export 4K
    candidate.status = 'exporting'
    saveThumbnailJobStateAtomic(state.projectDir, state)

    const destPath = getCandidateImagePath(state.projectDir, candidate.round, candidate.optionId, candidate.revision)

    const exportRes = await this.provider.exportImage({
      mediaId: genRes.mediaId,
      projectId: state.flowProjectId,
      quality: '4k',
      fallbackToOriginalUrl: genRes.fifeUrl,
      destinationPath: destPath
    })

    // Verify downloaded file
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

  private resolveScriptText(projectDir: string, customPath?: string): string {
    if (customPath && fs.existsSync(customPath)) {
      try {
        return fs.readFileSync(customPath, 'utf-8')
      } catch {
        // ignore
      }
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
          } catch {
            // ignore
          }
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
      // Ignore in headless / test environments
    }
  }
}

export const thumbnailOrchestrator = new ThumbnailOrchestrator()
