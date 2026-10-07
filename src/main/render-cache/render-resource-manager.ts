/**
 * render-resource-manager.ts
 *
 * macOS-friendly resource profiles + adaptive load protection for rendering.
 *
 * Profiles ONLY control CPU/RAM usage (threads, concurrency, caches, priority).
 * They never change resolution, fps, codec quality or timeline → identical output.
 */

import * as os from 'os'
import { execFile } from 'child_process'
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks'
import { getLiveRenderProcessCount } from './ffmpeg-process'

export type RenderResourceProfile = 'balanced' | 'low-power' | 'fast'

export const DEFAULT_RESOURCE_PROFILE: RenderResourceProfile = 'balanced'

export const RESOURCE_PROFILE_LABELS: Record<RenderResourceProfile, string> = {
  balanced: 'Balanced — Recommended for Mac',
  'low-power': 'Low Power — Keeps the Mac responsive',
  fast: 'Fast — Uses more CPU and memory'
}

export interface RenderResourceLimits {
  profile: RenderResourceProfile
  logicalCpus: number
  ffmpegThreads: number
  ffmpegFilterThreads: number
  remotionConcurrency: number
  offthreadVideoThreads: number
  mediaCacheSizeInBytes: number
  offthreadVideoCacheSizeInBytes: number
  /** Unix niceness for spawned FFmpeg processes */
  niceLevel: number
  /** Max scene inputs per transition assembly segment (bounds decoder memory). */
  assemblyMaxScenesPerSegment: number
  /** 1-minute load average threshold relative to CPU count */
  loadAverageFactor: number
}

const MB = 1024 * 1024

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function normalizeResourceProfile(p: unknown): RenderResourceProfile {
  return p === 'low-power' || p === 'fast' || p === 'balanced' ? p : DEFAULT_RESOURCE_PROFILE
}

/**
 * Pure computation of limits for a profile on a given machine.
 */
export function computeResourceLimits(
  profileInput: RenderResourceProfile | string | undefined,
  logicalCpus: number = os.cpus().length || 4,
  totalMemBytes: number = os.totalmem()
): RenderResourceLimits {
  const profile = normalizeResourceProfile(profileInput)
  const n = Math.max(1, Math.floor(logicalCpus))
  const lowMemMachine = totalMemBytes > 0 && totalMemBytes < 12 * 1024 * MB

  switch (profile) {
    case 'low-power':
      return {
        profile,
        logicalCpus: n,
        ffmpegThreads: clamp(Math.floor(n / 4), 1, 2),
        ffmpegFilterThreads: 1,
        remotionConcurrency: 1,
        offthreadVideoThreads: 1,
        mediaCacheSizeInBytes: 256 * MB,
        offthreadVideoCacheSizeInBytes: 256 * MB,
        niceLevel: 15,
        assemblyMaxScenesPerSegment: 8,
        loadAverageFactor: 1.0
      }
    case 'fast':
      return {
        profile,
        logicalCpus: n,
        ffmpegThreads: clamp(n - 2, 2, 6),
        ffmpegFilterThreads: clamp(Math.floor(n / 2), 1, 4),
        remotionConcurrency: clamp(Math.floor(n * 0.5), 1, 16),
        offthreadVideoThreads: 2,
        mediaCacheSizeInBytes: (lowMemMachine ? 384 : 512) * MB,
        offthreadVideoCacheSizeInBytes: (lowMemMachine ? 384 : 512) * MB,
        niceLevel: 0,
        assemblyMaxScenesPerSegment: 24,
        loadAverageFactor: 2.0
      }
    case 'balanced':
    default:
      return {
        profile: 'balanced',
        logicalCpus: n,
        ffmpegThreads: clamp(Math.floor(n / 2), 2, 4),
        ffmpegFilterThreads: clamp(Math.floor(n / 3), 1, 3),
        remotionConcurrency: clamp(Math.floor(n / 4), 1, 2),
        offthreadVideoThreads: 1,
        mediaCacheSizeInBytes: (lowMemMachine ? 256 : 384) * MB,
        offthreadVideoCacheSizeInBytes: (lowMemMachine ? 256 : 384) * MB,
        niceLevel: 5,
        assemblyMaxScenesPerSegment: 12,
        loadAverageFactor: 1.5
      }
  }
}

// ─── System load sampling ────────────────────────────────────────────────────

export interface SystemLoadSample {
  loadAvg1: number
  logicalCpus: number
  availableMemRatio: number
  eventLoopLagMs: number
  liveRenderProcesses: number
  sampledAt: number
}

export interface LoadAssessment {
  underPressure: boolean
  reasons: string[]
}

export function assessLoad(sample: SystemLoadSample, limits: RenderResourceLimits): LoadAssessment {
  const reasons: string[] = []
  if (sample.availableMemRatio > 0 && sample.availableMemRatio < 0.15) {
    reasons.push(`available memory ${(sample.availableMemRatio * 100).toFixed(0)}%`)
  }
  if (sample.eventLoopLagMs > 250) {
    reasons.push(`event-loop lag ${Math.round(sample.eventLoopLagMs)}ms`)
  }
  if (sample.loadAvg1 > sample.logicalCpus * limits.loadAverageFactor) {
    reasons.push(`load average ${sample.loadAvg1.toFixed(1)}`)
  }
  return { underPressure: reasons.length > 0, reasons }
}

/**
 * Available memory ratio. On macOS `os.freemem()` excludes inactive/purgeable pages
 * and is almost always tiny, so we parse `vm_stat` instead.
 */
export function readAvailableMemoryRatio(): Promise<number> {
  const total = os.totalmem()
  const fallback = total > 0 ? os.freemem() / total : 1
  if (process.platform !== 'darwin') return Promise.resolve(fallback)
  return new Promise((resolve) => {
    // kern.memorystatus_level = % of memory available before pressure (Activity Monitor's
    // "Memory Pressure"). It accounts for compressible/file-backed pages, unlike freemem().
    execFile('sysctl', ['-n', 'kern.memorystatus_level'], { timeout: 2000 }, (sErr, sOut) => {
      const level = Number(String(sOut ?? '').trim())
      if (!sErr && Number.isFinite(level) && level > 0 && level <= 100) return resolve(level / 100)
      readVmStatRatio(total, fallback).then(resolve, () => resolve(fallback))
    })
  })
}

function readVmStatRatio(total: number, fallback: number): Promise<number> {
  return new Promise((resolve) => {
    execFile('vm_stat', { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve(fallback)
      try {
        const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 4096)
        const get = (label: string): number => {
          const m = new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)
          return m ? Number(m[1]) : 0
        }
        const availPages =
          get('Pages free') + get('Pages inactive') + get('Pages speculative') + get('Pages purgeable')
        const ratio = (availPages * pageSize) / total
        resolve(Number.isFinite(ratio) && ratio > 0 ? Math.min(1, ratio) : fallback)
      } catch {
        resolve(fallback)
      }
    })
  })
}

export class SystemLoadMonitor {
  private histogram: IntervalHistogram | null = null

  start(): void {
    if (this.histogram) return
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 20 })
      this.histogram.enable()
    } catch {
      this.histogram = null
    }
  }

  stop(): void {
    try {
      this.histogram?.disable()
    } catch {
      /* ignore */
    }
    this.histogram = null
  }

  async sample(): Promise<SystemLoadSample> {
    let lagMs = 0
    if (this.histogram) {
      // p95 delay since last sample (ns → ms), minus the sampling resolution
      lagMs = Math.max(0, this.histogram.percentile(95) / 1e6 - 20)
      this.histogram.reset()
    }
    return {
      loadAvg1: os.loadavg()[0] ?? 0,
      logicalCpus: os.cpus().length || 1,
      availableMemRatio: await readAvailableMemoryRatio(),
      eventLoopLagMs: lagMs,
      liveRenderProcesses: getLiveRenderProcessCount(),
      sampledAt: Date.now()
    }
  }
}

/** Cancellable, non-blocking sleep. */
export function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Adaptive throttle used between heavy jobs (scenes, overlay blocks).
 * When the system is under pressure it waits briefly (cancellable) and reports a
 * reduced concurrency for the NEXT job. Output is never affected.
 */
export class AdaptiveThrottle {
  private reducedSteps = 0
  public readonly monitor = new SystemLoadMonitor()

  constructor(
    private readonly limits: RenderResourceLimits,
    private readonly onNotice?: (msg: string) => void,
    private readonly sampler?: () => Promise<SystemLoadSample>
  ) {}

  start(): void {
    this.monitor.start()
  }

  stop(): void {
    this.monitor.stop()
  }

  /** Remotion concurrency to use for the next job. */
  currentRemotionConcurrency(): number {
    return Math.max(1, this.limits.remotionConcurrency - this.reducedSteps)
  }

  /** Total time (ms) this render may spend waiting for the system to calm down. */
  private waitBudgetMs = 60_000

  async beforeNextJob(signal?: AbortSignal, maxWaits = 2, waitMs = 2500): Promise<LoadAssessment> {
    let last: LoadAssessment = { underPressure: false, reasons: [] }
    for (let attempt = 0; attempt <= maxWaits; attempt++) {
      if (signal?.aborted) return last
      const sample = this.sampler ? await this.sampler() : await this.monitor.sample()
      last = assessLoad(sample, this.limits)
      if (!last.underPressure) {
        if (this.reducedSteps > 0 && attempt === 0) this.reducedSteps-- // recover gradually
        return last
      }
      if (attempt === 0) {
        this.reducedSteps = Math.min(this.reducedSteps + 1, Math.max(0, this.limits.remotionConcurrency - 1))
        this.onNotice?.(`System under load — reducing render concurrency (${last.reasons.join(', ')})`)
      }
      // Chronic pressure: once the budget is spent, keep reduced concurrency but stop
      // pausing, so a permanently busy Mac never stalls the render.
      if (attempt < maxWaits && this.waitBudgetMs > 0) {
        const ms = Math.min(waitMs, this.waitBudgetMs)
        this.waitBudgetMs -= ms
        await cancellableDelay(ms, signal)
      } else {
        break
      }
    }
    return last
  }
}
