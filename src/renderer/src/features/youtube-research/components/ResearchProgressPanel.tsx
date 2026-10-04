import React, { useState, useEffect, useRef } from 'react'
import type { ResearchProgressState, ResearchStage } from '../types/research.types'
import { isResearchStageTerminal } from '../types/research.types'

interface Props {
  topic: string
  progressState: ResearchProgressState | null
  onCancel: () => void
  isCancelling: boolean
  onRetry?: () => void
  onRestartService?: () => void
  onDismiss?: () => void
}

const ORDERED_STEPS: { stage: ResearchStage; label: string }[] = [
  { stage: 'STARTING', label: 'Starting market analysis' },
  { stage: 'QUEUED', label: 'Queued in background' },
  { stage: 'EXPANDING_KEYWORDS', label: 'Expanding keywords' },
  { stage: 'SEARCHING', label: 'Searching YouTube' },
  { stage: 'FETCHING_METADATA', label: 'Fetching video metadata' },
  { stage: 'LOADING_CHANNEL_BASELINES', label: 'Loading channel baselines' },
  { stage: 'CALCULATING_ADVANCED_METRICS', label: 'Calculating metrics' },
  { stage: 'CLUSTERING', label: 'Clustering topics' },
  { stage: 'AI_ANALYSIS', label: 'Generating insights' },
  { stage: 'COMPLETED', label: 'Complete' }
]

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function ResearchProgressPanel({
  topic,
  progressState,
  onCancel,
  isCancelling,
  onRetry,
  onRestartService,
  onDismiss
}: Props): React.ReactElement {
  const currentStage = progressState?.stage ?? 'STARTING'
  const progressPct = progressState?.progress_percent ?? 0
  const isTerminal = isResearchStageTerminal(currentStage)

  // Real-time local elapsed timer (1-second tick)
  const [localElapsed, setLocalElapsed] = useState<number>(progressState?.elapsed_seconds ?? 0)
  const lastEventElapsedRef = useRef<number>(progressState?.elapsed_seconds ?? 0)
  const lastProgressAtRef = useRef<number>(Date.now())
  const [isStalled, setIsStalled] = useState(false)

  const [activeStage, setActiveStage] = useState<ResearchStage>(() => {
    return isTerminal ? 'STARTING' : currentStage
  })

  useEffect(() => {
    if (progressState?.stage && !isResearchStageTerminal(progressState.stage)) {
      setActiveStage(progressState.stage)
    }
  }, [progressState?.stage])

  // Keep local baseline aligned with incoming events (never decreasing)
  useEffect(() => {
    if (progressState?.elapsed_seconds !== undefined && progressState.elapsed_seconds > lastEventElapsedRef.current) {
      lastEventElapsedRef.current = progressState.elapsed_seconds
      setLocalElapsed((prev) => Math.max(prev, progressState.elapsed_seconds!))
    }
    lastProgressAtRef.current = Date.now()
    setIsStalled(false)
  }, [progressState?.elapsed_seconds, progressState?.progress_percent, progressState?.stage])

  // 1-second active timer
  useEffect(() => {
    if (isTerminal) return

    const timer = setInterval(() => {
      setLocalElapsed((prev) => prev + 1)

      // Stall detection: display subtle hint if stage has no events for > 12 seconds
      if (Date.now() - lastProgressAtRef.current > 12000) {
        setIsStalled(true)
      }
    }, 1000)

    return () => clearInterval(timer)
  }, [isTerminal])

  const getStageStatus = (stepStage: ResearchStage): 'done' | 'current' | 'pending' => {
    const stageOrder: Record<string, number> = {
      STARTING: 0,
      QUEUED: 1,
      EXPANDING_KEYWORDS: 2,
      SEARCHING: 3,
      FETCHING_METADATA: 4,
      BASIC_SCORING: 4,
      ENRICHING_CANDIDATES: 5,
      LOADING_CHANNEL_BASELINES: 5,
      CALCULATING_ADVANCED_METRICS: 6,
      CLUSTERING: 7,
      AI_ANALYSIS: 8,
      PERSISTING: 8,
      COMPLETED: 9
    }

    const currentIdx = stageOrder[activeStage] ?? 0
    const stepIdx = stageOrder[stepStage] ?? 0

    if (currentStage === 'COMPLETED') return 'done'
    if (currentIdx > stepIdx) return 'done'
    if (currentIdx === stepIdx) return 'current'
    return 'pending'
  }

  const stageBadgeColor = () => {
    if (currentStage === 'FAILED') return { bg: 'rgba(239, 68, 68, 0.2)', text: '#f87171' }
    if (currentStage === 'INTERRUPTED') return { bg: 'rgba(245, 158, 11, 0.2)', text: '#fbbf24' }
    if (currentStage === 'CANCELLED') return { bg: 'rgba(156, 163, 175, 0.2)', text: '#9ca3af' }
    return { bg: 'rgba(99, 102, 241, 0.2)', text: '#a5b4fc' }
  }

  const badgeStyle = stageBadgeColor()

  return (
    <div style={{
      maxWidth: '680px',
      margin: '40px auto',
      background: 'var(--bg-elevated, #13141c)',
      border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.1))',
      borderRadius: 'var(--radius-lg, 12px)',
      padding: '28px',
      boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-muted)' }}>
            Deep Market Research
          </div>
          <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '4px 0 0 0', color: 'var(--text-primary)' }}>
            Researching “{topic}”
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
            <span style={{
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '4px',
              background: badgeStyle.bg,
              color: badgeStyle.text,
              fontWeight: 600
            }}>
              Stage: {currentStage}
            </span>
            {progressState?.run_id ? (
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                Run ID: {progressState.run_id}
              </span>
            ) : (
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Connecting sidecar...
              </span>
            )}
          </div>
        </div>
        <div style={{
          fontSize: '20px',
          fontWeight: 800,
          fontFamily: 'var(--font-mono)',
          color: currentStage === 'FAILED' ? '#f87171' : (currentStage === 'INTERRUPTED' ? '#fbbf24' : 'var(--brand-primary, #6366f1)')
        }}>
          {progressPct}%
        </div>
      </div>

      {/* Progress Bar */}
      <div style={{
        height: '6px',
        width: '100%',
        background: 'var(--bg-base, #0a0a0f)',
        borderRadius: '999px',
        overflow: 'hidden',
        marginBottom: '20px'
      }}>
        <div style={{
          height: '100%',
          width: `${Math.min(100, Math.max(2, progressPct))}%`,
          background: currentStage === 'FAILED'
            ? 'linear-gradient(90deg, #ef4444, #f87171)'
            : (currentStage === 'INTERRUPTED'
              ? 'linear-gradient(90deg, #f59e0b, #fbbf24)'
              : 'linear-gradient(90deg, #6366f1, #818cf8)'),
          borderRadius: '999px',
          transition: 'width 0.4s ease'
        }} />
      </div>

      {/* Stalled Stage Warning Hint */}
      {isStalled && !isTerminal && (
        <div style={{
          padding: '8px 12px',
          background: 'rgba(99, 102, 241, 0.1)',
          border: '1px solid rgba(99, 102, 241, 0.25)',
          borderRadius: '6px',
          fontSize: '11px',
          color: '#a5b4fc',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}>
          <span>⏳</span>
          <span>Still waiting for keyword sources...</span>
        </div>
      )}

      {/* Checklist */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        marginBottom: '24px',
        padding: '16px',
        background: 'var(--bg-base, #0a0a0f)',
        borderRadius: 'var(--radius-md, 8px)'
      }}>
        {ORDERED_STEPS.map((step) => {
          const status = getStageStatus(step.stage)
          return (
            <div key={step.stage} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px' }}>
              {status === 'done' && (
                <span style={{ color: '#34d399', fontWeight: 700, width: '16px', textAlign: 'center' }}>✓</span>
              )}
              {status === 'current' && (
                <span style={{
                  color: currentStage === 'FAILED' ? '#f87171' : (currentStage === 'INTERRUPTED' ? '#fbbf24' : '#818cf8'),
                  fontSize: '10px',
                  width: '16px',
                  textAlign: 'center',
                  animation: isTerminal ? 'none' : 'pulse 1.5s infinite'
                }}>●</span>
              )}
              {status === 'pending' && (
                <span style={{ color: 'var(--text-muted)', fontSize: '10px', width: '16px', textAlign: 'center' }}>○</span>
              )}
              <span style={{
                color: status === 'done' ? 'var(--text-primary)' : (status === 'current' ? '#818cf8' : 'var(--text-muted)'),
                fontWeight: status === 'current' ? 600 : 400
              }}>
                {step.label}
              </span>
            </div>
          )
        })}
      </div>

      {/* Metrics Row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '12px',
        marginBottom: '24px',
        textAlign: 'center'
      }}>
        <div style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Videos collected</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>
            {progressState?.videos_collected ?? 0}
          </div>
        </div>
        <div style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Channels analyzed</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>
            {progressState?.channels_analyzed ?? 0}
          </div>
        </div>
        <div style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Keywords expanded</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>
            {progressState?.keywords_expanded ?? 0}
          </div>
        </div>
        <div style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Elapsed time</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {formatElapsed(localElapsed)}
          </div>
        </div>
      </div>

      {/* Interrupted Alert Box */}
      {currentStage === 'INTERRUPTED' && (
        <div style={{
          background: 'rgba(245, 158, 11, 0.12)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          borderRadius: '8px',
          padding: '14px 16px',
          marginBottom: '20px',
          fontSize: '12px',
          color: '#fcd34d'
        }}>
          <div style={{ fontWeight: 700, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
            <span>🔌</span>
            <span>Research Interrupted</span>
          </div>
          <div style={{ marginBottom: '12px', lineHeight: 1.5, color: '#fef3c7' }}>
            The local research service stopped unexpectedly. Your research run was interrupted. Restart the service and try again.
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {onRestartService && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onRestartService}
                style={{ padding: '6px 14px', fontSize: '11px', background: 'rgba(255,255,255,0.1)' }}
              >
                Restart Service
              </button>
            )}
            {onRetry && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={onRetry}
                style={{ padding: '6px 14px', fontSize: '11px' }}
              >
                Retry Research
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onDismiss}
                style={{ padding: '6px 14px', fontSize: '11px' }}
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      {/* Error Alert Box */}
      {currentStage === 'FAILED' && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.12)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: '8px',
          padding: '14px 16px',
          marginBottom: '20px',
          fontSize: '12px',
          color: '#fca5a5'
        }}>
          <div style={{ fontWeight: 700, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
            <span>⚠️</span>
            <span>Research Failed</span>
          </div>
          <div style={{ marginBottom: '12px', lineHeight: 1.5 }}>
            {progressState?.error || progressState?.message || 'An unknown error occurred during research.'}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {onRetry && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={onRetry}
                style={{ padding: '6px 14px', fontSize: '11px' }}
              >
                Retry Research
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onDismiss}
                style={{ padding: '6px 14px', fontSize: '11px' }}
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      {/* Cancelled Alert Box */}
      {currentStage === 'CANCELLED' && (
        <div style={{
          background: 'rgba(156, 163, 175, 0.12)',
          border: '1px solid rgba(156, 163, 175, 0.3)',
          borderRadius: '8px',
          padding: '14px 16px',
          marginBottom: '20px',
          fontSize: '12px',
          color: '#e5e7eb'
        }}>
          <div style={{ fontWeight: 700, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>🛑</span>
            <span>Research Cancelled</span>
          </div>
          <div style={{ marginBottom: '12px' }}>
            {progressState?.message || 'Research run was cancelled by user.'}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {onRetry && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={onRetry}
                style={{ padding: '6px 14px', fontSize: '11px' }}
              >
                Start New Research
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onDismiss}
                style={{ padding: '6px 14px', fontSize: '11px' }}
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      {/* Action Footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
        <div style={{
          fontSize: '12px',
          color: currentStage === 'FAILED' ? '#f87171' : (currentStage === 'INTERRUPTED' ? '#fbbf24' : 'var(--text-muted)'),
          fontStyle: isTerminal ? 'normal' : 'italic'
        }}>
          {progressState?.message || (currentStage === 'STARTING' ? 'Starting market analysis...' : 'Processing background analysis...')}
        </div>
        {progressState?.can_cancel !== false && !isTerminal && (
          <button
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={isCancelling || currentStage === 'STARTING'}
            style={{ padding: '6px 18px', fontSize: '12px', whiteSpace: 'nowrap' }}
          >
            {isCancelling ? 'Cancelling...' : 'Cancel Research'}
          </button>
        )}
      </div>
    </div>
  )
}
