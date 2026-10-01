import React from 'react'
import type { ResearchProgressState, ResearchStage } from '../types/research.types'

interface Props {
  topic: string
  progressState: ResearchProgressState | null
  onCancel: () => void
  isCancelling: boolean
}

const ORDERED_STEPS: { stage: ResearchStage; label: string }[] = [
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
  isCancelling
}: Props): React.ReactElement {
  const currentStage = progressState?.stage ?? 'QUEUED'
  const progressPct = progressState?.progress_percent ?? 0
  const elapsedSecs = progressState?.elapsed_seconds ?? 0

  const getStageStatus = (stepStage: ResearchStage): 'done' | 'current' | 'pending' => {
    const stageOrder: Record<string, number> = {
      QUEUED: 0,
      EXPANDING_KEYWORDS: 1,
      SEARCHING: 2,
      FETCHING_METADATA: 3,
      BASIC_SCORING: 3,
      ENRICHING_CANDIDATES: 4,
      LOADING_CHANNEL_BASELINES: 4,
      CALCULATING_ADVANCED_METRICS: 5,
      CLUSTERING: 6,
      AI_ANALYSIS: 7,
      PERSISTING: 7,
      COMPLETED: 8
    }

    const currentIdx = stageOrder[currentStage] ?? 0
    const stepIdx = stageOrder[stepStage] ?? 0

    if (currentIdx > stepIdx || currentStage === 'COMPLETED') return 'done'
    if (currentIdx === stepIdx) return 'current'
    return 'pending'
  }

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-muted)' }}>
            Deep Market Research
          </div>
          <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '4px 0 0 0', color: 'var(--text-primary)' }}>
            Researching “{topic}”
          </h2>
        </div>
        <div style={{
          fontSize: '18px',
          fontWeight: 800,
          fontFamily: 'var(--font-mono)',
          color: 'var(--brand-primary, #6366f1)'
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
        marginBottom: '24px'
      }}>
        <div style={{
          height: '100%',
          width: `${Math.min(100, Math.max(2, progressPct))}%`,
          background: 'linear-gradient(90deg, #6366f1, #818cf8)',
          borderRadius: '999px',
          transition: 'width 0.4s ease'
        }} />
      </div>

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
                  color: '#818cf8',
                  fontSize: '10px',
                  width: '16px',
                  textAlign: 'center',
                  animation: 'pulse 1.5s infinite'
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
            {formatElapsed(elapsedSecs)}
          </div>
        </div>
      </div>

      {/* Action Footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {progressState?.message || 'Processing background analysis...'}
        </div>
        <button
          className="btn btn-secondary"
          onClick={onCancel}
          disabled={isCancelling}
          style={{ padding: '6px 18px', fontSize: '12px' }}
        >
          {isCancelling ? 'Cancelling...' : 'Cancel Research'}
        </button>
      </div>
    </div>
  )
}
