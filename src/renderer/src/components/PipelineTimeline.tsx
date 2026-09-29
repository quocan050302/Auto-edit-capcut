import React from 'react'
import type {
  AutoPipelineState,
  PipelineStage,
  StageStatus
} from '../../../../shared/types'

interface PipelineTimelineProps {
  pipelineState: AutoPipelineState
  isRunning: boolean
  onCancel: () => void
  onResume: () => void
  onRetryStage: (stage: PipelineStage) => void
  onNavigateToStage: (stage: PipelineStage) => void
}

interface StageMeta {
  key: PipelineStage
  title: string
  pageName: string
}

const ORDERED_STAGES: StageMeta[] = [
  { key: 'validating', title: 'Validate Inputs', pageName: 'input' },
  { key: 'transcribing', title: 'Transcription', pageName: 'transcribe' },
  { key: 'planning', title: 'AI Planning', pageName: 'planning' },
  { key: 'captions', title: 'Dynamic Captions', pageName: 'captions' },
  { key: 'global-context', title: 'Global Visual Context', pageName: 'stock' },
  { key: 'stock-search', title: 'Stock Search & Ranking', pageName: 'stock' },
  { key: 'audio-search', title: 'Background Music & SFX', pageName: 'audio' },
  { key: 'preflight', title: 'Render Preflight QA', pageName: 'render' },
  { key: 'rendering', title: 'Rendering Video', pageName: 'render' },
  { key: 'postflight', title: 'Postflight QA', pageName: 'render' }
]

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return ''
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m ${remSecs}s`
}

export function PipelineTimeline({
  pipelineState,
  isRunning,
  onCancel,
  onResume,
  onRetryStage,
  onNavigateToStage
}: PipelineTimelineProps): React.ReactElement {
  const { stages, currentStage, overallStatus, warnings, fatalErrors } = pipelineState

  const isCompleted = overallStatus === 'completed'
  const isNeedsAttention = overallStatus === 'needs-attention'
  const isFailed = overallStatus === 'failed'

  function getStatusIcon(status?: StageStatus, isCurrent?: boolean) {
    if (status === 'completed') return <span style={{ color: 'var(--color-success, #22c55e)' }}>✓</span>
    if (status === 'running' || isCurrent) {
      return (
        <span
          style={{
            display: 'inline-block',
            width: 12,
            height: 12,
            border: '2px solid rgba(139,92,246,0.3)',
            borderTopColor: 'var(--brand-primary, #a855f7)',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }}
        />
      )
    }
    if (status === 'warning') return <span style={{ color: '#f59e0b' }}>⚠️</span>
    if (status === 'failed') return <span style={{ color: '#ef4444' }}>✕</span>
    if (status === 'cancelled') return <span style={{ color: '#6b7280' }}>⊘</span>
    return <span style={{ color: '#4b5563' }}>○</span>
  }

  function getStatusBadgeClass(status?: StageStatus) {
    if (status === 'completed') return 'badge-success'
    if (status === 'running') return 'badge-progress'
    if (status === 'warning') return 'badge-warning'
    if (status === 'failed') return 'badge-error'
    if (status === 'cancelled') return 'badge-secondary'
    return 'badge-secondary'
  }

  return (
    <div
      className="panel"
      style={{
        border: isNeedsAttention
          ? '1px solid #f59e0b'
          : isFailed
          ? '1px solid #ef4444'
          : isCompleted
          ? '1px solid var(--color-success, #22c55e)'
          : '1px solid var(--border-brand, #3b82f6)'
      }}
    >
      <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '18px' }}>⚡</span>
          Auto Production Pipeline
          <span
            className={`panel-badge ${
              isCompleted
                ? 'badge-success'
                : isNeedsAttention
                ? 'badge-warning'
                : isFailed
                ? 'badge-error'
                : isRunning
                ? 'badge-progress'
                : 'badge-secondary'
            }`}
          >
            {overallStatus.toUpperCase()}
          </span>
        </div>

        {/* Global Pipeline Action Buttons */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {isRunning && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={onCancel}
              style={{ borderColor: '#ef4444', color: '#ef4444' }}
              title="Cancel Pipeline"
            >
              Cancel
            </button>
          )}

          {(isNeedsAttention || isFailed || (!isRunning && !isCompleted && overallStatus !== 'idle')) && (
            <button className="btn btn-primary btn-sm" onClick={onResume}>
              Resume Pipeline
            </button>
          )}

          {isCompleted && pipelineState.renderOutputPath && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onNavigateToStage('rendering')}
            >
              View Output Video
            </button>
          )}
        </div>
      </div>

      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* Banner nếu có cảnh báo hoặc fatal error */}
        {fatalErrors && fatalErrors.length > 0 && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#f87171',
              fontSize: '13px'
            }}
          >
            <strong>Pipeline Stopped:</strong> {fatalErrors[fatalErrors.length - 1]}
          </div>
        )}

        {isNeedsAttention && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'rgba(245, 158, 11, 0.1)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              color: '#fbbf24',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px'
            }}
          >
            <div>
              <strong>Action Needed:</strong> One or more scenes require manual stock review or preflight fix before rendering.
            </div>
            <button
              className="btn btn-secondary btn-sm"
              style={{ flexShrink: 0 }}
              onClick={() => onNavigateToStage(currentStage as PipelineStage)}
            >
              Open Step
            </button>
          </div>
        )}

        {/* Timeline list of 10 stages */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {ORDERED_STAGES.map((s, idx) => {
            const stageData = stages[s.key]
            const status: StageStatus = stageData?.status ?? 'pending'
            const isCurrent = currentStage === s.key && isRunning
            const progress = stageData?.progress ?? 0

            return (
              <div
                key={s.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-sm, 6px)',
                  background: isCurrent
                    ? 'rgba(168, 85, 247, 0.08)'
                    : status === 'completed'
                    ? 'rgba(34, 197, 94, 0.04)'
                    : 'rgba(255, 255, 255, 0.02)',
                  border: isCurrent
                    ? '1px solid rgba(168, 85, 247, 0.3)'
                    : '1px solid rgba(255, 255, 255, 0.05)',
                  gap: '12px'
                }}
              >
                {/* Left: Step Index & Status Icon */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '220px' }}>
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: 'rgba(255,255,255,0.05)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '12px',
                      fontWeight: 600,
                      flexShrink: 0
                    }}
                  >
                    {getStatusIcon(status, isCurrent)}
                  </div>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
                      {idx + 1}. {s.title}
                    </div>
                    {stageData?.durationMs ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary, #9ca3af)' }}>
                        {formatDuration(stageData.durationMs)}
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Center: Message & Progress */}
                <div style={{ flex: 1, minWidth: '150px' }}>
                  {stageData?.message && (
                    <div
                      style={{
                        fontSize: '12px',
                        color: stageData.error ? '#f87171' : 'var(--text-secondary, #9ca3af)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                      title={stageData.message}
                    >
                      {stageData.message}
                    </div>
                  )}

                  {/* Progress bar if running or partial */}
                  {(status === 'running' || (progress > 0 && progress < 1)) && (
                    <div
                      style={{
                        height: 4,
                        width: '100%',
                        background: 'rgba(255,255,255,0.1)',
                        borderRadius: 2,
                        marginTop: 4,
                        overflow: 'hidden'
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.round(progress * 100)}%`,
                          background: 'var(--brand-primary, #a855f7)',
                          transition: 'width 0.2s ease'
                        }}
                      />
                    </div>
                  )}
                </div>

                {/* Right: Actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  <span className={`panel-badge ${getStatusBadgeClass(status)}`} style={{ fontSize: '11px' }}>
                    {status}
                  </span>

                  {(status === 'failed' || (status === 'warning' && !isRunning)) && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onRetryStage(s.key)}
                      style={{ padding: '2px 8px', fontSize: '11px' }}
                    >
                      Retry
                    </button>
                  )}

                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onNavigateToStage(s.key)}
                    style={{ padding: '2px 8px', fontSize: '11px' }}
                    title={`Open ${s.title}`}
                  >
                    Open
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Output path banner when completed */}
        {isCompleted && pipelineState.renderOutputPath && (
          <div
            style={{
              padding: '12px',
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'rgba(34, 197, 94, 0.1)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px'
            }}
          >
            <div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-success, #22c55e)' }}>
                Production Complete!
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary, #9ca3af)', wordBreak: 'break-all' }}>
                {pipelineState.renderOutputPath}
              </div>
            </div>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onNavigateToStage('rendering')}
            >
              Open Render Page
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
