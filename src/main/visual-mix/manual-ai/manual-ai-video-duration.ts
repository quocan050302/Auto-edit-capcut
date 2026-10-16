/**
 * manual-ai-video-duration.ts
 *
 * Verifiable duration recovery from video packet timestamps for manual AI video imports.
 * Used when container/stream metadata (format.duration / stream.duration) is missing,
 * zero, or non-finite, but a readable video stream and valid dimensions are present
 * (typical of WEBM / VP9 exports from AI generation tools).
 */

import { spawn } from 'child_process'
import { getFfprobeBinary } from '../../render-cache/ffmpeg-process'
import { logger } from '../../logger'

export const VIDEO_DURATION_PROBE_TIMEOUT_MS = 45_000

export type VideoDurationRecoveryResult =
  | {
      ok: true
      durationSecs: number
      source: 'packet-timestamps'
      packetCount: number
    }
  | {
      ok: false
      reason:
        | 'FFPROBE_UNAVAILABLE'
        | 'FFPROBE_EXECUTION_FAILED'
        | 'NO_VALID_TIMESTAMPS'
        | 'TIMEOUT'
        | 'CANCELLED'
      message: string
    }

export interface PacketTimingRecord {
  ptsTime?: number
  durationTime?: number
}

/**
 * Pure streaming line parser for FFprobe compact output (-of compact=p=0:nk=0).
 * Matches pts_time and duration_time field names regardless of column ordering.
 * Rejects 'N/A', empty strings, NaN, and non-finite numbers.
 */
export function parsePacketTimingLine(line: string): PacketTimingRecord | null {
  if (!line || typeof line !== 'string') return null
  const trimmed = line.trim()
  if (!trimmed) return null

  const ptsMatch = /(?:^|[|\s])pts_time=([^\s|]+)/.exec(trimmed)
  const durMatch = /(?:^|[|\s])duration_time=([^\s|]+)/.exec(trimmed)
  if (!ptsMatch && !durMatch) return null

  let ptsTime: number | undefined
  let durationTime: number | undefined

  if (ptsMatch) {
    const raw = ptsMatch[1].trim()
    if (raw !== 'N/A' && raw !== '') {
      const v = parseFloat(raw)
      if (Number.isFinite(v)) {
        ptsTime = v
      }
    }
  }

  if (durMatch) {
    let raw = durMatch[1].trim()
    // In case Matroska BlockAdditional or side_data is concatenated
    const sideIdx = raw.indexOf('side_data')
    if (sideIdx !== -1) {
      raw = raw.slice(0, sideIdx).trim()
    }
    if (raw !== 'N/A' && raw !== '') {
      const v = parseFloat(raw)
      if (Number.isFinite(v) && v >= 0) {
        durationTime = v
      }
    }
  }

  if (ptsTime === undefined && durationTime === undefined) {
    return null
  }
  return { ptsTime, durationTime }
}

export interface RecoverVideoDurationOptions {
  timeoutMs?: number
  signal?: AbortSignal
  ffprobeBinaryOverride?: string
}

/**
 * Recovers a verifiable video duration from packet timestamps when format/stream metadata
 * does not report a valid duration.
 *
 * Scans video packets (v:0) via FFprobe, extracts PTS and duration_time incrementally,
 * and derives elapsed media duration.
 */
export async function recoverVideoDuration(
  filePath: string,
  options: RecoverVideoDurationOptions = {}
): Promise<VideoDurationRecoveryResult> {
  const timeoutMs = options.timeoutMs ?? VIDEO_DURATION_PROBE_TIMEOUT_MS
  const signal = options.signal

  if (signal?.aborted) {
    return {
      ok: false,
      reason: 'CANCELLED',
      message: 'Video duration recovery was cancelled before execution.'
    }
  }

  const ffprobe = options.ffprobeBinaryOverride ?? getFfprobeBinary()
  if (!ffprobe) {
    logger.warn(`[ManualAI:DurationRecovery] FFprobe binary not available for ${filePath}`)
    return {
      ok: false,
      reason: 'FFPROBE_UNAVAILABLE',
      message: 'FFprobe executable is not available on this system.'
    }
  }

  return new Promise<VideoDurationRecoveryResult>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null

    let packetCount = 0
    let minPts = Infinity
    let maxPts = -Infinity
    let maxPacketEnd = -Infinity
    let prevPts: number | null = null
    const intervals: number[] = []

    let partial = ''
    let stderrBuffer = ''
    const MAX_STDERR_BYTES = 16 * 1024

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(
        ffprobe,
        [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_packets',
          '-show_entries', 'packet=pts_time,duration_time',
          '-of', 'compact=p=0:nk=0',
          filePath
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (spawnErr) {
      return resolve({
        ok: false,
        reason: 'FFPROBE_EXECUTION_FAILED',
        message: `Failed to spawn FFprobe: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`
      })
    }

    const finish = (result: VideoDurationRecoveryResult): void => {
      if (settled) return
      settled = true

      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort)
      }

      if (result.ok) {
        logger.info(
          `[ManualAI:DurationRecovery] file="${filePath}" method=packet-timestamps packets=${result.packetCount} duration=${result.durationSecs.toFixed(3)}s`
        )
      } else {
        logger.warn(
          `[ManualAI:DurationRecovery] file="${filePath}" failed reason=${result.reason}: ${result.message}`
        )
      }

      resolve(result)
    }

    const onAbort = (): void => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        reason: 'CANCELLED',
        message: 'Video duration recovery was aborted.'
      })
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        reason: 'TIMEOUT',
        message: `FFprobe packet scan timed out after ${timeoutMs}ms.`
      })
    }, timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = partial + chunk.toString()
      const lines = text.split(/\r?\n/)
      partial = lines.pop() ?? ''

      for (const line of lines) {
        const parsed = parsePacketTimingLine(line)
        if (!parsed) continue

        const { ptsTime, durationTime } = parsed

        if (ptsTime !== undefined) {
          packetCount++
          if (ptsTime < minPts) minPts = ptsTime
          if (ptsTime > maxPts) maxPts = ptsTime

          if (durationTime !== undefined && durationTime > 0) {
            const end = ptsTime + durationTime
            if (end > maxPacketEnd) maxPacketEnd = end
          }

          if (prevPts !== null) {
            const diff = ptsTime - prevPts
            // Filter out negative or crazy outliers (> 10s between frames)
            if (diff > 0 && diff < 10) {
              intervals.push(diff)
              if (intervals.length > 500) intervals.shift()
            }
          }
          prevPts = ptsTime
        }
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuffer.length < MAX_STDERR_BYTES) {
        stderrBuffer += chunk.toString()
      }
    })

    proc.on('error', (err) => {
      finish({
        ok: false,
        reason: 'FFPROBE_EXECUTION_FAILED',
        message: `Failed to execute FFprobe: ${err.message}`
      })
    })

    proc.on('close', (code, signalStr) => {
      // Process remaining partial if any
      if (partial.trim()) {
        const parsed = parsePacketTimingLine(partial)
        if (parsed?.ptsTime !== undefined) {
          const { ptsTime, durationTime } = parsed
          packetCount++
          if (ptsTime < minPts) minPts = ptsTime
          if (ptsTime > maxPts) maxPts = ptsTime
          if (durationTime !== undefined && durationTime > 0) {
            const end = ptsTime + durationTime
            if (end > maxPacketEnd) maxPacketEnd = end
          }
        }
      }

      if (code !== 0) {
        const errDetail = stderrBuffer.trim() ? `: ${stderrBuffer.trim().slice(0, 300)}` : ''
        return finish({
          ok: false,
          reason: 'FFPROBE_EXECUTION_FAILED',
          message: `FFprobe exited with code ${code ?? signalStr ?? 'unknown'}${errDetail}`
        })
      }

      // Check for fatal errors in stderr like "File ended prematurely" or corrupt file
      if (/file ended prematurely|invalid data found|corrupt input/i.test(stderrBuffer)) {
        return finish({
          ok: false,
          reason: 'NO_VALID_TIMESTAMPS',
          message: `Media stream is truncated or corrupt: ${stderrBuffer.trim().slice(0, 200)}`
        })
      }

      // Must have at least 2 packets to establish duration
      if (packetCount < 2 || !Number.isFinite(minPts) || !Number.isFinite(maxPts) || maxPts < minPts) {
        return finish({
          ok: false,
          reason: 'NO_VALID_TIMESTAMPS',
          message: `Insufficient packet timestamp evidence (packetCount=${packetCount}).`
        })
      }

      let durationSecs = 0

      // If packet durations were provided and valid
      if (Number.isFinite(maxPacketEnd) && maxPacketEnd > minPts) {
        durationSecs = maxPacketEnd - minPts
      } else {
        // Derive final frame duration from median of observed intervals
        let medianInterval = 0
        if (intervals.length > 0) {
          const sorted = [...intervals].sort((a, b) => a - b)
          medianInterval = sorted[Math.floor(sorted.length / 2)]
        } else {
          // If no positive intervals found between 2 packets, cannot reliably compute
          return finish({
            ok: false,
            reason: 'NO_VALID_TIMESTAMPS',
            message: 'Could not determine frame intervals from presentation timestamps.'
          })
        }

        durationSecs = (maxPts - minPts) + medianInterval
      }

      if (!Number.isFinite(durationSecs) || durationSecs <= 0 || durationSecs > 86400) {
        return finish({
          ok: false,
          reason: 'NO_VALID_TIMESTAMPS',
          message: `Derived duration is invalid (${durationSecs}).`
        })
      }

      // Round to 3 decimal places to avoid floating point noise (e.g. 3.14159265...)
      const cleanDuration = Math.round(durationSecs * 1000) / 1000

      finish({
        ok: true,
        durationSecs: cleanDuration,
        source: 'packet-timestamps',
        packetCount
      })
    })
  })
}
