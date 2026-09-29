import React from 'react'

export interface DocumentCardProps {
  title: string
  subLabel?: string
  sf: number
}

export const DocumentCard: React.FC<DocumentCardProps> = ({ title, subLabel, sf }) => {
  return (
    <div
      style={{
        background: '#F5F0E6',
        border: `${Math.round(1 * sf)}px solid #D6CEBE`,
        borderTop: `${Math.round(4 * sf)}px solid #71717A`,
        padding: `${Math.round(12 * sf)}px ${Math.round(18 * sf)}px`,
        borderRadius: Math.round(4 * sf),
        boxShadow: `${Math.round(3 * sf)}px ${Math.round(3 * sf)}px 0px #000000`,
        maxWidth: `${Math.round(380 * sf)}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: `${Math.round(4 * sf)}px`
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `${Math.round(1 * sf)}px solid rgba(0,0,0,0.15)`,
          paddingBottom: `${Math.round(4 * sf)}px`
        }}
      >
        <span
          style={{
            fontFamily: '"Courier New", Courier, monospace',
            fontSize: Math.round(10 * sf),
            fontWeight: 700,
            color: '#52525B',
            letterSpacing: `${1 * sf}px`,
            textTransform: 'uppercase'
          }}
        >
          {subLabel || 'OFFICIAL RECORD'}
        </span>
        <span
          style={{
            background: '#DC2626',
            color: '#FFFFFF',
            fontSize: Math.round(8 * sf),
            fontWeight: 800,
            padding: `${Math.round(1 * sf)}px ${Math.round(4 * sf)}px`,
            borderRadius: '2px',
            letterSpacing: '0.5px'
          }}
        >
          DECLASS
        </span>
      </div>

      <div
        style={{
          color: '#18181B',
          fontFamily: '"Georgia", "Merriweather", serif',
          fontSize: Math.round(15 * sf),
          fontWeight: 700,
          lineHeight: 1.25,
          textTransform: 'uppercase',
          letterSpacing: `${0.5 * sf}px`
        }}
      >
        {title}
      </div>
    </div>
  )
}
