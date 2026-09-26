import React from 'react'
import { useCurrentFrame, useVideoConfig, AbsoluteFill } from 'remotion'
import { BigStatementCaption } from './components/BigStatementCaption'
import { NewsChyronCaption } from './components/NewsChyronCaption'
import { DataNoteCallout } from './components/DataNoteCallout'
import type { CaptionPlan } from '../../shared/types'

interface Props {
  captionPlan: CaptionPlan
}

/**
 * CaptionsOverlay — component gốc của Remotion composition.
 *
 * Nhận toàn bộ CaptionPlan qua inputProps.
 * Mỗi frame: lọc các phrases đang active (startTime ≤ currentTime ≤ endTime),
 * dispatch đúng component theo presetType.
 *
 * Nền trong suốt (AbsoluteFill với backgroundColor: 'transparent') để overlay
 * lên video gốc qua FFmpeg sau khi export dạng WebM VP8 alpha.
 */
export const CaptionsOverlay: React.FC<Props> = ({ captionPlan }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const currentTime = frame / fps

  // Lọc phrases đang active tại frame hiện tại
  const activePhrases = captionPlan.phrases.filter(
    (p) => currentTime >= p.startTime && currentTime <= p.endTime
  )

  return (
    <AbsoluteFill style={{ backgroundColor: '#00FF00' }}>
      {activePhrases.map((phrase) => {
        const entranceFrame = Math.round(phrase.startTime * fps)
        const preset = phrase.presetType ?? inferPreset(phrase.emphasisType)

        switch (preset) {
          case 'big_statement':
            return (
              <BigStatementCaption
                key={phrase.id}
                text={phrase.text}
                highlightWords={phrase.highlightWords ?? []}
                entranceFrame={entranceFrame}
              />
            )
          case 'news_chyron':
            return (
              <NewsChyronCaption
                key={phrase.id}
                segments={phrase.chyronSegments ?? buildDefaultChyronSegments(phrase.text)}
                entranceFrame={entranceFrame}
              />
            )
          case 'data_note':
            return phrase.dataNote ? (
              <DataNoteCallout
                key={phrase.id}
                label={phrase.dataNote.label}
                position={phrase.dataNote.position}
                entranceFrame={entranceFrame}
              />
            ) : null
          default:
            // Fallback: mọi phrase không có preset đều render dạng big_statement
            return (
              <BigStatementCaption
                key={phrase.id}
                text={phrase.text}
                highlightWords={phrase.highlightWords ?? []}
                entranceFrame={entranceFrame}
              />
            )
        }
      })}
    </AbsoluteFill>
  )
}

/**
 * inferPreset — suy ra preset từ emphasisType nếu phrase cũ chưa có presetType.
 * Backward-compatible với caption-plan.json được tạo trước khi có Remotion.
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
