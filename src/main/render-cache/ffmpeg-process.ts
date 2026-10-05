/**
 * ffmpeg-process.ts
 *
 * Shared, resource-aware FFmpeg / FFprobe process runner for the render engine.
 *
 *  - Thread limits (-threads / -filter_threads / -filter_complex_threads)
 *  - Bounded stderr ring buffer (never keeps a 20-minute log in memory)
 *  - Machine-readable progress (-progress pipe:1) with throttled callbacks
 *  - AbortSignal support: SIGTERM → grace period → SIGKILL
 *  - Global registry of live child processes so app quit can terminate them
 *
 * NOTE: `-progress pipe:1` also acts as orphan protection — if the Electron main
 * process dies, FFmpeg receives SIGPIPE on its next progress write and exits.
 */

import * as fs from 'fs'
import * as os from 'os'
import { spawn, type ChildProcess } from 'child_process'
import { logger } from '../logger'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegStaticPath: string = require('ffmpeg-static')

let ffmpegBinaryOverride: string | null = null

/** Test hook — allows pointing the runner at a fake binary. */
export function setFfmpegBinaryForTests(bin: string | null): void {
  ffmpegBinaryOverride = bin
}

export function getFfmpegBinary(): string {
  return ffmpegBinaryOverride ?? ffmpegStaticPath
}

export function getFfprobeBinary(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffp = require('ffprobe-static')
    if (ffp?.path && fs.existsSync(ffp.path)) return ffp.path as string
  } catch {
    /* ignore */
  }
  return null
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class RenderCancelledError extends Error {
  constructor(message = 'Render cancelled') {
    super(message)
    this.name = 'AbortError'
  }
}

export function isRenderCancelledError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof RenderCancelledError) return true
  const e = err as { name?: string; message?: string }
  return e.name === 'AbortError' || /cancelled|canceled/i.test(String(e.message ?? ''))
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RenderCancelledError()
}

// ─── Ring buffer ──────────────────────────────────────────────────────────────

/**
 * Bounded line buffer — keeps at most `maxLines` lines and `maxBytes` bytes.
 */
export class LineRingBuffer {
  private lines: string[] = []
  private bytes = 0
  private partial = ''

  constructor(
    private readonly maxLines = 200,
    private readonly maxBytes = 1024 * 1024
  ) {}

  push(chunk: string): void {
    const data = this.partial + chunk
    const parts = data.split(/\r?\n|\r/)
    this.partial = parts.pop() ?? ''
    // Guard against a pathological single "line" without newlines
    if (this.partial.length > this.maxBytes) {
      this.partial = this.partial.slice(-this.maxBytes)
    }
    for (const line of parts) {
      if (!line) continue
      this.lines.push(line)
      this.bytes += line.length + 1
    }
    while (this.lines.length > this.maxLines || this.bytes > this.maxBytes) {
      const removed = this.lines.shift()
      if (removed === undefined) break
      this.bytes -= removed.length + 1
    }
  }

  get lineCount(): number {
    return this.lines.length + (this.partial ? 1 : 0)
  }

  get byteSize(): number {
    return this.bytes + this.partial.length
  }

  tail(n = 8): string {
    const all = this.partial ? [...this.lines, this.partial] : this.lines
    return all.slice(-n).join('\n')
  }
}

// ─── Process registry ────────────────────────────────────────────────────────

interface RegisteredProcess {
  proc: ChildProcess
  jobId?: string
  phase?: string
  startedAt: number
}

const liveProcesses = new Set<RegisteredProcess>()

export function getLiveRenderProcessCount(): number {
  return liveProcesses.size
}

export function getLiveRenderProcessPids(): number[] {
  return Array.from(liveProcesses)
    .map((p) => p.proc.pid)
    .filter((pid): pid is number => typeof pid === 'number')
}

function killWithGrace(proc: ChildProcess, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve()
      return
    }
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    proc.once('close', finish)
    proc.once('exit', finish)
    try {
      proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      // Give the OS a moment to reap, then resolve regardless
      setTimeout(finish, 250)
    }, graceMs)
  })
}

/**
 * Terminates every live render child process (SIGTERM → grace → SIGKILL).
 */
export async function terminateAllRenderProcesses(graceMs = 2500): Promise<number> {
  const all = Array.from(liveProcesses)
  if (all.length === 0) return 0
  logger.info(`[FFmpegProcess] Terminating ${all.length} live render process(es)`)
  await Promise.all(all.map((p) => killWithGrace(p.proc, graceMs)))
  return all.length
}

// ─── Run options ─────────────────────────────────────────────────────────────

export interface FfmpegProgress {
  outTimeMs: number
  frame: number
  speed: number | null
  done: boolean
}

export interface FfmpegRunOptions {
  signal?: AbortSignal
  threads?: number
  filterThreads?: number
  jobId?: string
  phase?: string
  /** Unix niceness applied to the child (0 = normal, 19 = lowest). */
  niceLevel?: number
  onProgress?: (progress: FfmpegProgress) => void
  /** Minimum ms between onProgress callbacks (default 500ms). */
  progressThrottleMs?: number
  /** Grace period before SIGKILL after abort (default 2500ms). */
  killGraceMs?: number
}

function isStreamCopyOnly(args: string[]): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if ((args[i] === '-c' || args[i] === '-codec') && args[i + 1] === 'copy') return true
  }
  const vCopy = args.some((a, i) => (a === '-c:v' || a === '-vcodec') && args[i + 1] === 'copy')
  const hasVideoFilter = args.includes('-vf') || args.includes('-filter_complex')
  return vCopy && !hasVideoFilter
}

/**
 * Builds the final FFmpeg argument list with global flags and thread limits
 * placed at positions FFmpeg honours:
 *   - global options (-hide_banner, -nostdin, -nostats, -progress,
 *     -filter_threads, -filter_complex_threads) → very start
 *   - -threads (encoder output option) → immediately before the output path
 */
export function buildFfmpegArgs(args: string[], options: FfmpegRunOptions = {}): string[] {
  if (args.length === 0) throw new Error('FFmpeg called without arguments')
  const output = args[args.length - 1]
  if (output.startsWith('-')) {
    throw new Error(`FFmpeg output path must be the last argument (got "${output}")`)
  }

  const globals = ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1']
  if (options.filterThreads && options.filterThreads > 0) {
    const ft = String(Math.floor(options.filterThreads))
    globals.push('-filter_threads', ft, '-filter_complex_threads', ft)
  }

  const body = args.slice(0, -1)
  const outputOpts: string[] = []
  if (options.threads && options.threads > 0 && !isStreamCopyOnly(args) && !body.includes('-threads')) {
    outputOpts.push('-threads', String(Math.floor(options.threads)))
  }

  return [...globals, ...body, ...outputOpts, output]
}

export function parseProgressBlock(
  block: Record<string, string>
): FfmpegProgress {
  const outUs = Number(block['out_time_us'] ?? block['out_time_ms'] ?? 0)
  const speedRaw = (block['speed'] ?? '').replace('x', '').trim()
  const speed = speedRaw && speedRaw !== 'N/A' ? Number(speedRaw) : null
  return {
    // FFmpeg's "out_time_ms" is actually microseconds (historic quirk)
    outTimeMs: Number.isFinite(outUs) ? Math.max(0, Math.round(outUs / 1000)) : 0,
    frame: Number(block['frame'] ?? 0) || 0,
    speed: speed !== null && Number.isFinite(speed) ? speed : null,
    done: block['progress'] === 'end'
  }
}

/**
 * Runs FFmpeg with resource limits, bounded logging and cancellation.
 */
export function ffmpegRun(args: string[], options: FfmpegRunOptions = {}): Promise<void> {
  const { signal } = options
  if (signal?.aborted) return Promise.reject(new RenderCancelledError())

  const finalArgs = buildFfmpegArgs(args, options)
  const throttleMs = options.progressThrottleMs ?? 500

  return new Promise<void>((resolve, reject) => {
    let proc: ChildProcess
    try {
      proc = spawn(getFfmpegBinary(), finalArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }

    const entry: RegisteredProcess = { proc, jobId: options.jobId, phase: options.phase, startedAt: Date.now() }
    liveProcesses.add(entry)

    if (typeof options.niceLevel === 'number' && options.niceLevel > 0 && proc.pid) {
      try {
        os.setPriority(proc.pid, Math.min(19, Math.max(0, Math.floor(options.niceLevel))))
      } catch {
        /* not permitted / unsupported — ignore */
      }
    }

    const stderr = new LineRingBuffer(200, 1024 * 1024)
    let progressBuf = ''
    let block: Record<string, string> = {}
    let lastEmit = 0
    let aborted = false

    proc.stdout?.on('data', (d: Buffer) => {
      progressBuf += d.toString()
      // Bound the progress buffer as well
      if (progressBuf.length > 64 * 1024) progressBuf = progressBuf.slice(-16 * 1024)
      let idx: number
      while ((idx = progressBuf.indexOf('\n')) >= 0) {
        const line = progressBuf.slice(0, idx).trim()
        progressBuf = progressBuf.slice(idx + 1)
        if (!line) continue
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const key = line.slice(0, eq)
        const value = line.slice(eq + 1)
        block[key] = value
        if (key === 'progress') {
          const parsed = parseProgressBlock(block)
          block = {}
          const now = Date.now()
          if (options.onProgress && (parsed.done || now - lastEmit >= throttleMs)) {
            lastEmit = now
            try {
              options.onProgress(parsed)
            } catch {
              /* never let a progress listener break the encode */
            }
          }
        }
      }
    })

    proc.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()))

    const onAbort = (): void => {
      aborted = true
      void killWithGrace(proc, options.killGraceMs ?? 2500)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      liveProcesses.delete(entry)
      signal?.removeEventListener('abort', onAbort)
    }

    proc.on('error', (err) => {
      cleanup()
      reject(err)
    })

    proc.on('close', (code, sig) => {
      cleanup()
      if (aborted || signal?.aborted) {
        reject(new RenderCancelledError())
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`FFmpeg exited ${code ?? sig}: ${stderr.tail(6)}`))
    })
  })
}

// ─── Probe ────────────────────────────────────────────────────────────────────

export interface MediaProbe {
  hasVideo: boolean
  hasAudio: boolean
  width: number
  height: number
  duration: number
  fps: number
  frames: number | null
}

function parseRate(rate?: string): number {
  if (!rate) return 0
  const [n, d] = rate.split('/').map(Number)
  if (!d) return Number.isFinite(n) ? n : 0
  const v = n / d
  return Number.isFinite(v) ? v : 0
}

/**
 * Probes a media file. Returns null if ffprobe is unavailable or the file is unreadable.
 */
export function probeMedia(
  filePath: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<MediaProbe | null> {
  const ffprobe = getFfprobeBinary()
  if (!ffprobe || !filePath || !fs.existsSync(filePath)) return Promise.resolve(null)

  return new Promise((resolve) => {
    const proc = spawn(
      ffprobe,
      [
        '-v', 'error',
        '-show_entries',
        'stream=codec_type,width,height,duration,r_frame_rate,avg_frame_rate,nb_frames:format=duration',
        '-of', 'json',
        filePath
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const entry: RegisteredProcess = { proc, phase: 'probe', startedAt: Date.now() }
    liveProcesses.add(entry)
    let stdout = ''
    let settled = false
    const finish = (val: MediaProbe | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      liveProcesses.delete(entry)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(val)
    }
    const onAbort = (): void => {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
      finish(null)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
      finish(null)
    }, opts.timeoutMs ?? 30000)

    proc.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 512 * 1024) stdout += d.toString()
    })
    proc.on('error', () => finish(null))
    proc.on('close', (code) => {
      if (code !== 0) return finish(null)
      try {
        const data = JSON.parse(stdout) as {
          streams?: Array<Record<string, string | number>>
          format?: { duration?: string }
        }
        const streams = data.streams ?? []
        const v = streams.find((s) => s.codec_type === 'video')
        const a = streams.find((s) => s.codec_type === 'audio')
        const duration =
          parseFloat(String(data.format?.duration ?? '')) || parseFloat(String(v?.duration ?? '')) || 0
        const nb = v?.nb_frames !== undefined ? Number(v.nb_frames) : NaN
        finish({
          hasVideo: !!v,
          hasAudio: !!a,
          width: Number(v?.width) || 0,
          height: Number(v?.height) || 0,
          duration,
          fps: parseRate(String(v?.avg_frame_rate ?? '')) || parseRate(String(v?.r_frame_rate ?? '')),
          frames: Number.isFinite(nb) && nb > 0 ? nb : null
        })
      } catch {
        finish(null)
      }
    })
  })
}
