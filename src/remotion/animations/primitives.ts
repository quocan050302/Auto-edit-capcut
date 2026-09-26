/**
 * primitives.ts — Animation primitive functions
 *
 * Mỗi primitive nhận { relativeFrame, fps, intensity } và trả về
 * partial CSS values.  Chúng được kết hợp bởi animation-engine.ts.
 *
 * QUY TẮC CHỐNG GREEN BLEED:
 * - Không dùng rgba semi-transparent trừ khi alpha > 0.85
 * - Mọi shadow phải solid (không rgba)
 * - filter: blur() chỉ ở entrance (relativeFrame < enter duration)
 *   và KHÔNG được dùng trong HOLD phase để tránh blur mix green BG
 *
 * DETERMINISM: Không dùng Math.random(). Mọi giá trị tính từ frame.
 */

import { interpolate, spring } from 'remotion'

// ─── Intensity presets ────────────────────────────────────────────────────────

export const INTENSITY_PARAMS = {
  subtle: { slide: 8, scaleFrom: 0.98, overshoot: 1.02 },
  medium: { slide: 14, scaleFrom: 0.93, overshoot: 1.06 },
  strong: { slide: 20, scaleFrom: 0.80, overshoot: 1.12 },
} as const

// ─── Enter / Exit frame counts ────────────────────────────────────────────────

export const ENTER_FRAMES = 7  // ~0.23s ở 30fps
export const EXIT_FRAMES = 4   // ~0.13s ở 30fps

/** Tính progress 0→1 cho enter phase */
export function enterProgress(relativeFrame: number, fps: number): number {
  return Math.min(1, Math.max(0, relativeFrame / ENTER_FRAMES))
}

/** Tính progress 0→1 cho exit phase — cần biết tổng duration phrase */
export function exitProgress(relativeFrame: number, totalFrames: number): number {
  const exitStart = totalFrames - EXIT_FRAMES
  if (relativeFrame < exitStart) return 0
  return Math.min(1, (relativeFrame - exitStart) / EXIT_FRAMES)
}

// ─── 1. FADE ─────────────────────────────────────────────────────────────────

export function fade(
  relativeFrame: number,
  fps: number,
  totalFrames: number
): number {
  const ep = enterProgress(relativeFrame, fps)
  const xp = exitProgress(relativeFrame, totalFrames)
  const enterOpacity = interpolate(ep, [0, 1], [0, 1], { extrapolateRight: 'clamp' })
  const exitOpacity = interpolate(xp, [0, 1], [1, 0], { extrapolateRight: 'clamp' })
  return Math.min(enterOpacity, exitOpacity)
}

// ─── 2. SLIDE UP ─────────────────────────────────────────────────────────────

export function slideUp(
  relativeFrame: number,
  fps: number,
  totalFrames: number,
  intensity: 'subtle' | 'medium' | 'strong' = 'medium'
): number {
  const { slide } = INTENSITY_PARAMS[intensity]
  const ep = enterProgress(relativeFrame, fps)
  const xp = exitProgress(relativeFrame, totalFrames)
  const enterY = interpolate(ep, [0, 1], [slide, 0], { extrapolateRight: 'clamp' })
  const exitY = interpolate(xp, [0, 1], [0, -slide * 0.4], { extrapolateRight: 'clamp' })
  return enterY + exitY
}

// ─── 3. SLIDE LEFT / RIGHT ───────────────────────────────────────────────────

export function slideX(
  relativeFrame: number,
  fps: number,
  fromPx: number  // negative = from left, positive = from right
): number {
  const ep = enterProgress(relativeFrame, fps)
  return interpolate(ep, [0, 1], [fromPx, 0], { extrapolateRight: 'clamp' })
}

// ─── 4. SPRING SCALE (smooth bounce) ────────────────────────────────────────

export function springScale(
  relativeFrame: number,
  fps: number,
  intensity: 'subtle' | 'medium' | 'strong' = 'medium'
): number {
  if (relativeFrame < 0) return 0
  const { scaleFrom } = INTENSITY_PARAMS[intensity]
  return spring({
    frame: relativeFrame,
    fps,
    config: { damping: 12, stiffness: 200, mass: 0.5 },
    from: scaleFrom,
    to: 1,
  })
}

// ─── 5. IMPACT SCALE (snap overshoot then settle) ────────────────────────────

export function impactScale(
  relativeFrame: number,
  fps: number,
  intensity: 'subtle' | 'medium' | 'strong' = 'strong'
): number {
  if (relativeFrame < 0) return 0
  const { scaleFrom, overshoot } = INTENSITY_PARAMS[intensity]
  // Phase 1: snap lên overshoot (frames 0-3)
  // Phase 2: settle về 1 (frames 3+)
  if (relativeFrame <= 3) {
    return interpolate(relativeFrame, [0, 3], [scaleFrom, overshoot], { extrapolateRight: 'clamp' })
  }
  return spring({
    frame: relativeFrame - 3,
    fps,
    config: { damping: 14, stiffness: 180, mass: 0.6 },
    from: overshoot,
    to: 1,
  })
}

// ─── 6. BLUR FOCUS ───────────────────────────────────────────────────────────

/**
 * Trả về blur px value.
 * Chỉ blur trong entrance — về 0 sau ENTER_FRAMES.
 * KHÔNG giữ blur ở hold phase (tránh green bleed artifacts).
 */
export function blurFocus(
  relativeFrame: number,
  fps: number
): number {
  if (relativeFrame >= ENTER_FRAMES) return 0
  const ep = enterProgress(relativeFrame, fps)
  return interpolate(ep, [0, 1], [6, 0], { extrapolateRight: 'clamp' })
}

// ─── 7. ROTATE SETTLE ────────────────────────────────────────────────────────

/** Trả về degrees rotation. Từ -2° → 0°. */
export function rotateSettle(
  relativeFrame: number,
  fps: number
): number {
  if (relativeFrame < 0) return -2
  return spring({
    frame: relativeFrame,
    fps,
    config: { damping: 15, stiffness: 200, mass: 0.4 },
    from: -2,
    to: 0,
  })
}

// ─── 8. REVEAL (clip-path) ───────────────────────────────────────────────────

/**
 * Trả về clip-path string để reveal text từ trái sang phải.
 * Dùng inset(top right bottom left).
 */
export function revealClipPath(
  relativeFrame: number,
  fps: number
): string {
  const ep = enterProgress(relativeFrame, fps)
  const right = interpolate(ep, [0, 1], [100, 0], { extrapolateRight: 'clamp' })
  return `inset(0 ${right}% 0 0)`
}

// ─── 9. LETTER SPACING SETTLE ────────────────────────────────────────────────

/** Letter spacing px: từ 4px → 0px trong enter phase. */
export function letterSpacingSettle(
  relativeFrame: number,
  fps: number,
  fromPx: number = 4
): number {
  const ep = enterProgress(relativeFrame, fps)
  return interpolate(ep, [0, 1], [fromPx, 0], { extrapolateRight: 'clamp' })
}

// ─── 10. WORD STAGGER delay ──────────────────────────────────────────────────

/**
 * Tính relativeFrame cho một word tại wordIndex với stagger delay.
 * Mỗi word xuất hiện trễ hơn word trước `staggerFrames` frames.
 */
export function staggeredRelativeFrame(
  relativeFrame: number,
  wordIndex: number,
  staggerFrames: number
): number {
  return relativeFrame - wordIndex * staggerFrames
}

// ─── 11. KEYWORD COLOR HIT ──────────────────────────────────────────────────

/**
 * Progress 0→1 của keyword highlight animation.
 * Đạt 1 sau khoảng 5 frames.
 */
export function keywordHighlightProgress(relativeFrame: number): number {
  return Math.min(1, Math.max(0, relativeFrame / 5))
}
