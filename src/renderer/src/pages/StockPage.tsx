import React, { useState, useEffect } from 'react'
import type { ProjectState, StockSceneAssignment, StockAsset, StockReviewData } from '../../../../shared/types'

// ─── Props ────────────────────────────────────────────────────────────────────

interface StockPageProps {
  project: ProjectState
  review: StockReviewData | null
  isRunning: boolean
  progress: { message: string; progress: number } | null
  onRun: () => void
  onReplace: (sceneIndex: number, query: string) => Promise<StockAsset | null>
  onLock: (sceneIndex: number, locked: boolean) => Promise<void>
  onUpload: (sceneIndex: number) => Promise<void>
  onLoad: () => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function providerBadge(provider: string): React.ReactElement {
  const colors: Record<string, { bg: string; fg: string }> = {
    pexels: { bg: 'rgba(5, 193, 112, 0.15)', fg: '#05C170' },
    pixabay: { bg: 'rgba(43, 135, 217, 0.15)', fg: '#2B87D9' }
  }
  const c = colors[provider] ?? { bg: 'rgba(255,255,255,0.08)', fg: '#a0a0c0' }
  return (
    <span style={{
      fontSize: '10px', fontWeight: 700, padding: '2px 8px',
      borderRadius: '999px', background: c.bg, color: c.fg,
      letterSpacing: '0.05em', textTransform: 'uppercase'
    }}>
      {provider}
    </span>
  )
}

function statusBadge(status: string): React.ReactElement {
  const map: Record<string, { label: string; color: string }> = {
    assigned: { label: '✓ Assigned', color: 'var(--color-success)' },
    failed: { label: '✗ Failed', color: 'var(--color-error)' },
    pending: { label: '⋯ Pending', color: 'var(--color-pending)' },
    searching: { label: '⟳ Searching', color: 'var(--color-info)' },
    disabled: { label: '⊘ Disabled', color: 'var(--text-muted)' }
  }
  const s = map[status] ?? map.pending
  return (
    <span style={{ fontSize: '10px', fontWeight: 600, color: s.color }}>{s.label}</span>
  )
}

// ─── Replace Modal ────────────────────────────────────────────────────────────

function ReplaceModal({
  assignment,
  onConfirm,
  onClose
}: {
  assignment: StockSceneAssignment
  onConfirm: (query: string) => void
  onClose: () => void
}): React.ReactElement {
  const [query, setQuery] = useState(assignment.searchQueries[0] ?? '')
  const suggestions = assignment.searchQueries

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-lg)',
        padding: '28px', width: '520px',
        boxShadow: 'var(--shadow-lg)'
      }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
          Replace Scene {assignment.sceneIndex}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '20px', lineHeight: 1.5 }}>
          {assignment.narrationText.slice(0, 120)}{assignment.narrationText.length > 120 ? '…' : ''}
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
            SEARCH QUERY
          </label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(query) }}
            placeholder="Enter a short, visual search query…"
            style={{
              width: '100%', background: 'var(--bg-base)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
              fontSize: '13px', padding: '10px 12px', outline: 'none'
            }}
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>
            SUGGESTED QUERIES (click to use)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {suggestions.map((q) => (
              <button
                key={q}
                onClick={() => setQuery(q)}
                style={{
                  background: query === q ? 'var(--brand-gradient-subtle)' : 'var(--bg-overlay)',
                  border: `1px solid ${query === q ? 'var(--border-brand)' : 'var(--border-subtle)'}`,
                  color: query === q ? 'var(--text-brand)' : 'var(--text-secondary)',
                  borderRadius: 'var(--radius-sm)', fontSize: '11px',
                  padding: '4px 10px', cursor: 'pointer'
                }}
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            className="btn btn-secondary"
            onClick={onClose}
            style={{ minWidth: '80px' }}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onConfirm(query)}
            disabled={!query.trim()}
            style={{ minWidth: '120px' }}
          >
            🔍 Search & Replace
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Scene Card ───────────────────────────────────────────────────────────────

function SceneCard({
  assignment,
  projectDir,
  onReplace,
  onLock,
  onUpload
}: {
  assignment: StockSceneAssignment
  projectDir: string
  onReplace: (sceneIndex: number, query: string) => Promise<StockAsset | null>
  onLock: (sceneIndex: number, locked: boolean) => Promise<void>
  onUpload: (sceneIndex: number) => Promise<void>
}): React.ReactElement {
  const [showReplace, setShowReplace] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [locking, setLocking] = useState(false)

  const asset = assignment.asset
  const isAssigned = assignment.status === 'assigned' && asset

  async function handleReplace(query: string): Promise<void> {
    setShowReplace(false)
    setReplacing(true)
    await onReplace(assignment.sceneIndex, query)
    setReplacing(false)
  }

  async function handleLock(): Promise<void> {
    setLocking(true)
    await onLock(assignment.sceneIndex, !assignment.locked)
    setLocking(false)
  }

  return (
    <>
      <div style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${isAssigned ? 'var(--border-default)' : assignment.status === 'failed' ? 'rgba(248,113,113,0.3)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        transition: 'border-color 0.2s',
        position: 'relative'
      }}>
        {/* Lock indicator */}
        {assignment.locked && (
          <div style={{
            position: 'absolute', top: 8, right: 8, zIndex: 2,
            background: 'rgba(251,191,36,0.2)',
            border: '1px solid rgba(251,191,36,0.4)',
            borderRadius: '999px', fontSize: '9px', padding: '2px 7px',
            color: 'var(--color-warning)', fontWeight: 700
          }}>
            🔒 LOCKED
          </div>
        )}
        {assignment.manualOverride && (
          <div style={{
            position: 'absolute', top: 8, right: assignment.locked ? 72 : 8, zIndex: 2,
            background: 'rgba(96,165,250,0.2)',
            border: '1px solid rgba(96,165,250,0.4)',
            borderRadius: '999px', fontSize: '9px', padding: '2px 7px',
            color: 'var(--color-info)', fontWeight: 700
          }}>
            📤 OWN
          </div>
        )}

        {/* Thumbnail */}
        <div style={{ height: '120px', background: 'var(--bg-void)', overflow: 'hidden', position: 'relative' }}>
          {isAssigned && asset?.thumbnailUrl ? (
            <img
              src={asset.thumbnailUrl}
              alt={`Scene ${assignment.sceneIndex}`}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div style={{
              width: '100%', height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column', gap: '6px'
            }}>
              {assignment.status === 'failed' ? (
                <>
                  <span style={{ fontSize: '24px' }}>⚠️</span>
                  <span style={{ fontSize: '10px', color: 'var(--color-error)' }}>No asset found</span>
                </>
              ) : (
                <>
                  <span style={{ fontSize: '24px', opacity: 0.3 }}>🎬</span>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Pending</span>
                </>
              )}
            </div>
          )}

          {/* Score bar overlay */}
          {isAssigned && (
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, height: '3px',
              background: 'rgba(0,0,0,0.5)'
            }}>
              <div style={{
                height: '100%',
                width: `${Math.round(assignment.score * 100)}%`,
                background: assignment.score > 0.6
                  ? 'var(--color-success)'
                  : assignment.score > 0.35
                    ? 'var(--color-warning)'
                    : 'var(--color-error)',
                transition: 'width 0.5s ease'
              }} />
            </div>
          )}
        </div>

        {/* Info */}
        <div style={{ padding: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-muted)' }}>
                S{String(assignment.sceneIndex).padStart(3, '0')}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-brand)' }}>
                {fmt(assignment.startTime)}–{fmt(assignment.endTime)}
              </span>
              {statusBadge(assignment.status)}
            </div>
            {isAssigned && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {providerBadge(asset.provider)}
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                  {Math.round(assignment.score * 100)}%
                </span>
              </div>
            )}
          </div>

          <div style={{
            fontSize: '11px', color: 'var(--text-secondary)',
            lineHeight: 1.4, marginBottom: '8px',
            overflow: 'hidden', display: '-webkit-box',
            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical'
          }}>
            {assignment.narrationText || '(no narration)'}
          </div>

          {isAssigned && (
            <div style={{
              fontSize: '10px', color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)', marginBottom: '8px'
            }}>
              🔍 "{assignment.usedQuery}" · by {asset.creator}
            </div>
          )}

          {assignment.status === 'failed' && assignment.errorMessage && (
            <div style={{ fontSize: '10px', color: 'var(--color-error)', marginBottom: '8px' }}>
              {assignment.errorMessage.slice(0, 80)}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowReplace(true)}
              disabled={replacing || assignment.locked}
              style={{ fontSize: '10px', padding: '4px 8px' }}
              title={assignment.locked ? 'Unlock to replace' : 'Search for different asset'}
            >
              {replacing ? '⟳' : '🔄'} Replace
            </button>
            <button
              className="btn btn-sm"
              onClick={handleLock}
              disabled={locking}
              style={{
                fontSize: '10px', padding: '4px 8px',
                background: assignment.locked ? 'rgba(251,191,36,0.1)' : 'var(--bg-overlay)',
                border: `1px solid ${assignment.locked ? 'rgba(251,191,36,0.4)' : 'var(--border-subtle)'}`,
                color: assignment.locked ? 'var(--color-warning)' : 'var(--text-muted)',
                cursor: 'pointer', borderRadius: 'var(--radius-sm)'
              }}
              title={assignment.locked ? 'Unlock this scene' : 'Lock this scene to prevent auto-replacement'}
            >
              {assignment.locked ? '🔓 Unlock' : '🔒 Lock'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => onUpload(assignment.sceneIndex)}
              style={{
                fontSize: '10px', padding: '4px 8px',
                background: 'var(--bg-overlay)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-muted)', cursor: 'pointer',
                borderRadius: 'var(--radius-sm)'
              }}
              title="Upload your own media for this scene"
            >
              📤 Upload
            </button>
          </div>
        </div>
      </div>

      {showReplace && (
        <ReplaceModal
          assignment={assignment}
          onConfirm={handleReplace}
          onClose={() => setShowReplace(false)}
        />
      )}
    </>
  )
}

// ─── Main Stock Page ──────────────────────────────────────────────────────────

export function StockPage({
  project,
  review,
  isRunning,
  progress,
  onRun,
  onReplace,
  onLock,
  onUpload,
  onLoad
}: StockPageProps): React.ReactElement {

  useEffect(() => {
    onLoad()
  }, [])

  const assigned = review?.assignedScenes ?? 0
  const total = review?.totalScenes ?? 0
  const coverage = total > 0 ? Math.round((assigned / total) * 100) : 0
  const hasPlan = true // will show useful empty state if no plan

  return (
    <div className="page-container">

      {/* ── Header Panel ────────────────────────────────────────────────────── */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm3 2h6v4H7V5zm8 8v2h1v-2h-1zm-2-2H7v4h6v-4zm2 0h1V9h-1v2zm1-4V5h-1v2h1zM5 5v2H4V5h1zm-1 4h1v2H4V9zm1 4H4v2h1v-2z" clipRule="evenodd" />
              </svg>
            </div>
            Stock Media Engine
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {review && total > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  width: '80px', height: '6px', borderRadius: '999px',
                  background: 'var(--bg-overlay)', overflow: 'hidden'
                }}>
                  <div style={{
                    height: '100%', width: `${coverage}%`,
                    background: coverage === 100
                      ? 'var(--color-success)'
                      : coverage > 60
                        ? 'var(--color-warning)'
                        : 'var(--color-info)',
                    transition: 'width 0.4s ease'
                  }} />
                </div>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  {assigned}/{total} scenes ({coverage}%)
                </span>
              </div>
            )}
            <button
              className={`btn ${isRunning ? 'btn-secondary' : 'btn-primary'}`}
              onClick={onRun}
              disabled={isRunning}
              id="btn-run-stock-search"
              style={{ minWidth: '160px' }}
            >
              {isRunning ? '⟳ Running…' : review ? '🔄 Re-run Search' : '🎬 Run Stock Search'}
            </button>
          </div>
        </div>

        {/* Progress bar */}
        {isRunning && progress && (
          <div style={{ padding: '0 20px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{progress.message}</span>
              <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-brand)' }}>
                {Math.round(progress.progress * 100)}%
              </span>
            </div>
            <div style={{ height: '4px', background: 'var(--bg-overlay)', borderRadius: '999px', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${Math.round(progress.progress * 100)}%`,
                background: 'var(--brand-gradient)',
                transition: 'width 0.3s ease',
                borderRadius: '999px'
              }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Instructions / Info ──────────────────────────────────────────────── */}
      {!review && !isRunning && (
        <div className="panel" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🎬</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
            Automatic Stock Media Engine
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.8, maxWidth: '480px', margin: '0 auto 24px' }}>
            After running AI Planning, click <strong>Run Stock Search</strong> to automatically find, rank, and download
            the best matching stock footage from Pexels and Pixabay for each scene in your edit plan.
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', flexWrap: 'wrap' }}>
            {[
              { icon: '🔍', label: 'AI-generated queries', desc: 'Short, visual search terms' },
              { icon: '📊', label: 'Multi-factor ranking', desc: 'Relevance + quality + fit' },
              { icon: '⬇️', label: 'Auto download', desc: 'Saved to project/assets/stock/' },
              { icon: '🔒', label: 'User review', desc: 'Replace, lock, or upload own' }
            ].map((f) => (
              <div key={f.label} style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)', padding: '16px 20px', width: '160px', textAlign: 'center'
              }}>
                <div style={{ fontSize: '24px', marginBottom: '8px' }}>{f.icon}</div>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>{f.label}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{f.desc}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: '24px', fontSize: '11px', color: 'var(--text-muted)' }}>
            Make sure Pexels and/or Pixabay API keys are configured in{' '}
            <strong style={{ color: 'var(--text-brand)' }}>Settings → API Providers</strong>
          </div>
        </div>
      )}

      {/* ── Stats Summary ────────────────────────────────────────────────────── */}
      {review && total > 0 && !isRunning && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
          {[
            { label: 'Total Scenes', value: total, icon: '🎬' },
            {
              label: 'Assigned', value: assigned, icon: '✅',
              color: 'var(--color-success)'
            },
            {
              label: 'Failed', value: total - assigned, icon: '⚠️',
              color: total - assigned > 0 ? 'var(--color-error)' : 'var(--text-muted)'
            },
            { label: 'Coverage', value: `${coverage}%`, icon: '📊' }
          ].map((s) => (
            <div key={s.label} className="stat-card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '20px', marginBottom: '4px' }}>{s.icon}</div>
              <div className="stat-value accent" style={{ color: s.color }}>{s.value}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Scene Grid ───────────────────────────────────────────────────────── */}
      {review && review.assignments.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Scene Assignments</div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {review.assignments.length} scenes · click Replace to find alternatives
            </span>
          </div>
          <div className="panel-body">
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
              gap: '14px'
            }}>
              {review.assignments.map((a) => (
                <SceneCard
                  key={a.sceneId}
                  assignment={a}
                  projectDir={project.projectDir}
                  onReplace={onReplace}
                  onLock={onLock}
                  onUpload={onUpload}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Provider Info ────────────────────────────────────────────────────── */}
      {review && review.assignments.length > 0 && (
        <div className="panel" style={{ background: 'var(--bg-elevated)' }}>
          <div className="panel-body">
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
              <strong style={{ color: 'var(--text-secondary)' }}>Provider chain:</strong>{' '}
              Pexels Video → Pixabay Video → Pexels Photo → Pixabay Photo → Manual Review
              <br />
              <strong style={{ color: 'var(--text-secondary)' }}>Downloads:</strong>{' '}
              Saved to <code style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-brand)' }}>
                {project.projectDir}/assets/stock/
              </code>
              <br />
              <strong style={{ color: 'var(--text-secondary)' }}>License:</strong>{' '}
              Pexels and Pixabay assets are free for commercial use under their respective licenses.
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
