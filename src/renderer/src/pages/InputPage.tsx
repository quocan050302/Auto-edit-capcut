import React, { useState, useEffect, useRef } from 'react'
import type { ProjectState, ProjectInputs, PipelineStage } from '../../../../shared/types'
import { usePipeline } from '../hooks/usePipeline'
import { useUiPreferences } from '../hooks/useUiPreferences'
import { PipelineTimeline } from '../components/PipelineTimeline'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { getPageForPipelineStage } from '../navigation/pipelineStageNavigation'
import { ThumbnailInputAutomationCard } from '../components/thumbnail/ThumbnailInputAutomationCard'

export interface InputPageProps {
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
  disabled?: boolean
}

function getBasename(filePath: string | null): string {
  if (!filePath) return ''
  return filePath.split(/[/\\]/).pop() || filePath
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
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={onSelect}
        disabled={disabled}
        id={`btn-select-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        {value ? 'Change' : 'Select'}
      </button>
      {value && onClear && (
        <button
          type="button"
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
  const { isSimpleMode, setInterfaceMode } = useUiPreferences()

  // Mode: 'manual' (default) hoặc 'auto'
  const [workflowMode, setWorkflowMode] = useState<'manual' | 'auto'>('auto')

  // Auto Pipeline Options
  const [whisperModel, setWhisperModel] = useState<'tiny' | 'base' | 'small' | 'medium'>('base')
  const [requireBgMusic, setRequireBgMusic] = useState(false)
  const [autoStartOnReady, setAutoStartOnReady] = useState(false)
  const [isStarting, setIsStarting] = useState(false)

  // Remove confirmation while running
  const [confirmRemoveTarget, setConfirmRemoveTarget] = useState<'script' | 'voiceover' | null>(null)
  const [showCancelPipelineDialog, setShowCancelPipelineDialog] = useState(false)

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
    if (!inputs.scriptPath || !inputs.voiceoverPath || isRunning || isStarting) return
    setIsStarting(true)
    try {
      const ok = await startPipeline({
        projectDir: project.projectDir,
        scriptPath: inputs.scriptPath,
        voiceoverPath: inputs.voiceoverPath,
        whisperModel,
        requireBackgroundMusic: requireBgMusic,
        autoStartOnReady
      })
      if (ok && onNavigate && isSimpleMode) {
        onNavigate('production')
      }
    } finally {
      setIsStarting(false)
    }
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

  function handleRequestClearInput(target: 'script' | 'voiceover'): void {
    if (isRunning) {
      setConfirmRemoveTarget(target)
    } else {
      if (target === 'script') onUpdateInputs({ scriptPath: null })
      if (target === 'voiceover') onUpdateInputs({ voiceoverPath: null })
    }
  }

  async function handleConfirmRemove(): Promise<void> {
    if (confirmRemoveTarget === 'script') {
      await onUpdateInputs({ scriptPath: null })
    } else if (confirmRemoveTarget === 'voiceover') {
      await onUpdateInputs({ voiceoverPath: null })
    }
    setConfirmRemoveTarget(null)
  }

  const allRequiredSetManual = inputs.voiceoverPath !== null
  const scanCount = [inputs.imagesFolder, inputs.videosFolder, inputs.musicFolder, inputs.sfxFolder].filter(Boolean).length

  function handleNavigateToStage(stage: PipelineStage): void {
    if (onNavigate) {
      onNavigate(getPageForPipelineStage(stage))
    }
  }

  function handleSwitchToManual(): void {
    setWorkflowMode('manual')
    setInterfaceMode('advanced')
  }

  /* ─────────────────────────────────────────────────────────────
     SIMPLE MODE UI (Client-Friendly)
     ───────────────────────────────────────────────────────────── */
  if (isSimpleMode) {
    return (
      <div className="page-container setup-page-shell">
        {/* Header */}
        <div className="setup-header">
          <h1 className="setup-header__title">Setup your video</h1>
          <p className="setup-header__subtitle">
            Add your script and voiceover. The app will handle planning, stock footage, captions, music and rendering.
          </p>
        </div>

        {/* Input changed alert while running */}
        {inputChangedWhileRunning && (
          <div className="status-banner status-banner--warning">
            <div className="status-banner__icon"><span>⚠️</span></div>
            <div className="status-banner__content">
              <div className="status-banner__title">Input files changed while running</div>
              <div className="status-banner__message">
                New files will not take effect until current pipeline is cancelled or restarted.
              </div>
            </div>
          </div>
        )}

        {/* Required Inputs Section */}
        <div className="setup-section">
          <div className="setup-section__header">
            <div>
              <h2 className="setup-section__title">Required Inputs</h2>
              <p className="setup-section__desc">
                {isAutoReady
                  ? 'Ready to create video'
                  : 'Add a script and voiceover to continue'}
              </p>
            </div>
            <span className={`panel-badge ${isAutoReady ? 'badge-success' : 'badge-secondary'}`}>
              {isAutoReady ? '✓ Ready to create video' : 'Inputs needed'}
            </span>
          </div>

          <div className="required-input-grid">
            {/* Script Card */}
            <div className={`required-input-card ${inputs.scriptPath ? 'is-ready' : 'is-missing'}`}>
              <div className="required-input-card__icon-col">
                <div className="required-input-card__icon">
                  <svg width="24" height="24" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
                  </svg>
                </div>
              </div>

              <div className="required-input-card__main">
                <div className="required-input-card__type">Script File</div>
                <div className="required-input-card__name" title={inputs.scriptPath ?? undefined}>
                  {inputs.scriptPath ? getBasename(inputs.scriptPath) : 'No script selected'}
                </div>
                <div className="required-input-card__format">
                  Supports .txt, .md, .docx, .rtf
                </div>
              </div>

              <div className="required-input-card__actions">
                <span className={`status-pill ${inputs.scriptPath ? 'status-pill--ready' : 'status-pill--missing'}`}>
                  {inputs.scriptPath ? 'Ready' : 'Missing'}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={selectScript}
                  disabled={isRunning}
                  id="btn-select-script"
                >
                  {inputs.scriptPath ? 'Replace' : 'Browse'}
                </button>
                {inputs.scriptPath && (
                  <button
                    type="button"
                    className="btn btn-icon btn-sm"
                    onClick={() => handleRequestClearInput('script')}
                    title="Remove script"
                    aria-label="Remove script"
                    style={{ color: '#f87171' }}
                  >
                    🗑
                  </button>
                )}
              </div>
            </div>

            {/* Voiceover Card */}
            <div className={`required-input-card ${inputs.voiceoverPath ? 'is-ready' : 'is-missing'}`}>
              <div className="required-input-card__icon-col">
                <div className="required-input-card__icon">
                  <svg width="24" height="24" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
                  </svg>
                </div>
              </div>

              <div className="required-input-card__main">
                <div className="required-input-card__type">Voiceover Audio</div>
                <div className="required-input-card__name" title={inputs.voiceoverPath ?? undefined}>
                  {inputs.voiceoverPath ? getBasename(inputs.voiceoverPath) : 'No audio selected'}
                </div>
                <div className="required-input-card__format">
                  Supports .wav, .mp3, .m4a, .aac, .flac
                </div>
              </div>

              <div className="required-input-card__actions">
                <span className={`status-pill ${inputs.voiceoverPath ? 'status-pill--ready' : 'status-pill--missing'}`}>
                  {inputs.voiceoverPath ? 'Ready' : 'Missing'}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={selectVoiceover}
                  disabled={isRunning}
                  id="btn-select-voiceover"
                >
                  {inputs.voiceoverPath ? 'Replace' : 'Browse'}
                </button>
                {inputs.voiceoverPath && (
                  <button
                    type="button"
                    className="btn btn-icon btn-sm"
                    onClick={() => handleRequestClearInput('voiceover')}
                    title="Remove voiceover"
                    aria-label="Remove voiceover"
                    style={{ color: '#f87171' }}
                  >
                    🗑
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Optional Media Assets Accordion */}
        <CollapsibleSection
          title="Optional media and brand assets"
          subtitle="Connect local asset folders if you have custom footage, logos or soundtracks."
          summaryWhenClosed={
            scanCount === 0
              ? 'No custom assets — stock media will be downloaded automatically'
              : `${scanCount} custom media folder${scanCount > 1 ? 's' : ''} connected`
          }
          icon={<span>📁</span>}
          defaultOpen={false}
          className="optional-assets-section"
        >
          <div className="setup-folder-list">
            <FileRow
              label="Custom Images"
              description="Optional folder containing brand images (.jpg, .png, .webp)"
              value={inputs.imagesFolder}
              icon="🖼️"
              onSelect={() => selectFolder('imagesFolder', 'Select Images Folder')}
              onClear={() => onUpdateInputs({ imagesFolder: null })}
              disabled={isRunning}
            />
            <FileRow
              label="Custom Videos"
              description="Optional folder containing video footage (.mp4, .mov, .avi)"
              value={inputs.videosFolder}
              icon="🎥"
              onSelect={() => selectFolder('videosFolder', 'Select Videos Folder')}
              onClear={() => onUpdateInputs({ videosFolder: null })}
              disabled={isRunning}
            />
            <FileRow
              label="Custom Music"
              description="Optional folder containing background tracks (.mp3, .wav)"
              value={inputs.musicFolder}
              icon="🎵"
              onSelect={() => selectFolder('musicFolder', 'Select Music Folder')}
              onClear={() => onUpdateInputs({ musicFolder: null })}
              disabled={isRunning}
            />
            <FileRow
              label="Sound Effects (SFX)"
              description="Optional folder containing audio effects"
              value={inputs.sfxFolder}
              icon="🔊"
              onSelect={() => selectFolder('sfxFolder', 'Select SFX Folder')}
              onClear={() => onUpdateInputs({ sfxFolder: null })}
              disabled={isRunning}
            />
          </div>
        </CollapsibleSection>

        {/* Advanced Production Options Accordion */}
        <CollapsibleSection
          title="Advanced production options"
          subtitle="Model parameters and pipeline execution preferences."
          summaryWhenClosed="Recommended settings (Base Whisper model, automatic stock & music)"
          icon={<span>⚙️</span>}
          defaultOpen={false}
          className="advanced-options-section"
        >
          <div className="advanced-options-grid">
            <div>
              <label className="settings-label">Whisper Speech-to-Text Model</label>
              <select
                value={whisperModel}
                onChange={(e) => setWhisperModel(e.target.value as typeof whisperModel)}
                className="input-select"
                disabled={isRunning}
              >
                <option value="tiny">Tiny (fastest, lower precision)</option>
                <option value="base">Base (recommended standard)</option>
                <option value="small">Small (high accuracy)</option>
                <option value="medium">Medium (best accuracy)</option>
              </select>
            </div>

            <div className="flex flex-col gap-2 justify-center">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={requireBgMusic}
                  onChange={(e) => setRequireBgMusic(e.target.checked)}
                  disabled={isRunning}
                />
                <span>Require Background Music (block if none found)</span>
              </label>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoStartOnReady}
                  onChange={(e) => setAutoStartOnReady(e.target.checked)}
                  disabled={isRunning}
                />
                <span>Auto-start when inputs are ready</span>
              </label>
            </div>
          </div>
        </CollapsibleSection>

        {/* Thumbnail Automation Card */}
        <div style={{ marginTop: '20px' }}>
          <ThumbnailInputAutomationCard
            projectDir={project.projectDir}
            onManageLibrary={() => onNavigate?.('thumbnail-library')}
            disabled={isRunning}
          />
        </div>

        {/* Sticky Action Bar */}
        <div className="sticky-action-bar">
          <div className="sticky-action-bar__info">
            <div className="sticky-action-bar__title">
              {isAutoReady ? 'Ready to create' : 'Select a script and voiceover to continue'}
            </div>
            <div className="sticky-action-bar__subtitle">
              {isAutoReady
                ? 'All prerequisites met. Click to generate the complete video.'
                : 'Both a narration script and audio voiceover are required for Auto Production.'}
            </div>
          </div>

          <div className="sticky-action-bar__actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleSwitchToManual}
              disabled={isRunning}
            >
              Run steps manually
            </button>

            {isRunning ? (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ color: '#ef4444', borderColor: '#ef4444' }}
                onClick={() => setShowCancelPipelineDialog(true)}
                id="btn-cancel-auto-pipeline"
              >
                Cancel Run
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={handleStartAutoPipeline}
                disabled={!isAutoReady || isRunning || isStarting}
                id="btn-start-auto-production"
                style={{ minHeight: '44px', padding: '0 24px', fontWeight: 700 }}
              >
                {isStarting ? 'Starting Pipeline...' : '⚡ Start Auto Production'}
              </button>
            )}
          </div>
        </div>

        {/* Remove Confirmation Dialog */}
        <ConfirmDialog
          isOpen={confirmRemoveTarget !== null}
          title="Remove Input File?"
          message="The pipeline is currently running. Removing this file will invalidate current production progress."
          confirmText="Yes, Remove File"
          cancelText="Keep File"
          isDestructive={true}
          onConfirm={handleConfirmRemove}
          onCancel={() => setConfirmRemoveTarget(null)}
        />

        {/* Cancel Pipeline Confirmation Dialog */}
        <ConfirmDialog
          isOpen={showCancelPipelineDialog}
          title="Cancel Pipeline?"
          message="Are you sure you want to stop the running video production? All completed stages will be saved so you can resume."
          confirmText="Yes, Cancel"
          cancelText="Continue Pipeline"
          isDestructive={true}
          onConfirm={async () => {
            setShowCancelPipelineDialog(false)
            await cancelPipeline()
          }}
          onCancel={() => setShowCancelPipelineDialog(false)}
        />
      </div>
    )
  }

  /* ─────────────────────────────────────────────────────────────
     ADVANCED MODE UI (Full Original Navigation & Controls)
     ───────────────────────────────────────────────────────────── */
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
            onClear={() => handleRequestClearInput('script')}
          />
          <FileRow
            label="Voiceover"
            description="Select voice-over audio file (.wav, .mp3, .m4a)"
            value={inputs.voiceoverPath}
            icon="🎙️"
            onSelect={selectVoiceover}
            onClear={() => handleRequestClearInput('voiceover')}
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
                  onChange={(e) => setWhisperModel(e.target.value as typeof whisperModel)}
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
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setShowCancelPipelineDialog(true)}
                    style={{ borderColor: '#ef4444', color: '#ef4444' }}
                    id="btn-cancel-auto-pipeline"
                  >
                    Cancel Run
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleStartAutoPipeline}
                    disabled={!isAutoReady || isRunning || isStarting}
                    id="btn-start-auto-production"
                    style={{ padding: '8px 20px', fontWeight: 600 }}
                  >
                    {isStarting ? 'Starting...' : '⚡ Start Auto Production'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Thumbnail Automation Card */}
      <div style={{ marginTop: '20px' }}>
        <ThumbnailInputAutomationCard
          projectDir={project.projectDir}
          onManageLibrary={() => onNavigate?.('thumbnail-library')}
          disabled={isRunning}
        />
      </div>

      {/* MANUAL MODE: Existing Analyze Project action panel */}
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
                type="button"
                className="btn btn-primary"
                onClick={onScanMedia}
                disabled={!allRequiredSetManual || isScanning || (!inputs.imagesFolder && !inputs.videosFolder)}
                id="btn-analyze-project"
              >
                {isScanning ? 'Scanning...' : 'Analyze Project'}
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
          onCancel={() => setShowCancelPipelineDialog(true)}
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

      {/* Confirm Dialogs */}
      <ConfirmDialog
        isOpen={confirmRemoveTarget !== null}
        title="Remove Input File?"
        message="The pipeline is currently running. Removing this file will invalidate current production progress."
        confirmText="Yes, Remove File"
        cancelText="Keep File"
        isDestructive={true}
        onConfirm={handleConfirmRemove}
        onCancel={() => setConfirmRemoveTarget(null)}
      />

      <ConfirmDialog
        isOpen={showCancelPipelineDialog}
        title="Cancel Pipeline?"
        message="Are you sure you want to stop the running video production? All completed stages will be saved so you can resume."
        confirmText="Yes, Cancel"
        cancelText="Continue Pipeline"
        isDestructive={true}
        onConfirm={async () => {
          setShowCancelPipelineDialog(false)
          await cancelPipeline()
        }}
        onCancel={() => setShowCancelPipelineDialog(false)}
      />
    </div>
  )
}
