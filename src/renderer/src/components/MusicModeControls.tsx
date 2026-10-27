import React from 'react'
import type { BackgroundMusicMode } from '../../../../shared/types'

export interface MusicModeControlsProps {
  mode: BackgroundMusicMode
  disabled?: boolean
  onChange: (mode: BackgroundMusicMode) => void
  idSuffix?: string
}

export function MusicModeControls({
  mode,
  disabled = false,
  onChange,
  idSuffix = ''
}: MusicModeControlsProps): React.ReactElement {
  const isMusicOn = mode === 'auto'

  return (
    <div
      id={`music-mode-controls${idSuffix}`}
      style={{
        padding: '12px 14px',
        borderRadius: '8px',
        background: 'rgba(0, 0, 0, 0.25)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
              🎵 Background Music:
            </span>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: isMusicOn ? '#38bdf8' : '#a3e635'
              }}
            >
              {isMusicOn ? 'Add Background Music' : 'No Music (Muted/Off)'}
            </span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
            {isMusicOn
              ? 'Finds and mixes mood-appropriate background music ducked under the voiceover.'
              : 'True No Music: zero background music or soundtrack tracks will enter the final MP4.'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            id={`music-mode-auto${idSuffix}`}
            className={`btn btn-sm ${isMusicOn ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '11px', padding: '5px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}
            onClick={() => onChange('auto')}
            disabled={disabled}
          >
            <span>🎵</span> Add Background Music
          </button>
          <button
            type="button"
            id={`music-mode-off${idSuffix}`}
            className={`btn btn-sm ${!isMusicOn ? 'btn-primary' : 'btn-secondary'}`}
            style={{
              fontSize: '11px',
              padding: '5px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              background: !isMusicOn ? 'rgba(239, 68, 68, 0.2)' : undefined,
              borderColor: !isMusicOn ? '#ef4444' : undefined,
              color: !isMusicOn ? '#fca5a5' : undefined
            }}
            onClick={() => onChange('off')}
            disabled={disabled}
          >
            <span>🔇</span> No Music
          </button>
        </div>
      </div>
    </div>
  )
}
