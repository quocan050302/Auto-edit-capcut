import React, { useState, useEffect } from 'react'
import type { ThumbnailJobState, ThumbnailProviderHealth, ProjectThumbnailSettings } from '../../../../shared/types'

interface RenderThumbnailCompanionCardProps {
  projectDir: string
  onOpenStudio?: () => void
}

export const RenderThumbnailCompanionCard: React.FC<RenderThumbnailCompanionCardProps> = ({
  projectDir,
  onOpenStudio
}) => {
  const [jobState, setJobState] = useState<ThumbnailJobState | null>(null)
  const [health, setHealth] = useState<ThumbnailProviderHealth | null>(null)
  const [settings, setSettings] = useState<ProjectThumbnailSettings | null>(null)

  useEffect(() => {
    if (!projectDir) return

    window.api.thumbnail.jobs.get(projectDir).then((res) => {
      if (res.success && res.state) setJobState(res.state)
    }).catch(() => {})

    window.api.thumbnail.settings.get(projectDir).then((res) => {
      if (res.success && res.settings) setSettings(res.settings)
    }).catch(() => {})

    window.api.thumbnail.flow.checkHealth().then((h) => {
      setHealth(h)
    }).catch(() => {})

    const unsubscribe = window.api.thumbnail.onProgress((payload) => {
      if (payload.projectDir === projectDir) {
        if (payload.jobState) {
          setJobState(payload.jobState)
        } else {
          // Refresh state
          window.api.thumbnail.jobs.get(projectDir).then((res) => {
            if (res.success && res.state) setJobState(res.state)
          }).catch(() => {})
        }
      }
    })

    return () => {
      unsubscribe()
    }
  }, [projectDir])

  if (!settings?.enabled) {
    return null
  }

  const completedCount = jobState?.candidates.filter((c) => c.status === 'completed').length || 0
  const isCompleted = jobState?.status === 'completed' || completedCount === 5
  const isFailed = jobState?.status === 'failed' || jobState?.status === 'needs-attention'
  const isGenerating = jobState?.status === 'generating' || jobState?.status === 'planning' || jobState?.status === 'exporting'

  return (
    <div
      style={{
        marginTop: '16px',
        padding: '16px 20px',
        background: 'rgba(255, 255, 255, 0.03)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '10px'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '15px' }}>🖼️</span>
            <span style={{ fontWeight: 600, fontSize: '14px', color: '#f3f4f6' }}>
              Thumbnail Generation
            </span>
            <span
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '10px',
                fontWeight: 600,
                background: isCompleted ? 'rgba(34, 197, 94, 0.15)' : isFailed ? 'rgba(245, 158, 11, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                color: isCompleted ? '#22c55e' : isFailed ? '#f59e0b' : '#60a5fa'
              }}
            >
              {isCompleted
                ? '5 Thumbnails Ready'
                : isGenerating
                ? `Generating ${completedCount}/5`
                : isFailed
                ? 'Needs Attention'
                : 'Queued'}
            </span>
          </div>

          <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
            Video render completed successfully. Thumbnail is a separate companion task.
          </div>

          <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#9ca3af', marginTop: '6px' }}>
            <span>
              Google Flow: <span style={{ color: health?.reachable ? '#22c55e' : '#ef4444' }}>{health?.reachable ? 'Connected' : 'Offline'}</span>
            </span>
            {settings?.selectedTemplateId && (
              <span>Template: <span style={{ color: '#d1d5db' }}>{settings.selectedTemplateId}</span></span>
            )}
          </div>
        </div>

        <div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onOpenStudio}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 600,
              background: '#3b82f6',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            {isCompleted ? 'Review Thumbnails ↗' : 'Open Thumbnail Studio ↗'}
          </button>
        </div>
      </div>
    </div>
  )
}
