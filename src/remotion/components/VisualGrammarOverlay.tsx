import React from 'react'
import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion'
import { getSafeArea } from '../animations/helpers'
import type { VisualGrammarDecision } from '../../../shared/types'
import { StatCard } from './StatCard'
import { QuoteCard } from './QuoteCard'
import { ComparisonCard } from './ComparisonCard'
import { ChapterTitleCard } from './ChapterTitleCard'
import { DocumentCard } from './DocumentCard'

interface VisualGrammarOverlayProps {
  decision: VisualGrammarDecision
  entranceFrame: number
  exitFrame: number
}

const ENTER_FRAMES = 8
const EXIT_FRAMES = 5

function resolvePositionStyle(
  pos: string,
  marginH: number,
  marginTop: number,
  marginBottom: number
): React.CSSProperties {
  switch (pos) {
    case 'top_left':
      return { top: marginTop, left: marginH }
    case 'top_right':
      return { top: marginTop, right: marginH }
    case 'bottom_left':
      return { bottom: marginBottom, left: marginH }
    case 'bottom_right':
      return { bottom: marginBottom, right: marginH }
    case 'center':
      return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
    case 'center_bottom':
      return { bottom: marginBottom, left: '50%', transform: 'translateX(-50%)' }
    default:
      return { bottom: marginBottom, right: marginH }
  }
}

export const VisualGrammarOverlay: React.FC<VisualGrammarOverlayProps> = ({
  decision,
  entranceFrame,
  exitFrame
}) => {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()

  const relFrame = frame - entranceFrame
  if (relFrame < 0 || frame >= exitFrame) return null

  const totalFrames = exitFrame - entranceFrame
  const safeArea = getSafeArea(width, height)
  const sf = width / 1920

  // Entrance spring & opacity
  const enterProgress = Math.min(1, relFrame / ENTER_FRAMES)
  const opacity = interpolate(enterProgress, [0, 1], [0, 1], { extrapolateRight: 'clamp' })
  const scale = spring({
    frame: relFrame,
    fps,
    config: { damping: 18, stiffness: 240, mass: 0.45 },
    from: 0.92,
    to: 1
  })

  // Exit animation
  const exitStart = totalFrames - EXIT_FRAMES
  const exitProgress = relFrame >= exitStart ? Math.min(1, (relFrame - exitStart) / EXIT_FRAMES) : 0
  const finalOpacity = opacity * (1 - exitProgress * exitProgress)

  const marginH = Math.round(width * safeArea.horizontal)
  const marginTop = Math.round(height * safeArea.top)
  const marginBottom = Math.round(height * safeArea.bottom)

  const pos = decision.position ?? 'bottom_right'
  const isCentered = pos === 'center' || pos === 'center_bottom'
  const posStyle = resolvePositionStyle(pos, marginH, marginTop, marginBottom)

  const transform = isCentered
    ? `${(posStyle.transform as string) || ''} scale(${scale.toFixed(4)})`
    : `scale(${scale.toFixed(4)})`

  return (
    <div
      style={{
        position: 'absolute',
        ...posStyle,
        transform,
        opacity: finalOpacity,
        zIndex: 85,
        willChange: 'transform, opacity'
      }}
    >
      {renderGrammarContent(decision, sf)}
    </div>
  )
}

function renderGrammarContent(decision: VisualGrammarDecision, sf: number): React.ReactElement | null {
  const primary = decision.primaryText ?? ''
  const secondary = decision.secondaryText

  switch (decision.type) {
    case 'stat_card':
      return <StatCard text={primary} subLabel={secondary} sf={sf} />

    case 'quote_card':
      return <QuoteCard quote={primary} author={secondary} sf={sf} />

    case 'comparison_card':
      return <ComparisonCard primaryText={primary} secondaryText={secondary} sf={sf} />

    case 'chapter_title':
      return <ChapterTitleCard title={primary} subtitle={secondary} sf={sf} />

    case 'document_card':
      return <DocumentCard title={primary} subLabel={secondary} sf={sf} />

    case 'date_card':
      return (
        <div
          style={{
            background: '#0F0F0F',
            borderLeft: `${Math.round(5 * sf)}px solid #E8352B`,
            color: '#FFFFFF',
            fontFamily: '"Anton", "Impact", sans-serif',
            fontSize: Math.round(44 * sf),
            letterSpacing: `${2 * sf}px`,
            padding: `${Math.round(10 * sf)}px ${Math.round(18 * sf)}px`,
            borderRadius: Math.round(5 * sf),
            boxShadow: `${Math.round(2 * sf)}px ${Math.round(2 * sf)}px 0px #000000`
          }}
        >
          {primary}
        </div>
      )

    case 'location_card':
      return (
        <div
          style={{
            background: '#0F0F0F',
            border: `${Math.round(1 * sf)}px solid #27272A`,
            borderLeft: `${Math.round(4 * sf)}px solid #3B82F6`,
            color: '#FFFFFF',
            fontFamily: '"Inter", sans-serif',
            fontWeight: 800,
            fontSize: Math.round(14 * sf),
            letterSpacing: `${1.5 * sf}px`,
            padding: `${Math.round(8 * sf)}px ${Math.round(14 * sf)}px`,
            borderRadius: Math.round(4 * sf),
            boxShadow: `${Math.round(2 * sf)}px ${Math.round(2 * sf)}px 0px #000000`,
            display: 'flex',
            alignItems: 'center',
            gap: `${Math.round(6 * sf)}px`
          }}
        >
          <span style={{ color: '#3B82F6', fontSize: Math.round(12 * sf) }}>●</span>
          {primary}
        </div>
      )

    default:
      return null
  }
}
