import React, { useState } from 'react'
import type { AutoPipelineState, PipelineStage, StageStatus } from '../../../../shared/types'

export type UiPhaseId = 'prepare' | 'visuals' | 'audio' | 'build' | 'final-check'

export interface UiPhaseMeta {
  id: UiPhaseId
  phaseNumber: number
  title: string
  icon: string
  stages: { key: PipelineStage; title: string; pageName: string }[]
}

export const UI_PHASES: UiPhaseMeta[] = [
  {
    id: 'prepare',
    phaseNumber: 1,
    title: 'Phase 1 — Prepare',
    icon: '📝',
    stages: [
      { key: 'validating', title: 'Validate Inputs', pageName: 'input' },
      { key: 'transcribing', title: 'Transcription', pageName: 'transcribe' },
      { key: 'planning', title: 'AI Planning', pageName: 'planning' },
      { key: 'captions', title: 'Dynamic Captions', pageName: 'captions' }
    ]
  },
  {
    id: 'visuals',
    phaseNumber: 2,
    title: 'Phase 2 — Find Visuals',
    icon: '🎬',
    stages: [
      { key: 'global-context', title: 'Global Visual Context', pageName: 'stock' },
      { key: 'stock-search', title: 'Stock Search & Ranking', pageName: 'stock' }
    ]
  },
  {
    id: 'audio',
    phaseNumber: 3,
    title: 'Phase 3 — Add Audio',
    icon: '🎵',
    stages: [
      { key: 'audio-search', title: 'Background Music & SFX', pageName: 'audio' }
    ]
  },
  {
    id: 'build',
    phaseNumber: 4,
    title: 'Phase 4 — Build Video',
    icon: '⚙️',
    stages: [
      { key: 'preflight', title: 'Render Preflight QA', pageName: 'render' },
      { key: 'rendering', title: 'Rendering Video', pageName: 'render' }
    ]
  },
  {
    id: 'final-check',
    phaseNumber: 5,
    title: 'Phase 5 — Final Check',
    icon: '🛡️',
    stages: [
      { key: 'postflight', title: 'Postflight QA', pageName: 'render' }
    ]
  }
]

export type UiPhaseStatus = 'pending' | 'running' | 'completed' | 'warning' | 'failed' | 'interrupted'

export function computePhaseState(
  phase: UiPhaseMeta,
  pipelineState: AutoPipelineState | null
): {
  status: UiPhaseStatus
  progress: number
  durationMs: number
  summary: string
  activeStage?: PipelineStage
} {
  if (!pipelineState) {
    return {
      status: 'pending',
      progress: 0,
      durationMs: 0,
      summary: 'Pending pipeline start'
    }
  }

  const { stages, currentStage, overallStatus } = pipelineState
  const stageKeys = phase.stages.map((s) => s.key)

  let totalDuration = 0
  let completedCount = 0
  let progressAccumulator = 0
  let isCurrentPhase = false
  let activeStageKey: PipelineStage | undefined
  let phaseHasFailure = false
  let phaseHasWarning = false
  let phaseHasInterrupted = false

  for (const sk of stageKeys) {
    const sData = stages[sk]
    if (sData?.durationMs) {
      totalDuration += sData.durationMs
    }

    const sStatus: StageStatus = sData?.status ?? 'pending'
    const sProgress = sData?.progress ?? 0

    if (sStatus === 'completed') {
      completedCount++
      progressAccumulator += 1
    } else if (sStatus === 'running' || (currentStage === sk && overallStatus === 'running')) {
      isCurrentPhase = true
      activeStageKey = sk
      progressAccumulator += sProgress
    } else if (sStatus === 'failed') {
      phaseHasFailure = true
      activeStageKey = sk
    } else if (sStatus === 'warning') {
      phaseHasWarning = true
    } else if (sStatus === 'interrupted') {
      phaseHasInterrupted = true
    }

    if (currentStage === sk) {
      activeStageKey = sk
      if (overallStatus === 'running') isCurrentPhase = true
      if (overallStatus === 'failed') phaseHasFailure = true
      if (overallStatus === 'needs-attention') phaseHasWarning = true
      if (overallStatus === 'interrupted' || overallStatus === 'recovering') phaseHasInterrupted = true
    }
  }

  const progressFraction = stageKeys.length > 0 ? progressAccumulator / stageKeys.length : 0

  let status: UiPhaseStatus = 'pending'
  if (completedCount === stageKeys.length) {
    status = 'completed'
  } else if (isCurrentPhase) {
    status = 'running'
  } else if (phaseHasFailure) {
    status = 'failed'
  } else if (phaseHasWarning) {
    status = 'warning'
  } else if (phaseHasInterrupted) {
    status = 'interrupted'
  } else if (completedCount > 0) {
    status = 'pending'
  }

  // Generate clean client-friendly summary
  let summary = ''
  const activeData = activeStageKey ? stages[activeStageKey] : undefined

  if (status === 'completed') {
    switch (phase.id) {
      case 'prepare':
        summary = 'Script transcribed, chapters and scenes planned with captions'
        break
      case 'visuals':
        summary = 'Global visual context analyzed and stock footage assigned'
        break
      case 'audio':
        summary = 'Background music and sound effects matched'
        break
      case 'build':
        summary = 'Render preflight passed and video rendered'
        break
      case 'final-check':
        summary = 'Postflight quality check completed'
        break
    }
  } else if (status === 'running') {
    summary = activeData?.message || `Processing ${activeStageKey || phase.title}...`
  } else if (status === 'failed') {
    summary = activeData?.error || 'A problem occurred during this phase'
  } else if (status === 'warning') {
    summary = activeData?.message || 'Review needed before proceeding'
  } else if (status === 'interrupted') {
    summary = 'Paused — ready to resume'
  } else {
    // Pending summaries
    switch (phase.id) {
      case 'prepare':
        summary = 'Transcribes voiceover audio and generates scene plan'
        break
      case 'visuals':
        summary = 'Searches, ranks and downloads matching visual assets'
        break
      case 'audio':
        summary = 'Selects and blends background soundtrack'
        break
      case 'build':
        summary = 'Automated QA check and final video rendering'
        break
      case 'final-check':
        summary = 'Final output verification and validation'
        break
    }
  }

  return {
    status,
    progress: Math.min(1, Math.max(0, progressFraction)),
    durationMs: totalDuration,
    summary,
    activeStage: activeStageKey
  }
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return ''
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m ${remSecs}s`
}

export interface PipelinePhaseCardProps {
  phase: UiPhaseMeta
  pipelineState: AutoPipelineState | null
  isRunning: boolean
  isExpanded?: boolean
  onToggleExpand?: () => void
  onNavigateToStage?: (stage: PipelineStage) => void
  onRetryStage?: (stage: PipelineStage) => void
}

export function PipelinePhaseCard({
  phase,
  pipelineState,
  isRunning,
  isExpanded: controlledExpanded,
  onToggleExpand,
  onNavigateToStage,
  onRetryStage
}: PipelinePhaseCardProps): React.ReactElement {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const phaseState = computePhaseState(phase, pipelineState)
  const { status, progress, durationMs, summary, activeStage } = phaseState

  // If status is running, it's expanded by default if uncontrolled
  const isExpanded =
    controlledExpanded !== undefined
      ? controlledExpanded
      : status === 'running' || status === 'failed' || status === 'warning'
      ? true
      : internalExpanded

  function handleToggle(): void {
    if (onToggleExpand) {
      onToggleExpand()
    } else {
      setInternalExpanded((prev) => !prev)
    }
  }

  const statusBadge = (
    <span className={`phase-badge phase-badge--${status}`}>
      {status === 'completed' && '✓ Done'}
      {status === 'running' && '⚡ In Progress'}
      {status === 'warning' && '⚠️ Needs Attention'}
      {status === 'failed' && '✕ Failed'}
      {status === 'interrupted' && '⏸ Paused'}
      {status === 'pending' && '○ Waiting'}
    </span>
  )

  const cardModifier =
    status === 'completed'
      ? 'pipeline-phase-card--complete'
      : status === 'running'
      ? 'pipeline-phase-card--active'
      : status === 'warning' || status === 'interrupted'
      ? 'pipeline-phase-card--attention'
      : status === 'failed'
      ? 'pipeline-phase-card--failed'
      : 'pipeline-phase-card--pending'

  return (
    <div className={`pipeline-phase-card ${cardModifier} ${isExpanded ? 'is-expanded' : 'is-collapsed'}`}>
      <div
        className="pipeline-phase-card__header"
        onClick={handleToggle}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleToggle()
          }
        }}
      >
        <div className="pipeline-phase-card__icon-wrap">
          <span className="pipeline-phase-card__icon">{phase.icon}</span>
        </div>

        <div className="pipeline-phase-card__info">
          <div className="pipeline-phase-card__title-row">
            <span className="pipeline-phase-card__name">{phase.title}</span>
            {statusBadge}
            {durationMs > 0 && (
              <span className="pipeline-phase-card__duration">{formatDuration(durationMs)}</span>
            )}
          </div>
          <div className="pipeline-phase-card__summary">{summary}</div>
        </div>

        <button
          type="button"
          className="pipeline-phase-card__toggle-btn"
          aria-label={isExpanded ? 'Collapse phase details' : 'Expand phase details'}
        >
          <svg
            className={`collapsible-chevron ${isExpanded ? 'rotate-180' : ''}`}
            width="16"
            height="16"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {/* Progress Bar when Running */}
      {status === 'running' && (
        <div className="pipeline-phase-card__progress">
          <div className="progress-bar-wrap" style={{ height: '6px' }}>
            <div
              className="progress-bar-fill"
              style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}
            />
          </div>
        </div>
      )}

      {/* Expanded Technical Details */}
      {isExpanded && (
        <div className="pipeline-phase-card__details">
          <div className="pipeline-phase-card__stages-list">
            {phase.stages.map((stg) => {
              const stageData = pipelineState?.stages[stg.key]
              const stgStatus = stageData?.status ?? 'pending'
              const isCurrent = activeStage === stg.key && isRunning

              return (
                <div
                  key={stg.key}
                  className={`pipeline-substage-item ${isCurrent ? 'is-current' : ''} ${stgStatus}`}
                >
                  <div className="pipeline-substage-left">
                    <span className="pipeline-substage-status">
                      {stgStatus === 'completed' && <span style={{ color: 'var(--color-success)' }}>✓</span>}
                      {stgStatus === 'running' && (
                        <span
                          style={{
                            display: 'inline-block',
                            width: 10,
                            height: 10,
                            border: '2px solid rgba(139,92,246,0.3)',
                            borderTopColor: 'var(--brand-primary)',
                            borderRadius: '50%',
                            animation: 'spin 1s linear infinite'
                          }}
                        />
                      )}
                      {stgStatus === 'failed' && <span style={{ color: 'var(--color-error)' }}>✕</span>}
                      {stgStatus === 'warning' && <span style={{ color: 'var(--color-warning)' }}>⚠️</span>}
                      {stgStatus === 'interrupted' && <span style={{ color: 'var(--color-warning)' }}>⏸</span>}
                      {stgStatus === 'pending' && <span style={{ color: 'var(--text-disabled)' }}>○</span>}
                    </span>
                    <span className="pipeline-substage-title">{stg.title}</span>
                    {stageData?.durationMs ? (
                      <span className="pipeline-substage-dur">
                        {formatDuration(stageData.durationMs)}
                      </span>
                    ) : null}
                  </div>

                  <div className="pipeline-substage-right">
                    {stageData?.message && (
                      <span className="pipeline-substage-msg" title={stageData.message}>
                        {stageData.message}
                      </span>
                    )}

                    {onNavigateToStage && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ fontSize: '11px', padding: '2px 8px' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          onNavigateToStage(stg.key)
                        }}
                      >
                        Inspect
                      </button>
                    )}

                    {onRetryStage && stgStatus === 'failed' && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        style={{ fontSize: '11px', padding: '2px 8px' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          onRetryStage(stg.key)
                        }}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
