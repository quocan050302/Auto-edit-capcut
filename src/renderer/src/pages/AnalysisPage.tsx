import React from 'react'
import type { ProjectState, ScanResult, MediaItem } from '../../../../shared/types'
import { basename } from '../utils/path'

interface AnalysisPageProps {
  project: ProjectState
  scanResult: ScanResult | null
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function formatDuration(secs: number | undefined): string {
  if (!secs) return '—'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function MediaTable({
  items,
  type
}: {
  items: MediaItem[]
  type: 'image' | 'video' | 'audio'
}): React.ReactElement {
  if (items.length === 0) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
        No {type} assets found
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '12px',
          fontFamily: 'var(--font-mono)'
        }}
      >
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            {['Filename', 'Size', type === 'image' ? 'Dimensions' : 'Duration', 'Details'].map(
              (h) => (
                <th
                  key={h}
                  style={{
                    padding: '8px 12px',
                    textAlign: 'left',
                    color: 'var(--text-muted)',
                    fontWeight: 600,
                    fontSize: '10px',
                    letterSpacing: '0.6px',
                    textTransform: 'uppercase'
                  }}
                >
                  {h}
                </th>
              )
            )}
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 200).map((item) => (
            <tr
              key={item.id}
              style={{
                borderBottom: '1px solid var(--border-subtle)',
                transition: 'background 0.1s'
              }}
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-hover)'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLTableRowElement).style.background = ''
              }}
            >
              <td style={{ padding: '8px 12px', color: 'var(--text-primary)', maxWidth: '260px' }}>
                <div
                  style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={item.path}
                >
                  {basename(item.filename)}
                </div>
              </td>
              <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {formatBytes(item.fileSize)}
              </td>
              <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {type === 'image'
                  ? item.width && item.height
                    ? `${item.width}×${item.height}`
                    : '—'
                  : formatDuration(item.duration ?? item.audioDuration)}
              </td>
              <td style={{ padding: '8px 12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {type === 'video' ? `${item.fps ?? '?'} fps  ${item.codec ?? ''}` : item.aspectRatio ?? ''}
              </td>
            </tr>
          ))}
          {items.length > 200 && (
            <tr>
              <td colSpan={4} style={{ padding: '8px 12px', color: 'var(--text-muted)', textAlign: 'center' }}>
                … and {items.length - 200} more
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export function AnalysisPage({ project, scanResult }: AnalysisPageProps): React.ReactElement {
  const [activeTab, setActiveTab] = React.useState<'images' | 'videos' | 'music' | 'sfx' | 'errors'>('videos')

  if (!scanResult) {
    return (
      <div className="page-container">
        <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>📊</div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
              No Analysis Yet
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              Go to <strong>Inputs</strong> and click <strong>Analyze Project</strong>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const total =
    scanResult.images.length +
    scanResult.videos.length +
    scanResult.music.length +
    scanResult.sfx.length

  const tabs: { id: typeof activeTab; label: string; count: number }[] = [
    { id: 'videos', label: 'Videos', count: scanResult.videos.length },
    { id: 'images', label: 'Images', count: scanResult.images.length },
    { id: 'music', label: 'Music', count: scanResult.music.length },
    { id: 'sfx', label: 'SFX', count: scanResult.sfx.length },
    { id: 'errors', label: 'Errors', count: scanResult.errors.length }
  ]

  return (
    <div className="page-container">
      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value accent">{total}</div>
          <div className="stat-label">Total Assets</div>
        </div>
        <div className="stat-card">
          <div className="stat-value accent">{scanResult.images.length}</div>
          <div className="stat-label">Images</div>
        </div>
        <div className="stat-card">
          <div className="stat-value accent">{scanResult.videos.length}</div>
          <div className="stat-label">Videos</div>
        </div>
        <div className="stat-card">
          <div className="stat-value accent">{scanResult.music.length}</div>
          <div className="stat-label">Music</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: scanResult.errors.length > 0 ? 'var(--color-warning)' : undefined }}>
            {scanResult.errors.length}
          </div>
          <div className="stat-label">Errors</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{project.settings.fps} fps</div>
          <div className="stat-label">Target FPS</div>
        </div>
      </div>

      {/* Media Tables */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex gap-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={`btn btn-sm ${activeTab === tab.id ? 'btn-secondary' : 'btn-ghost'}`}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  borderColor: activeTab === tab.id ? 'var(--border-brand)' : undefined,
                  color:
                    tab.id === 'errors' && tab.count > 0
                      ? 'var(--color-warning)'
                      : undefined
                }}
              >
                {tab.label}
                <span
                  style={{
                    marginLeft: '4px',
                    background: 'var(--bg-active)',
                    borderRadius: '100px',
                    padding: '0 5px',
                    fontSize: '10px'
                  }}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        </div>

        {activeTab === 'errors' ? (
          <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {scanResult.errors.length === 0 ? (
              <div style={{ color: 'var(--color-success)', fontSize: '13px', padding: '8px' }}>
                ✓ No errors during scan
              </div>
            ) : (
              scanResult.errors.map((err, i) => (
                <div
                  key={i}
                  style={{
                    padding: '8px 12px',
                    background: 'var(--bg-elevated)',
                    borderRadius: '6px',
                    border: '1px solid rgba(248,113,113,0.2)'
                  }}
                >
                  <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                    {err.path}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--color-error)', marginTop: '2px' }}>
                    {err.error}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <MediaTable
            items={
              activeTab === 'images'
                ? scanResult.images
                : activeTab === 'videos'
                ? scanResult.videos
                : activeTab === 'music'
                ? scanResult.music
                : scanResult.sfx
            }
            type={activeTab === 'images' ? 'image' : activeTab === 'videos' ? 'video' : 'audio'}
          />
        )}
      </div>
    </div>
  )
}
