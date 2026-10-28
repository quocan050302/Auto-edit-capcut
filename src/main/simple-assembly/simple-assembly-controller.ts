import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'
import { logger } from '../logger'
import { renderJobCoordinator, RenderBusyError } from '../render-cache/render-job-coordinator'
import { executeSimpleAssembly } from './simple-assembly-engine'
import type {
  SimpleAssemblyRequest,
  SimpleAssemblyResult,
  SimpleAssemblyProgressPayload
} from './simple-assembly-types'

export interface ActiveAssemblyState {
  projectDir: string
  isActive: boolean
  lastProgress?: SimpleAssemblyProgressPayload
  outputPath?: string
  error?: string
}

export class SimpleAssemblyController {
  private activeJobs = new Map<string, { abortController: AbortController; state: ActiveAssemblyState }>()

  public isRunning(projectDir: string): boolean {
    return renderJobCoordinator.isActive(projectDir)
  }

  public getStatus(projectDir: string): ActiveAssemblyState {
    const job = this.activeJobs.get(projectDir)
    if (job) {
      return job.state
    }
    return {
      projectDir,
      isActive: renderJobCoordinator.isActive(projectDir)
    }
  }

  public async startAssembly(
    request: SimpleAssemblyRequest,
    senderWindow?: BrowserWindow | null
  ): Promise<SimpleAssemblyResult> {
    const { projectDir } = request

    // Request key for the coordinator
    const requestKey = `simple-assembly:${projectDir}:${request.backgroundMusicMode}:${request.outputName || 'simple_assembly'}`

    const abortController = new AbortController()
    const state: ActiveAssemblyState = {
      projectDir,
      isActive: true
    }
    this.activeJobs.set(projectDir, { abortController, state })

    const broadcast = (p: SimpleAssemblyProgressPayload): void => {
      state.lastProgress = p
      if (senderWindow && !senderWindow.isDestroyed()) {
        try {
          senderWindow.webContents.send(IPC_CHANNELS.SIMPLE_ASSEMBLY_PROGRESS, p)
        } catch {
          /* ignore */
        }
      }
    }

    try {
      const { promise } = renderJobCoordinator.run<SimpleAssemblyResult>({
        projectDir,
        requestKey,
        source: 'manual',
        externalSignal: abortController.signal,
        starter: async (signal) => {
          return await executeSimpleAssembly({
            ...request,
            signal,
            onProgress: (p) => {
              broadcast(p)
              request.onProgress?.(p)
            }
          })
        }
      })

      const res = await promise
      state.isActive = false
      state.outputPath = res.outputPath
      state.error = res.error
      return res
    } catch (err: unknown) {
      state.isActive = false
      const msg = err instanceof Error ? err.message : String(err)
      state.error = msg
      if (err instanceof RenderBusyError) {
        logger.warn(`[SimpleAssemblyController] ${msg}`)
      } else {
        logger.error(`[SimpleAssemblyController] Assembly failed: ${msg}`)
      }
      return { success: false, error: msg }
    } finally {
      this.activeJobs.delete(projectDir)
    }
  }

  public cancelAssembly(projectDir: string): boolean {
    const job = this.activeJobs.get(projectDir)
    if (job) {
      logger.info(`[SimpleAssemblyController] Cancelling assembly for ${projectDir}`)
      job.abortController.abort()
      renderJobCoordinator.cancel(projectDir, 'user-cancelled')
      this.activeJobs.delete(projectDir)
      return true
    }
    return renderJobCoordinator.cancel(projectDir, 'user-cancelled')
  }
}

export const simpleAssemblyController = new SimpleAssemblyController()
