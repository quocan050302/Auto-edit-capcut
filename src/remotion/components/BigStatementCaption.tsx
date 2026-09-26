/**
 * BigStatementCaption.tsx — preset "big_statement"
 *
 * UPGRADE: Dùng KineticCaption + animation engine thay cho useBounceScale cũ.
 * Backward compatible: animationPreset là OPTIONAL — old plans vẫn render.
 *
 * KHÔNG xóa component này — CaptionsOverlay vẫn dispatch tới đây.
 *
 * Thay đổi từ version cũ:
 * - Không bounce cả block (chỉ container exit nhẹ)
 * - Word-level animation (mỗi từ animate riêng)
 * - Keyword spring pop + yellow highlight (không dùng ô đỏ trừ khi boxHighlight=true)
 * - Font size responsive theo resolution
 * - Exit animation nhẹ (fade + slideUp nhỏ)
 *
 * Giữ nguyên:
 * - useBounceScale vẫn available trong utils/ (backward compat)
 * - highlightWords logic
 * - entranceFrame logic
 */

import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import { KineticCaption } from './KineticCaption'
import { resolveCaptionAnimation } from '../animations/presets'
import type { CaptionPhrase } from '../../../shared/types'
import type { AnimationPreset, AnimationIntensity, KeywordAnimation } from '../animations/types'

interface Props {
  text: string
  highlightWords: string[]
  entranceFrame: number
  exitFrame?: number
  // Optional animation override — nếu CaptionsOverlay truyền resolved animation
  resolvedPreset?: AnimationPreset
  resolvedIntensity?: AnimationIntensity
  resolvedKeyword?: KeywordAnimation
  resolvedStagger?: number
  // Để infer animation nếu không có override
  emphasisType?: string
  phraseIndex?: number
  phraseId?: string
  // Legacy: boxHighlight vẫn giữ cho backward compat
  boxHighlight?: boolean
}

export const BigStatementCaption: React.FC<Props> = ({
  text,
  highlightWords,
  entranceFrame,
  exitFrame,
  resolvedPreset,
  resolvedIntensity,
  resolvedKeyword,
  resolvedStagger,
  emphasisType = 'hook',
  phraseIndex = 0,
  phraseId,
  boxHighlight = false,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const relativeFrame = frame - entranceFrame

  // Chưa tới lúc hiện
  if (relativeFrame < 0) return null

  // Resolve animation — nếu có override dùng override, không thì infer
  const resolved = resolvedPreset
    ? {
        preset: resolvedPreset,
        intensity: resolvedIntensity ?? 'medium' as AnimationIntensity,
        keywordAnimation: resolvedKeyword ?? 'spring' as KeywordAnimation,
        wordStaggerFrames: resolvedStagger ?? 0,
      }
    : resolveCaptionAnimation(
        {
          id: phraseId ?? `fallback_${phraseIndex}`,
          sceneId: '',
          text,
          startTime: 0,
          endTime: 0,
          emphasisType: (emphasisType as any) ?? 'hook',
          highlightWords,
          style: { fontPreset: 'sans_bold_caps', boxHighlight: boxHighlight ?? false, skew: false, baseColor: 'white' },
        } as CaptionPhrase,
        phraseIndex
      )

  return (
    <KineticCaption
      text={text}
      highlightWords={highlightWords}
      entranceFrame={entranceFrame}
      exitFrame={exitFrame}
      resolvedAnimation={resolved}
    />
  )
}
