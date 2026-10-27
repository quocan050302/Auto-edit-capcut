import React from 'react'
import type { SimpleAssemblyProgressPayload, SimpleAssemblyStatus } from '../../../../shared/types'

export interface SimpleAssemblyProgressProps {
  progress: SimpleAssemblyProgressPayload | null
  isRunning: boolean
  onCancel: () => void
  error?: string | null
}

const STAGES: { status: SimpleAssemblyStatus; label: string; step: number }[] = [
  { status: 'validating-voiceover', label: '1. Validate Voiceover', step: 1 },
  { status: 'validating-scenes', label: '2. Validate Scenes', step: 2 },
  { status: 'resolving-timing', label: '3. Resolve Timing', step: 3 },
  { status: 'normalizing-scenes', label: '4. Normalize Media', step: 4 },
  { status: 'joining-scenes', label: '5. Join Scenes', step: 5 },
  { status: 'mixing-audio', label: '6. Attach Audio', step: 6 },
  { status: 'validating-output', label: '7. Validate MP4', step: 7 },
  { status: 'completed', label: '8. Complete', step: 8 }
]

function getStageIndex(status?: SimpleAssemblyStatus): number {
  if (!status) return 0
  const idx = STAGES.findIndex((s) => s.status === status)
  return idx >= 0 ? idx : 0
}

export function SimpleAssemblyProgress({
  progress,
  isRunning,
  onCancel,
  error
}: SimpleAssemblyProgressProps): React.ReactElement | null {
  if (!isRunning && !progress && !error) {
    return null
  }

  const currentStatus = progress?.status ?? 'validating-voiceover'
  const currentStageIdx = getStageIndex(currentStatus)
  const isCompleted = currentStatus === 'completed'
  const isFailed = currentStatus === 'failed' || Boolean(error)
  const pct = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)))

  return (
    <div
      id="simple-assembly-progress-panel"
      style={{
        marginTop: '16px',
        padding: '16px',
        borderRadius: 'var(--radius-lg, 12px)',
        border: `1px solid ${isFailed ? 'rgba(239, 68, 68, 0.4)' : isCompleted ? 'rgba(16, 185, 129, 0.4)' : 'rgba(56, 189, 248, 0.4)'}`,
        background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.95))',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.02em' }}>
            ⚡ SIMPLE SCENE ASSEMBLY
          </span>
          {isRunning && !isCompleted && !isFailed && (
            <span style={{ fontSize: '11px', color: '#38bdf8', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <span className="spinner-sm" style={{ width: '10px', height: '10px' }} /> Assembling...
            </span>
          )}
          {isCompleted && (
            <span style={{ fontSize: '11px', color: '#34d399', fontWeight: 600 }}>
              ✓ Assembly Finished Successfully
            </span>
          )}
          {isFailed && (
            <span style={{ fontSize: '11px', color: '#f87171', fontWeight: 600 }}>
              ⚠️ Assembly Failed
            </span>
          )}
        </div>

        {isRunning && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onCancel}
            style={{ color: '#ef4444', borderColor: '#ef4444', fontSize: '11px', padding: '3px 8px' }}
          >
            Cancel Assembly
          </button>
        )}
      </div>

      {/* 8-stage progress tracker */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
          gap: '6px'
        }}
      >
        {STAGES.map((s, idx) => {
          const isDone = isCompleted || idx < currentStageIdx
          const isCurrent = !isCompleted && !isFailed && idx === currentStageIdx

          let bg = 'rgba(255, 255, 255, 0.04)'
          let border = 'rgba(255, 255, 255, 0.08)'
          let text = 'var(--text-secondary)'

          if (isDone) {
            bg = 'rgba(16, 185, 129, 0.12)'
            border = 'rgba(16, 185, 129, 0.3)'
            text = '#34d399'
          } else if (isCurrent) {
            bg = 'rgba(56, 189, 248, 0.15)'
            border = '#38bdf8'
            text = '#38bdf8'
          }

          return (
            <div
              key={s.status}
              style={{
                padding: '6px 8px',
                borderRadius: '6px',
                background: bg,
                border: `1px solid ${border}`,
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                color: text,
                fontWeight: isCurrent ? 700 : 500
              }}
            >
              <span>{isDone ? '✓' : isCurrent ? '●' : '○'}</span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.label}
              </span>
            </div>
          )
        })}
      </div>

      {/* Progress Bar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)' }}>
          <span>{progress?.message || (isRunning ? 'Processing scenes...' : '')}</span>
          <span>{pct}%</span>
        </div>
        <div
          style={{
            height: '6px',
            borderRadius: '3px',
            background: 'rgba(255, 255, 255, 0.1)',
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${pct}%`,
              background: isFailed ? '#ef4444' : isCompleted ? '#10b981' : 'linear-gradient(90deg, #0284c7, #38bdf8)',
              transition: 'width 0.3s ease'
            }}
          />
        </div>
      </div>

      {/* Error display */}
      {(error || progress?.error) && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: '6px',
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#f87171',
            fontSize: '12px'
          }}
        >
          <span>⚠️ {error || progress?.error}</span>
        </div>
      )}

      {/* Result Card when completed */}
      {isCompleted && progress?.outputPath && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: '6px',
            background: 'rgba(16, 185, 129, 0.1)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px'
          }}
        >
          <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
            🎉 <strong>MP4 Exported:</strong> {progress.outputPath.split(/[/\\]/).pop()}
            {progress.duration !== undefined && ` (${progress.duration.toFixed(1)}s)`}
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            {window.api?.openPath && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ fontSize: '11px', padding: '4px 10px' }}
                onClick={() => window.api.openPath(progress.outputPath!)}
              >
                Open Video
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
