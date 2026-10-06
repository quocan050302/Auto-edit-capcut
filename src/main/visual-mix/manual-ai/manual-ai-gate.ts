import * as path from 'path'

/**
 * ManualAiAssetGate — event-driven wait for manually imported AI images.
 *
 * The importer calls `notify(projectDir)` after every commit; waiters re-evaluate their condition
 * only then (no tight polling loop). A slow safety-net poll (default 3s) covers external changes
 * (e.g. files copied while the app was restarting) and costs essentially nothing.
 */

export const MANUAL_AI_GATE_DEFAULT_POLL_MS = 3000
export const MANUAL_AI_CANCELLED_MESSAGE = 'Pipeline execution was cancelled.'

export interface ManualAiGateWaitOptions {
  projectDir: string
  /** Returns true when every required manual AI image is ready. May be async. */
  isReady: () => boolean | Promise<boolean>
  /** Called after every evaluation (also when still not ready), e.g. to publish progress to the UI. */
  onEvaluate?: () => void | Promise<void>
  signal?: AbortSignal
  pollIntervalMs?: number
}

function keyOf(projectDir: string): string {
  return path.resolve(projectDir)
}

export class ManualAiAssetGate {
  private listeners = new Map<string, Set<() => void>>()

  /** Wakes every waiter of this project (event-driven path). */
  notify(projectDir: string): void {
    const set = this.listeners.get(keyOf(projectDir))
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb()
      } catch {
        /* listener errors must never break the importer */
      }
    }
  }

  /** Number of active waiters for a project (used by tests / diagnostics). */
  waiterCount(projectDir: string): number {
    return this.listeners.get(keyOf(projectDir))?.size ?? 0
  }

  private subscribe(projectDir: string, cb: () => void): () => void {
    const key = keyOf(projectDir)
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(cb)
    return () => {
      const s = this.listeners.get(key)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) this.listeners.delete(key)
    }
  }

  /**
   * Resolves once `isReady()` is true. Rejects with the standard pipeline-cancel error on abort.
   * Evaluations are coalesced: notifications arriving while one is running trigger exactly one re-run.
   */
  waitUntilReady(opts: ManualAiGateWaitOptions): Promise<void> {
    const pollMs = Math.max(20, opts.pollIntervalMs ?? MANUAL_AI_GATE_DEFAULT_POLL_MS)

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let running = false
      let dirty = false
      let timer: NodeJS.Timeout | null = null
      let unsubscribe: (() => void) | null = null

      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        timer = null
        if (unsubscribe) unsubscribe()
        unsubscribe = null
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        if (err) reject(err)
        else resolve()
      }
      const onAbort = (): void => finish(new Error(MANUAL_AI_CANCELLED_MESSAGE))

      const schedulePoll = (): void => {
        if (settled) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void evaluate(), pollMs)
        // Never keep the process alive just for the safety-net poll.
        timer.unref?.()
      }

      const evaluate = async (): Promise<void> => {
        if (settled) return
        if (running) {
          dirty = true
          return
        }
        running = true
        try {
          do {
            dirty = false
            if (settled) return
            if (opts.signal?.aborted) {
              finish(new Error(MANUAL_AI_CANCELLED_MESSAGE))
              return
            }
            const ready = await opts.isReady()
            if (opts.onEvaluate) await opts.onEvaluate()
            if (ready) {
              finish()
              return
            }
          } while (dirty && !settled)
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)))
          return
        } finally {
          running = false
        }
        schedulePoll()
      }

      if (opts.signal?.aborted) {
        finish(new Error(MANUAL_AI_CANCELLED_MESSAGE))
        return
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      unsubscribe = this.subscribe(opts.projectDir, () => void evaluate())
      void evaluate()
    })
  }
}

export const manualAiAssetGate = new ManualAiAssetGate()
