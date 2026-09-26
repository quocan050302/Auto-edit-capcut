/**
 * KineticCaption.tsx — component caption kinetic chính
 *
 * Dùng cho hầu hết caption dạng big_statement.
 * Hỗ trợ tất cả 6 animation preset.
 * Word-level animation + keyword emphasis riêng.
 * Responsive font size theo resolution.
 * Exit animation nhẹ.
 *
 * Props backward-compatible: animationPreset là OPTIONAL.
 * Old caption-plan.json không có animationPreset vẫn render (dùng resolved default).
 */

import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import { computeWordStyle, computeContainerStyle, COLORS } from '../animations/animation-engine'
import { normalizeWord, getResponsiveFontSize, getSafeArea } from '../animations/helpers'
import type { AnimationPreset, AnimationIntensity, KeywordAnimation, ResolvedAnimation } from '../animations/types'

interface KineticCaptionProps {
  text: string
  highlightWords: string[]
  entranceFrame: number
  exitFrame?: number         // frame kết thúc phrase (để tính exit animation)
  resolvedAnimation: ResolvedAnimation
}

/**
 * KineticCaption — renders word-by-word với animation riêng cho mỗi từ.
 *
 * Animation order: container exit > word entrance > keyword emphasis.
 * Font size responsive theo resolution và word count.
 */
export const KineticCaption: React.FC<KineticCaptionProps> = ({
  text,
  highlightWords,
  entranceFrame,
  exitFrame,
  resolvedAnimation,
}) => {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()

  const relativeFrame = frame - entranceFrame
  const safeArea = getSafeArea(width, height)

  // Chưa tới lúc hiện — ẩn hoàn toàn
  if (relativeFrame < 0) return null

  const { preset, intensity, keywordAnimation, wordStaggerFrames } = resolvedAnimation

  // Tính totalFrames cho exit animation
  const totalFrames = exitFrame != null
    ? (exitFrame - entranceFrame)
    : 999  // không biết exit → không có exit anim

  // Split words và normalize để match highlights
  const words = text.toUpperCase().split(/\s+/).filter(Boolean)
  const highlightSet = new Set(highlightWords.map(normalizeWord))

  // Font size responsive
  const isImpact = preset === 'punch' || preset === 'impact_keyword'
  const fontSizePreset = isImpact ? 'impact' : 'normal'
  const fontSize = getResponsiveFontSize(words.length, width, fontSizePreset)

  // Container style (exit)
  const containerStyle = computeContainerStyle(relativeFrame, totalFrames, fps)

  // Safe area margins
  const hMargin = `${(safeArea.horizontal * 100).toFixed(1)}%`
  const bottomPos = `${(safeArea.bottom * 100).toFixed(1)}%`

  return (
    <div
      style={{
        position: 'absolute',
        bottom: bottomPos,
        left: hMargin,
        right: hMargin,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'flex-end',
        gap: `${Math.round(fontSize * 0.22)}px ${Math.round(fontSize * 0.26)}px`,
        opacity: containerStyle.opacity,
        transform: containerStyle.transform,
        transformOrigin: 'center bottom',
      }}
    >
      {words.map((word, i) => {
        const isKeyword = highlightSet.has(normalizeWord(word))

        const wordStyle = computeWordStyle({
          relativeFrame,
          totalFrames,
          fps,
          preset,
          intensity,
          keywordAnim: keywordAnimation,
          isKeyword,
          wordIndex: i,
          wordStaggerFrames,
        })

        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              fontFamily: '"Anton", sans-serif',
              fontSize,
              fontWeight: 900,
              lineHeight: 1.1,
              letterSpacing: wordStyle.letterSpacing,
              color: wordStyle.color,
              // Solid black shadow — no semi-transparent on chroma screen
              textShadow: '2px 2px 0px #000000, -1px -1px 0px #000000',
              // Keyword ô đỏ
              background: isKeyword ? 'transparent' : COLORS.chroma,
              padding: 0,
              opacity: wordStyle.opacity,
              transform: wordStyle.transform,
              filter: wordStyle.filter || undefined,
              clipPath: wordStyle.clipPath,
              transformOrigin: 'center bottom',
              willChange: 'transform, opacity',
            }}
          >
            {word}
          </span>
        )
      })}
    </div>
  )
}
