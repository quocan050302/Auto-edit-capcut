import React, { useState, useEffect } from 'react'
import type { AutoPipelineState, PipelineStage, ProjectState } from '../../../../shared/types'
import { UI_PHASES, PipelinePhaseCard, computePhaseState, type UiPhaseId } from './PipelinePhaseCard'
import { ConfirmDialog } from './ConfirmDialog'
import { StatusBanner } from './StatusBanner'
import { PipelineTimeline } from './PipelineTimeline'
import { LivePipelineInspector } from './LivePipelineInspector'
import { getPageForPipelineStage } from '../navigation/pipelineStageNavigation'

export interface ClientPipelineDashboardProps {
  project: ProjectState
  pipelineState: AutoPipelineState | null
  isRunning: boolean
  onCancel: () => Promise<boolean>
  onResume: () => Promise<boolean>
  onRetryStage: (stage: PipelineStage) => Promise<boolean>
  onNavigate: (page: string) => void
}

function fmtStopwatch(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Tính toán elapsed time của pipeline chính xác theo accumulated duration các stage,
 * không phụ thuộc vào component mount time để không bị reset về 00:00 khi khôi phục / mở lại app.
 */
export function computePipelineElapsedMs(pipelineState: AutoPipelineState | null): number {
  if (!pipelineState) return 0

  let accumulatedMs = 0
  if (pipelineState.stages) {
    for (const stage of Object.values(pipelineState.stages)) {
      if (stage && typeof stage.durationMs === 'number' && stage.durationMs > 0) {
        accumulatedMs += stage.durationMs
      }
    }
  }

  // Nếu pipeline không running (interrupted, completed, paused, failed, idle)
  if (pipelineState.overallStatus !== 'running') {
    if (pipelineState.startedAt && pipelineState.completedAt) {
      const diff = new Date(pipelineState.completedAt).getTime() - new Date(pipelineState.startedAt).getTime()
      if (diff > 0) return Math.max(diff, accumulatedMs)
    }
    return accumulatedMs
  }

  // Nếu pipeline đang running: tính thêm thời gian của stage hiện tại đang chạy
  const currentStageKey = pipelineState.currentStage
  const currentStage = currentStageKey && pipelineState.stages ? pipelineState.stages[currentStageKey] : null

  if (currentStage?.startedAt && currentStage.status === 'running') {
    const stageElapsed = Date.now() - new Date(currentStage.startedAt).getTime()
    if (stageElapsed > 0) {
      return accumulatedMs + stageElapsed
    }
  }

  if (pipelineState.startedAt) {
    const overallElapsed = Date.now() - new Date(pipelineState.startedAt).getTime()
    if (overallElapsed > 0) {
      return Math.max(overallElapsed, accumulatedMs)
    }
  }

  return accumulatedMs
}

export function ClientPipelineDashboard({
  project,
  pipelineState,
  isRunning,
  onCancel,
  onResume,
  onRetryStage,
  onNavigate
}: ClientPipelineDashboardProps): React.ReactElement {
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false)

  // Live Inspector states
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [selectedStage, setSelectedStage] = useState<PipelineStage | null>(
    (pipelineState?.currentStage as PipelineStage) || 'validating'
  )
  const [followCurrentStage, setFollowCurrentStage] = useState(true)

  // Timer 1s chỉ dùng để refresh UI khi pipeline đang running
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => {
      setTick((t) => t + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [isRunning])

  const elapsedMs = computePipelineElapsedMs(pipelineState)
  const elapsedSecs = Math.floor(elapsedMs / 1000)

  const overallStatus = pipelineState?.overallStatus ?? 'idle'
  const isCompleted = overallStatus === 'completed'
  const isNeedsAttention = overallStatus === 'needs-attention'
  const isFailed = overallStatus === 'failed'
  const isInterrupted = overallStatus === 'interrupted' || overallStatus === 'recovering'

  // Tìm phase chứa stage
  function findPhaseForStage(stageKey?: PipelineStage): UiPhaseId {
    if (!stageKey) return 'prepare'
    for (const ph of UI_PHASES) {
      if (ph.stages.some((s) => s.key === stageKey)) {
        return ph.id
      }
    }
    return 'prepare'
  }

  // Phase accordion: current phase tự mở, completed/pending mặc định đóng, mỗi lúc chỉ mở 1 phase
  const [expandedPhaseId, setExpandedPhaseId] = useState<UiPhaseId | null>(() =>
    findPhaseForStage(pipelineState?.currentStage)
  )

  // Auto-expand current phase khi currentStage thay đổi nếu Follow live bật
  useEffect(() => {
    if (followCurrentStage && pipelineState?.currentStage) {
      const activePhase = findPhaseForStage(pipelineState.currentStage)
      setExpandedPhaseId(activePhase)
    }
  }, [pipelineState?.currentStage, followCurrentStage])

  // Follow current stage khi pipeline chuyển stage
  useEffect(() => {
    if (inspectorOpen && followCurrentStage && pipelineState?.currentStage) {
      setSelectedStage(pipelineState.currentStage)
    }
  }, [pipelineState?.currentStage, inspectorOpen, followCurrentStage])

  // Overall percentage calculation
  let overallPercentage = 0
  if (pipelineState) {
    let completedStages = 0
    let activeStageProgress = 0
    const stages = pipelineState.stages
    const allStageKeys = Object.keys(stages) as PipelineStage[]

    for (const key of allStageKeys) {
      const s = stages[key]
      if (s?.status === 'completed') {
        completedStages++
      } else if (s?.status === 'running') {
        activeStageProgress = s.progress ?? 0
      }
    }
    const totalCount = allStageKeys.length || 10
    overallPercentage = isCompleted
      ? 100
      : Math.min(99, Math.round(((completedStages + activeStageProgress) / totalCount) * 100))
  }

  // Active Phase identification
  let currentPhaseTitle = 'Phase 1 — Prepare'
  if (pipelineState) {
    for (const ph of UI_PHASES) {
      const pState = computePhaseState(ph, pipelineState)
      if (pState.status === 'running' || pState.status === 'warning' || pState.status === 'failed' || pState.status === 'interrupted') {
        currentPhaseTitle = ph.title
        break
      }
      if (pState.status === 'completed') {
        currentPhaseTitle = ph.title
      }
    }
  }

  // Current active message
  const activeMessage =
    pipelineState?.stages[pipelineState.currentStage as PipelineStage]?.message ||
    (isRunning ? 'Processing video components...' : 'Ready to start')

  const currentPhaseFriendly = currentPhaseTitle.replace(/^Phase \d+ — /, '')
  const headerTitle = isRunning
    ? 'Creating your video'
    : isInterrupted
    ? 'Production paused safely'
    : isNeedsAttention
    ? 'Video needs review'
    : isFailed
    ? 'Production stopped due to an error'
    : 'Pipeline ready'

  const headerSubtitle = isInterrupted
    ? `Previous progress was recovered. Resume to continue from ${currentPhaseFriendly}.`
    : isRunning
    ? activeMessage
    : isNeedsAttention
    ? 'One or more scenes require manual review before rendering.'
    : isFailed
    ? (pipelineState?.fatalErrors?.[pipelineState.fatalErrors.length - 1] || 'An error occurred during production.')
    : 'Ready to start production.'

  async function handleConfirmCancel(): Promise<void> {
    setShowCancelDialog(false)
    await onCancel()
  }

  function handleInspectStage(stage: PipelineStage): void {
    setSelectedStage(stage)
    if (pipelineState?.currentStage === stage) {
      setFollowCurrentStage(true)
    } else {
      setFollowCurrentStage(false)
    }
    setInspectorOpen(true)
  }

  function handleOpenTechnicalDetails(): void {
    setSelectedStage(pipelineState?.currentStage || 'validating')
    setFollowCurrentStage(true)
    setInspectorOpen(true)
  }

  function handleOpenFullWorkspace(stage: PipelineStage): void {
    const targetPage = getPageForPipelineStage(stage)
    onNavigate(targetPage)
  }

  // Success Screen
  if (isCompleted) {
    return (
      <div className="page-container client-production-page">
        <div className="success-dashboard-card">
          <div className="success-dashboard-icon">
            <svg width="40" height="40" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
          </div>

          <h2 className="success-dashboard-title">Your video is ready!</h2>
          <p className="success-dashboard-subtitle">
            The full documentary video pipeline has completed and passed final QA verification.
          </p>

          <div className="success-metrics-grid">
            <div className="metric-box">
              <span className="metric-box__label">Output Filename</span>
              <span className="metric-box__value metric-box__value--file">
                {pipelineState?.renderOutputPath?.split(/[/\\]/).pop() || 'final_output.mp4'}
              </span>
            </div>
            <div className="metric-box">
              <span className="metric-box__label">Duration</span>
              <span className="metric-box__value">{fmtStopwatch(elapsedSecs)}</span>
            </div>
            <div className="metric-box">
              <span className="metric-box__label">Resolution</span>
              <span className="metric-box__value">1920×1080 · 30fps</span>
            </div>
            <div className="metric-box">
              <span className="metric-box__label">Quality Audit</span>
              <span className="metric-box__value" style={{ color: 'var(--color-success)' }}>
                ✓ Passed
              </span>
            </div>
          </div>

          <div className="success-actions-row">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => onNavigate('render')}
            >
              ▶ Preview / Open Video
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-lg"
              onClick={() => {
                if (pipelineState?.renderOutputPath) {
                  onNavigate('render')
                }
              }}
            >
              📁 Open Export Details
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowTechnicalDetails((prev) => !prev)}
            >
              {showTechnicalDetails ? 'Hide Technical Report' : 'View Technical Report'}
            </button>
          </div>
        </div>

        {showTechnicalDetails && pipelineState && (
          <div className="mt-4">
            <PipelineTimeline
              pipelineState={pipelineState}
              isRunning={isRunning}
              onCancel={() => setShowCancelDialog(true)}
              onResume={onResume}
              onRetryStage={onRetryStage}
              onInspectStage={handleInspectStage}
              onOpenFullWorkspace={handleOpenFullWorkspace}
            />
          </div>
        )}

        {/* Live Inspector Drawer */}
        <LivePipelineInspector
          isOpen={inspectorOpen}
          pipelineState={pipelineState}
          selectedStage={selectedStage}
          followCurrentStage={followCurrentStage}
          onSelectStage={(stg) => setSelectedStage(stg)}
          onFollowCurrentStageChange={(follow) => setFollowCurrentStage(follow)}
          onClose={() => setInspectorOpen(false)}
          onOpenFullWorkspace={handleOpenFullWorkspace}
          onRetryStage={onRetryStage}
        />
      </div>
    )
  }

  return (
    <div className="page-container client-production-page">
      {/* Recovery Notice if interrupted */}
      {isInterrupted && (
        <StatusBanner
          variant="recovery"
          title="Previous progress recovered"
          message={`Assets and completed stages have been safely restored from the previous session. Resume to continue from ${currentPhaseFriendly}.`}
        />
      )}

      {/* Needs Attention Notice */}
      {isNeedsAttention && (
        <StatusBanner
          variant="warning"
          title="Video needs your review"
          message="One or more scenes require manual stock verification or asset selection before rendering."
          action={{
            label: 'Review Missing Scenes',
            onClick: () => onNavigate('stock'),
            variant: 'primary'
          }}
          secondaryAction={{
            label: 'Resume Pipeline',
            onClick: onResume
          }}
        />
      )}

      {/* Fatal Error Notice */}
      {isFailed && (
        <StatusBanner
          variant="error"
          title="Production paused due to an error"
          message={
            pipelineState?.fatalErrors?.[pipelineState.fatalErrors.length - 1] ||
            'An error occurred. Check activity logs or retry the current step.'
          }
          action={{
            label: 'Resume Production',
            onClick: onResume,
            variant: 'primary'
          }}
        />
      )}

      {/* Header Dashboard Card */}
      <div className="production-header-card">
        <div className="production-header-main">
          <div className="production-status-pill">
            <span
              className={`status-dot ${
                isRunning
                  ? 'rendering'
                  : isInterrupted
                  ? 'paused'
                  : isNeedsAttention
                  ? 'warning'
                  : isFailed
                  ? 'error'
                  : 'ready'
              }`}
            />
            <span className="production-status-text">
              {headerTitle}
            </span>
          </div>

          <div className="production-current-message">
            {headerSubtitle}
          </div>

          <div className="production-meta-row">
            <span className="production-meta-item">
              <strong>Phase:</strong> {currentPhaseTitle}
            </span>
            <span className="production-meta-item">
              <strong>Elapsed:</strong> {fmtStopwatch(elapsedSecs)}
            </span>
            <span className="production-meta-item">
              <strong>Progress:</strong> {overallPercentage}%
            </span>
          </div>

          {/* Overall Progress Bar */}
          <div className="progress-bar-wrap" style={{ height: '8px', marginTop: '12px' }}>
            <div
              className="progress-bar-fill"
              style={{ width: `${Math.max(2, overallPercentage)}%` }}
            />
          </div>
        </div>

        <div className="production-header-actions">
          {/* Primary Action Button: Resume Production if interrupted or not running */}
          {isInterrupted && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onResume}
            >
              ▶ Resume Production
            </button>
          )}

          {!isRunning && !isInterrupted && !isCompleted && overallStatus !== 'idle' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onResume}
            >
              ▶ Resume Production
            </button>
          )}

          {/* Inspect Live when running */}
          {isRunning && (
            <button
              type="button"
              className="btn btn-primary live-header-btn"
              onClick={() => handleInspectStage(pipelineState?.currentStage || 'validating')}
              title="Inspect live progress of currently running stage"
            >
              <span className="live-dot" />
              <span>Inspect Live</span>
            </button>
          )}

          {/* Secondary Inspection Button when not running */}
          {!isRunning && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleOpenTechnicalDetails}
              title="Inspect stage details in Live Inspector"
            >
              Inspect Stages
            </button>
          )}

          {/* Secondary Action: Cancel when running */}
          {isRunning && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' }}
              onClick={() => setShowCancelDialog(true)}
            >
              Cancel
            </button>
          )}

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setShowTechnicalDetails((prev) => !prev)}
            title="Toggle low-level 10-stage technical timeline"
          >
            {showTechnicalDetails ? 'Hide Timeline' : 'View Timeline'}
          </button>
        </div>
      </div>

      {/* 5 UI Phase Cards */}
      <div className="production-phases-container">
        <div className="production-phases-header">
          <span className="production-phases-title">Production Phases</span>
          <span className="text-xs text-muted">5 major phases · Auto-managed</span>
        </div>

        <div className="production-phases-list">
          {UI_PHASES.map((phase) => (
            <PipelinePhaseCard
              key={phase.id}
              phase={phase}
              pipelineState={pipelineState}
              isRunning={isRunning}
              isExpanded={expandedPhaseId === phase.id}
              onToggleExpand={() => {
                setExpandedPhaseId((prev) => (prev === phase.id ? null : phase.id))
              }}
              onInspectStage={handleInspectStage}
              onOpenFullWorkspace={handleOpenFullWorkspace}
              onRetryStage={onRetryStage}
            />
          ))}
        </div>
      </div>

      {/* Expanded Technical View if toggled */}
      {showTechnicalDetails && pipelineState && (
        <div className="production-technical-panel mt-4">
          <div className="panel-title mb-2" style={{ fontSize: '13px', fontWeight: 600 }}>
            Detailed 10-Stage Pipeline
          </div>
          <PipelineTimeline
            pipelineState={pipelineState}
            isRunning={isRunning}
            onCancel={() => setShowCancelDialog(true)}
            onResume={onResume}
            onRetryStage={onRetryStage}
            onInspectStage={handleInspectStage}
            onOpenFullWorkspace={handleOpenFullWorkspace}
          />
        </div>
      )}

      {/* Cancel Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showCancelDialog}
        title="Cancel Video Production?"
        message="Are you sure you want to cancel the running pipeline? Completed assets will remain saved on disk so you can resume later."
        confirmText="Yes, Cancel Pipeline"
        cancelText="Keep Running"
        isDestructive={true}
        onConfirm={handleConfirmCancel}
        onCancel={() => setShowCancelDialog(false)}
      />

      {/* Live Pipeline Inspector Drawer */}
      <LivePipelineInspector
        isOpen={inspectorOpen}
        pipelineState={pipelineState}
        selectedStage={selectedStage}
        followCurrentStage={followCurrentStage}
        onSelectStage={(stg) => setSelectedStage(stg)}
        onFollowCurrentStageChange={(follow) => setFollowCurrentStage(follow)}
        onClose={() => setInspectorOpen(false)}
        onOpenFullWorkspace={handleOpenFullWorkspace}
        onRetryStage={onRetryStage}
      />
    </div>
  )
}
