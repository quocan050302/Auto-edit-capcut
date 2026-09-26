/**
 * CaptionsOverlay.tsx — Remotion composition root (UPGRADED)
 *
 * FLOW KHÔNG ĐỔI:
 *   CaptionPlan → filter active phrases per frame → dispatch component theo presetType
 *
 * UPGRADE:
 * - Truyền exitFrame cho tất cả components (để exit animation hoạt động)
 * - resolveCaptionAnimation() cho BigStatementCaption (word-level anim)
 * - Truyền phraseIndex để variation rule hoạt động
 * - inferPreset() giữ nguyên để backward compat
 *
 * KHÔNG THAY ĐỔI:
 * - Logic filter activeRanges (handled ở caption-planner, không phải đây)
 * - presetType dispatch logic
 * - Background chroma key (#00FF00)
 * - buildDefaultChyronSegments()
 */

import React from 'react'
import { useCurrentFrame, useVideoConfig, AbsoluteFill } from 'remotion'
import { BigStatementCaption } from './components/BigStatementCaption'
import { NewsChyronCaption } from './components/NewsChyronCaption'
import { DataNoteCallout } from './components/DataNoteCallout'
import { resolveCaptionAnimation } from './animations/presets'
import type { CaptionPlan } from '../../shared/types'

interface Props {
  captionPlan: CaptionPlan
}

export const CaptionsOverlay: React.FC<Props> = ({ captionPlan }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const currentTime = frame / fps

  // Filter active phrases tại frame hiện tại
  const activePhrases = captionPlan.phrases.filter(
    (p) => currentTime >= p.startTime && currentTime <= p.endTime
  )

  return (
    <AbsoluteFill style={{ backgroundColor: '#00FF00' }}>
      {activePhrases.map((phrase, renderIdx) => {
        const entranceFrame = Math.round(phrase.startTime * fps)
        const exitFrame = Math.round(phrase.endTime * fps)
        const preset = phrase.presetType ?? inferPreset(phrase.emphasisType)

        // Tìm index thực trong toàn bộ phrases array (để variation rule)
        const phraseIndex = captionPlan.phrases.indexOf(phrase)

        switch (preset) {
          case 'big_statement': {
            // Resolve animation để truyền xuống (deterministic, dựa vào index)
            const resolved = resolveCaptionAnimation(phrase, phraseIndex)
            return (
              <BigStatementCaption
                key={phrase.id}
                text={phrase.text}
                highlightWords={phrase.highlightWords ?? []}
                entranceFrame={entranceFrame}
                exitFrame={exitFrame}
                resolvedPreset={resolved.preset}
                resolvedIntensity={resolved.intensity}
                resolvedKeyword={resolved.keywordAnimation}
                resolvedStagger={resolved.wordStaggerFrames}
                emphasisType={phrase.emphasisType}
                phraseIndex={phraseIndex}
                phraseId={phrase.id}
                boxHighlight={phrase.style?.boxHighlight ?? false}
              />
            )
          }

          case 'news_chyron':
            return (
              <NewsChyronCaption
                key={phrase.id}
                segments={phrase.chyronSegments ?? buildDefaultChyronSegments(phrase.text)}
                entranceFrame={entranceFrame}
                exitFrame={exitFrame}
              />
            )

          case 'data_note':
            return phrase.dataNote ? (
              <DataNoteCallout
                key={phrase.id}
                label={phrase.dataNote.label}
                position={phrase.dataNote.position}
                entranceFrame={entranceFrame}
                exitFrame={exitFrame}
              />
            ) : null

          default:
            // Fallback: big_statement với default animation
            return (
              <BigStatementCaption
                key={phrase.id}
                text={phrase.text}
                highlightWords={phrase.highlightWords ?? []}
                entranceFrame={entranceFrame}
                exitFrame={exitFrame}
                emphasisType={phrase.emphasisType}
                phraseIndex={phraseIndex}
                phraseId={phrase.id}
              />
            )
        }
      })}
    </AbsoluteFill>
  )
}

/**
 * inferPreset — backward compatible: suy ra preset từ emphasisType.
 * Giữ nguyên để caption-plan cũ không có presetType vẫn render.
 */
function inferPreset(emphasisType: string): 'big_statement' | 'news_chyron' | 'data_note' {
  switch (emphasisType) {
    case 'hook':
    case 'punchline':
      return 'big_statement'
    case 'list_transition':
      return 'news_chyron'
    case 'shock_stat':
      return 'data_note'
    default:
      return 'big_statement'
  }
}

/**
 * buildDefaultChyronSegments — fallback nếu news_chyron không có chyronSegments.
 * Chia text làm đôi: nửa đầu segment đỏ, nửa sau segment trắng ngà.
 * KHÔNG THAY ĐỔI function này.
 */
function buildDefaultChyronSegments(text: string) {
  const words = text.split(' ')
  const mid = Math.ceil(words.length / 2)
  return [
    {
      text: words.slice(0, mid).join(' '),
      background: '#E8352B',
      textColor: '#FFFFFF',
      fontPreset: 'sans_bold_caps' as const,
    },
    {
      text: words.slice(mid).join(' '),
      background: '#F5F0E6',
      textColor: '#1A1A1A',
      fontPreset: 'serif' as const,
    },
  ]
}
