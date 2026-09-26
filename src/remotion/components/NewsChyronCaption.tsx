import React from 'react'
import { useBounceScale } from '../utils/useBounceScale'
import type { ChyronSegment } from '../../../shared/types'

interface Props {
  segments: ChyronSegment[]
  entranceFrame: number
}

/**
 * Ánh xạ fontPreset → CSS font-family.
 * Cả 2 font đều load qua @remotion/google-fonts trong index.ts.
 */
const FONT_MAP: Record<ChyronSegment['fontPreset'], string> = {
  sans_bold_caps: '"Anton", sans-serif',
  serif: '"Playfair Display", serif',
}

/**
 * NewsChyronCaption — preset "list_transition"
 *
 * Giống phong cách banner bản tin: 2 khối màu nối liền mép nhau (flexbox).
 * Mỗi khối tự co giãn theo độ dài text — CSS đảm bảo không có khoảng hở.
 * Segment 1: nền đỏ #E8352B, Anton caps (mệnh đề chính)
 * Segment 2: nền trắng ngà #F5F0E6, Playfair Display (phần bổ nghĩa)
 */
export const NewsChyronCaption: React.FC<Props> = ({ segments, entranceFrame }) => {
  const scale = useBounceScale(entranceFrame)

  if (scale === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '22%',
        left: '50%',
        transform: `translateX(-50%) scale(${scale})`,
        transformOrigin: 'center bottom',
        display: 'flex',       // flex tự đảm bảo các segment dính liền mép
        width: 'fit-content',
        whiteSpace: 'nowrap',
        boxShadow: '0 4px 16px #000000',  // solid shadow — no green bleed
      }}
    >
      {segments.map((seg, i) => (
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
            // Không có gap, border, margin — các khối dính khít nhau tự nhiên
          }}
        >
          {seg.text}
        </div>
      ))}
    </div>
  )
}
