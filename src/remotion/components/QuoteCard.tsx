import React from 'react'

export interface QuoteCardProps {
  quote: string
  author?: string
  sf: number
}

export const QuoteCard: React.FC<QuoteCardProps> = ({ quote, author, sf }) => {
  return (
    <div
      style={{
        background: '#141416',
        borderLeft: `${Math.round(5 * sf)}px solid #F59E0B`,
        borderTop: `${Math.round(1 * sf)}px solid #27272A`,
        borderRight: `${Math.round(1 * sf)}px solid #27272A`,
        borderBottom: `${Math.round(1 * sf)}px solid #27272A`,
        padding: `${Math.round(16 * sf)}px ${Math.round(24 * sf)}px`,
        borderRadius: Math.round(6 * sf),
        boxShadow: `${Math.round(3 * sf)}px ${Math.round(3 * sf)}px 0px #000000`,
        maxWidth: `${Math.round(560 * sf)}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: `${Math.round(8 * sf)}px`
      }}
    >
      <div
        style={{
          color: '#F4F4F5',
          fontFamily: '"Georgia", "Merriweather", serif',
          fontSize: Math.round(20 * sf),
          fontStyle: 'italic',
          lineHeight: 1.4,
          letterSpacing: `${0.3 * sf}px`
        }}
      >
        {quote}
      </div>
      {author && (
        <div
          style={{
            color: '#A1A1AA',
            fontFamily: '"Inter", -apple-system, sans-serif',
            fontSize: Math.round(11 * sf),
            fontWeight: 700,
            letterSpacing: `${1.2 * sf}px`,
            textTransform: 'uppercase',
            display: 'flex',
            alignItems: 'center',
            gap: `${Math.round(6 * sf)}px`
          }}
        >
          <span style={{ color: '#F59E0B' }}>—</span> {author}
        </div>
      )}
    </div>
  )
}
