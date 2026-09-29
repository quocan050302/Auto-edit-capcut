import React, { useState, useEffect, useRef } from 'react'
import type { ProjectState, ProjectInputs, PipelineStage } from '../../../../shared/types'
import { usePipeline } from '../hooks/usePipeline'
import { PipelineTimeline } from '../components/PipelineTimeline'

interface InputPageProps {
  project: ProjectState
  onUpdateInputs: (inputs: Partial<ProjectInputs>) => Promise<void>
  onScanMedia: () => Promise<void>
  isScanning: boolean
  onNavigate?: (page: string) => void
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
  isScanning,
  onNavigate
}: InputPageProps): React.ReactElement {
  const { inputs } = project

  // Mode: 'manual' (default) hoặc 'auto'
  const [workflowMode, setWorkflowMode] = useState<'manual' | 'auto'>('manual')

  // Auto Pipeline Options
  const [whisperModel, setWhisperModel] = useState<'tiny' | 'base' | 'small' | 'medium'>('base')
  const [requireBgMusic, setRequireBgMusic] = useState(false)
  const [autoStartOnReady, setAutoStartOnReady] = useState(false)

  // Pipeline hook
  const {
    pipelineState,
    isRunning,
    startPipeline,
    resumePipeline,
    cancelPipeline,
    retryStage
  } = usePipeline(project.projectDir)

  // Auto-start tracking ref to prevent duplicate triggers on React re-render
  const lastAutoStartedFingerprintRef = useRef<string | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track input alterations while pipeline is running
  const runningInputsSnapshotRef = useRef<{ script: string | null; voiceover: string | null } | null>(null)

  useEffect(() => {
    if (isRunning && !runningInputsSnapshotRef.current) {
      runningInputsSnapshotRef.current = {
        script: inputs.scriptPath,
        voiceover: inputs.voiceoverPath
      }
    } else if (!isRunning) {
      runningInputsSnapshotRef.current = null
    }
  }, [isRunning, inputs.scriptPath, inputs.voiceoverPath])

  const inputChangedWhileRunning =
    isRunning &&
    runningInputsSnapshotRef.current !== null &&
    (runningInputsSnapshotRef.current.script !== inputs.scriptPath ||
      runningInputsSnapshotRef.current.voiceover !== inputs.voiceoverPath)

  const isAutoReady = !!(inputs.scriptPath && inputs.voiceoverPath)

  // Auto-start trigger with debounce and fingerprint guard
  useEffect(() => {
    if (workflowMode !== 'auto' || !autoStartOnReady || !isAutoReady || isRunning) {
      return
    }

    const currentFp = `${inputs.scriptPath}:${inputs.voiceoverPath}`
    if (lastAutoStartedFingerprintRef.current === currentFp) {
      return
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    debounceTimerRef.current = setTimeout(() => {
      if (lastAutoStartedFingerprintRef.current !== currentFp && !isRunning) {
        lastAutoStartedFingerprintRef.current = currentFp
        handleStartAutoPipeline()
      }
    }, 800)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [workflowMode, autoStartOnReady, isAutoReady, inputs.scriptPath, inputs.voiceoverPath, isRunning])

  async function handleStartAutoPipeline(): Promise<void> {
    if (!inputs.scriptPath || !inputs.voiceoverPath) return
    await startPipeline({
      projectDir: project.projectDir,
      scriptPath: inputs.scriptPath,
      voiceoverPath: inputs.voiceoverPath,
      whisperModel,
      requireBackgroundMusic: requireBgMusic,
      autoStartOnReady
    })
  }

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

  const allRequiredSetManual = inputs.voiceoverPath !== null
  const scanCount = [inputs.imagesFolder, inputs.videosFolder].filter(Boolean).length

  function handleNavigateToStage(stage: PipelineStage): void {
    const stageToPage: Partial<Record<PipelineStage, string>> = {
      transcribing: 'transcribe',
      planning: 'planning',
      captions: 'captions',
      'global-context': 'stock',
      'stock-search': 'stock',
      'audio-search': 'audio',
      preflight: 'render',
      rendering: 'render',
      postflight: 'render',
      completed: 'render'
    }
    const targetPage = stageToPage[stage] || 'input'
    if (onNavigate) {
      onNavigate(targetPage)
    }
  }

  return (
    <div className="page-container">
      {/* Workflow Mode Selector */}
      <div
        className="panel"
        style={{
          background: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          marginBottom: '16px'
        }}
      >
        <div
          className="panel-body"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px'
          }}
        >
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
              Workflow Mode
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              {workflowMode === 'manual'
                ? 'Manual mode: Inspect and run each production step individually'
                : 'Auto Production: Fully autonomous end-to-end documentary video generation'}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              background: 'rgba(255, 255, 255, 0.06)',
              borderRadius: 'var(--radius-sm, 6px)',
              padding: '3px',
              gap: '4px'
            }}
          >
            <button
              type="button"
              className={`btn btn-sm ${workflowMode === 'manual' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setWorkflowMode('manual')}
              id="btn-mode-manual"
              style={{ padding: '6px 14px' }}
            >
              Manual
            </button>
            <button
              type="button"
              className={`btn btn-sm ${workflowMode === 'auto' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setWorkflowMode('auto')}
              id="btn-mode-auto"
              style={{ padding: '6px 14px' }}
            >
              ⚡ Auto Production
            </button>
          </div>
        </div>
      </div>

      {/* Input changed warning while pipeline running */}
      {inputChangedWhileRunning && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 'var(--radius-sm, 6px)',
            background: 'rgba(245, 158, 11, 0.15)',
            border: '1px solid rgba(245, 158, 11, 0.4)',
            color: '#fbbf24',
            fontSize: '13px',
            marginBottom: '16px'
          }}
        >
          ⚠️ <strong>Input files changed while pipeline is running:</strong> New files will not take effect until current pipeline is cancelled or restarted.
        </div>
      )}

      {/* Required Source Files */}
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
          <span className="panel-badge badge-new">
            {workflowMode === 'auto' ? 'Required for Auto Flow' : 'Required'}
          </span>
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
            Media Library {workflowMode === 'auto' ? '(Optional)' : ''}
          </div>
          {scanCount > 0 && (
            <span className="panel-badge badge-success">{scanCount} folder{scanCount > 1 ? 's' : ''} set</span>
          )}
          {workflowMode === 'auto' && scanCount === 0 && (
            <span className="panel-badge badge-secondary" style={{ fontSize: '11px' }}>
              Stock will auto-download
            </span>
          )}
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <FileRow
            label="Images"
            description={workflowMode === 'auto' ? 'Optional local images folder' : 'Folder containing images (.jpg, .png, .webp...)'}
            value={inputs.imagesFolder}
            icon="🖼️"
            onSelect={() => selectFolder('imagesFolder', 'Select Images Folder')}
            onClear={() => onUpdateInputs({ imagesFolder: null })}
          />
          <FileRow
            label="Videos"
            description={workflowMode === 'auto' ? 'Optional local video footage folder' : 'Folder containing video footage (.mp4, .mov, .avi...)'}
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

      {/* AUTO PRODUCTION CONTROLS & OPTIONS */}
      {workflowMode === 'auto' && (
        <div
          className="panel"
          style={{
            background: 'var(--brand-gradient-subtle)',
            border: '1px solid var(--border-brand)'
          }}
        >
          <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="panel-title">
              ⚡ Auto Production Engine
            </div>
            {isAutoReady && (
              <span className="panel-badge badge-success">
                Ready for Auto Production
              </span>
            )}
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Options grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                  Whisper Model
                </label>
                <select
                  value={whisperModel}
                  onChange={(e) => setWhisperModel(e.target.value as 'tiny' | 'base' | 'small' | 'medium')}
                  className="input-select"
                  style={{ width: '100%', padding: '6px 10px', background: 'rgba(0,0,0,0.4)', color: '#fff', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)' }}
                  disabled={isRunning}
                >
                  <option value="tiny">Tiny (fastest)</option>
                  <option value="base">Base (recommended)</option>
                  <option value="small">Small (high accuracy)</option>
                  <option value="medium">Medium (best accuracy)</option>
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '8px' }}>
                <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={requireBgMusic}
                    onChange={(e) => setRequireBgMusic(e.target.checked)}
                    disabled={isRunning}
                  />
                  <span>Require Background Music (block if none found)</span>
                </label>

                <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={autoStartOnReady}
                    onChange={(e) => setAutoStartOnReady(e.target.checked)}
                    disabled={isRunning}
                  />
                  <span>Start automatically when required inputs are ready</span>
                </label>
              </div>
            </div>

            {/* Launch bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: '10px',
                borderTop: '1px solid rgba(255,255,255,0.08)'
              }}
            >
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {!isAutoReady
                  ? 'Select both Script and Voiceover audio above to enable Auto Production'
                  : isRunning
                  ? 'Pipeline is currently executing autonomously...'
                  : 'All prerequisites met. Click to run the entire pipeline from start to finish.'}
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                {isRunning ? (
                  <button
                    className="btn btn-secondary"
                    onClick={cancelPipeline}
                    style={{ borderColor: '#ef4444', color: '#ef4444' }}
                    id="btn-cancel-auto-pipeline"
                  >
                    Cancel Run
                  </button>
                ) : (
                  <button
                    className="btn btn-primary"
                    onClick={handleStartAutoPipeline}
                    disabled={!isAutoReady || isRunning}
                    id="btn-start-auto-production"
                    style={{ padding: '8px 20px', fontWeight: 600 }}
                  >
                    ⚡ Start Auto Production
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MANUAL MODE: Existing Analyze Project action panel (preserved 100%) */}
      {workflowMode === 'manual' && (
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
                  {!allRequiredSetManual
                    ? 'Select a voice-over file to enable analysis'
                    : 'Scan media folders and extract metadata'}
                </div>
              </div>
              <button
                className="btn btn-primary"
                onClick={onScanMedia}
                disabled={!allRequiredSetManual || isScanning || (!inputs.imagesFolder && !inputs.videosFolder)}
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
      )}

      {/* PIPELINE PROGRESS TIMELINE */}
      {pipelineState && (
        <PipelineTimeline
          pipelineState={pipelineState}
          isRunning={isRunning}
          onCancel={cancelPipeline}
          onResume={resumePipeline}
          onRetryStage={retryStage}
          onNavigateToStage={handleNavigateToStage}
        />
      )}

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
