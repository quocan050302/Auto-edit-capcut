import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../logger'
import { IPC_CHANNELS } from '../../../shared/types'
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
  applyInvalidation
} from './pipeline-state'
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
  runPostflightStage
} from './pipeline-stage-runners'

interface ActivePipelineInstance {
  runId: string
  projectDir: string
  abortController: AbortController
  promise: Promise<AutoPipelineState>
}

class PipelineOrchestrator {
  private activeInstances = new Map<string, ActivePipelineInstance>()

  /**
   * Phát event cập nhật trạng thái pipeline đến toàn bộ BrowserWindows.
   */
  public broadcastProgress(state: AutoPipelineState): void {
    try {
      if (typeof BrowserWindow !== 'undefined' && BrowserWindow?.getAllWindows) {
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.PIPELINE_PROGRESS, state)
          }
        }
      }
    } catch {
      // Ignore in headless test environments
    }
  }

  /**
   * Khởi động Auto Production Pipeline.
   * Ngăn chặn race condition và double-start.
   */
  public async startPipeline(options: AutoPipelineOptions): Promise<{ runId: string; state: AutoPipelineState }> {
    const { projectDir } = options
    if (!projectDir) throw new Error('projectDir is required to start Auto Production Pipeline.')

    // Kiểm tra pipeline đang chạy
    const existing = this.activeInstances.get(projectDir)
    if (existing) {
      logger.warn(`[Pipeline] Pipeline already running for project: ${projectDir}`)
      const currentState = loadPipelineState(projectDir)
      return {
        runId: existing.runId,
        state: currentState ?? createInitialPipelineState(options, computeInputFingerprint(projectDir, options.scriptPath, options.voiceoverPath), existing.runId)
      }
    }

    const fingerprint = computeInputFingerprint(projectDir, options.scriptPath, options.voiceoverPath)

    // Kiểm tra xem đã có state cũ chưa để quyết định invalidate nếu cần
    let state = loadPipelineState(projectDir)
    const runId = uuidv4()

    if (!state) {
      state = createInitialPipelineState(options, fingerprint, runId)
    } else {
      // Check invalidation
      const invalidated = determineInvalidatedStages(state, options, fingerprint)
      if (invalidated.length > 0) {
        applyInvalidation(state, invalidated)
        logger.info(`[Pipeline] Invalidated stages: ${invalidated.join(', ')}`)
      }
      state.runId = runId
      state.inputFingerprint = fingerprint
      state.options = options
      state.overallStatus = 'running'
      state.updatedAt = new Date().toISOString()
      state.fatalErrors = []
    }

    savePipelineStateAtomic(projectDir, state)
    this.broadcastProgress(state)

    const abortController = new AbortController()

    // Khởi động chạy background
    const promise = this.executePipelineLoop(state, abortController)
    this.activeInstances.set(projectDir, {
      runId,
      projectDir,
      abortController,
      promise
    })

    return { runId, state }
  }

  /**
   * Tiếp tục chạy pipeline từ stage chưa hoàn thành đầu tiên.
   */
  public async resumePipeline(projectDir: string): Promise<{ runId: string; state: AutoPipelineState }> {
    if (!projectDir) throw new Error('projectDir is required to resume pipeline.')

    const existing = this.activeInstances.get(projectDir)
    if (existing) {
      const currentState = loadPipelineState(projectDir)
      return { runId: existing.runId, state: currentState! }
    }

    let state = loadPipelineState(projectDir)
    if (!state) {
      throw new Error(`No pipeline state found to resume for project: ${projectDir}`)
    }

    // Kiểm tra fingerprint hiện tại
    const currentFingerprint = computeInputFingerprint(
      projectDir,
      state.options.scriptPath,
      state.options.voiceoverPath
    )

    const invalidated = determineInvalidatedStages(state, state.options, currentFingerprint)
    if (invalidated.length > 0) {
      applyInvalidation(state, invalidated)
      state.inputFingerprint = currentFingerprint
    }

    state.runId = uuidv4()
    state.overallStatus = 'running'
    state.updatedAt = new Date().toISOString()
    state.fatalErrors = []
    savePipelineStateAtomic(projectDir, state)
    this.broadcastProgress(state)

    const abortController = new AbortController()
    const promise = this.executePipelineLoop(state, abortController)
    this.activeInstances.set(projectDir, {
      runId: state.runId,
      projectDir,
      abortController,
      promise
    })

    return { runId: state.runId, state }
  }

  /**
   * Hủy pipeline đang chạy.
   */
  public cancelPipeline(projectDirOrRunId: string): boolean {
    for (const [projectDir, instance] of this.activeInstances.entries()) {
      if (instance.runId === projectDirOrRunId || projectDir === projectDirOrRunId) {
        logger.info(`[Pipeline] Cancelling pipeline run ${instance.runId} for ${projectDir}`)
        instance.abortController.abort()

        const state = loadPipelineState(projectDir)
        if (state) {
          state.overallStatus = 'cancelled'
          if (state.currentStage && state.stages[state.currentStage]) {
            state.stages[state.currentStage].status = 'cancelled'
            state.stages[state.currentStage].message = 'Stage cancelled by user'
          }
          state.updatedAt = new Date().toISOString()
          savePipelineStateAtomic(projectDir, state)
          this.broadcastProgress(state)
        }

        this.activeInstances.delete(projectDir)
        return true
      }
    }
    return false
  }

  /**
   * Lấy trạng thái hiện tại của pipeline.
   */
  public getStatus(projectDir: string): AutoPipelineState | null {
    return loadPipelineState(projectDir)
  }

  /**
   * Chạy lại một stage cụ thể (dành cho debugging hoặc sửa lỗi).
   */
  public async retryStage(projectDir: string, targetStage: PipelineStage): Promise<{ runId: string; state: AutoPipelineState }> {
    let state = loadPipelineState(projectDir)
    if (!state) throw new Error(`No pipeline state found for project: ${projectDir}`)

    // Invalidate target stage và tất cả các stage downstream
    const stageIdx = PIPELINE_EXECUTION_STAGES.indexOf(targetStage)
    if (stageIdx >= 0) {
      const downstream = PIPELINE_EXECUTION_STAGES.slice(stageIdx)
      applyInvalidation(state, [...downstream])
    }

    savePipelineStateAtomic(projectDir, state)
    return this.resumePipeline(projectDir)
  }

  /**
   * Chạy từ một stage chỉ định.
   */
  public async runFromStage(
    projectDir: string,
    stage: PipelineStage,
    overrideOptions?: Partial<AutoPipelineOptions>
  ): Promise<{ runId: string; state: AutoPipelineState }> {
    let state = loadPipelineState(projectDir)
    if (!state) throw new Error(`No pipeline state found for project: ${projectDir}`)

    if (overrideOptions) {
      state.options = { ...state.options, ...overrideOptions }
    }

    const stageIdx = PIPELINE_EXECUTION_STAGES.indexOf(stage)
    if (stageIdx >= 0) {
      const downstream = PIPELINE_EXECUTION_STAGES.slice(stageIdx)
      applyInvalidation(state, [...downstream])
    }

    savePipelineStateAtomic(projectDir, state)
    return this.resumePipeline(projectDir)
  }

  /**
   * Vòng lặp chính thực thi tuần tự các stage.
   */
  private async executePipelineLoop(
    state: AutoPipelineState,
    abortController: AbortController
  ): Promise<AutoPipelineState> {
    const { projectDir } = state
    const signal = abortController.signal
    let lastRenderResult: { outputPath: string } = { outputPath: state.renderOutputPath || '' }

    try {
      state.overallStatus = 'running'
      state.startedAt = state.startedAt || new Date().toISOString()
      savePipelineStateAtomic(projectDir, state)
      this.broadcastProgress(state)

      for (let i = 0; i < PIPELINE_EXECUTION_STAGES.length; i++) {
        const stage = PIPELINE_EXECUTION_STAGES[i]

        if (signal.aborted) {
          state.overallStatus = 'cancelled'
          break
        }

        const stageState = state.stages[stage]

        // Nếu stage đã completed hợp lệ, bỏ qua để tiết kiệm thời gian
        if (stageState && stageState.status === 'completed') {
          logger.info(`[Pipeline] Stage ${stage} is already completed, skipping.`)
          if (stage === 'rendering' && stageState.artifactPath) {
            lastRenderResult = { outputPath: stageState.artifactPath }
          }
          continue
        }

        // Cập nhật stage đang chạy
        state.currentStage = stage
        state.stages[stage] = {
          status: 'running',
          progress: 0,
          startedAt: new Date().toISOString(),
          message: `Running ${stage}...`
        }
        state.updatedAt = new Date().toISOString()
        savePipelineStateAtomic(projectDir, state)
        this.broadcastProgress(state)

        const stageStartTime = Date.now()

        const onProgress = (message: string, progress: number): void => {
          if (signal.aborted) return
          state.stages[stage].message = message
          state.stages[stage].progress = Math.min(Math.max(progress, 0), 1)
          state.updatedAt = new Date().toISOString()
          savePipelineStateAtomic(projectDir, state)
          this.broadcastProgress(state)
        }

        // Chạy stage runner tương ứng
        let stageResult
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
            break
          }
          const msg = err instanceof Error ? err.message : String(err)
          logger.error(`[Pipeline] Stage ${stage} failed with unhandled error: ${msg}`)
          stageResult = {
            success: false,
            error: msg
          }
        }

        const durationMs = Date.now() - stageStartTime
        state.stages[stage].durationMs = durationMs
        state.stages[stage].completedAt = new Date().toISOString()

        if (stageResult.warning) {
          state.stages[stage].warning = stageResult.warning
          if (!state.warnings.includes(stageResult.warning)) {
            state.warnings.push(stageResult.warning)
          }
        }

        if (stageResult.artifactPath) {
          state.stages[stage].artifactPath = stageResult.artifactPath
        }

        if (stageResult.stats) {
          state.stages[stage].stats = {
            ...(state.stages[stage].stats || {}),
            ...stageResult.stats
          }
        }

        // Xử lý kết quả stage
        if (stageResult.needsAttention) {
          logger.warn(`[Pipeline] Stage ${stage} requires user attention: ${stageResult.error}`)
          state.stages[stage].status = 'warning'
          state.stages[stage].message = stageResult.error || 'Needs user attention'
          state.stages[stage].error = stageResult.error
          state.overallStatus = 'needs-attention'
          state.currentStage = 'needs-attention'
          state.updatedAt = new Date().toISOString()
          savePipelineStateAtomic(projectDir, state)
          this.broadcastProgress(state)
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
          state.updatedAt = new Date().toISOString()
          savePipelineStateAtomic(projectDir, state)
          this.broadcastProgress(state)
          return state
        }

        // Stage thành công
        state.stages[stage].status = 'completed'
        state.stages[stage].progress = 1.0
        state.stages[stage].message = stageResult.cached ? 'Using cached result' : 'Completed'
        state.updatedAt = new Date().toISOString()
        savePipelineStateAtomic(projectDir, state)
        this.broadcastProgress(state)
      }

      // Toàn bộ pipeline đã hoàn tất thành công
      if (state.overallStatus === 'running') {
        state.overallStatus = 'completed'
        state.currentStage = 'completed'
        state.completedAt = new Date().toISOString()
        state.updatedAt = new Date().toISOString()
        savePipelineStateAtomic(projectDir, state)
        this.broadcastProgress(state)
        logger.info(`[Pipeline] Pipeline ${state.runId} completed successfully!`)
      }
    } finally {
      this.activeInstances.delete(projectDir)
    }

    return state
  }
}

export const pipelineOrchestrator = new PipelineOrchestrator()
