/**
 * NewsChyronCaption.tsx — preset "list_transition" (UPGRADED)
 *
 * UPGRADE: Animation per-segment — segment đỏ slideX từ trái, segment trắng reveal trễ.
 * GIỮ NGUYÊN: Layout 2 khối dính liền, font, màu sắc, kích thước.
 *
 * KHÔNG bounce cả block như trước.
 * Animation: slide reveal staggered — segment 1 trước, segment 2 trễ 4 frames.
 */

import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import { interpolate, spring } from 'remotion'
import type { ChyronSegment } from '../../../shared/types'
import { getSafeArea } from '../animations/helpers'
import { ENTER_FRAMES, EXIT_FRAMES } from '../animations/primitives'

interface Props {
  segments: ChyronSegment[]
  entranceFrame: number
  exitFrame?: number
}

const FONT_MAP: Record<ChyronSegment['fontPreset'], string> = {
  sans_bold_caps: '"Anton", sans-serif',
  serif: '"Playfair Display", serif',
}

const SEGMENT_STAGGER = 4  // frames delay giữa segment 1 và 2

export const NewsChyronCaption: React.FC<Props> = ({ segments, entranceFrame, exitFrame }) => {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()

  const relativeFrame = frame - entranceFrame
  if (relativeFrame < 0) return null

  const totalFrames = exitFrame != null ? exitFrame - entranceFrame : 999

  const safeArea = getSafeArea(width, height)
  const bottomPos = `${(0.18 * 100).toFixed(1)}%`  // lower-third ~18% from bottom

  // Exit phase
  const exitStart = totalFrames - EXIT_FRAMES
  const exitProgress = relativeFrame >= exitStart
    ? Math.min(1, (relativeFrame - exitStart) / EXIT_FRAMES)
    : 0

  return (
    <div
      style={{
        position: 'absolute',
        bottom: bottomPos,
        left: '50%',
        transform: `translateX(-50%) translateY(${(exitProgress * -8).toFixed(2)}px)`,
        transformOrigin: 'center bottom',
        display: 'flex',
        width: 'fit-content',
        whiteSpace: 'nowrap',
        boxShadow: '3px 3px 0px #000000',
        opacity: 1 - exitProgress * exitProgress,
      }}
    >
      {segments.map((seg, i) => {
        // Segment i bắt đầu trễ i*SEGMENT_STAGGER frames
        const segRelFrame = relativeFrame - i * SEGMENT_STAGGER
        if (segRelFrame < 0) {
          return (
            <div key={i} style={{ opacity: 0, background: seg.background, padding: '10px 22px' }}>
              {seg.text}
            </div>
          )
        }

        // Segment 1 (đỏ): slide từ trái
        // Segment 2+: clip reveal từ trái
        let opacity = 1
        let translateX = 0
        let clipPath: string | undefined

        if (i === 0) {
          // slideX từ trái với spring
          translateX = spring({
            frame: segRelFrame,
            fps,
            config: { damping: 14, stiffness: 220, mass: 0.5 },
            from: -30,
            to: 0,
          })
          opacity = interpolate(segRelFrame, [0, 5], [0, 1], { extrapolateRight: 'clamp' })
        } else {
          // clip reveal từ trái
          const revealProgress = Math.min(1, segRelFrame / ENTER_FRAMES)
          const rightPercent = interpolate(revealProgress, [0, 1], [100, 0])
          clipPath = `inset(0 ${rightPercent.toFixed(1)}% 0 0)`
          opacity = interpolate(segRelFrame, [0, 4], [0, 1], { extrapolateRight: 'clamp' })
        }

        return (
          <div
            key={i}
            style={{
              background: seg.background,
              color: seg.textColor,
              fontFamily: FONT_MAP[seg.fontPreset],
              fontSize: 44,
              fontWeight: seg.fontPreset === 'sans_bold_caps' ? 900 : 400,
              textTransform: seg.fontPreset === 'sans_bold_caps' ? 'uppercase' : 'none',
              padding: '10px 22px',
              opacity,
              transform: translateX !== 0 ? `translateX(${translateX.toFixed(2)}px)` : undefined,
              clipPath,
              willChange: 'transform, clip-path, opacity',
            }}
          >
            {seg.text}
          </div>
        )
      })}
    </div>
  )
}
