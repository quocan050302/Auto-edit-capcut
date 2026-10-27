import React from 'react'
import type { VideoAssemblyMode, BackgroundMusicMode, ShortClipPolicy } from '../../../../shared/types'
import { MusicModeControls } from './MusicModeControls'

export interface AssemblyModeControlsProps {
  assemblyMode: VideoAssemblyMode
  backgroundMusicMode: BackgroundMusicMode
  shortClipPolicy?: ShortClipPolicy
  sceneFolder?: string
  disabled?: boolean
  saving?: boolean
  error?: string | null
  onAssemblyModeChange: (mode: VideoAssemblyMode) => void
  onMusicModeChange: (mode: BackgroundMusicMode) => void
  onSelectSceneFolder?: () => Promise<void>
  onClearSceneFolder?: () => void
  idSuffix?: string
}

export function AssemblyModeControls({
  assemblyMode,
  backgroundMusicMode,
  sceneFolder,
  disabled = false,
  saving = false,
  error = null,
  onAssemblyModeChange,
  onMusicModeChange,
  onSelectSceneFolder,
  onClearSceneFolder,
  idSuffix = ''
}: AssemblyModeControlsProps): React.ReactElement {
  const isSimpleAssembly = assemblyMode === 'simple-assembly'

  return (
    <div
      id={`production-mode-setup-controls${idSuffix}`}
      style={{
        marginTop: '12px',
        padding: '16px',
        borderRadius: 'var(--radius-lg, 12px)',
        border: '1px solid rgba(14, 165, 233, 0.28)',
        background: 'linear-gradient(135deg, rgba(14, 165, 233, 0.06), rgba(99, 102, 241, 0.04))',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.02em' }}>
            ⚡ PRODUCTION &amp; AUDIO CONTROLS
          </span>
          {saving && (
            <span style={{ fontSize: '11px', color: 'var(--color-brand, #818cf8)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <span className="spinner-sm" style={{ width: '10px', height: '10px' }} /> Saving...
            </span>
          )}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
          Step 2 Output &amp; Assembly Strategy
        </div>
      </div>

      {/* Error banner if save or load failed */}
      {error && (
        <div
          id={`production-mode-error${idSuffix}`}
          style={{
            padding: '8px 12px',
            borderRadius: '6px',
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#f87171',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <span>⚠️ {error}</span>
        </div>
      )}

      {/* AUDIO SETTINGS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
          AUDIO SETTINGS
        </div>
        <MusicModeControls
          mode={backgroundMusicMode}
          disabled={disabled}
          onChange={onMusicModeChange}
          idSuffix={idSuffix}
        />
      </div>

      <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.08)', margin: '4px 0' }} />

      {/* VIDEO ASSEMBLY MODE */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
              VIDEO ASSEMBLY MODE
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              Choose between full smart production and lightweight direct scene concatenation.
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px' }}>
          {/* Full Production Card */}
          <div
            id={`assembly-mode-full-card${idSuffix}`}
            onClick={() => !disabled && onAssemblyModeChange('full-production')}
            style={{
              padding: '12px',
              borderRadius: '8px',
              border: `2px solid ${!isSimpleAssembly ? '#818cf8' : 'rgba(255, 255, 255, 0.08)'}`,
              background: !isSimpleAssembly ? 'rgba(99, 102, 241, 0.12)' : 'rgba(0, 0, 0, 0.2)',
              cursor: disabled ? 'default' : 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              transition: 'all 0.2s ease'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: !isSimpleAssembly ? '#c7d2fe' : 'var(--text-primary)' }}>
                🚀 Full Production
              </span>
              {!isSimpleAssembly && (
                <span style={{ fontSize: '10px', background: '#4f46e5', color: '#fff', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>
                  ACTIVE
                </span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              Smart editing, AI Planning, Retention, Transitions, Dynamic Captions, Remotion, and visual enhancement overlays.
            </div>
          </div>

          {/* Simple Assembly Card */}
          <div
            id={`assembly-mode-simple-card${idSuffix}`}
            onClick={() => !disabled && onAssemblyModeChange('simple-assembly')}
            style={{
              padding: '12px',
              borderRadius: '8px',
              border: `2px solid ${isSimpleAssembly ? '#38bdf8' : 'rgba(255, 255, 255, 0.08)'}`,
              background: isSimpleAssembly ? 'rgba(14, 165, 233, 0.12)' : 'rgba(0, 0, 0, 0.2)',
              cursor: disabled ? 'default' : 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              transition: 'all 0.2s ease'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: isSimpleAssembly ? '#bae6fd' : 'var(--text-primary)' }}>
                ⚡ Simple Assembly
              </span>
              {isSimpleAssembly && (
                <span style={{ fontSize: '10px', background: '#0284c7', color: '#fff', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>
                  ACTIVE
                </span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              Imported scenes + Input Voiceover → MP4. Preserves source visuals with hard cuts. Zero Remotion, captions, or creative re-editing.
            </div>
          </div>
        </div>

        {/* Simple Assembly Extra Configuration */}
        {isSimpleAssembly && (
          <div
            id={`simple-assembly-options${idSuffix}`}
            style={{
              marginTop: '4px',
              padding: '10px 12px',
              borderRadius: '8px',
              background: 'rgba(0, 0, 0, 0.25)',
              border: '1px solid rgba(56, 189, 248, 0.2)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#38bdf8' }}>
              Simple Assembly Media Source:
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                {sceneFolder ? (
                  <span>
                    Direct Scene Folder: <strong style={{ color: 'var(--text-primary)' }}>{sceneFolder.split(/[/\\]/).pop()}</strong>
                  </span>
                ) : (
                  <span>
                    Using project imported scenes (<strong style={{ color: 'var(--text-primary)' }}>Edit Plan / Manual AI Assets</strong>)
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {onSelectSceneFolder && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: '11px', padding: '3px 8px' }}
                    onClick={() => void onSelectSceneFolder()}
                    disabled={disabled}
                  >
                    📁 {sceneFolder ? 'Change Scene Folder' : 'Select Scene Video Folder'}
                  </button>
                )}
                {sceneFolder && onClearSceneFolder && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: '11px', padding: '3px 8px', color: '#f87171' }}
                    onClick={onClearSceneFolder}
                    disabled={disabled}
                    title="Revert to project imported scenes"
                  >
                    Use Project Scenes
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MODE SUMMARY */}
      <div
        id={`production-mode-summary${idSuffix}`}
        style={{
          marginTop: '4px',
          padding: '10px 14px',
          borderRadius: '6px',
          background: 'rgba(0, 0, 0, 0.3)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px'
        }}
      >
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Mode Summary
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11px' }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '4px',
              background: isSimpleAssembly ? 'rgba(56, 189, 248, 0.2)' : 'rgba(99, 102, 241, 0.2)',
              color: isSimpleAssembly ? '#38bdf8' : '#a5b4fc',
              fontWeight: 600
            }}
          >
            Assembly: {isSimpleAssembly ? 'Simple' : 'Full Production'}
          </span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '4px',
              background: backgroundMusicMode === 'auto' ? 'rgba(163, 230, 53, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              color: backgroundMusicMode === 'auto' ? '#a3e635' : '#fca5a5',
              fontWeight: 600
            }}
          >
            Music: {backgroundMusicMode === 'auto' ? 'On (Auto)' : 'Off (None)'}
          </span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '4px',
              background: 'rgba(255, 255, 255, 0.06)',
              color: 'var(--text-primary)'
            }}
          >
            Voiceover: Included
          </span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '4px',
              background: isSimpleAssembly ? 'rgba(255, 255, 255, 0.05)' : 'rgba(168, 85, 247, 0.15)',
              color: isSimpleAssembly ? 'var(--text-secondary)' : '#c084fc'
            }}
          >
            Captions: {isSimpleAssembly ? 'Off' : 'On (Remotion)'}
          </span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '4px',
              background: isSimpleAssembly ? 'rgba(255, 255, 255, 0.05)' : 'rgba(56, 189, 248, 0.15)',
              color: isSimpleAssembly ? 'var(--text-secondary)' : '#38bdf8'
            }}
          >
            Transitions: {isSimpleAssembly ? 'Off (Hard Cuts)' : 'On'}
          </span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '4px',
              background: isSimpleAssembly ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
              color: isSimpleAssembly ? '#34d399' : '#fbbf24',
              fontWeight: 600
            }}
          >
            Remotion: {isSimpleAssembly ? 'Not Used (0 RAM)' : 'Full Compositor'}
          </span>
        </div>
      </div>
    </div>
  )
}
