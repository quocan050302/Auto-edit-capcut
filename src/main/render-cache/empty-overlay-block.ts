/**
 * empty-overlay-block.ts
 *
 * Lightweight generation of truly empty overlay blocks.
 * When a planned block interval contains 0 captions, 0 proof visuals, 0 visual grammar,
 * and 0 opening events, instead of launching Chromium/Remotion to render green frames,
 * an FFmpeg solid green (#00FF00) H.264 clip with identical fps, resolution, frame count,
 * and yuv420p pixel format can be generated in milliseconds.
 *
 * SAFETY GUARD (Phase 8):
 * Kept behind feature gate `ENABLE_EMPTY_OVERLAY_OPTIMIZATION`.
 * Default is FALSE unless explicitly enabled.
 */

import { ffmpegRun } from './ffmpeg-process'
import type { BlockOverlayProps } from './overlay-block-input'

export function isBlockOverlayEmpty(props: BlockOverlayProps): boolean {
  return (
    props.captionPlan.phrases.length === 0 &&
    props.proofVisuals.length === 0 &&
    props.visualGrammar.length === 0 &&
    props.openingEvents.length === 0
  )
}

export function isEmptyOverlayOptimizationEnabled(): boolean {
  return process.env.ENABLE_EMPTY_OVERLAY_OPTIMIZATION === '1' || process.env.ENABLE_EMPTY_OVERLAY_OPTIMIZATION === 'true'
}

export interface EmptyOverlayBlockOptions {
  outputPath: string
  width: number
  height: number
  fps: number
  frames: number
  signal?: AbortSignal
}

export async function renderEmptyOverlayBlock(options: EmptyOverlayBlockOptions): Promise<void> {
  const { outputPath, width, height, fps, frames, signal } = options
  const durationSecs = frames / fps

  // Matches Remotion overlay output: H.264, yuv420p, chroma-key background #00FF00
  const args = [
    '-f', 'lavfi',
    '-i', `color=c=#00FF00:s=${width}x${height}:r=${fps}:d=${durationSecs.toFixed(6)}`,
    '-frames:v', String(frames),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast',
    outputPath
  ]

  await ffmpegRun(args, { signal })
}
