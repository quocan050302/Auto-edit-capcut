import React from 'react'

export interface ComparisonCardProps {
  primaryText: string
  secondaryText?: string
  sf: number
}

export const ComparisonCard: React.FC<ComparisonCardProps> = ({ primaryText, secondaryText, sf }) => {
  return (
    <div
      style={{
        background: '#0D0D10',
        border: `${Math.round(1 * sf)}px solid #3F3F46`,
        borderRadius: Math.round(8 * sf),
        padding: `${Math.round(14 * sf)}px ${Math.round(20 * sf)}px`,
        boxShadow: `${Math.round(3 * sf)}px ${Math.round(3 * sf)}px 0px #000000`,
        display: 'flex',
        alignItems: 'center',
        gap: `${Math.round(16 * sf)}px`,
        maxWidth: `${Math.round(520 * sf)}px`
      }}
    >
      <div
        style={{
          background: 'rgba(232, 53, 43, 0.2)',
          borderLeft: `${Math.round(4 * sf)}px solid #E8352B`,
          padding: `${Math.round(8 * sf)}px ${Math.round(12 * sf)}px`,
          borderRadius: Math.round(4 * sf),
          flex: 1
        }}
      >
        <div
          style={{
            color: '#FFFFFF',
            fontFamily: '"Anton", "Arial Black", sans-serif',
            fontSize: Math.round(18 * sf),
            letterSpacing: `${0.8 * sf}px`
          }}
        >
          {primaryText}
        </div>
      </div>

      <div
        style={{
          color: '#E4E4E7',
          fontFamily: '"Anton", sans-serif',
          fontSize: Math.round(14 * sf),
          letterSpacing: `${1 * sf}px`
        }}
      >
        VS
      </div>

      <div
        style={{
          background: 'rgba(59, 130, 246, 0.2)',
          borderLeft: `${Math.round(4 * sf)}px solid #3B82F6`,
          padding: `${Math.round(8 * sf)}px ${Math.round(12 * sf)}px`,
          borderRadius: Math.round(4 * sf),
          flex: 1
        }}
      >
        <div
          style={{
            color: '#FFFFFF',
            fontFamily: '"Anton", "Arial Black", sans-serif',
            fontSize: Math.round(18 * sf),
            letterSpacing: `${0.8 * sf}px`
          }}
        >
          {secondaryText?.replace(/^VS\.?\s*/i, '') || 'ALTERNATIVE'}
        </div>
      </div>
    </div>
  )
}
