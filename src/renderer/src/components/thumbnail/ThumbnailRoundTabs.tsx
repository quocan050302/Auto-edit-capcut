import React from 'react'

interface ThumbnailRoundTabsProps {
  currentRound: number
  totalRounds: number
  activeRound: number
  onSelectRound: (round: number) => void
}

export const ThumbnailRoundTabs: React.FC<ThumbnailRoundTabsProps> = ({
  totalRounds,
  activeRound,
  onSelectRound
}) => {
  const rounds = Array.from({ length: Math.max(1, totalRounds) }, (_, i) => i + 1)

  if (rounds.length <= 1) {
    return null
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
      <span style={{ fontSize: '13px', color: '#9ca3af', fontWeight: 500 }}>Generation Rounds:</span>
      <div style={{ display: 'flex', gap: '6px' }}>
        {rounds.map((r) => {
          const isActive = r === activeRound
          return (
            <button
              key={r}
              onClick={() => onSelectRound(r)}
              style={{
                padding: '4px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: isActive ? 600 : 400,
                background: isActive ? '#3b82f6' : 'rgba(255, 255, 255, 0.05)',
                color: isActive ? '#ffffff' : '#d1d5db',
                border: isActive ? '1px solid #60a5fa' : '1px solid rgba(255, 255, 255, 0.1)',
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
            >
              Round {r}
            </button>
          )
        })}
      </div>
    </div>
  )
}
