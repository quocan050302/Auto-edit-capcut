/**
 * planning-request.ts
 *
 * Bounded API execution for AI Planning.
 * Combines per-request deadline timeouts, user cancellation (AbortSignal),
 * and clean resource release so Gemini calls never hang indefinitely.
 */

import { logger } from '../logger'

export class PlanningTimeoutError extends Error {
  public readonly isTimeout = true
  public readonly task: string
  public readonly timeoutMs: number

  constructor(task: string, timeoutMs: number) {
    super(`[PlanningTimeout] Task "${task}" exceeded deadline of ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'PlanningTimeoutError'
    this.task = task
    this.timeoutMs = timeoutMs
  }
}

export class PlanningCancelledError extends Error {
  public readonly isCancelled = true
  public readonly task: string

  constructor(task: string) {
    super(`[PlanningCancelled] Task "${task}" was cancelled by user`)
    this.name = 'PlanningCancelledError'
    this.task = task
  }
}

export interface PlanningRequestOptions<T> {
  task: string
  timeoutMs: number
  signal?: AbortSignal
  execute: (combinedSignal: AbortSignal) => Promise<T>
}

/**
 * Executes a planning request with:
 * 1. An explicit timeout deadline.
 * 2. An external abort signal (user cancellation).
 * 3. Guaranteed cleanup of event listeners and timers.
 */
export async function executePlanningRequest<T>(options: PlanningRequestOptions<T>): Promise<T> {
  const { task, timeoutMs, signal, execute } = options

  // 1. Check if already cancelled
  if (signal?.aborted) {
    throw new PlanningCancelledError(task)
  }

  const controller = new AbortController()
  let timer: NodeJS.Timeout | null = null
  let didTimeout = false

  const onUserAbort = (): void => {
    controller.abort(new PlanningCancelledError(task))
  }

  if (signal) {
    signal.addEventListener('abort', onUserAbort, { once: true })
  }

  timer = setTimeout(() => {
    didTimeout = true
    controller.abort(new PlanningTimeoutError(task, timeoutMs))
  }, timeoutMs)

  const t0 = Date.now()
  try {
    const result = await execute(controller.signal)
    const elapsed = Date.now() - t0
    logger.debug(`[PlanningRequest] Task "${task}" succeeded in ${elapsed}ms`)
    return result
  } catch (err: unknown) {
    const elapsed = Date.now() - t0

    if (signal?.aborted) {
      logger.info(`[PlanningRequest] Task "${task}" cancelled by user after ${elapsed}ms`)
      throw new PlanningCancelledError(task)
    }

    if (didTimeout || (err instanceof Error && err.name === 'AbortError' && didTimeout)) {
      logger.warn(`[PlanningRequest] Task "${task}" timed out after ${elapsed}ms (limit: ${timeoutMs}ms)`)
      throw new PlanningTimeoutError(task, timeoutMs)
    }

    throw err
  } finally {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (signal) {
      signal.removeEventListener('abort', onUserAbort)
    }
  }
}

/**
 * Calculates an adaptive timeout based on scene count.
 * Prevents small batches from waiting minutes while giving large batches ample headroom.
 */
export function computeBatchTimeoutMs(sceneCount: number): number {
  if (sceneCount <= 2) return 35000 // 35s for very small 1-2 scene projects
  if (sceneCount <= 5) return 45000 // 45s for 3-5 scenes
  if (sceneCount <= 10) return 60000 // 60s for 6-10 scenes
  return Math.min(85000, 50000 + sceneCount * 1500) // up to 80-85s for 20 scenes
}

/**
 * Calculates adaptive token output budget based on scene count.
 */
export function computeOutputTokenBudget(sceneCount: number): number {
  // ~200-250 tokens per scene JSON + safety buffer
  return Math.min(8192, Math.max(1024, sceneCount * 350))
}
