/**
 * video-encoder.ts
 *
 * Encoder selection for the render engine.
 *
 *  - Default: libx264 with the exact same preset/CRF the legacy renderer used.
 *  - Optional (experimental, macOS): Apple VideoToolbox (h264_videotoolbox).
 *    Only used when the user enabled it AND a real sample encode succeeded.
 *    VideoToolbox has no CRF → a bitrate equivalent to the CRF target is used.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { logger } from '../logger'
import { ffmpegRun, getFfmpegBinary, probeMedia } from './ffmpeg-process'
import type { VideoEncoderMode } from './render-preferences'

export class HardwareEncoderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HardwareEncoderError'
  }
}

export interface EncoderProfile {
  mode: VideoEncoderMode
  /** stable key used in fingerprints */
  key: string
  /** args for -c:v … replacing `-c:v libx264 -preset X -crf Y` */
  videoArgs: (crf: number, preset: string) => string[]
}

/** Bitrate (bits/s) approximating libx264 CRF quality for the given geometry. */
export function bitrateForCrf(width: number, height: number, fps: number, crf: number): number {
  const bpp = 0.16 * Math.pow(0.89, crf - 20) // ~0.16 bpp at CRF 20, ~-11%/CRF step
  const bps = width * height * Math.max(1, fps) * bpp
  return Math.round(Math.min(80_000_000, Math.max(1_000_000, bps)))
}

export function softwareEncoder(): EncoderProfile {
  return {
    mode: 'software-h264',
    key: 'libx264',
    videoArgs: (crf, preset) => ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)]
  }
}

export function videoToolboxEncoder(width: number, height: number, fps: number): EncoderProfile {
  return {
    mode: 'videotoolbox-h264',
    key: `h264_videotoolbox:${width}x${height}@${fps}`,
    videoArgs: (crf) => {
      const br = bitrateForCrf(width, height, fps, crf)
      return [
        '-c:v', 'h264_videotoolbox',
        '-b:v', String(br),
        '-maxrate', String(Math.round(br * 1.5)),
        '-bufsize', String(Math.round(br * 2)),
        '-profile:v', 'high',
        '-allow_sw', '0'
      ]
    }
  }
}

let vtProbeResult: { ok: boolean; reason?: string } | null = null

export function resetVideoToolboxProbeForTests(): void {
  vtProbeResult = null
}

function listEncoders(): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(getFfmpegBinary(), ['-hide_banner', '-encoders'], { windowsHide: true })
    let out = ''
    proc.stdout.on('data', (d: Buffer) => { if (out.length < 1024 * 1024) out += d.toString() })
    proc.on('error', () => resolve(''))
    proc.on('close', () => resolve(out))
  })
}

/**
 * Probes VideoToolbox: name in `-encoders` AND a real 1-second sample encode that ffprobe accepts.
 */
export async function probeVideoToolbox(force = false): Promise<{ ok: boolean; reason?: string }> {
  if (vtProbeResult && !force) return vtProbeResult
  if (process.platform !== 'darwin') {
    vtProbeResult = { ok: false, reason: 'VideoToolbox is only available on macOS' }
    return vtProbeResult
  }
  const encoders = await listEncoders()
  if (!/\bh264_videotoolbox\b/.test(encoders)) {
    vtProbeResult = { ok: false, reason: 'h264_videotoolbox not present in this FFmpeg build' }
    return vtProbeResult
  }
  const tmp = path.join(os.tmpdir(), `vt-probe-${process.pid}-${Date.now()}.mp4`)
  try {
    await ffmpegRun([
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=1',
      ...videoToolboxEncoder(320, 240, 30).videoArgs(20, 'fast'),
      '-pix_fmt', 'yuv420p', tmp
    ], { phase: 'vt-probe' })
    const probe = await probeMedia(tmp)
    vtProbeResult = probe && probe.hasVideo && probe.width === 320 && probe.frames !== 0
      ? { ok: true }
      : { ok: false, reason: 'sample encode produced an invalid file' }
  } catch (err) {
    vtProbeResult = { ok: false, reason: `sample encode failed: ${String(err).slice(0, 200)}` }
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* ignore */ }
  }
  logger.info(`[VideoEncoder] VideoToolbox probe: ${JSON.stringify(vtProbeResult)}`)
  return vtProbeResult
}

/**
 * Resolves the encoder for a render. Never silently switches the default:
 * VideoToolbox is used only if requested AND the probe passes; otherwise software.
 */
export async function resolveEncoder(
  requested: VideoEncoderMode,
  geometry: { width: number; height: number; fps: number },
  warnings: string[]
): Promise<EncoderProfile> {
  if (requested !== 'videotoolbox-h264') return softwareEncoder()
  const probe = await probeVideoToolbox()
  if (!probe.ok) {
    warnings.push(`Apple VideoToolbox unavailable (${probe.reason}); using Software H.264.`)
    return softwareEncoder()
  }
  return videoToolboxEncoder(geometry.width, geometry.height, geometry.fps)
}

/** Wraps an FFmpeg failure from a hardware encode into HardwareEncoderError. */
export function asHardwareError(err: unknown, profile: EncoderProfile): unknown {
  if (profile.mode === 'videotoolbox-h264' && !(err as { name?: string })?.name?.includes('Abort')) {
    return new HardwareEncoderError(`VideoToolbox encode failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`)
  }
  return err
}
