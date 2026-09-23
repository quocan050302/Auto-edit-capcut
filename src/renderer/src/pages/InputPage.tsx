import React from 'react'
import type { ProjectState, ProjectInputs } from '../../../../shared/types'

interface InputPageProps {
  project: ProjectState
  onUpdateInputs: (inputs: Partial<ProjectInputs>) => Promise<void>
  onScanMedia: () => Promise<void>
  isScanning: boolean
}

interface FileRowProps {
  label: string
  description: string
  value: string | null
  icon: string
  onSelect: () => void
  onClear?: () => void
  accept?: string
  disabled?: boolean
}

function FileRow({
  label,
  description,
  value,
  icon,
  onSelect,
  onClear,
  disabled
}: FileRowProps): React.ReactElement {
  return (
    <div className="file-input-row">
      <div className={`file-input-icon ${value ? 'set' : ''}`}>
        <span style={{ fontSize: '16px' }}>{icon}</span>
      </div>
      <div className="file-input-info">
        <div className="file-input-label">{label}</div>
        {value ? (
          <div className="file-input-path" title={value}>
            {value.length > 60 ? `...${value.slice(-57)}` : value}
          </div>
        ) : (
          <div className="file-input-path placeholder">{description}</div>
        )}
      </div>
      <button
        className="btn btn-secondary btn-sm"
        onClick={onSelect}
        disabled={disabled}
        id={`btn-select-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        {value ? 'Change' : 'Select'}
      </button>
      {value && onClear && (
        <button
          className="btn btn-sm"
          onClick={onClear}
          disabled={disabled}
          title={`Clear ${label}`}
          style={{
            background: 'rgba(248,113,113,0.1)',
            border: '1px solid rgba(248,113,113,0.3)',
            color: '#f87171',
            padding: '4px 8px',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            flexShrink: 0,
            fontSize: '13px',
            lineHeight: 1
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.25)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.1)')}
          id={`btn-clear-${label.toLowerCase().replace(/\s+/g, '-')}`}
        >
          🗑
        </button>
      )}
      {value && (
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--color-success)',
            flexShrink: 0
          }}
        />
      )}
    </div>
  )
}

export function InputPage({
  project,
  onUpdateInputs,
  onScanMedia,
  isScanning
}: InputPageProps): React.ReactElement {
  const { inputs } = project

  async function selectScript(): Promise<void> {
    const path = await window.api.selectFile({
      title: 'Select Script File',
      filters: [
        { name: 'Script Files', extensions: ['txt', 'md', 'docx', 'rtf'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (path) await onUpdateInputs({ scriptPath: path })
  }

  async function selectVoiceover(): Promise<void> {
    const path = await window.api.selectFile({
      title: 'Select Voice-over Audio',
      filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'] }]
    })
    if (path) await onUpdateInputs({ voiceoverPath: path })
  }

  async function selectFolder(
    key: keyof Pick<ProjectInputs, 'imagesFolder' | 'videosFolder' | 'musicFolder' | 'sfxFolder'>,
    title: string
  ): Promise<void> {
    const path = await window.api.selectFolder({ title })
    if (path) await onUpdateInputs({ [key]: path })
  }

  const allRequiredSet = inputs.voiceoverPath !== null

  const scanCount = [inputs.imagesFolder, inputs.videosFolder].filter(Boolean).length

  return (
    <div className="page-container">
      {/* Required Inputs */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
              </svg>
            </div>
            Source Files
          </div>
          <span className="panel-badge badge-new">Required</span>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <FileRow
            label="Script"
            description="Select narration script (.txt, .md, .docx)"
            value={inputs.scriptPath}
            icon="📄"
            onSelect={selectScript}
            onClear={() => onUpdateInputs({ scriptPath: null })}
          />
          <FileRow
            label="Voiceover"
            description="Select voice-over audio file (.wav, .mp3, .m4a)"
            value={inputs.voiceoverPath}
            icon="🎙️"
            onSelect={selectVoiceover}
            onClear={() => onUpdateInputs({ voiceoverPath: null })}
          />
        </div>
      </div>

      {/* Media Folders */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              </svg>
            </div>
            Media Library
          </div>
          {scanCount > 0 && (
            <span className="panel-badge badge-success">{scanCount} folder{scanCount > 1 ? 's' : ''} set</span>
          )}
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <FileRow
            label="Images"
            description="Folder containing images (.jpg, .png, .webp...)"
            value={inputs.imagesFolder}
            icon="🖼️"
            onSelect={() => selectFolder('imagesFolder', 'Select Images Folder')}
            onClear={() => onUpdateInputs({ imagesFolder: null })}
          />
          <FileRow
            label="Videos"
            description="Folder containing video footage (.mp4, .mov, .avi...)"
            value={inputs.videosFolder}
            icon="🎥"
            onSelect={() => selectFolder('videosFolder', 'Select Videos Folder')}
            onClear={() => onUpdateInputs({ videosFolder: null })}
          />
          <FileRow
            label="Music"
            description="Folder containing background music (optional)"
            value={inputs.musicFolder}
            icon="🎵"
            onSelect={() => selectFolder('musicFolder', 'Select Music Folder')}
            onClear={() => onUpdateInputs({ musicFolder: null })}
          />
          <FileRow
            label="SFX"
            description="Folder containing sound effects (optional)"
            value={inputs.sfxFolder}
            icon="🔊"
            onSelect={() => selectFolder('sfxFolder', 'Select SFX Folder')}
            onClear={() => onUpdateInputs({ sfxFolder: null })}
          />
        </div>
      </div>

      {/* Scan action */}
      <div
        className="panel"
        style={{
          background: 'var(--brand-gradient-subtle)',
          border: '1px solid var(--border-brand)'
        }}
      >
        <div className="panel-body">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '16px'
            }}
          >
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                Analyze Project
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {!allRequiredSet
                  ? 'Select a voice-over file to enable analysis'
                  : 'Scan media folders and extract metadata'}
              </div>
            </div>
            <button
              className="btn btn-primary"
              onClick={onScanMedia}
              disabled={!allRequiredSet || isScanning || (!inputs.imagesFolder && !inputs.videosFolder)}
              id="btn-analyze-project"
            >
              {isScanning ? (
                <>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    style={{ animation: 'spin 1s linear infinite' }}
                  >
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                    <path d="M12 2a10 10 0 0110 10" strokeLinecap="round" />
                  </svg>
                  Scanning...
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clipRule="evenodd" />
                  </svg>
                  Analyze Project
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Current stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value accent">{project.stats.totalImages}</div>
          <div className="stat-label">Images</div>
        </div>
        <div className="stat-card">
          <div className="stat-value accent">{project.stats.totalVideos}</div>
          <div className="stat-label">Videos</div>
        </div>
        <div className="stat-card">
          <div className="stat-value accent">{project.stats.totalMusic}</div>
          <div className="stat-label">Music Tracks</div>
        </div>
        <div className="stat-card">
          <div className="stat-value accent">{project.stats.totalSfx}</div>
          <div className="stat-label">SFX</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{project.stats.estimatedScenes || '—'}</div>
          <div className="stat-label">Est. Scenes</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{project.stats.estimatedChapters || '—'}</div>
          <div className="stat-label">Est. Chapters</div>
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
