/**
 * animation-engine.ts — kết hợp primitives thành style objects
 *
 * computeWordStyle(): tính CSS style cho một word tại frame hiện tại.
 * computeContainerStyle(): style cho container (exit animation chủ yếu).
 *
 * Phân biệt rõ 3 phase:
 * ENTER (0 → ENTER_FRAMES): animation entrance
 * HOLD  (ENTER_FRAMES → totalFrames - EXIT_FRAMES): ổn định, không animation liên tục
 * EXIT  (totalFrames - EXIT_FRAMES → totalFrames): fade out nhẹ
 *
 * QUY TẮC GREEN SCREEN SAFETY:
 * - opacity < 0.1 trong hold phase → bỏ hoàn toàn
 * - Không dùng semi-transparent trong hold (gây green bleed artifacts)
 */

import type { AnimationPreset, AnimationIntensity, KeywordAnimation } from './types'
import {
  fade, slideUp, slideX, springScale, impactScale,
  blurFocus, rotateSettle, revealClipPath, letterSpacingSettle,
  staggeredRelativeFrame, keywordHighlightProgress,
  ENTER_FRAMES, EXIT_FRAMES, enterProgress, exitProgress
} from './primitives'

// ─── Color constants ─────────────────────────────────────────────────────────

export const COLORS = {
  white:   '#FFFFFF',
  yellow:  '#FFD84D',
  red:     '#E8352B',
  cream:   '#F5F0E6',
  black:   '#0F0F0F',
  chroma:  '#00FF00',  // green screen background
} as const

// ─── Style computation ────────────────────────────────────────────────────────

export interface WordStyleInput {
  relativeFrame: number        // frame - entranceFrame
  totalFrames: number          // tổng frame phrase hiển thị
  fps: number
  preset: AnimationPreset
  intensity: AnimationIntensity
  keywordAnim: KeywordAnimation
  isKeyword: boolean
  wordIndex: number
  wordStaggerFrames: number
}

export interface ComputedWordStyle {
  opacity: number
  transform: string
  filter: string
  color: string
  letterSpacing: string
  clipPath?: string
}

/**
 * Tính style CSS cho một word tại frame hiện tại.
 * Áp dụng stagger delay, keyword emphasis, preset primitives.
 */
export function computeWordStyle(input: WordStyleInput): ComputedWordStyle {
  const {
    relativeFrame: rawFrame,
    totalFrames,
    fps,
    preset,
    intensity,
    keywordAnim,
    isKeyword,
    wordIndex,
    wordStaggerFrames,
  } = input

  // Áp dụng stagger delay cho word
  const relativeFrame = staggeredRelativeFrame(rawFrame, wordIndex, wordStaggerFrames)

  // Chưa tới lúc hiện
  if (relativeFrame < 0) {
    return {
      opacity: 0,
      transform: 'translateY(12px)',
      filter: '',
      color: COLORS.white,
      letterSpacing: '0px',
    }
  }

  // ── Keyword có animation riêng ─────────────────────────────────────────────
  if (isKeyword) {
    return computeKeywordStyle(relativeFrame, totalFrames, fps, keywordAnim, intensity)
  }

  // ── Normal word theo preset ────────────────────────────────────────────────
  return computeNormalWordStyle(relativeFrame, totalFrames, fps, preset, intensity)
}

// ─── Normal word ──────────────────────────────────────────────────────────────

function computeNormalWordStyle(
  relativeFrame: number,
  totalFrames: number,
  fps: number,
  preset: AnimationPreset,
  intensity: AnimationIntensity
): ComputedWordStyle {
  let opacity = 1
  let translateY = 0
  let translateX = 0
  let scale = 1
  let rotation = 0
  let blur = 0
  let clipPath: string | undefined

  switch (preset) {
    case 'smooth_kinetic':
      opacity  = fade(relativeFrame, fps, totalFrames)
      translateY = slideUp(relativeFrame, fps, totalFrames, intensity)
      scale    = springScale(relativeFrame, fps, 'subtle')
      break

    case 'punch':
      opacity  = fade(relativeFrame, fps, totalFrames)
      scale    = impactScale(relativeFrame, fps, intensity)
      rotation = rotateSettle(relativeFrame, fps)
      break

    case 'swipe_reveal':
      opacity  = fade(relativeFrame, fps, totalFrames)
      translateX = slideX(relativeFrame, fps, -24)
      clipPath = revealClipPath(relativeFrame, fps)
      break

    case 'blur_focus':
      opacity  = fade(relativeFrame, fps, totalFrames)
      blur     = blurFocus(relativeFrame, fps)
      scale    = springScale(relativeFrame, fps, 'subtle')
      break

    case 'impact_keyword':
      opacity  = fade(relativeFrame, fps, totalFrames)
      translateY = slideUp(relativeFrame, fps, totalFrames, intensity)
      break

    case 'type_pop':
      opacity  = fade(relativeFrame, fps, totalFrames)
      translateY = slideUp(relativeFrame, fps, totalFrames, 'medium')
      break

    default:
      opacity  = fade(relativeFrame, fps, totalFrames)
      translateY = slideUp(relativeFrame, fps, totalFrames, intensity)
  }

  const transform = buildTransform(translateX, translateY, scale, rotation)
  const filter = blur > 0 ? `blur(${blur.toFixed(1)}px)` : ''

  return {
    opacity,
    transform,
    filter,
    color: COLORS.white,
    letterSpacing: '0px',
    clipPath,
  }
}

// ─── Keyword word ────────────────────────────────────────────────────────────

function computeKeywordStyle(
  relativeFrame: number,
  totalFrames: number,
  fps: number,
  keywordAnim: KeywordAnimation,
  intensity: AnimationIntensity
): ComputedWordStyle {
  const opacity = fade(relativeFrame, fps, totalFrames)

  switch (keywordAnim) {
    case 'spring': {
      const scale = springScale(relativeFrame, fps, intensity)
      const lsProgress = keywordHighlightProgress(relativeFrame)
      const ls = letterSpacingSettle(relativeFrame, fps, 3)
      return {
        opacity,
        transform: buildTransform(0, 0, scale, 0),
        filter: '',
        color: COLORS.yellow,
        letterSpacing: `${ls.toFixed(1)}px`,
      }
    }

    case 'impact': {
      const scale = impactScale(relativeFrame, fps, intensity)
      return {
        opacity,
        transform: buildTransform(0, 0, scale, 0),
        filter: '',
        color: COLORS.yellow,
        letterSpacing: '0px',
      }
    }

    case 'highlight': {
      // Color hit từ white → yellow
      const progress = keywordHighlightProgress(relativeFrame)
      const scale = springScale(relativeFrame, fps, 'subtle')
      return {
        opacity,
        transform: buildTransform(0, 0, scale, 0),
        filter: '',
        color: COLORS.yellow,
        letterSpacing: '0px',
      }
    }

    case 'none':
    default: {
      // Keyword không có animation riêng — dùng normal entrance + color
      const translateY = slideUp(relativeFrame, fps, totalFrames, intensity)
      return {
        opacity,
        transform: buildTransform(0, translateY, 1, 0),
        filter: '',
        color: COLORS.yellow,
        letterSpacing: '0px',
      }
    }
  }
}

// ─── Container exit ──────────────────────────────────────────────────────────

export interface ComputedContainerStyle {
  opacity: number
  transform: string
}

/**
 * Container style — chủ yếu xử lý exit animation nhẹ.
 * Entrance để cho words tự animate (tránh double-animate).
 */
export function computeContainerStyle(
  relativeFrame: number,
  totalFrames: number,
  fps: number
): ComputedContainerStyle {
  const xp = exitProgress(relativeFrame, totalFrames)
  const exitOpacity = xp > 0 ? 1 - xp * xp : 1  // quadratic ease out
  const exitTranslateY = xp > 0 ? xp * -5 : 0

  return {
    opacity: exitOpacity,
    transform: `translateY(${exitTranslateY.toFixed(2)}px)`,
  }
}

// ─── Internal util ────────────────────────────────────────────────────────────

function buildTransform(
  tx: number,
  ty: number,
  scale: number,
  rotateDeg: number
): string {
  const parts: string[] = []
  if (Math.abs(tx) > 0.01) parts.push(`translateX(${tx.toFixed(2)}px)`)
  if (Math.abs(ty) > 0.01) parts.push(`translateY(${ty.toFixed(2)}px)`)
  if (Math.abs(scale - 1) > 0.001) parts.push(`scale(${scale.toFixed(4)})`)
  if (Math.abs(rotateDeg) > 0.01) parts.push(`rotate(${rotateDeg.toFixed(2)}deg)`)
  return parts.length > 0 ? parts.join(' ') : 'none'
}
