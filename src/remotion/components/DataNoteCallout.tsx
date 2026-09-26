/**
 * DataNoteCallout.tsx — preset "data_note" (UPGRADED)
 *
 * UPGRADE: Animation riêng theo position — fade + slide from edge + subtle scale.
 * GIỮ NGUYÊN: Layout góc màn hình, viền đỏ trái, font Inter, background #0F0F0F.
 *
 * Animation:
 * - bottom_right: translateX 20→0 + fade + scale 0.96→1
 * - bottom_left: translateX -20→0 + fade + scale 0.96→1
 * - top_right: translateY -12→0 + fade + scale 0.96→1
 *
 * Không bounce mạnh. Không backdrop-filter (green bleed risk).
 * Exit: fade + translateY nhẹ.
 */

import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import { interpolate, spring } from 'remotion'
import { getSafeArea } from '../animations/helpers'
import { EXIT_FRAMES } from '../animations/primitives'

interface Props {
  label: string
  position: 'bottom_left' | 'bottom_right' | 'top_right'
  entranceFrame: number
  exitFrame?: number
}

export const DataNoteCallout: React.FC<Props> = ({ label, position, entranceFrame, exitFrame }) => {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()

  const relativeFrame = frame - entranceFrame
  if (relativeFrame < 0) return null

  const totalFrames = exitFrame != null ? exitFrame - entranceFrame : 999
  const safeArea = getSafeArea(width, height)

  const marginPx = Math.round(width * safeArea.horizontal)
  const marginVPx = Math.round(height * safeArea.bottom)

  // Enter animation — spring scale + fade
  const enterProgress = Math.min(1, relativeFrame / 8)
  const scale = spring({
    frame: relativeFrame,
    fps,
    config: { damping: 16, stiffness: 220, mass: 0.5 },
    from: 0.92,
    to: 1,
  })
  const opacity = interpolate(enterProgress, [0, 1], [0, 1], { extrapolateRight: 'clamp' })

  // Slide from edge theo position
  const SLIDE_PX = 18
  let slideX = 0
  let slideY = 0
  if (position === 'bottom_right') {
    slideX = spring({
      frame: relativeFrame,
      fps,
      config: { damping: 16, stiffness: 200, mass: 0.5 },
      from: SLIDE_PX,
      to: 0,
    })
  } else if (position === 'bottom_left') {
    slideX = spring({
      frame: relativeFrame,
      fps,
      config: { damping: 16, stiffness: 200, mass: 0.5 },
      from: -SLIDE_PX,
      to: 0,
    })
  } else {
    // top_right: slide down from above
    slideY = spring({
      frame: relativeFrame,
      fps,
      config: { damping: 16, stiffness: 200, mass: 0.5 },
      from: -SLIDE_PX,
      to: 0,
    })
  }

  // Exit fade
  const exitStart = totalFrames - EXIT_FRAMES
  const exitProgress = relativeFrame >= exitStart
    ? Math.min(1, (relativeFrame - exitStart) / EXIT_FRAMES)
    : 0
  const finalOpacity = opacity * (1 - exitProgress * exitProgress)

  // Position styles
  const positionStyle: React.CSSProperties =
    position === 'bottom_left'
      ? { bottom: marginVPx, left: marginPx }
      : position === 'bottom_right'
      ? { bottom: marginVPx, right: marginPx }
      : { top: Math.round(height * safeArea.top), right: marginPx }

  const transformOrigin =
    position === 'bottom_left' ? 'left bottom'
    : position === 'top_right' ? 'right top'
    : 'right bottom'

  const transform = [
    slideX !== 0 ? `translateX(${slideX.toFixed(2)}px)` : '',
    slideY !== 0 ? `translateY(${slideY.toFixed(2)}px)` : '',
    `scale(${scale.toFixed(4)})`,
  ].filter(Boolean).join(' ')

  return (
    <div
      style={{
        position: 'absolute',
        ...positionStyle,
        transform,
        transformOrigin,
        background: '#0F0F0F',       // fully opaque — no green bleed
        borderLeft: '5px solid #E8352B',
        color: '#FFFFFF',
        fontFamily: '"Inter", sans-serif',
        fontSize: Math.round(28 * (width / 1920)),
        fontWeight: 600,
        padding: '14px 22px',
        borderRadius: 6,
        maxWidth: Math.round(420 * (width / 1920)),
        boxShadow: '2px 2px 0px #000000',  // solid — no green bleed
        opacity: finalOpacity,
        willChange: 'transform, opacity',
      }}
    >
      {label}
    </div>
  )
}
