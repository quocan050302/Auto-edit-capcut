import React from 'react'

export interface ChapterTitleCardProps {
  title: string
  subtitle?: string
  sf: number
}

export const ChapterTitleCard: React.FC<ChapterTitleCardProps> = ({ title, subtitle, sf }) => {
  return (
    <div
      style={{
        background: 'rgba(10, 10, 12, 0.95)',
        borderTop: `${Math.round(2 * sf)}px solid #E8352B`,
        borderBottom: `${Math.round(2 * sf)}px solid #E8352B`,
        padding: `${Math.round(20 * sf)}px ${Math.round(48 * sf)}px`,
        boxShadow: `${Math.round(4 * sf)}px ${Math.round(4 * sf)}px 0px #000000`,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: `${Math.round(6 * sf)}px`,
        maxWidth: `${Math.round(780 * sf)}px`
      }}
    >
      {subtitle && (
        <div
          style={{
            color: '#E8352B',
            fontFamily: '"Inter", -apple-system, sans-serif',
            fontSize: Math.round(12 * sf),
            fontWeight: 800,
            letterSpacing: `${4 * sf}px`,
            textTransform: 'uppercase'
          }}
        >
          {subtitle}
        </div>
      )}
      <div
        style={{
          color: '#FFFFFF',
          fontFamily: '"Anton", "Impact", "Arial Black", sans-serif',
          fontSize: Math.round(46 * sf),
          letterSpacing: `${2 * sf}px`,
          lineHeight: 1.1,
          textTransform: 'uppercase'
        }}
      >
        {title}
      </div>
    </div>
  )
}
