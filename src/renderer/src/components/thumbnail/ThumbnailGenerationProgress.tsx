import React from 'react'
import type { ThumbnailJobState } from '../../../../shared/types'

interface ThumbnailGenerationProgressProps {
  jobState: ThumbnailJobState | null
  onStart: () => void
  onResume: () => void
  onCancel: () => void
  onGenerateMore: () => void
  onOpenFolder: () => void
  onManageLibrary: () => void
}

export const ThumbnailGenerationProgress: React.FC<ThumbnailGenerationProgressProps> = ({
  jobState,
  onStart,
  onResume,
  onCancel,
  onGenerateMore,
  onOpenFolder,
  onManageLibrary
}) => {
  const status = jobState?.status || 'idle'
  const isRunning = status === 'generating' || status === 'planning' || status === 'exporting'
  const completedCount = jobState?.candidates.filter((c) => c.status === 'completed').length || 0
  const progressPercent = Math.round((completedCount / 5) * 100)

  const getStatusColor = () => {
    switch (status) {
      case 'completed':
        return '#22c55e'
      case 'generating':
      case 'exporting':
      case 'planning':
        return '#3b82f6'
      case 'partial':
      case 'needs-attention':
        return '#f59e0b'
      case 'failed':
        return '#ef4444'
      case 'interrupted':
        return '#a855f7'
      default:
        return '#6b7280'
    }
  }

  const getStatusLabel = () => {
    switch (status) {
      case 'completed':
        return 'All 5 Thumbnails Ready (4K)'
      case 'generating':
      case 'exporting':
        return `Generating Thumbnails (${completedCount}/5)...`
      case 'planning':
        return 'Planning Concepts with Gemini...'
      case 'partial':
        return `${completedCount}/5 Thumbnails Ready`
      case 'needs-attention':
        return 'FlowKit Connection Required — Resume when ready'
      case 'failed':
        return 'Generation Failed'
      case 'interrupted':
        return 'Interrupted — Resume to continue'
      default:
        return 'Ready to Generate'
    }
  }

  return (
    <div
      style={{
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '12px',
        padding: '20px',
        marginBottom: '24px'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: getStatusColor(),
                boxShadow: `0 0 10px ${getStatusColor()}`
              }}
            />
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#f9fafb' }}>
              {getStatusLabel()}
            </h3>
            {jobState?.generationRound && (
              <span
                style={{
                  background: 'rgba(59, 130, 246, 0.15)',
                  color: '#60a5fa',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  fontSize: '11px',
                  fontWeight: 600
                }}
              >
                Round {jobState.generationRound}
              </span>
            )}
          </div>
          <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
            {jobState?.renderOutputPath ? `Video Output: ${jobState.renderOutputPath}` : 'Companion workflow for YouTube thumbnails'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          {isRunning ? (
            <button
              onClick={onCancel}
              style={{
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#f87171',
                borderRadius: '6px',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
          ) : (status === 'interrupted' || status === 'partial' || status === 'needs-attention') ? (
            <button
              onClick={onResume}
              style={{
                background: status === 'needs-attention' ? '#f59e0b' : '#8b5cf6',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '8px 18px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Resume Generation
            </button>
          ) : null}

          {status === 'completed' || status === 'partial' ? (
            <button
              onClick={onGenerateMore}
              style={{
                background: '#3b82f6',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '8px 18px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <span>+ Generate 5 More</span>
            </button>
          ) : (status === 'idle' || status === 'failed') ? (
            <button
              onClick={onStart}
              style={{
                background: '#3b82f6',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '8px 20px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Start Thumbnail Generation
            </button>
          ) : null}

          <button
            onClick={onOpenFolder}
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              color: '#d1d5db',
              borderRadius: '6px',
              padding: '8px 14px',
              fontSize: '13px',
              cursor: 'pointer'
            }}
          >
            Open Folder ↗
          </button>

          <button
            onClick={onManageLibrary}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              color: '#9ca3af',
              borderRadius: '6px',
              padding: '8px 14px',
              fontSize: '13px',
              cursor: 'pointer'
            }}
          >
            Prompt Library
          </button>
        </div>
      </div>

      {/* Progress Track */}
      <div
        style={{
          width: '100%',
          height: '6px',
          background: 'rgba(255, 255, 255, 0.05)',
          borderRadius: '3px',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            width: `${progressPercent}%`,
            height: '100%',
            background: isRunning ? 'linear-gradient(90deg, #3b82f6, #60a5fa)' : getStatusColor(),
            transition: 'width 0.4s ease'
          }}
        />
      </div>

      {jobState?.warnings && jobState.warnings.length > 0 && (
        <div style={{ marginTop: '10px', fontSize: '12px', color: '#f59e0b' }}>
          {jobState.warnings.join(' • ')}
        </div>
      )}

      {/* Show errors in needs-attention or failed state */}
      {(status === 'needs-attention' || status === 'failed') && jobState?.errors && jobState.errors.length > 0 && (
        <div style={{ marginTop: '10px', fontSize: '12px', color: '#f87171', lineHeight: '1.5' }}>
          {jobState.errors.slice(-2).map((e, i) => (
            <div key={i}>⚠ {e.replace(/^\[\w+\]\s*/, '')}</div>
          ))}
        </div>
      )}
    </div>
  )
}
