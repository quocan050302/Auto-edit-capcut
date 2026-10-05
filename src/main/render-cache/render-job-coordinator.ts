/**
 * render-job-coordinator.ts
 *
 * Project-level render mutex shared by Manual Render (Step 4) and the Auto Production
 * Pipeline. Guarantees at most ONE render job (and therefore one FFmpeg/Remotion
 * process tree) per project.
 *
 *  - Same request key while running → attach to the existing job (no second job).
 *  - Different request key while running → rejected with RenderBusyError.
 */

import * as path from 'path'
import { logger } from '../logger'

export class RenderBusyError extends Error {
  constructor(message = 'Another render is already active for this project.') {
    super(message)
    this.name = 'RenderBusyError'
  }
}

export interface RenderJobProgress {
  stage: string
  progress: number
  sceneIndex?: number
  totalScenes?: number
}

export type RenderJobListener = (p: RenderJobProgress) => void

export type RenderJobSource = 'manual' | 'pipeline' | 'resume'

interface RenderJob<T> {
  projectDir: string
  requestKey: string
  source: RenderJobSource
  abortController: AbortController
  listeners: Set<RenderJobListener>
  promise: Promise<T>
  startedAt: number
  lastProgress?: RenderJobProgress
  cancelReason?: 'user-cancelled' | 'app-closed'
}

function norm(projectDir: string): string {
  return path.normalize(path.resolve(projectDir))
}

export class RenderJobCoordinator {
  private jobs = new Map<string, RenderJob<unknown>>()

  isActive(projectDir: string): boolean {
    return this.jobs.has(norm(projectDir))
  }

  hasAnyActive(): boolean {
    return this.jobs.size > 0
  }

  getActiveInfo(projectDir: string): { requestKey: string; source: RenderJobSource; startedAt: number; lastProgress?: RenderJobProgress } | null {
    const job = this.jobs.get(norm(projectDir))
    if (!job) return null
    return { requestKey: job.requestKey, source: job.source, startedAt: job.startedAt, lastProgress: job.lastProgress }
  }

  getCancelReason(projectDir: string): 'user-cancelled' | 'app-closed' | undefined {
    return this.jobs.get(norm(projectDir))?.cancelReason
  }

  /**
   * Run (or attach to) the render job for a project.
   *
   * @param starter receives an AbortSignal and an emit function for progress.
   * @param externalSignal optional upstream signal (e.g. pipeline cancel) linked to the job.
   */
  run<T>(params: {
    projectDir: string
    requestKey: string
    source: RenderJobSource
    listener?: RenderJobListener
    externalSignal?: AbortSignal
    starter: (signal: AbortSignal, emit: RenderJobListener) => Promise<T>
  }): { promise: Promise<T>; attached: boolean } {
    const key = norm(params.projectDir)
    const existing = this.jobs.get(key) as RenderJob<T> | undefined

    if (existing) {
      if (existing.requestKey === params.requestKey) {
        if (params.listener) {
          existing.listeners.add(params.listener)
          if (existing.lastProgress) params.listener(existing.lastProgress)
        }
        logger.info(`[RenderCoordinator] Attached ${params.source} listener to running render for ${key}`)
        if (params.externalSignal) this.linkSignal(existing, params.externalSignal)
        return { promise: existing.promise, attached: true }
      }
      throw new RenderBusyError(
        'Another render with different settings is already running for this project. Wait for it to finish or cancel it first.'
      )
    }

    const abortController = new AbortController()
    const listeners = new Set<RenderJobListener>()
    if (params.listener) listeners.add(params.listener)

    const job: RenderJob<T> = {
      projectDir: key,
      requestKey: params.requestKey,
      source: params.source,
      abortController,
      listeners,
      startedAt: Date.now(),
      promise: Promise.resolve() as unknown as Promise<T>
    }

    const emit: RenderJobListener = (p) => {
      job.lastProgress = p
      for (const l of job.listeners) {
        try { l(p) } catch { /* a broken listener must not break the render */ }
      }
    }

    if (params.externalSignal) this.linkSignal(job, params.externalSignal)

    this.jobs.set(key, job as RenderJob<unknown>)
    job.promise = (async () => {
      try {
        return await params.starter(abortController.signal, emit)
      } finally {
        if (this.jobs.get(key) === (job as RenderJob<unknown>)) this.jobs.delete(key)
      }
    })()
    return { promise: job.promise, attached: false }
  }

  /** Detach a listener (e.g. renderer window closed) without cancelling the job. */
  detach(projectDir: string, listener: RenderJobListener): void {
    this.jobs.get(norm(projectDir))?.listeners.delete(listener)
  }

  cancel(projectDir: string, reason: 'user-cancelled' | 'app-closed' = 'user-cancelled'): boolean {
    const job = this.jobs.get(norm(projectDir))
    if (!job) return false
    job.cancelReason = reason
    job.abortController.abort()
    logger.info(`[RenderCoordinator] Render for ${job.projectDir} cancelled (${reason})`)
    return true
  }

  /** Abort every job (app quit). Resolves once all job promises settle or timeout. */
  async abortAll(reason: 'user-cancelled' | 'app-closed', timeoutMs = 4000): Promise<void> {
    const all = Array.from(this.jobs.values())
    for (const job of all) {
      job.cancelReason = reason
      job.abortController.abort()
    }
    if (all.length === 0) return
    await Promise.race([
      Promise.allSettled(all.map((j) => j.promise)),
      new Promise((r) => setTimeout(r, timeoutMs))
    ])
  }

  private linkSignal(job: RenderJob<unknown>, signal: AbortSignal): void {
    const onAbort = (): void => {
      job.cancelReason = job.cancelReason ?? 'user-cancelled'
      job.abortController.abort()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
}

export const renderJobCoordinator = new RenderJobCoordinator()
