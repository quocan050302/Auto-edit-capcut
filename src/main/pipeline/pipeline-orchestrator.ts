import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../logger'
import { thumbnailAutoTrigger } from '../thumbnail/thumbnail-auto-trigger'
import { IPC_CHANNELS } from '../../../shared/types'
import type {
  PipelineRecoveryResult,
  PipelineSnapshot,
  PipelineLease
} from '../../../shared/types'
import {
  PIPELINE_EXECUTION_STAGES
} from './pipeline-types'
import type {
  AutoPipelineState,
  AutoPipelineOptions,
  PipelineStage,
  PipelineError
} from './pipeline-types'
import {
  computeInputFingerprint,
  createInitialPipelineState,
  loadPipelineState,
  savePipelineStateAtomic,
  determineInvalidatedStages,
  applyInvalidation,
  createLease,
  updateHeartbeat,
  releaseLease,
  isLeaseStale,
  normalizeProjectDir,
  toSnapshot,
  APP_INSTANCE_ID,
  isProcessAlive
} from './pipeline-state'
import {
  isTranscriptionValid,
  isPlanningValid,
  isCaptionsValid,
  isGlobalContextValid,
  checkStockCompletion,
  isAudioValid,
  isPreflightValid,
  reconcileProjectArtifacts
} from './pipeline-artifacts'
import {
  runValidationStage,
  runTranscriptionStage,
  runPlanningStage,
  runCaptionsStage,
  runGlobalContextStage,
  runStockSearchStage,
  runAudioSearchStage,
  runPreflightStage,
  runRenderStage,
  runPostflightStage,
  type StageRunResult,
  type StageProgressMeta
} from './pipeline-stage-runners'
import { renderJobCoordinator } from '../render-cache/render-job-coordinator'
import type { ArtifactReconciliationSummary } from './pipeline-artifacts'
import { pipelineProfiler } from '../performance/pipeline-profiler'

/**
 * When the final MP4 is missing but the render cache holds completed checkpoints,
 * keep the rendering stage pending/interrupted with its cached progress instead of
 * resetting it to 0 (Resumable Render Engine V2).
 */
function applyRenderRecoveryToState(state: AutoPipelineState, recon: ArtifactReconciliationSummary): void {
  const rr = recon.renderRecovery
  if (recon.renderValid || !rr || !rr.resumable || !state.stages.rendering) return
  if (state.stages.rendering.status === 'completed') return
  const pct = rr.totalScenes > 0 ? rr.completedScenes / rr.totalScenes : 0
  state.stages.rendering = {
    ...state.stages.rendering,
    status: 'pending',
    progress: Math.max(state.stages.rendering.progress ?? 0, Math.min(0.99, 0.08 + pct * 0.68)),
    message: rr.message ?? `Render interrupted — ${rr.completedScenes}/${rr.totalScenes} scenes cached`,
    stats: {
      ...(state.stages.rendering.stats || {}),
      renderCacheResumable: true,
      cachedScenes: rr.completedScenes,
      totalScenes: rr.totalScenes,
      cachedOverlayBlocks: rr.completedOverlayBlocks,
      totalOverlayBlocks: rr.totalOverlayBlocks,
      renderPhase: rr.currentPhase
    }
  }
}

interface ActivePipelineInstance {
  runId: string
  projectDir: string
  abortController: AbortController
  promise: Promise<AutoPipelineState>
  stageStartTime: number
  currentStage: PipelineStage
}

class PipelineOrchestrator {
  private activeInstances = new Map<string, ActivePipelineInstance>()
  private heartbeatTimers = new Map<string, NodeJS.Timeout>()
  private projectMutexes = new Map<string, Promise<unknown>>()

  /** True when a pipeline run for this project is active in this process. */
  public isRunning(projectDir: string): boolean {
    return this.activeInstances.has(normalizeProjectDir(projectDir))
  }

  /**
   * Chạy tác vụ với mutex trên projectDir để ngăn chặn start/resume/recover đồng thời.
   */
  private async withProjectLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
    const norm = normalizeProjectDir(projectDir)
    const currentLock = this.projectMutexes.get(norm) ?? Promise.resolve()
    let resolveLock!: () => void
    const nextLock = new Promise<void>((res) => {
      resolveLock = res
    })
    this.projectMutexes.set(norm, nextLock)

    try {
      await currentLock
      return await fn()
    } finally {
      resolveLock()
      if (this.projectMutexes.get(norm) === nextLock) {
        this.projectMutexes.delete(norm)
      }
    }
  }

  /**
   * Phát snapshot trạng thái pipeline đến toàn bộ BrowserWindows.
   */
  public broadcastProgress(state: AutoPipelineState): void {
    try {
      const snapshot = toSnapshot(state)
      if (typeof BrowserWindow !== 'undefined' && BrowserWindow?.getAllWindows) {
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.PIPELINE_PROGRESS, snapshot)
          }
        }
      }
    } catch {
      // Ignore in headless test environments
    }
  }

  /**
   * Bắt đầu timer heartbeat định kỳ (mỗi 3 giây) ghi nhận lease còn sống.
   */
  private startHeartbeat(projectDir: string, runId: string): void {
    this.stopHeartbeat(projectDir)
    const norm = normalizeProjectDir(projectDir)
    const timer = setInterval(() => {
      const instance = this.activeInstances.get(norm)
      if (!instance || instance.runId !== runId) {
        this.stopHeartbeat(norm)
        return
      }
      const state = loadPipelineState(norm)
      if (state && state.runId === runId && state.overallStatus === 'running') {
        updateHeartbeat(state)
        savePipelineStateAtomic(norm, state)
      }
    }, 3000)
    this.heartbeatTimers.set(norm, timer)
  }

  /**
   * Dừng timer heartbeat.
   */
  private stopHeartbeat(projectDir: string): void {
    const norm = normalizeProjectDir(projectDir)
    const timer = this.heartbeatTimers.get(norm)
    if (timer) {
      clearInterval(timer)
      this.heartbeatTimers.delete(norm)
    }
  }

  /**
   * Helper hoàn tất stage theo đúng thứ tự bắt buộc:
   * 1. Service hoàn thành.
   * 2. Validate artifact đầu ra.
   * 3. Reconcile số liệu thực tế.
   * 4. Mark stage completed trong memory.
   * 5. Atomic write pipeline state (monotonic version++).
   * 6. Emit snapshot hoàn chỉnh tới renderer.
   */
  private async completeStage(
    state: AutoPipelineState,
    stage: PipelineStage,
    result: StageRunResult,
    stageStartTime: number
  ): Promise<void> {
    const norm = normalizeProjectDir(state.projectDir)
    const durationMs = Date.now() - stageStartTime

    state.stages[stage] = {
      status: 'completed',
      progress: 1.0,
      startedAt: state.stages[stage]?.startedAt || new Date(stageStartTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs,
      message: result.stats?.completionMessage
        ? String(result.stats.completionMessage)
        : result.cached
        ? 'Using cached result'
        : 'Completed',
      warning: result.warning,
      artifactPath: result.artifactPath || state.stages[stage]?.artifactPath,
      stats: {
        ...(state.stages[stage]?.stats || {}),
        ...(result.stats || {})
      }
    }

    if (result.warning && !state.warnings.includes(result.warning)) {
      state.warnings.push(result.warning)
    }

    state.version = (state.version ?? 0) + 1
    state.updatedAt = new Date().toISOString()
    if (state.lease) {
      state.lease.heartbeatAt = state.updatedAt
      state.lease.currentStage = stage
    }

    savePipelineStateAtomic(norm, state)
    this.broadcastProgress(state)
  }

  /**
   * Khởi động Auto Production Pipeline.
   * Tự động reclaim stale lease nếu tiến trình trước đã chết.
   */
  public async startPipeline(options: AutoPipelineOptions): Promise<{ runId: string; state: AutoPipelineState }> {
    const { projectDir } = options
    if (!projectDir) throw new Error('projectDir is required to start Auto Production Pipeline.')
    const norm = normalizeProjectDir(projectDir)

    return this.withProjectLock(norm, async () => {
      // 1. Kiểm tra in-memory instance đang hoạt động
      const existing = this.activeInstances.get(norm)
      if (existing) {
        logger.warn(`[Pipeline] Pipeline is already running in memory for project: ${norm}`)
        const currentState = loadPipelineState(norm)
        return {
          runId: existing.runId,
          state: currentState ?? createInitialPipelineState(options, computeInputFingerprint(norm, options.scriptPath, options.voiceoverPath), existing.runId)
        }
      }

      // 2. Kiểm tra lease trên disk
      let state = loadPipelineState(norm)
      if (state && state.overallStatus === 'running') {
        const isRunningInAnotherProcess =
          state.lease &&
          state.lease.appInstanceId !== APP_INSTANCE_ID &&
          isProcessAlive(state.lease.pid) &&
          !isLeaseStale(state.lease)

        if (isRunningInAnotherProcess) {
          throw new Error(`Pipeline is currently running in another process (PID ${state.lease?.pid || 'unknown'}).`)
        } else {
          logger.info(`[Pipeline] Reclaiming lease from prior unmanaged/stale run for ${norm}`)
          state.overallStatus = 'interrupted'
          releaseLease(state)
          savePipelineStateAtomic(norm, state)
        }
      }

      const fingerprint = computeInputFingerprint(norm, options.scriptPath, options.voiceoverPath)
      const runId = uuidv4()

      if (!state) {
        state = createInitialPipelineState(options, fingerprint, runId)
      } else {
        const invalidated = determineInvalidatedStages(state, options, fingerprint)
        if (invalidated.length > 0) {
          applyInvalidation(state, invalidated)
          logger.info(`[Pipeline] Invalidated stages: ${invalidated.join(', ')}`)
        }
        state.runId = runId
        state.inputFingerprint = fingerprint
        state.options = options
        state.overallStatus = 'running'
        state.version = (state.version ?? 0) + 1
        state.updatedAt = new Date().toISOString()
        state.fatalErrors = []
      }

      // Gán lease cho run mới
      state.lease = createLease(runId, 'validating')
      savePipelineStateAtomic(norm, state)
      this.broadcastProgress(state)

      const abortController = new AbortController()
      this.startHeartbeat(norm, runId)
      pipelineProfiler.startRun(norm, runId)

      const instance: ActivePipelineInstance = {
        runId,
        projectDir: norm,
        abortController,
        stageStartTime: Date.now(),
        currentStage: 'validating',
        promise: Promise.resolve(state) // replaced below
      }

      instance.promise = this.executePipelineLoop(state, abortController)
      this.activeInstances.set(norm, instance)

      return { runId, state }
    })
  }

  /**
   * Tiếp tục chạy pipeline từ stage chưa hoàn thành đầu tiên.
   */
  public async resumePipeline(projectDir: string): Promise<{ runId: string; state: AutoPipelineState }> {
    if (!projectDir) throw new Error('projectDir is required to resume pipeline.')
    const norm = normalizeProjectDir(projectDir)

    return this.withProjectLock(norm, async () => {
      const existing = this.activeInstances.get(norm)
      if (existing) {
        const currentState = loadPipelineState(norm)
        return { runId: existing.runId, state: currentState! }
      }

      let state = loadPipelineState(norm)
      if (!state) {
        throw new Error(`No pipeline state found to resume for project: ${norm}`)
      }

      // Nếu lease cũ còn tồn tại nhưng stale thì reclaim
      if (isLeaseStale(state.lease)) {
        logger.info(`[Pipeline] Reclaiming stale lease before resume on ${norm}`)
        releaseLease(state)
      }

      // Reconcile artifacts trên disk để đánh dấu stage đã xong trước khi resume
      const recon = reconcileProjectArtifacts(norm, state.options)
      if (recon.transcribingValid && state.stages.transcribing) state.stages.transcribing.status = 'completed'
      if (recon.planningValid && state.stages.planning) state.stages.planning.status = 'completed'
      if (recon.captionsValid && state.stages.captions) state.stages.captions.status = 'completed'
      if (recon.globalContextValid && state.stages['global-context']) state.stages['global-context'].status = 'completed'
      if (
        recon.stockCompletion.totalScenes > 0 &&
        recon.stockCompletion.missingScenes === 0 &&
        state.stages['stock-search']
      ) {
        state.stages['stock-search'].status = 'completed'
        state.stages['stock-search'].progress = 1.0
        state.stages['stock-search'].message = `Stock search completed — ${recon.stockCompletion.totalScenes}/${recon.stockCompletion.totalScenes} scenes assigned`
      }
      if (recon.audioValid && state.stages['audio-search']) state.stages['audio-search'].status = 'completed'
      if (recon.preflightValid && state.stages.preflight) state.stages.preflight.status = 'completed'
      if (recon.renderValid && state.stages.rendering) state.stages.rendering.status = 'completed'
      if (recon.postflightValid && state.stages.postflight) state.stages.postflight.status = 'completed'
      applyRenderRecoveryToState(state, recon)

      // Kiểm tra fingerprint hiện tại
      const currentFingerprint = computeInputFingerprint(
        norm,
        state.options.scriptPath,
        state.options.voiceoverPath
      )

      const invalidated = determineInvalidatedStages(state, state.options, currentFingerprint)
      if (invalidated.length > 0) {
        applyInvalidation(state, invalidated)
        state.inputFingerprint = currentFingerprint
      }

      const runId = uuidv4()
      state.runId = runId
      state.overallStatus = 'running'
      state.version = (state.version ?? 0) + 1
      state.updatedAt = new Date().toISOString()
      state.fatalErrors = []

      // Tìm stage đầu tiên chưa hoàn thành
      const firstPending = PIPELINE_EXECUTION_STAGES.find((s) => state!.stages[s]?.status !== 'completed') || 'validating'
      state.currentStage = firstPending
      state.lease = createLease(runId, firstPending)

      savePipelineStateAtomic(norm, state)
      this.broadcastProgress(state)

      const abortController = new AbortController()
      this.startHeartbeat(norm, runId)
      pipelineProfiler.startRun(norm, runId)

      const instance: ActivePipelineInstance = {
        runId,
        projectDir: norm,
        abortController,
        stageStartTime: Date.now(),
        currentStage: firstPending,
        promise: Promise.resolve(state)
      }

      instance.promise = this.executePipelineLoop(state, abortController)
      this.activeInstances.set(norm, instance)

      return { runId, state }
    })
  }

  /**
   * Hủy pipeline đang chạy hoặc dọn dẹp state mồ côi.
   */
  public cancelPipeline(projectDirOrRunId: string): boolean {
    let targetProjectDir: string | null = null

    // 1. Kiểm tra trong activeInstances
    for (const [projectDir, instance] of this.activeInstances.entries()) {
      if (instance.runId === projectDirOrRunId || projectDir === projectDirOrRunId) {
        logger.info(`[Pipeline] Cancelling active pipeline run ${instance.runId} for ${projectDir}`)
        instance.abortController.abort()
        targetProjectDir = projectDir
        break
      }
    }

    if (!targetProjectDir) {
      targetProjectDir = normalizeProjectDir(projectDirOrRunId)
    }

    this.stopHeartbeat(targetProjectDir)
    this.activeInstances.delete(targetProjectDir)

    // 2. Cập nhật persisted state trên đĩa kể cả khi instance không còn trong RAM
    const state = loadPipelineState(targetProjectDir)
    if (state) {
      state.overallStatus = 'cancelled'
      if (state.currentStage && state.stages[state.currentStage] && state.stages[state.currentStage].status === 'running') {
        state.stages[state.currentStage].status = 'cancelled'
        state.stages[state.currentStage].message = 'Stage cancelled by user'
      }
      releaseLease(state)
      state.version = (state.version ?? 0) + 1
      state.updatedAt = new Date().toISOString()
      savePipelineStateAtomic(targetProjectDir, state)
      this.broadcastProgress(state)
      return true
    }

    return false
  }

  /**
   * Lấy trạng thái hiện tại của pipeline. Tự động kiểm tra stale lease nếu app khởi động lại.
   */
  public getStatus(projectDir: string): AutoPipelineState | null {
    const norm = normalizeProjectDir(projectDir)
    const state = loadPipelineState(norm)
    if (!state) return null

    // Watchdog check: nếu state báo running nhưng không có orchestrator active trong memory -> chuyển interrupted
    if (state.overallStatus === 'running' && !this.activeInstances.has(norm)) {
      logger.warn(`[Pipeline] Running state with no active in-memory orchestrator detected on getStatus for ${norm}. Marking interrupted.`)
      state.overallStatus = 'interrupted'
      releaseLease(state)
      state.version = (state.version ?? 0) + 1
      state.updatedAt = new Date().toISOString()
      savePipelineStateAtomic(norm, state)
    }

    return state
  }

  /**
   * Phục hồi pipeline bị gián đoạn (crash recovery / bootstrap recovery).
   */
  public async recoverInterruptedPipeline(projectDir: string): Promise<PipelineRecoveryResult> {
    const norm = normalizeProjectDir(projectDir)

    return this.withProjectLock(norm, async () => {
      // Nếu pipeline đang thực sự chạy trong memory thì không recover
      if (this.activeInstances.has(norm)) {
        const active = this.activeInstances.get(norm)!
        return {
          recovered: false,
          previousRunId: active.runId,
          resumable: false,
          completedStages: [],
          invalidStages: [],
          warnings: ['Pipeline is currently active in memory.']
        }
      }

      const state = loadPipelineState(norm)
      if (!state) {
        return {
          recovered: false,
          resumable: false,
          completedStages: [],
          invalidStages: [],
          warnings: ['No auto-pipeline-state.json file found for project.']
        }
      }

      const previousRunId = state.runId
      const warnings: string[] = []
      const completedStages: PipelineStage[] = []
      const invalidStages: PipelineStage[] = []

      // 1. Reconcile thực tế artifacts trên đĩa
      const recon = reconcileProjectArtifacts(norm, state.options)

      // Transcription
      if (recon.transcribingValid) {
        completedStages.push('transcribing')
        state.stages.transcribing = {
          ...(state.stages.transcribing || {}),
          status: 'completed',
          progress: 1.0,
          message: 'Transcription artifact verified'
        }
      } else if (state.stages.transcribing?.status === 'completed') {
        invalidStages.push('transcribing')
        state.stages.transcribing.status = 'pending'
        warnings.push('Transcript artifact is missing or invalid. Will re-transcribe.')
      }

      // Planning
      if (recon.planningValid) {
        completedStages.push('planning')
        state.stages.planning = {
          ...(state.stages.planning || {}),
          status: 'completed',
          progress: 1.0,
          message: 'Master edit plan verified'
        }
      } else if (state.stages.planning?.status === 'completed') {
        invalidStages.push('planning')
        state.stages.planning.status = 'pending'
      }

      // Captions
      if (recon.captionsValid) {
        completedStages.push('captions')
        state.stages.captions = {
          ...(state.stages.captions || {}),
          status: 'completed',
          progress: 1.0,
          message: 'Caption plan verified'
        }
      } else if (state.stages.captions?.status === 'completed') {
        invalidStages.push('captions')
        state.stages.captions.status = 'pending'
      }

      // Global Context
      if (recon.globalContextValid) {
        completedStages.push('global-context')
        state.stages['global-context'] = {
          ...(state.stages['global-context'] || {}),
          status: 'completed',
          progress: 1.0,
          message: 'Global visual context verified'
        }
      } else if (state.stages['global-context']?.status === 'completed') {
        invalidStages.push('global-context')
        state.stages['global-context'].status = 'pending'
      }

      // Stock Search: Nếu đủ 100% scenes hợp lệ trên đĩa -> completed 95/95!
      if (
        recon.stockCompletion.totalScenes > 0 &&
        recon.stockCompletion.assignedScenes === recon.stockCompletion.totalScenes &&
        recon.stockCompletion.missingScenes === 0
      ) {
        completedStages.push('stock-search')
        state.stages['stock-search'] = {
          ...(state.stages['stock-search'] || {}),
          status: 'completed',
          progress: 1.0,
          message: `Stock search completed — ${recon.stockCompletion.totalScenes}/${recon.stockCompletion.totalScenes} scenes assigned`,
          stats: {
            totalScenes: recon.stockCompletion.totalScenes,
            assignedScenes: recon.stockCompletion.assignedScenes,
            downloadedScenes: recon.stockCompletion.downloadedScenes,
            missingScenes: 0,
            percent: 100
          }
        }
      } else {
        if (recon.stockCompletion.totalScenes > 0) {
          warnings.push(
            `Stock media incomplete: ${recon.stockCompletion.assignedScenes}/${recon.stockCompletion.totalScenes} scenes assigned (${recon.stockCompletion.missingScenes} missing).`
          )
        }
        if (state.stages['stock-search']?.status === 'completed') {
          invalidStages.push('stock-search')
          state.stages['stock-search'].status = 'pending'
        }
      }

      // Audio
      if (recon.audioValid) {
        completedStages.push('audio-search')
        state.stages['audio-search'] = {
          ...(state.stages['audio-search'] || {}),
          status: 'completed',
          progress: 1.0,
          message: 'Audio plan verified'
        }
      } else if (state.stages['audio-search']?.status === 'completed') {
        invalidStages.push('audio-search')
        state.stages['audio-search'].status = 'pending'
      }

      // Preflight
      if (recon.preflightValid) {
        completedStages.push('preflight')
        state.stages.preflight = {
          ...(state.stages.preflight || {}),
          status: 'completed',
          progress: 1.0,
          message: 'Preflight report passed'
        }
      } else if (state.stages.preflight?.status === 'completed') {
        invalidStages.push('preflight')
        state.stages.preflight.status = 'pending'
      }

      // Rendering
      if (recon.renderValid) {
        completedStages.push('rendering')
        state.stages.rendering = {
          ...(state.stages.rendering || {}),
          status: 'completed',
          progress: 1.0,
          message: 'Rendered video verified'
        }
      } else if (state.stages.rendering?.status === 'completed') {
        invalidStages.push('rendering')
        state.stages.rendering.status = 'pending'
      }
      applyRenderRecoveryToState(state, recon)
      if (recon.renderRecovery?.resumable && recon.renderRecovery.message) {
        warnings.push(recon.renderRecovery.message.replace('\n', ' — '))
      }

      // Postflight
      if (recon.postflightValid) {
        completedStages.push('postflight')
        state.stages.postflight = {
          ...(state.stages.postflight || {}),
          status: 'completed',
          progress: 1.0,
          message: 'Postflight QA passed'
        }
      }

      // 2. Tìm stage chưa hoàn thành đầu tiên
      const resumeFrom = PIPELINE_EXECUTION_STAGES.find((s) => state!.stages[s]?.status !== 'completed')

      // 3. Cập nhật overallStatus
      if (!resumeFrom) {
        state.overallStatus = 'completed'
        state.currentStage = 'completed'
      } else {
        state.overallStatus = 'interrupted'
        state.currentStage = resumeFrom
      }

      // 4. Giải phóng lease cũ
      releaseLease(state)
      state.version = (state.version ?? 0) + 1
      state.updatedAt = new Date().toISOString()

      savePipelineStateAtomic(norm, state)
      this.broadcastProgress(state)

      logger.info(`[Pipeline] Recovered interrupted pipeline for ${norm}. Next resume stage: ${resumeFrom || 'all completed'}`)

      return {
        recovered: true,
        previousRunId,
        resumable: !!resumeFrom,
        resumeFrom,
        completedStages,
        invalidStages,
        warnings
      }
    })
  }

  /**
   * Chạy lại một stage cụ thể (dành cho debugging hoặc sửa lỗi).
   */
  public async retryStage(projectDir: string, targetStage: PipelineStage): Promise<{ runId: string; state: AutoPipelineState }> {
    const norm = normalizeProjectDir(projectDir)
    let state = loadPipelineState(norm)
    if (!state) throw new Error(`No pipeline state found for project: ${norm}`)

    const stageIdx = PIPELINE_EXECUTION_STAGES.indexOf(targetStage)
    if (stageIdx >= 0) {
      const downstream = PIPELINE_EXECUTION_STAGES.slice(stageIdx)
      applyInvalidation(state, [...downstream])
    }

    state.version = (state.version ?? 0) + 1
    savePipelineStateAtomic(norm, state)
    return this.resumePipeline(norm)
  }

  /**
   * Chạy từ một stage chỉ định.
   */
  public async runFromStage(
    projectDir: string,
    stage: PipelineStage,
    overrideOptions?: Partial<AutoPipelineOptions>
  ): Promise<{ runId: string; state: AutoPipelineState }> {
    const norm = normalizeProjectDir(projectDir)
    let state = loadPipelineState(norm)
    if (!state) throw new Error(`No pipeline state found for project: ${norm}`)

    if (overrideOptions) {
      state.options = { ...state.options, ...overrideOptions }
    }

    const stageIdx = PIPELINE_EXECUTION_STAGES.indexOf(stage)
    if (stageIdx >= 0) {
      const downstream = PIPELINE_EXECUTION_STAGES.slice(stageIdx)
      applyInvalidation(state, [...downstream])
    }

    state.version = (state.version ?? 0) + 1
    savePipelineStateAtomic(norm, state)
    return this.resumePipeline(norm)
  }

  /**
   * Xử lý khi ứng dụng sắp tắt (before-quit / will-quit).
   * Đánh dấu các pipeline đang chạy thành interrupted và release lease an toàn.
   */
  public handleAppQuit(): void {
    logger.info(`[Pipeline] Application is closing. Gracefully saving active pipeline checkpoints...`)
    // Mark render jobs as "app-closed" (interrupted, auto-resumable) BEFORE the pipeline
    // abort propagates, so they are never mistaken for a user cancel.
    void renderJobCoordinator.abortAll('app-closed')
    for (const [projectDir, instance] of this.activeInstances.entries()) {
      try {
        instance.abortController.abort()
        this.stopHeartbeat(projectDir)

        const state = loadPipelineState(projectDir)
        if (state && state.overallStatus === 'running') {
          state.overallStatus = 'interrupted'
          if (state.currentStage && state.stages[state.currentStage]) {
            state.stages[state.currentStage].message = 'Interrupted: Application closed'
          }
          releaseLease(state)
          state.version = (state.version ?? 0) + 1
          state.updatedAt = new Date().toISOString()
          savePipelineStateAtomic(projectDir, state)
        }
      } catch (err) {
        logger.error(`[Pipeline] Error saving checkpoint during quit for ${projectDir}: ${String(err)}`)
      }
    }
    this.activeInstances.clear()
  }

  /**
   * Vòng lặp chính thực thi tuần tự các stage.
   */
  private async executePipelineLoop(
    state: AutoPipelineState,
    abortController: AbortController
  ): Promise<AutoPipelineState> {
    const norm = normalizeProjectDir(state.projectDir)
    const signal = abortController.signal
    const currentRunId = state.runId
    let lastRenderResult: { outputPath: string } = { outputPath: state.renderOutputPath || '' }

    try {
      state.overallStatus = 'running'
      state.startedAt = state.startedAt || new Date().toISOString()
      state.version = (state.version ?? 0) + 1
      savePipelineStateAtomic(norm, state)
      this.broadcastProgress(state)

      for (let i = 0; i < PIPELINE_EXECUTION_STAGES.length; i++) {
        const stage = PIPELINE_EXECUTION_STAGES[i]

        if (signal.aborted) {
          state.overallStatus = 'cancelled'
          break
        }

        const stageState = state.stages[stage]

        // Nếu stage đã completed hợp lệ, bỏ qua
        if (stageState && stageState.status === 'completed') {
          logger.info(`[Pipeline] Stage ${stage} is already completed, skipping.`)
          if (stage === 'rendering' && stageState.artifactPath) {
            lastRenderResult = { outputPath: stageState.artifactPath }
          }
          continue
        }

        // Cập nhật stage đang chạy
        state.currentStage = stage
        if (state.lease) {
          state.lease.currentStage = stage
          state.lease.heartbeatAt = new Date().toISOString()
        }
        const priorStage = state.stages[stage]
        const resumingCachedRender = stage === 'rendering' && priorStage?.stats?.renderCacheResumable === true
        state.stages[stage] = {
          status: 'running',
          // Resuming from render cache: do not reset progress to 0
          progress: resumingCachedRender ? priorStage.progress ?? 0 : 0,
          startedAt: new Date().toISOString(),
          message: resumingCachedRender ? 'Resuming cached render...' : `Running ${stage}...`,
          ...(resumingCachedRender ? { stats: priorStage.stats } : {})
        }
        state.version = (state.version ?? 0) + 1
        state.updatedAt = new Date().toISOString()
        savePipelineStateAtomic(norm, state)
        this.broadcastProgress(state)

        const stageStartTime = Date.now()

        // Progress callback với guard chống ghi đè late progress event
        const onProgress = (
          message: string,
          progress: number,
          meta?: StageProgressMeta
        ): void => {
          if (signal.aborted) return
          // Late event guard: bỏ qua nếu stage đã hoàn tất hoặc runId đã thay đổi
          if (state.runId !== currentRunId || state.stages[stage]?.status === 'completed') {
            logger.debug(`[Pipeline] Ignoring late progress event for stage ${stage}`)
            return
          }
          state.stages[stage].message = message
          state.stages[stage].progress = Math.min(Math.max(progress, 0), 1)
          if (meta && 'manualAiWait' in meta) {
            if (meta.manualAiWait) state.stages[stage].manualAiWait = meta.manualAiWait
            else delete state.stages[stage].manualAiWait
          }
          state.version = (state.version ?? 0) + 1
          state.updatedAt = new Date().toISOString()
          if (state.lease) {
            state.lease.heartbeatAt = state.updatedAt
          }
          savePipelineStateAtomic(norm, state)
          this.broadcastProgress(state)
        }

        // Chạy stage runner tương ứng
        let stageResult: StageRunResult
        pipelineProfiler.startStage(stage)
        try {
          switch (stage) {
            case 'validating':
              stageResult = await runValidationStage(state.options, onProgress, signal)
              break
            case 'transcribing':
              stageResult = await runTranscriptionStage(state.options, onProgress, signal)
              break
            case 'planning':
              stageResult = await runPlanningStage(state.options, onProgress, signal)
              break
            case 'captions':
              stageResult = await runCaptionsStage(state.options, onProgress, signal)
              break
            case 'global-context':
              stageResult = await runGlobalContextStage(state.options, onProgress, signal)
              break
            case 'stock-search':
              stageResult = await runStockSearchStage(state.options, onProgress, signal)
              break
            case 'audio-search':
              stageResult = await runAudioSearchStage(state.options, onProgress, signal)
              break
            case 'preflight':
              stageResult = await runPreflightStage(state.options, onProgress, signal)
              break
            case 'rendering':
              stageResult = await runRenderStage(state.options, onProgress, signal)
              if (stageResult.success && stageResult.artifactPath) {
                lastRenderResult = { outputPath: stageResult.artifactPath }
                state.renderOutputPath = stageResult.artifactPath
              }
              break
            case 'postflight':
              stageResult = await runPostflightStage(state.options, lastRenderResult, onProgress, signal)
              break
            default:
              throw new Error(`Unknown stage: ${stage}`)
          }
        } catch (err) {
          if (signal.aborted) {
            state.overallStatus = 'cancelled'
            state.stages[stage].status = 'cancelled'
            state.stages[stage].message = 'Cancelled by user'
            pipelineProfiler.endStage(stage, false)
            break
          }
          const msg = err instanceof Error ? err.message : String(err)
          logger.error(`[Pipeline] Stage ${stage} failed with unhandled error: ${msg}`)
          stageResult = {
            success: false,
            error: msg
          }
        }
        pipelineProfiler.endStage(stage, stageResult.cached)

        // Xử lý kết quả stage
        if (state.stages[stage]) delete state.stages[stage].manualAiWait
        if (stageResult.needsAttention) {
          logger.warn(`[Pipeline] Stage ${stage} requires user attention: ${stageResult.error}`)
          state.stages[stage].status = 'warning'
          state.stages[stage].message = stageResult.error || 'Needs user attention'
          state.stages[stage].error = stageResult.error
          state.overallStatus = 'needs-attention'
          state.currentStage = 'needs-attention'
          state.version = (state.version ?? 0) + 1
          state.updatedAt = new Date().toISOString()
          releaseLease(state)
          savePipelineStateAtomic(norm, state)
          this.broadcastProgress(state)
          pipelineProfiler.endRun()
          return state
        }

        if (!stageResult.success) {
          logger.error(`[Pipeline] Stage ${stage} failed: ${stageResult.error}`)
          state.stages[stage].status = 'failed'
          state.stages[stage].error = stageResult.error
          state.stages[stage].message = stageResult.error || 'Stage failed'
          state.overallStatus = 'failed'
          state.currentStage = 'failed'
          state.fatalErrors.push(`Stage [${stage}]: ${stageResult.error || 'failed'}`)
          state.version = (state.version ?? 0) + 1
          state.updatedAt = new Date().toISOString()
          releaseLease(state)
          savePipelineStateAtomic(norm, state)
          this.broadcastProgress(state)
          pipelineProfiler.endRun()
          return state
        }

        // Hoàn tất stage theo đúng thứ tự bắt buộc
        await this.completeStage(state, stage, stageResult, stageStartTime)
      }

      // Toàn bộ pipeline đã hoàn tất thành công
      if (state.overallStatus === 'running') {
        state.overallStatus = 'completed'
        state.currentStage = 'completed'
        state.completedAt = new Date().toISOString()
        state.version = (state.version ?? 0) + 1
        state.updatedAt = new Date().toISOString()
        releaseLease(state)
        savePipelineStateAtomic(norm, state)
        this.broadcastProgress(state)
        logger.info(`[Pipeline] Pipeline ${state.runId} completed successfully!`)

        // Trigger companion thumbnail generation (non-blocking, never fails video)
        void thumbnailAutoTrigger.startIfEligible({
          projectDir: norm,
          renderOutputPath: state.renderOutputPath,
          scriptPath: state.options?.scriptPath
        })
      }
    } finally {
      pipelineProfiler.endRun()
      this.stopHeartbeat(norm)
      this.activeInstances.delete(norm)
    }

    return state
  }
}

export const pipelineOrchestrator = new PipelineOrchestrator()
