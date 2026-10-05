import React, { useState, useEffect, useRef } from 'react'
import type {
  ProjectState,
  ProjectInputs,
  PipelineStage,
  ContentType,
  ContentProfileMode,
  VisualSourceMode,
  VisualMixConfig,
  AiImageOutputResolution
} from '../../../../shared/types'
import {
  resolveVisualMixConfig,
  resolveContentProfileMode,
  HEALTH_RECOMMENDED_VISUAL_MIX_CONFIG,
  GENERAL_RECOMMENDED_CUSTOM_MIX_CONFIG
} from '../../../../shared/types'
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

interface VisualSourceSectionProps {
  isCustomMix: boolean
  currentAiPercent: number
  currentStockPercent: number
  imageOutputResolution?: AiImageOutputResolution
  flowHealth: { reachable?: boolean; extensionConnected?: boolean; checking?: boolean }
  isRunning: boolean
  onSelectMode: (mode: VisualSourceMode) => void
  onSetAiRatio: (ai: number) => void
  onSetStockRatio: (stock: number) => void
  onSelectResolution?: (res: AiImageOutputResolution) => void
  isAdvanced?: boolean
}

function VisualSourceSection({
  isCustomMix,
  currentAiPercent,
  currentStockPercent,
  imageOutputResolution = '1080p',
  flowHealth,
  isRunning,
  onSelectMode,
  onSetAiRatio,
  onSetStockRatio,
  onSelectResolution,
  isAdvanced
}: VisualSourceSectionProps): React.ReactElement {
  const containerClass = isAdvanced ? 'panel' : 'setup-section'
  const idSuffix = isAdvanced ? '-adv' : ''

  return (
    <div className={containerClass} style={{ marginBottom: '16px' }}>
      <div className={isAdvanced ? 'panel-header' : 'setup-section__header'}>
        <div>
          <h2 className={isAdvanced ? 'panel-title' : 'setup-section__title'}>Visual Source</h2>
          <p
            className={isAdvanced ? '' : 'setup-section__desc'}
            style={isAdvanced ? { fontSize: '12px', color: 'var(--text-secondary)' } : undefined}
          >
            Choose where scene visuals come from — standard stock or AI-generated visual mix
          </p>
        </div>
        <span className="panel-badge badge-primary">
          {isCustomMix ? 'Custom Mix' : 'Default Workflow'}
        </span>
      </div>

      <div className={isAdvanced ? 'panel-body' : ''}>
        <div className="content-type-grid" style={{ marginBottom: '12px' }}>
          <button
            type="button"
            id={`visual-mode-legacy${idSuffix}`}
            className={`content-type-card ${!isCustomMix ? 'is-selected' : ''}`}
            onClick={() => onSelectMode('legacy')}
            disabled={isRunning}
          >
            <div className="content-type-card__icon">🎞️</div>
            <div className="content-type-card__content">
              <div className="content-type-card__title">
                Default Workflow
                {!isCustomMix && (
                  <span style={{ fontSize: '11px', color: 'var(--color-brand)' }}>● Active</span>
                )}
              </div>
              <div className="content-type-card__subtitle">Stock Footage</div>
              <div className="content-type-card__desc">
                Use current stock footage production flow (Pexels / Pixabay / local assets). No Google Flow scene images.
              </div>
            </div>
          </button>

          <button
            type="button"
            id={`visual-mode-custom-mix${idSuffix}`}
            className={`content-type-card ${isCustomMix ? 'is-selected' : ''}`}
            onClick={() => onSelectMode('custom-mix')}
            disabled={isRunning}
          >
            <div className="content-type-card__icon">🎨</div>
            <div className="content-type-card__content">
              <div className="content-type-card__title">
                Custom Mix
                {isCustomMix && (
                  <span style={{ fontSize: '11px', color: 'var(--color-brand)' }}>● Active</span>
                )}
              </div>
              <div className="content-type-card__subtitle">AI Stills + Real Footage</div>
              <div className="content-type-card__desc">
                Combine AI-generated stills with real footage.
              </div>
            </div>
          </button>
        </div>

        {!isCustomMix ? (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              fontSize: '12px',
              color: 'var(--text-secondary)'
            }}
          >
            ✓ Uses existing production flow: Pexels / Pixabay / local assets. No Google Flow scene images will be generated.
          </div>
        ) : (
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 'var(--radius-md, 8px)',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                Visual Mix
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                Total: <strong>100%</strong>
              </div>
            </div>

            {/* Linked Inputs */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '16px'
              }}
            >
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm, 6px)',
                  background: 'rgba(99, 102, 241, 0.08)',
                  border: '1px solid rgba(99, 102, 241, 0.25)'
                }}
              >
                <label
                  htmlFor={`input-ai-image-ratio${idSuffix}`}
                  style={{
                    display: 'block',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: 'var(--color-brand, #818cf8)',
                    marginBottom: '4px'
                  }}
                >
                  AI Images (Google Flow)
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    id={`input-ai-image-ratio${idSuffix}`}
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    value={currentAiPercent}
                    onChange={(e) => onSetAiRatio(Number(e.target.value))}
                    disabled={isRunning}
                    style={{
                      width: '80px',
                      padding: '6px 10px',
                      borderRadius: '4px',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      background: 'rgba(0, 0, 0, 0.4)',
                      color: '#fff',
                      fontSize: '16px',
                      fontWeight: 700
                    }}
                  />
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>%</span>
                </div>
              </div>

              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm, 6px)',
                  background: 'rgba(14, 165, 233, 0.08)',
                  border: '1px solid rgba(14, 165, 233, 0.25)'
                }}
              >
                <label
                  htmlFor={`input-stock-footage-ratio${idSuffix}`}
                  style={{
                    display: 'block',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: '#38bdf8',
                    marginBottom: '4px'
                  }}
                >
                  Real Footage
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    id={`input-stock-footage-ratio${idSuffix}`}
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    value={currentStockPercent}
                    onChange={(e) => onSetStockRatio(Number(e.target.value))}
                    disabled={isRunning}
                    style={{
                      width: '80px',
                      padding: '6px 10px',
                      borderRadius: '4px',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      background: 'rgba(0, 0, 0, 0.4)',
                      color: '#fff',
                      fontSize: '16px',
                      fontWeight: 700
                    }}
                  />
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>%</span>
                </div>
              </div>
            </div>

            {/* Dual Visual Bar */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div
                style={{
                  height: '10px',
                  width: '100%',
                  borderRadius: '5px',
                  overflow: 'hidden',
                  display: 'flex',
                  background: 'rgba(255, 255, 255, 0.1)'
                }}
              >
                <div
                  style={{
                    width: `${currentAiPercent}%`,
                    background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
                    transition: 'width 0.2s ease'
                  }}
                />
                <div
                  style={{
                    width: `${currentStockPercent}%`,
                    background: 'linear-gradient(90deg, #0284c7, #0ea5e9)',
                    transition: 'width 0.2s ease'
                  }}
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '11px',
                  color: 'var(--text-secondary)'
                }}
              >
                <span>AI Images: {currentAiPercent}%</span>
                <span>Real Footage: {currentStockPercent}%</span>
              </div>
            </div>

            {/* Quick Presets */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Presets:</span>
              {[
                { label: '100 / 0', ai: 100 },
                { label: '80 / 20', ai: 80 },
                { label: '70 / 30', ai: 70 },
                { label: '50 / 50', ai: 50 },
                { label: '30 / 70', ai: 30 },
                { label: '0 / 100', ai: 0 }
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  id={`preset-${preset.ai}-${100 - preset.ai}${idSuffix}`}
                  className="btn btn-secondary btn-sm"
                  style={{
                    padding: '2px 8px',
                    fontSize: '11px',
                    background: currentAiPercent === preset.ai ? 'var(--color-brand)' : undefined,
                    color: currentAiPercent === preset.ai ? '#fff' : undefined
                  }}
                  onClick={() => onSetAiRatio(preset.ai)}
                  disabled={isRunning}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* AI Image Quality Selector (Section 12) */}
            <div style={{ marginTop: '2px', paddingTop: '8px', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                AI Image Quality:
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {(['1080p', '2k', '4k'] as const).map((res) => {
                  const isSelected = (imageOutputResolution || '1080p') === res
                  return (
                    <button
                      key={res}
                      type="button"
                      id={`quality-opt-${res}${idSuffix}`}
                      className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                      style={{
                        padding: '3px 10px',
                        fontSize: '11px',
                        fontWeight: isSelected ? 600 : 400
                      }}
                      onClick={() => onSelectResolution?.(res)}
                      disabled={isRunning}
                    >
                      {isSelected ? '● ' : ''}{res === '1080p' ? '1080p — Recommended' : res.toUpperCase()}
                    </button>
                  )
                })}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', fontStyle: 'italic' }}>
                {(imageOutputResolution || '1080p') === '1080p' && '1080p: Best for faster long-form production'}
                {(imageOutputResolution || '1080p') === '2k' && '2K: Higher-resolution still output'}
                {(imageOutputResolution || '1080p') === '4k' && '4K: Highest quality, slower generation/export'}
              </div>
            </div>

            {/* Google Flow status for Custom Mix */}
            {currentAiPercent > 0 ? (
              flowHealth.checking === false &&
              (flowHealth.reachable === false || flowHealth.extensionConnected === false) ? (
                <div
                  style={{
                    marginTop: '6px',
                    padding: '8px 12px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: 'var(--radius-sm, 6px)',
                    fontSize: '11px',
                    color: '#f87171',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px'
                  }}
                >
                  <div>
                    ⚠️ <strong>Google Flow / FlowKit is not ready:</strong> Health mode requires Google Flow / FlowKit connection. Open Google Flow in Chrome and ensure the FlowKit extension is connected.
                  </div>
                  {window.api?.thumbnail?.openFlowTab && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ flexShrink: 0, fontSize: '11px', padding: '3px 8px' }}
                      onClick={() => window.api.thumbnail.openFlowTab()}
                    >
                      Open Google Flow
                    </button>
                  )}
                </div>
              ) : (
                <div
                  style={{
                    fontSize: '11px',
                    color: 'var(--color-success, #10b981)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <span>●</span> AI Images — Google Flow: Ready
                </div>
              )
            ) : (
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                No Google Flow images required (100% stock footage).
              </div>
            )}
          </div>
        )}
      </div>
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

  // Resolve effective visual mix settings
  const effectiveMix = resolveVisualMixConfig({
    visualSourceMode: inputs.visualSourceMode,
    visualMixConfig: inputs.visualMixConfig,
    contentType: inputs.contentType
  })
  const isCustomMix = effectiveMix.mode === 'custom-mix'
  const currentAiPercent = Math.round(effectiveMix.aiImageRatio * 100)
  const currentStockPercent = 100 - currentAiPercent

  // Flow health check for Custom Mix with AI ratio > 0
  const [flowHealth, setFlowHealth] = useState<{
    reachable?: boolean
    extensionConnected?: boolean
    signedIn?: boolean
    checking?: boolean
  }>({ checking: false })

  useEffect(() => {
    let cancelled = false
    const checkFlow = async (): Promise<void> => {
      if (!isCustomMix || currentAiPercent <= 0) {
        setFlowHealth({ checking: false })
        return
      }
      try {
        setFlowHealth((prev) => ({ ...prev, checking: true }))
        const h = await window.api?.thumbnail?.checkFlowHealth?.()
        if (!cancelled && h) {
          setFlowHealth({
            reachable: Boolean(h.reachable),
            extensionConnected: Boolean(h.extensionConnected),
            signedIn: Boolean(h.signedIn),
            checking: false
          })
        }
      } catch {
        if (!cancelled) {
          setFlowHealth({ reachable: false, extensionConnected: false, checking: false })
        }
      }
    }
    checkFlow()
    return () => {
      cancelled = true
    }
  }, [isCustomMix, currentAiPercent])

  async function handleSelectContentType(type: ContentType): Promise<void> {
    if (isRunning) return
    const updates: Partial<ProjectInputs> = {
      contentType: type,
      contentProfileMode: type === 'health' ? 'health' : 'general'
    }
    await onUpdateInputs(updates)
  }

  async function handleSelectContentProfileMode(mode: ContentProfileMode): Promise<void> {
    if (isRunning) return
    const legacyType: ContentType = mode === 'health' ? 'health' : 'default'
    await onUpdateInputs({
      contentProfileMode: mode,
      contentType: legacyType
    })
  }

  async function handleSelectVisualSourceMode(mode: VisualSourceMode): Promise<void> {
    if (isRunning) return
    const baseAi = inputs.visualMixConfig?.aiImageRatio ?? (inputs.contentType === 'health' ? 0.8 : 0.5)
    const aiRatio = mode === 'legacy' ? 0 : baseAi
    const stockRatio = mode === 'legacy' ? 1 : Math.round((1 - aiRatio) * 1000) / 1000

    const nextConfig: VisualMixConfig = {
      mode,
      aiImageRatio: aiRatio,
      stockFootageRatio: stockRatio,
      imageOutputResolution: effectiveMix.imageOutputResolution,
      width: inputs.visualMixConfig?.width ?? 1920,
      height: inputs.visualMixConfig?.height ?? 1080,
      motionEnabled: inputs.visualMixConfig?.motionEnabled ?? true,
      generationConcurrency: inputs.visualMixConfig?.generationConcurrency ?? 2,
      postProcessConcurrency: inputs.visualMixConfig?.postProcessConcurrency ?? 2
    }

    await onUpdateInputs({
      visualSourceMode: mode,
      visualMixConfig: nextConfig
    })
  }

  async function handleSelectResolution(resolution: AiImageOutputResolution): Promise<void> {
    if (isRunning) return
    const nextConfig: VisualMixConfig = {
      ...effectiveMix,
      imageOutputResolution: resolution
    }
    await onUpdateInputs({
      visualMixConfig: nextConfig
    })
  }

  async function handleSetAiRatio(aiPercent: number): Promise<void> {
    if (isRunning) return
    const clampedAi = Math.max(0, Math.min(100, Math.round(isNaN(aiPercent) ? 0 : aiPercent)))
    const clampedStock = 100 - clampedAi
    const nextConfig: VisualMixConfig = {
      ...effectiveMix,
      mode: 'custom-mix',
      aiImageRatio: clampedAi / 100,
      stockFootageRatio: clampedStock / 100,
      imageOutputResolution: effectiveMix.imageOutputResolution
    }
    await onUpdateInputs({
      visualSourceMode: 'custom-mix',
      visualMixConfig: nextConfig
    })
  }

  async function handleSetStockRatio(stockPercent: number): Promise<void> {
    if (isRunning) return
    const clampedStock = Math.max(0, Math.min(100, Math.round(isNaN(stockPercent) ? 0 : stockPercent)))
    await handleSetAiRatio(100 - clampedStock)
  }

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

    const currentProfileMode = inputs.contentProfileMode ?? resolveContentProfileMode(inputs)
    const currentFp = `${inputs.scriptPath}:${inputs.voiceoverPath}:${currentProfileMode}:${effectiveMix.mode}:${effectiveMix.aiImageRatio}`
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
  }, [
    workflowMode,
    autoStartOnReady,
    isAutoReady,
    inputs.scriptPath,
    inputs.voiceoverPath,
    inputs.contentType,
    inputs.contentProfileMode,
    effectiveMix.mode,
    effectiveMix.aiImageRatio,
    isRunning
  ])

  async function handleStartAutoPipeline(): Promise<void> {
    if (!inputs.scriptPath || !inputs.voiceoverPath || isRunning || isStarting) return
    setIsStarting(true)
    try {
      const resolvedMix = resolveVisualMixConfig({
        visualSourceMode: inputs.visualSourceMode,
        visualMixConfig: inputs.visualMixConfig,
        contentType: inputs.contentType
      })
      const resolvedProfileMode = inputs.contentProfileMode ?? resolveContentProfileMode(inputs)

      console.log(
        `[Setup] Starting pipeline:\nprofileMode=${resolvedProfileMode}\nvisualSource=${resolvedMix.mode}\nAI=${Math.round(resolvedMix.aiImageRatio * 100)}%\nStock=${Math.round(resolvedMix.stockFootageRatio * 100)}%\nresolution=${resolvedMix.imageOutputResolution}`
      )

      const ok = await startPipeline({
        projectDir: project.projectDir,
        scriptPath: inputs.scriptPath,
        voiceoverPath: inputs.voiceoverPath,
        whisperModel,
        requireBackgroundMusic: requireBgMusic,
        autoStartOnReady,
        contentType: inputs.contentType ?? (resolvedProfileMode === 'health' ? 'health' : 'default'),
        contentProfileMode: resolvedProfileMode,
        visualSourceMode: resolvedMix.mode,
        visualMixConfig: resolvedMix,
        healthVisualConfig: (inputs.contentType === 'health' || resolvedProfileMode === 'health') && resolvedMix.mode === 'custom-mix' ? {
          aiRatio: resolvedMix.aiImageRatio,
          stockRatio: resolvedMix.stockFootageRatio,
          width: resolvedMix.width,
          height: resolvedMix.height,
          motionEnabled: resolvedMix.motionEnabled
        } : undefined
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

        {/* Visual Source / Mix Section */}
        <VisualSourceSection
          isCustomMix={isCustomMix}
          currentAiPercent={currentAiPercent}
          currentStockPercent={currentStockPercent}
          imageOutputResolution={effectiveMix.imageOutputResolution}
          flowHealth={flowHealth}
          isRunning={isRunning}
          onSelectMode={handleSelectVisualSourceMode}
          onSetAiRatio={handleSetAiRatio}
          onSetStockRatio={handleSetStockRatio}
          onSelectResolution={handleSelectResolution}
          isAdvanced={false}
        />

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

      {/* Content Profile Selector (Advanced Mode Override - Section 7) */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
            </div>
            Content Profile
          </div>
          <span className="panel-badge badge-primary">
            {(inputs.contentProfileMode ?? 'auto') === 'auto'
              ? 'Auto Detect'
              : inputs.contentProfileMode === 'health'
              ? 'Health (Override)'
              : 'General (Override)'}
          </span>
        </div>
        <div className="panel-body">
          <div className="content-type-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <button
              type="button"
              id="content-profile-auto-adv"
              className={`content-type-card ${(inputs.contentProfileMode ?? 'auto') === 'auto' ? 'is-selected' : ''}`}
              onClick={() => handleSelectContentProfileMode('auto')}
              disabled={isRunning}
            >
              <div className="content-type-card__icon">🤖</div>
              <div className="content-type-card__content">
                <div className="content-type-card__title">Auto Detect (Default)</div>
                <div className="content-type-card__desc">
                  Automatically detects medical vs general documentary from script
                </div>
              </div>
            </button>

            <button
              type="button"
              id="content-profile-general-adv"
              className={`content-type-card ${inputs.contentProfileMode === 'general' ? 'is-selected' : ''}`}
              onClick={() => handleSelectContentProfileMode('general')}
              disabled={isRunning}
            >
              <div className="content-type-card__icon">🎬</div>
              <div className="content-type-card__content">
                <div className="content-type-card__title">General Documentary</div>
                <div className="content-type-card__desc">
                  General documentary still prompts (no medical anatomy/SFX)
                </div>
              </div>
            </button>

            <button
              type="button"
              id="content-profile-health-adv"
              className={`content-type-card ${inputs.contentProfileMode === 'health' ? 'is-selected' : ''}`}
              onClick={() => handleSelectContentProfileMode('health')}
              disabled={isRunning}
            >
              <div className="content-type-card__icon">🩺</div>
              <div className="content-type-card__content">
                <div className="content-type-card__title">Health Explainer</div>
                <div className="content-type-card__desc">
                  Enforces anatomical realism, scientific prompts & Health SFX
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* Visual Source / Mix Section */}
      <VisualSourceSection
        isCustomMix={isCustomMix}
        currentAiPercent={currentAiPercent}
        currentStockPercent={currentStockPercent}
        imageOutputResolution={effectiveMix.imageOutputResolution}
        flowHealth={flowHealth}
        isRunning={isRunning}
        onSelectMode={handleSelectVisualSourceMode}
        onSetAiRatio={handleSetAiRatio}
        onSetStockRatio={handleSetStockRatio}
        onSelectResolution={handleSelectResolution}
        isAdvanced={true}
      />

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
