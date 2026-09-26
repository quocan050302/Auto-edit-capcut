import React from 'react'
import { useBounceScale } from '../utils/useBounceScale'

interface Props {
  label: string
  position: 'bottom_left' | 'bottom_right' | 'top_right'
  entranceFrame: number
}

/**
 * Map position string → absolute CSS positioning.
 * Đặt đủ xa mép để không bị crop khi letterbox hay output 9:16.
 */
const POSITION_STYLE: Record<Props['position'], React.CSSProperties> = {
  bottom_left: { bottom: 60, left: 60 },
  bottom_right: { bottom: 60, right: 60 },
  top_right: { top: 60, right: 60 },
}

/**
 * DataNoteCallout — preset "data_note" (shock_stat không phải trung tâm luận điểm)
 *
 * Callout nhỏ ở góc màn hình với viền đỏ bên trái.
 * Không chiếm diện tích lớn — giữ nguyên B-roll hiện tại nhìn được.
 * Scale bounce nhẹ hơn BigStatement (from=0.9 → 1 qua useBounceScale).
 */
export const DataNoteCallout: React.FC<Props> = ({ label, position, entranceFrame }) => {
  const scale = useBounceScale(entranceFrame)

  if (scale === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        ...POSITION_STYLE[position],
        transform: `scale(${scale})`,
        transformOrigin: position === 'bottom_left' ? 'left bottom'
          : position === 'top_right' ? 'right top'
          : 'right bottom',
        background: '#0F0F0F',  // fully opaque — semi-transparent + green = greenish bleed
        borderLeft: '5px solid #E8352B',
        color: '#FFFFFF',
        fontFamily: '"Inter", sans-serif',
        fontSize: 28,
        fontWeight: 600,
        padding: '14px 22px',
        borderRadius: 6,
        maxWidth: 420,
        boxShadow: '0 2px 12px #000000',  // solid — no green bleed
      }}
    >
      {label}
    </div>
  )
}
