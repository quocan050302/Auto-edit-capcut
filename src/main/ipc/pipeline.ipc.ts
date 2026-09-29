import { IpcMain } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'
import { pipelineOrchestrator } from '../pipeline/pipeline-orchestrator'
import { logger } from '../logger'
import type {
  AutoPipelineOptions,
  PipelineStage
} from '../pipeline/pipeline-types'

export function registerPipelineHandlers(ipcMain: IpcMain): void {
  // ── Start Auto Production Pipeline ──────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_START,
    async (_event, options: AutoPipelineOptions) => {
      try {
        if (!options || typeof options !== 'object') {
          return { success: false, error: 'Invalid pipeline options provided.' }
        }
        if (!options.projectDir) {
          return { success: false, error: 'projectDir is required.' }
        }
        if (!options.scriptPath) {
          return { success: false, error: 'scriptPath is required for Auto Production.' }
        }
        if (!options.voiceoverPath) {
          return { success: false, error: 'voiceoverPath is required for Auto Production.' }
        }

        const { runId, state } = await pipelineOrchestrator.startPipeline(options)
        return { success: true, runId, state }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[PipelineIPC] Start failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ── Resume Pipeline ─────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_RESUME,
    async (_event, params: { projectDir: string }) => {
      try {
        if (!params?.projectDir) {
          return { success: false, error: 'projectDir is required.' }
        }
        const { runId, state } = await pipelineOrchestrator.resumePipeline(params.projectDir)
        return { success: true, runId, state }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[PipelineIPC] Resume failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ── Cancel Pipeline ─────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_CANCEL,
    async (_event, params: { runId?: string; projectDir?: string }) => {
      try {
        const target = params?.runId || params?.projectDir
        if (!target) {
          return { success: false, error: 'runId or projectDir is required.' }
        }
        const ok = pipelineOrchestrator.cancelPipeline(target)
        return { success: ok }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[PipelineIPC] Cancel failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ── Get Pipeline Status ─────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_STATUS_GET,
    async (_event, params: { projectDir: string }) => {
      try {
        if (!params?.projectDir) return null
        return pipelineOrchestrator.getStatus(params.projectDir)
      } catch (err) {
        logger.error(`[PipelineIPC] GetStatus failed: ${String(err)}`)
        return null
      }
    }
  )

  // ── Retry Stage ─────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_RETRY_STAGE,
    async (_event, params: { projectDir: string; stage: PipelineStage }) => {
      try {
        if (!params?.projectDir || !params?.stage) {
          return { success: false, error: 'projectDir and stage are required.' }
        }
        const { runId, state } = await pipelineOrchestrator.retryStage(params.projectDir, params.stage)
        return { success: true, runId, state }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[PipelineIPC] RetryStage failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ── Run from Stage ──────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_RUN_FROM_STAGE,
    async (
      _event,
      params: {
        projectDir: string
        stage: PipelineStage
        options?: Partial<AutoPipelineOptions>
      }
    ) => {
      try {
        if (!params?.projectDir || !params?.stage) {
          return { success: false, error: 'projectDir and stage are required.' }
        }
        const { runId, state } = await pipelineOrchestrator.runFromStage(
          params.projectDir,
          params.stage,
          params.options
        )
        return { success: true, runId, state }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[PipelineIPC] RunFromStage failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )
}
