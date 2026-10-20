/**
 * overlay-blocks.ts
 *
 * Splits the Remotion overlay timeline into blocks (~60–120 s) so a 20-minute video
 * is never rendered by a single Chromium job, and every block is a resumable checkpoint.
 *
 * Rules:
 *  - Cuts are frame-aligned.
 *  - Prefer scene boundaries closest to the target duration.
 *  - Never cut inside a caption phrase, Proof Visual or Visual Grammar overlay.
 *  - Blocks are rendered with Remotion `frameRange` on the SAME full-length composition,
 *    so `useCurrentFrame()` stays absolute → timing is identical to a single render.
 */

export interface OverlayInterval {
  start: number // seconds (absolute timeline)
  end: number
}

export interface OverlayBlockPlan {
  blockIndex: number        // 1-based
  startFrame: number        // inclusive
  endFrameExclusive: number // exclusive
}

export interface PlanOverlayBlocksInput {
  totalFrames: number
  fps: number
  sceneBoundariesSecs: number[]
  protectedIntervals: OverlayInterval[]
  targetSecs?: number
  minSecs?: number
  maxSecs?: number
}

export function planOverlayBlocks(input: PlanOverlayBlocksInput): OverlayBlockPlan[] {
  const { totalFrames, fps } = input
  const targetF = Math.round((input.targetSecs ?? 90) * fps)
  const minF = Math.round((input.minSecs ?? 60) * fps)
  const maxF = Math.round((input.maxSecs ?? 120) * fps)

  if (totalFrames <= 0) return []
  if (totalFrames <= maxF) return [{ blockIndex: 1, startFrame: 0, endFrameExclusive: totalFrames }]

  // Protected frame ranges: a cut at frame f is unsafe if sF < f < eF
  const ranges = input.protectedIntervals
    .filter((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end > iv.start)
    .map((iv) => [Math.floor(iv.start * fps), Math.ceil(iv.end * fps)] as [number, number])
    .sort((a, b) => a[0] - b[0])

  const isSafe = (f: number): boolean => {
    for (const [s, e] of ranges) {
      if (s >= f) break
      if (s < f && f < e) return false
    }
    return true
  }

  const sceneFrames = Array.from(
    new Set(input.sceneBoundariesSecs.map((t) => Math.round(t * fps)).filter((f) => f > 0 && f < totalFrames))
  ).sort((a, b) => a - b)

  const blocks: OverlayBlockPlan[] = []
  let cur = 0
  while (totalFrames - cur > maxF) {
    const lo = cur + minF
    const hi = cur + maxF
    const target = cur + targetF
    let cut: number | null = null

    // 1. Scene boundary inside the window, closest to target, not inside an overlay
    let best: number | null = null
    for (const f of sceneFrames) {
      if (f < lo || f > hi) continue
      if (!isSafe(f)) continue
      if (best === null || Math.abs(f - target) < Math.abs(best - target)) best = f
    }
    cut = best

    // 2. Any safe frame inside the window, searching outward from target
    if (cut === null) {
      for (let delta = 0; delta <= Math.max(target - lo, hi - target); delta++) {
        if (target + delta <= hi && isSafe(target + delta)) { cut = target + delta; break }
        if (target - delta >= lo && isSafe(target - delta)) { cut = target - delta; break }
      }
    }

    // 3. First safe frame after the window (an overlay longer than the window)
    if (cut === null) {
      for (let f = hi + 1; f < totalFrames; f++) {
        if (isSafe(f)) { cut = f; break }
      }
    }

    if (cut === null || cut <= cur || cut >= totalFrames) break
    blocks.push({ blockIndex: blocks.length + 1, startFrame: cur, endFrameExclusive: cut })
    cur = cut
  }
  blocks.push({ blockIndex: blocks.length + 1, startFrame: cur, endFrameExclusive: totalFrames })
  return blocks
}

/** Collects every overlay interval that a block boundary must not split. */
export function collectProtectedIntervals(params: {
  captionPhrases?: Array<{ startTime: number; endTime: number }>
  proofVisuals?: Array<{ absoluteStartTime?: number; absoluteEndTime?: number }>
  visualGrammar?: Array<{ absoluteStartTime?: number; absoluteEndTime?: number }>
  openingEvents?: Array<{ startTime: number; duration: number }>
}): OverlayInterval[] {
  const out: OverlayInterval[] = []
  for (const p of params.captionPhrases ?? []) out.push({ start: p.startTime, end: p.endTime })
  for (const p of params.proofVisuals ?? []) {
    if (typeof p.absoluteStartTime === 'number' && typeof p.absoluteEndTime === 'number') {
      out.push({ start: p.absoluteStartTime, end: p.absoluteEndTime })
    }
  }
  for (const v of params.visualGrammar ?? []) {
    if (typeof v.absoluteStartTime === 'number' && typeof v.absoluteEndTime === 'number') {
      out.push({ start: v.absoluteStartTime, end: v.absoluteEndTime })
    }
  }
  for (const e of params.openingEvents ?? []) {
    out.push({ start: e.startTime, end: e.startTime + e.duration })
  }
  return out
}
