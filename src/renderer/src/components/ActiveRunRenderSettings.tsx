import React, { useState, useEffect, useRef } from 'react'
import {
  getActiveRunRenderSettings,
  isLiveRenderModeSwitchEligible,
  resolveVideoAssemblyMode,
  resolveBackgroundMusicMode,
  type AutoPipelineState,
  type ActiveRunRenderSettings as ActiveRunRenderSettingsDTO,
  type VideoAssemblyMode,
  type BackgroundMusicMode,
  type UpdateFinalRenderOptionsResult
} from '../../../../shared/types'

export const SIMPLE_ASSEMBLY_EXPLANATION =
  'All intelligent production stages remain unchanged. Only the final render joins the completed scenes with voiceover, using hard cuts and no Remotion overlays.'

export const NO_MUSIC_EXPLANATION =
  'The final MP4 will contain the input voiceover without background music. In Simple Assembly, no additional SFX will be added.'

export const PRESERVED_PRODUCTION_ITEMS: readonly string[] = [
  'AI Planning',
  'Visual Director',
  'Prompt Packs',
  'Stock Assignments',
  'Imported Scenes',
  'Scene Readiness',
  'Current Run'
] as const

export function resolveActiveRunEffectiveSettings(
  pipelineState?: AutoPipelineState | null
): ActiveRunRenderSettingsDTO {
  if (pipelineState?.renderSettings) {
    return {
      assemblyMode: resolveVideoAssemblyMode(pipelineState.renderSettings.assemblyMode),
      backgroundMusicMode: resolveBackgroundMusicMode(pipelineState.renderSettings.backgroundMusicMode)
    }
  }
  return getActiveRunRenderSettings(pipelineState?.options)
}

export function formatAssemblyModeLabel(mode: VideoAssemblyMode): string {
  return mode === 'simple-assembly' ? 'Simple Assembly' : 'Full Smart Render'
}

export function formatMusicModeLabel(mode: BackgroundMusicMode): string {
  return mode === 'off' ? 'No Music' : 'Add Music'
}

export function computeWillChangeSummary(
  current: ActiveRunRenderSettingsDTO,
  draft: ActiveRunRenderSettingsDTO
): string[] {
  const changes: string[] = []
  if (current.assemblyMode !== draft.assemblyMode) {
    changes.push('Final Rendering Strategy')
  }
  if (current.backgroundMusicMode !== draft.backgroundMusicMode) {
    changes.push('Background Music')
  }
  if (changes.length === 0) {
    changes.push('Final Rendering Strategy (No change from current run)')
  }
  return changes
}

export interface ActiveRunRenderSettingsProps {
  projectDir?: string | null
  pipelineState: AutoPipelineState | null
  onUpdateFinalRenderOptions?: (params: {
    assemblyMode: VideoAssemblyMode
    backgroundMusicMode: BackgroundMusicMode
    runId?: string
    expectedStateVersion?: number
  }) => Promise<UpdateFinalRenderOptionsResult>
}

export function ActiveRunRenderSettings({
  projectDir,
  pipelineState,
  onUpdateFinalRenderOptions
}: ActiveRunRenderSettingsProps): React.ReactElement | null {
  // Only render when there is an active or persisted pipeline run state
  if (!pipelineState || !pipelineState.runId) {
    return null
  }

  const effectiveSettings = resolveActiveRunEffectiveSettings(pipelineState)
  const isEligibleForLiveSwitch = isLiveRenderModeSwitchEligible(pipelineState)
  const waitInfo = pipelineState.stages?.['stock-search']?.manualAiWait

  const [isModalOpen, setIsModalOpen] = useState(false)
  const [draftAssemblyMode, setDraftAssemblyMode] = useState<VideoAssemblyMode>(
    effectiveSettings.assemblyMode
  )
  const [draftMusicMode, setDraftMusicMode] = useState<BackgroundMusicMode>(
    effectiveSettings.backgroundMusicMode
  )
  const [isSaving, setIsSaving] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [appliedNotice, setAppliedNotice] = useState<string | null>(null)
  const isSubmittingRef = useRef(false)

  // Keep modal draft initialized to the active run's effective settings when opening
  useEffect(() => {
    if (!isModalOpen) {
      setDraftAssemblyMode(effectiveSettings.assemblyMode)
      setDraftMusicMode(effectiveSettings.backgroundMusicMode)
    }
  }, [isModalOpen, effectiveSettings.assemblyMode, effectiveSettings.backgroundMusicMode])

  // Clear applied notice if run changes
  useEffect(() => {
    setAppliedNotice(null)
  }, [pipelineState.runId])

  const handleOpenModal = (): void => {
    const latest = resolveActiveRunEffectiveSettings(pipelineState)
    setDraftAssemblyMode(latest.assemblyMode)
    setDraftMusicMode(latest.backgroundMusicMode)
    setModalError(null)
    setIsModalOpen(true)
  }

  const handleCancelModal = (): void => {
    if (isSaving) return
    const latest = resolveActiveRunEffectiveSettings(pipelineState)
    setDraftAssemblyMode(latest.assemblyMode)
    setDraftMusicMode(latest.backgroundMusicMode)
    setModalError(null)
    setIsModalOpen(false)
  }

  const handleApplyToCurrentRun = async (): Promise<void> => {
    if (isSaving || isSubmittingRef.current) return
    isSubmittingRef.current = true
    setIsSaving(true)
    setModalError(null)
    setAppliedNotice(null)

    try {
      let result: UpdateFinalRenderOptionsResult
      if (onUpdateFinalRenderOptions) {
        result = await onUpdateFinalRenderOptions({
          assemblyMode: draftAssemblyMode,
          backgroundMusicMode: draftMusicMode,
          runId: pipelineState.runId
        })
      } else {
        const targetDir = projectDir || pipelineState.projectDir
        result = await window.api.pipeline.updateFinalRenderOptions({
          projectDir: targetDir,
          runId: pipelineState.runId,
          assemblyMode: draftAssemblyMode,
          backgroundMusicMode: draftMusicMode
        })
      }

      if (result.success && result.appliedToActiveRun) {
        const appliedAssembly = result.effectiveAssemblyMode ?? draftAssemblyMode
        const appliedMusic = result.effectiveBackgroundMusicMode ?? draftMusicMode
        setDraftAssemblyMode(appliedAssembly)
        setDraftMusicMode(appliedMusic)
        setAppliedNotice(
          `Applied to current run: ${formatAssemblyModeLabel(appliedAssembly)} + ${formatMusicModeLabel(appliedMusic)}`
        )
        setIsModalOpen(false)
      } else {
        // Keep modal open on rejection and sync draft to actual backend effective mode if returned
        if (result.effectiveAssemblyMode) {
          setDraftAssemblyMode(result.effectiveAssemblyMode)
        }
        if (result.effectiveBackgroundMusicMode) {
          setDraftMusicMode(result.effectiveBackgroundMusicMode)
        }
        setModalError(
          result.error ||
            'Could not update Final Render Mode for the current run. The safe waiting window may have closed.'
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setModalError(msg || 'Unexpected error while updating Final Render Mode.')
    } finally {
      isSubmittingRef.current = false
      setIsSaving(false)
    }
  }

  const currentLabel = `${formatAssemblyModeLabel(effectiveSettings.assemblyMode)} + ${formatMusicModeLabel(
    effectiveSettings.backgroundMusicMode
  )}`
  const draftLabel = `${formatAssemblyModeLabel(draftAssemblyMode)} + ${formatMusicModeLabel(
    draftMusicMode
  )}`
  const willChangeItems = computeWillChangeSummary(effectiveSettings, {
    assemblyMode: draftAssemblyMode,
    backgroundMusicMode: draftMusicMode
  })

  return (
    <div
      data-testid="active-run-render-settings"
      style={{
        background: '#16162a',
        border: isEligibleForLiveSwitch ? '1px solid #3d3d6b' : '1px solid #2b2b44',
        borderRadius: 10,
        padding: '14px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 10
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: '#a29bfe'
              }}
            >
              FINAL RENDER SETTINGS
            </span>
            {isEligibleForLiveSwitch && waitInfo ? (
              <span
                data-testid="active-run-waiting-badge"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'rgba(108, 92, 231, 0.18)',
                  color: '#c8c3ff',
                  border: '1px solid rgba(108, 92, 231, 0.38)'
                }}
              >
                AI Assets {waitInfo.ready} / {waitInfo.expected} Ready — Waiting for{' '}
                {Math.max(0, waitInfo.expected - waitInfo.ready)} remaining scenes
              </span>
            ) : (
              <span
                data-testid="active-run-readonly-badge"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: '#222238',
                  color: '#8e8ea8',
                  border: '1px solid #32324e'
                }}
              >
                Read-only for current stage
              </span>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              flexWrap: 'wrap',
              fontSize: 13,
              color: '#e0e0f0',
              marginTop: 2
            }}
          >
            <div>
              <span style={{ color: '#8e8ea8', marginRight: 6 }}>Current Run:</span>
              <strong data-testid="active-run-assembly-mode-badge" style={{ color: '#fff' }}>
                {formatAssemblyModeLabel(effectiveSettings.assemblyMode)}
              </strong>
            </div>
            <div>
              <span style={{ color: '#8e8ea8', marginRight: 6 }}>Background Music:</span>
              <strong data-testid="active-run-music-mode-badge" style={{ color: '#fff' }}>
                {formatMusicModeLabel(effectiveSettings.backgroundMusicMode)}
              </strong>
            </div>
          </div>
        </div>

        {isEligibleForLiveSwitch && (
          <button
            type="button"
            data-testid="change-final-render-mode-btn"
            onClick={handleOpenModal}
            style={{
              padding: '8px 14px',
              background: '#262645',
              color: '#e6e4ff',
              border: '1px solid #5849c4',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <span>⚙</span>
            <span>Change Final Render Mode</span>
          </button>
        )}
      </div>

      {appliedNotice && (
        <div
          data-testid="active-run-applied-notice"
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            background: 'rgba(0, 184, 148, 0.14)',
            border: '1px solid rgba(0, 184, 148, 0.4)',
            color: '#55efc4',
            fontSize: 12,
            fontWeight: 600
          }}
        >
          ✓ {appliedNotice}
        </div>
      )}

      {isModalOpen && (
        <div
          data-testid="change-final-render-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="change-final-render-modal-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(8, 8, 16, 0.76)',
            zIndex: 1200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 540,
              background: '#19192d',
              border: '1px solid #3f3f68',
              borderRadius: 12,
              padding: 22,
              color: '#eaeaff',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              boxShadow: '0 20px 50px rgba(0,0,0,0.6)'
            }}
          >
            <div>
              <h3
                id="change-final-render-modal-title"
                style={{
                  margin: 0,
                  fontSize: 15,
                  fontWeight: 800,
                  letterSpacing: '0.04em',
                  color: '#fff'
                }}
              >
                CHANGE FINAL RENDER SETTINGS
              </h3>
              <p style={{ margin: '6px 0 0 0', fontSize: 12, color: '#b4b4d0', lineHeight: 1.5 }}>
                This change applies to the current Production run. All completed AI Planning,
                prompts, scene assignments and imported assets will be preserved.
              </p>
            </div>

            {/* Final Renderer Radio Selection */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#c8c8e6' }}>Final Renderer</div>

              <label
                data-testid="radio-assembly-full"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border:
                    draftAssemblyMode === 'full-production'
                      ? '1px solid #6c5ce7'
                      : '1px solid #2e2e4d',
                  background:
                    draftAssemblyMode === 'full-production'
                      ? 'rgba(108, 92, 231, 0.14)'
                      : '#141424',
                  cursor: isSaving ? 'not-allowed' : 'pointer'
                }}
              >
                <input
                  type="radio"
                  name="active-run-assembly-mode"
                  value="full-production"
                  checked={draftAssemblyMode === 'full-production'}
                  disabled={isSaving}
                  onChange={() => setDraftAssemblyMode('full-production')}
                  style={{ marginTop: 2 }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
                    Full Smart Render
                  </span>
                  <span style={{ fontSize: 11.5, color: '#9c9cb8', lineHeight: 1.4 }}>
                    Uses the full intelligent renderer with configured motion, transitions and
                    caption/overlay policies.
                  </span>
                </div>
              </label>

              <label
                data-testid="radio-assembly-simple"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border:
                    draftAssemblyMode === 'simple-assembly'
                      ? '1px solid #6c5ce7'
                      : '1px solid #2e2e4d',
                  background:
                    draftAssemblyMode === 'simple-assembly'
                      ? 'rgba(108, 92, 231, 0.14)'
                      : '#141424',
                  cursor: isSaving ? 'not-allowed' : 'pointer'
                }}
              >
                <input
                  type="radio"
                  name="active-run-assembly-mode"
                  value="simple-assembly"
                  checked={draftAssemblyMode === 'simple-assembly'}
                  disabled={isSaving}
                  onChange={() => setDraftAssemblyMode('simple-assembly')}
                  style={{ marginTop: 2 }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
                    Simple Assembly
                  </span>
                  <span style={{ fontSize: 11.5, color: '#9c9cb8', lineHeight: 1.4 }}>
                    {SIMPLE_ASSEMBLY_EXPLANATION}
                  </span>
                </div>
              </label>
            </div>

            {/* Background Music Radio Selection */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#c8c8e6' }}>
                Background Music
              </div>

              <label
                data-testid="radio-music-auto"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border:
                    draftMusicMode === 'auto' ? '1px solid #6c5ce7' : '1px solid #2e2e4d',
                  background:
                    draftMusicMode === 'auto' ? 'rgba(108, 92, 231, 0.14)' : '#141424',
                  cursor: isSaving ? 'not-allowed' : 'pointer'
                }}
              >
                <input
                  type="radio"
                  name="active-run-music-mode"
                  value="auto"
                  checked={draftMusicMode === 'auto'}
                  disabled={isSaving}
                  onChange={() => setDraftMusicMode('auto')}
                  style={{ marginTop: 2 }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Add Music</span>
                  <span style={{ fontSize: 11.5, color: '#9c9cb8', lineHeight: 1.4 }}>
                    Automatically selects and mixes background music for the final render.
                  </span>
                </div>
              </label>

              <label
                data-testid="radio-music-off"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border:
                    draftMusicMode === 'off' ? '1px solid #6c5ce7' : '1px solid #2e2e4d',
                  background:
                    draftMusicMode === 'off' ? 'rgba(108, 92, 231, 0.14)' : '#141424',
                  cursor: isSaving ? 'not-allowed' : 'pointer'
                }}
              >
                <input
                  type="radio"
                  name="active-run-music-mode"
                  value="off"
                  checked={draftMusicMode === 'off'}
                  disabled={isSaving}
                  onChange={() => setDraftMusicMode('off')}
                  style={{ marginTop: 2 }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>No Music</span>
                  <span style={{ fontSize: 11.5, color: '#9c9cb8', lineHeight: 1.4 }}>
                    {NO_MUSIC_EXPLANATION}
                  </span>
                </div>
              </label>
            </div>

            {/* Confirmation Summary */}
            <div
              data-testid="modal-confirmation-summary"
              style={{
                background: '#121222',
                border: '1px solid #2c2c4a',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 8
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: '#8e8ea8' }}>Current:</span>
                <strong data-testid="summary-current-mode" style={{ color: '#d0d0e8' }}>
                  {currentLabel}
                </strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: '#8e8ea8' }}>New:</span>
                <strong data-testid="summary-new-mode" style={{ color: '#a29bfe' }}>
                  {draftLabel}
                </strong>
              </div>
              <div
                style={{
                  borderTop: '1px solid #252540',
                  paddingTop: 8,
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 10
                }}
              >
                <div>
                  <div style={{ color: '#55efc4', fontWeight: 700, marginBottom: 4 }}>
                    Will be preserved:
                  </div>
                  <div style={{ color: '#b8b8d0', fontSize: 11.5, lineHeight: 1.45 }}>
                    {PRESERVED_PRODUCTION_ITEMS.join(' • ')}
                  </div>
                </div>
                <div>
                  <div style={{ color: '#ffeaa7', fontWeight: 700, marginBottom: 4 }}>
                    Will change:
                  </div>
                  <div style={{ color: '#b8b8d0', fontSize: 11.5, lineHeight: 1.45 }}>
                    {willChangeItems.join(' • ')}
                  </div>
                </div>
              </div>
            </div>

            {modalError && (
              <div
                data-testid="modal-error-banner"
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'rgba(214, 48, 49, 0.16)',
                  border: '1px solid rgba(214, 48, 49, 0.48)',
                  color: '#ff7675',
                  fontSize: 12,
                  whiteSpace: 'pre-line',
                  lineHeight: 1.45
                }}
              >
                {modalError}
              </div>
            )}

            {/* Confirmation Controls */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                data-testid="modal-cancel-btn"
                disabled={isSaving}
                onClick={handleCancelModal}
                style={{
                  padding: '8px 16px',
                  background: 'transparent',
                  color: '#b8b8d0',
                  border: '1px solid #3a3a5c',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: isSaving ? 'not-allowed' : 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="modal-apply-btn"
                disabled={isSaving}
                onClick={() => void handleApplyToCurrentRun()}
                style={{
                  padding: '8px 16px',
                  background: isSaving ? '#483d8b' : '#6c5ce7',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: isSaving ? 'not-allowed' : 'pointer'
                }}
              >
                {isSaving ? 'Applying...' : 'Apply to Current Run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

