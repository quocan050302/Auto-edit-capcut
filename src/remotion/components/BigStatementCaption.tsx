import React from 'react'
import { useBounceScale } from '../utils/useBounceScale'

interface Props {
  text: string
  highlightWords: string[]
  entranceFrame: number
}

/**
 * BigStatementCaption — preset "hook" / "punchline"
 *
 * Chữ to Anton, viết hoa, chiếm 85% chiều rộng màn hình.
 * Từ trong highlightWords có nền đỏ ôm khít (display:inline-block + CSS tự tính width).
 * Scale bounce từ 85% → 100% khi xuất hiện.
 */
export const BigStatementCaption: React.FC<Props> = ({ text, highlightWords, entranceFrame }) => {
  const scale = useBounceScale(entranceFrame)

  // Nếu chưa tới lúc hiện
  if (scale === 0) return null

  const words = text.toUpperCase().split(' ')
  const highlightSet = new Set(highlightWords.map((w) => w.toUpperCase()))

  return (
    <div
      style={{
        position: 'absolute',
        top: '38%',
        left: '50%',
        transform: `translate(-50%, -50%) scale(${scale})`,
        width: '85%',
        textAlign: 'center',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: '0 18px',
        lineHeight: 1.15,
        transformOrigin: 'center center',
      }}
    >
      {words.map((word, i) => (
        <span
          key={i}
          style={{
            fontFamily: '"Anton", sans-serif',
            fontSize: 76,
            fontWeight: 900,
            color: '#FFFFFF',
            textShadow: '0 2px 6px #000000',  // solid black — no green bleed on chroma key
            // ô đỏ chỉ ôm từ được nhấn — CSS tự tính width qua display:inline-block
            background: highlightSet.has(word) ? '#E8352B' : '#00FF00',
            padding: highlightSet.has(word) ? '2px 10px' : '0',
            borderRadius: 2,
            display: 'inline-block',
          }}
        >
          {word}
        </span>
      ))}
    </div>
  )
}
