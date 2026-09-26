/**
 * ProofVisualOverlay.tsx — Remotion component cho Proof Visual cards.
 *
 * Hỗ trợ types:
 *   date_card       → 1963                  (top_right, red accent)
 *   number_card     → $2,000,000            (bottom_right, yellow number)
 *   stat_emphasis   → 40%                   (bottom_left, large stat)
 *   location_label  → ● MANITOBA, CANADA    (top_left, location pin)
 *   document_callout → text card            (bottom_right, cream)
 *
 * CHROMA SAFE:
 *   - Solid background (no transparency, no backdrop-filter)
 *   - Colors không phải green-adjacent
 *   - boxShadow solid, no blur
 *
 * DETERMINISTIC — không dùng Math.random().
 * Animation: fade + slide + subtle spring scale.
 * Enter: 8 frames. Exit: 5 frames.
 */

import React from 'react'
import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion'
import { getSafeArea } from '../animations/helpers'
import type { ProofVisual, ProofVisualPosition } from '../../../src/main/retention/retention-types'

// ─── Constants ────────────────────────────────────────────────────────────────

const ENTER_FRAMES = 8
const EXIT_FRAMES = 5

// Palette — US documentary editorial
const PALETTE = {
  bg:        '#0F0F0F',
  bgCream:   '#F5F0E6',
  white:     '#FFFFFF',
  black:     '#111111',
  red:       '#E8352B',
  yellow:    '#FFD84D',
  dimGray:   '#222222',
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ProofVisualOverlayProps {
  proof: ProofVisual
  entranceFrame: number
  exitFrame: number
}

// ─── Main Component ───────────────────────────────────────────────────────────

export const ProofVisualOverlay: React.FC<ProofVisualOverlayProps> = ({
  proof,
  entranceFrame,
  exitFrame,
}) => {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()

  const relFrame = frame - entranceFrame
  if (relFrame < 0) return null
  if (frame >= exitFrame) return null

  const totalFrames = exitFrame - entranceFrame
  const safeArea = getSafeArea(width, height)

  // ── Entrance animation ────────────────────────────────────────────────────
  const enterProgress = Math.min(1, relFrame / ENTER_FRAMES)

  const opacity = interpolate(enterProgress, [0, 1], [0, 1], { extrapolateRight: 'clamp' })

  const scale = spring({
    frame: relFrame,
    fps,
    config: { damping: 18, stiffness: 240, mass: 0.45 },
    from: 0.92,
    to: 1,
  })

  // ── Exit animation ────────────────────────────────────────────────────────
  const exitStart = totalFrames - EXIT_FRAMES
  const exitProgress = relFrame >= exitStart
    ? Math.min(1, (relFrame - exitStart) / EXIT_FRAMES)
    : 0
  const finalOpacity = opacity * (1 - exitProgress * exitProgress)

  // ── Slide from edge per position ──────────────────────────────────────────
  const SLIDE_PX = 16
  const pos = proof.position ?? 'bottom_right'
  const slideX = getSlideX(relFrame, fps, pos, SLIDE_PX)
  const slideY = getSlideY(relFrame, fps, pos, SLIDE_PX)

  // ── Position CSS ──────────────────────────────────────────────────────────
  const marginH = Math.round(width  * safeArea.horizontal)
  const marginTop = Math.round(height * safeArea.top)
  const marginBottom = Math.round(height * safeArea.bottom)

  const posStyle = resolvePositionStyle(pos, marginH, marginTop, marginBottom)
  const transformOrigin = resolveTransformOrigin(pos)

  const transform = [
    slideX !== 0 ? `translateX(${slideX.toFixed(2)}px)` : '',
    slideY !== 0 ? `translateY(${slideY.toFixed(2)}px)` : '',
    `scale(${scale.toFixed(4)})`,
  ].filter(Boolean).join(' ')

  // ── Responsive sizing ─────────────────────────────────────────────────────
  const scaleFactor = width / 1920

  // ── Render by type ────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'absolute',
        ...posStyle,
        transform,
        transformOrigin,
        opacity: finalOpacity,
        willChange: 'transform, opacity',
        zIndex: 80,
      }}
    >
      {renderCard(proof, scaleFactor)}
    </div>
  )
}

// ─── Card renderers ───────────────────────────────────────────────────────────

function renderCard(proof: ProofVisual, sf: number): React.ReactElement {
  switch (proof.type) {
    case 'date_card':
      return <DateCard text={proof.primaryText} sf={sf} />
    case 'number_card':
      return <MoneyCard text={proof.primaryText} sf={sf} />
    case 'stat_emphasis':
      return <StatCard text={proof.primaryText} sf={sf} />
    case 'location_label':
      return <LocationCard text={proof.primaryText} sf={sf} />
    case 'document_callout':
      return <DocCard text={proof.primaryText} subLabel={proof.subLabel} sf={sf} />
    default:
      return <MoneyCard text={proof.primaryText} sf={sf} />
  }
}

// ─── DateCard: 1963 ───────────────────────────────────────────────────────────

function DateCard({ text, sf }: { text: string; sf: number }): React.ReactElement {
  return (
    <div style={{
      background: PALETTE.bg,
      borderLeft: `${Math.round(5 * sf)}px solid ${PALETTE.red}`,
      color: PALETTE.white,
      fontFamily: '"Anton", "Impact", sans-serif',
      fontSize: Math.round(48 * sf),
      letterSpacing: `${2 * sf}px`,
      padding: `${Math.round(12 * sf)}px ${Math.round(20 * sf)}px`,
      borderRadius: Math.round(5 * sf),
      boxShadow: `${Math.round(2 * sf)}px ${Math.round(2 * sf)}px 0px #000000`,
      minWidth: Math.round(100 * sf),
      textAlign: 'center',
      lineHeight: 1.1,
    }}>
      {text}
    </div>
  )
}

// ─── MoneyCard: $2,000,000 ────────────────────────────────────────────────────

function MoneyCard({ text, sf }: { text: string; sf: number }): React.ReactElement {
  const isLong = text.length > 10
  const fontSize = Math.round((isLong ? 36 : 44) * sf)
  return (
    <div style={{
      background: PALETTE.bg,
      borderLeft: `${Math.round(5 * sf)}px solid ${PALETTE.yellow}`,
      color: PALETTE.yellow,
      fontFamily: '"Anton", "Impact", sans-serif',
      fontSize,
      letterSpacing: `${1 * sf}px`,
      padding: `${Math.round(12 * sf)}px ${Math.round(20 * sf)}px`,
      borderRadius: Math.round(5 * sf),
      boxShadow: `${Math.round(2 * sf)}px ${Math.round(2 * sf)}px 0px #000000`,
      maxWidth: Math.round(400 * sf),
      lineHeight: 1.15,
    }}>
      {text}
    </div>
  )
}

// ─── StatCard: 40% ────────────────────────────────────────────────────────────

function StatCard({ text, sf }: { text: string; sf: number }): React.ReactElement {
  const isLong = text.length > 6
  const fontSize = Math.round((isLong ? 52 : 68) * sf)
  return (
    <div style={{
      background: PALETTE.bg,
      borderLeft: `${Math.round(5 * sf)}px solid ${PALETTE.red}`,
      color: PALETTE.yellow,
      fontFamily: '"Anton", "Impact", sans-serif',
      fontSize,
      letterSpacing: `${1 * sf}px`,
      padding: `${Math.round(10 * sf)}px ${Math.round(20 * sf)}px`,
      borderRadius: Math.round(5 * sf),
      boxShadow: `${Math.round(2 * sf)}px ${Math.round(2 * sf)}px 0px #000000`,
      textAlign: 'center',
      minWidth: Math.round(100 * sf),
      lineHeight: 1.05,
    }}>
      {text}
    </div>
  )
}

// ─── LocationCard: ● MONTANA ──────────────────────────────────────────────────

function LocationCard({ text, sf }: { text: string; sf: number }): React.ReactElement {
  const isLong = text.length > 18
  const fontSize = Math.round((isLong ? 18 : 22) * sf)
  return (
    <div style={{
      background: PALETTE.bg,
      borderLeft: `${Math.round(4 * sf)}px solid ${PALETTE.red}`,
      color: PALETTE.white,
      fontFamily: '"Inter", "Helvetica Neue", sans-serif',
      fontSize,
      fontWeight: 700,
      letterSpacing: `${2.5 * sf}px`,
      padding: `${Math.round(10 * sf)}px ${Math.round(16 * sf)}px`,
      borderRadius: Math.round(4 * sf),
      boxShadow: `${Math.round(2 * sf)}px ${Math.round(2 * sf)}px 0px #000000`,
      display: 'flex',
      alignItems: 'center',
      gap: Math.round(8 * sf),
      maxWidth: Math.round(460 * sf),
      lineHeight: 1.3,
    }}>
      {/* Simple CSS pin — no image asset, no emoji */}
      <div style={{
        width: Math.round(10 * sf),
        height: Math.round(10 * sf),
        borderRadius: '50%',
        background: PALETTE.red,
        flexShrink: 0,
      }} />
      {text}
    </div>
  )
}

// ─── DocCard: document callout ────────────────────────────────────────────────

function DocCard({ text, subLabel, sf }: { text: string; subLabel?: string; sf: number }): React.ReactElement {
  return (
    <div style={{
      background: PALETTE.bgCream,
      borderLeft: `${Math.round(4 * sf)}px solid ${PALETTE.black}`,
      color: PALETTE.black,
      fontFamily: '"Inter", "Helvetica Neue", sans-serif',
      padding: `${Math.round(10 * sf)}px ${Math.round(16 * sf)}px`,
      borderRadius: Math.round(4 * sf),
      boxShadow: `${Math.round(2 * sf)}px ${Math.round(2 * sf)}px 0px #000000`,
      maxWidth: Math.round(420 * sf),
    }}>
      {subLabel && (
        <div style={{
          fontSize: Math.round(11 * sf),
          fontWeight: 700,
          letterSpacing: `${2 * sf}px`,
          color: '#666',
          marginBottom: Math.round(3 * sf),
          textTransform: 'uppercase',
        }}>
          {subLabel}
        </div>
      )}
      <div style={{
        fontSize: Math.round(22 * sf),
        fontWeight: 700,
        lineHeight: 1.25,
      }}>
        {text}
      </div>
    </div>
  )
}

// ─── Animation helpers ────────────────────────────────────────────────────────

function getSlideX(relFrame: number, fps: number, pos: ProofVisualPosition, px: number): number {
  if (pos === 'bottom_right' || pos === 'top_right') {
    return spring({ frame: relFrame, fps, config: { damping: 16, stiffness: 200, mass: 0.5 }, from: px, to: 0 })
  }
  if (pos === 'bottom_left' || pos === 'top_left') {
    return spring({ frame: relFrame, fps, config: { damping: 16, stiffness: 200, mass: 0.5 }, from: -px, to: 0 })
  }
  return 0
}

function getSlideY(relFrame: number, fps: number, pos: ProofVisualPosition, px: number): number {
  if (pos === 'top_right' || pos === 'top_left') {
    return spring({ frame: relFrame, fps, config: { damping: 16, stiffness: 200, mass: 0.5 }, from: -px, to: 0 })
  }
  if (pos === 'bottom_right' || pos === 'bottom_left') {
    return spring({ frame: relFrame, fps, config: { damping: 16, stiffness: 200, mass: 0.5 }, from: px, to: 0 })
  }
  return 0
}

function resolvePositionStyle(
  pos: ProofVisualPosition,
  marginH: number,
  marginTop: number,
  marginBottom: number
): React.CSSProperties {
  switch (pos) {
    case 'top_left':     return { top: marginTop, left: marginH }
    case 'top_right':    return { top: marginTop, right: marginH }
    case 'bottom_left':  return { bottom: marginBottom, left: marginH }
    case 'bottom_right':
    default:             return { bottom: marginBottom, right: marginH }
  }
}

function resolveTransformOrigin(pos: ProofVisualPosition): string {
  switch (pos) {
    case 'top_left':     return 'left top'
    case 'top_right':    return 'right top'
    case 'bottom_left':  return 'left bottom'
    case 'bottom_right':
    default:             return 'right bottom'
  }
}
