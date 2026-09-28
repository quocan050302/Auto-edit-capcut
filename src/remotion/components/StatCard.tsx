import React from 'react'

export interface StatCardProps {
  text: string
  subLabel?: string
  sf: number // scale factor relative to 1920px
}

export const StatCard: React.FC<StatCardProps> = ({ text, subLabel, sf }) => {
  return (
    <div
      style={{
        background: '#0F0F0F',
        borderLeft: `${Math.round(6 * sf)}px solid #FFD84D`,
        padding: `${Math.round(14 * sf)}px ${Math.round(22 * sf)}px`,
        borderRadius: Math.round(6 * sf),
        boxShadow: `${Math.round(3 * sf)}px ${Math.round(3 * sf)}px 0px #000000`,
        display: 'flex',
        flexDirection: 'column',
        gap: `${Math.round(4 * sf)}px`,
        maxWidth: `${Math.round(420 * sf)}px`
      }}
    >
      <div
        style={{
          color: '#FFD84D',
          fontFamily: '"Anton", "Impact", "Arial Black", sans-serif',
          fontSize: Math.round(44 * sf),
          lineHeight: 1,
          letterSpacing: `${1 * sf}px`
        }}
      >
        {text}
      </div>
      {subLabel && (
        <div
          style={{
            color: '#D4D4D8',
            fontFamily: '"Inter", -apple-system, sans-serif',
            fontSize: Math.round(12 * sf),
            fontWeight: 700,
            letterSpacing: `${1.5 * sf}px`,
            textTransform: 'uppercase'
          }}
        >
          {subLabel}
        </div>
      )}
    </div>
  )
}
