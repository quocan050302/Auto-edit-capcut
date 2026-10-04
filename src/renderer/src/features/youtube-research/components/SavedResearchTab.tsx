import React, { useState } from 'react'
import type { SavedResearchProject } from '../types/research.types'

interface Props {
  savedProjects: SavedResearchProject[]
  onOpenProject: (proj: SavedResearchProject) => void
  onRenameProject: (id: string, newName: string) => Promise<void>
  onDeleteProject: (id: string) => Promise<void>
  onRefreshData: (proj: SavedResearchProject) => void
  onCreateVideoProject: (keyword: string) => void
}

export function SavedResearchTab({
  savedProjects,
  onOpenProject,
  onRenameProject,
  onDeleteProject,
  onRefreshData,
  onCreateVideoProject
}: Props): React.ReactElement {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameInput, setRenameInput] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleStartRename = (proj: SavedResearchProject) => {
    setRenamingId(proj.id)
    setRenameInput(proj.name)
  }

  const handleSaveRename = async (id: string) => {
    if (!renameInput.trim()) return
    await onRenameProject(id, renameInput.trim())
    setRenamingId(null)
  }

  const handleConfirmDelete = async (id: string) => {
    await onDeleteProject(id)
    setDeletingId(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px 0' }}>
            Saved Research Dossiers ({savedProjects.length})
          </h3>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
            Saved market snapshots. Opening a dossier reads stored local database records without re-querying APIs.
          </p>
        </div>
      </div>

      {savedProjects.length === 0 ? (
        <div style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '40px',
          textAlign: 'center',
          color: 'var(--text-muted)'
        }}>
          No saved research dossiers yet. Run an analysis on the Discover tab and click "Save Research" to preserve market findings.
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
          gap: '16px'
        }}>
          {savedProjects.map((proj) => (
            <div
              key={proj.id}
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '18px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '14px'
              }}
            >
              <div>
                {/* Header / Rename */}
                {renamingId === proj.id ? (
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                    <input
                      type="text"
                      value={renameInput}
                      onChange={(e) => setRenameInput(e.target.value)}
                      style={{
                        flex: 1,
                        background: 'var(--bg-base)',
                        border: '1px solid var(--border-brand)',
                        borderRadius: '4px',
                        padding: '4px 8px',
                        color: 'var(--text-primary)',
                        fontSize: '12px'
                      }}
                      autoFocus
                    />
                    <button className="btn btn-primary" onClick={() => handleSaveRename(proj.id)} style={{ fontSize: '11px', padding: '2px 8px' }}>
                      Save
                    </button>
                    <button className="btn btn-secondary" onClick={() => setRenamingId(null)} style={{ fontSize: '11px', padding: '2px 8px' }}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                      {proj.name}
                    </h4>
                    <button
                      onClick={() => handleStartRename(proj)}
                      style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '11px', padding: '2px' }}
                      title="Rename dossier"
                    >
                      ✏
                    </button>
                  </div>
                )}

                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                  Seed Topic: <strong>{proj.seed_topic}</strong> • Market: <strong>{proj.market}</strong> • {proj.video_count} videos
                </div>

                {proj.top_opportunity_keyword && (
                  <div style={{
                    background: 'var(--bg-base)',
                    padding: '8px 10px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-subtle)',
                    marginBottom: '10px'
                  }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Top Opportunity</div>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: '#34d399', marginTop: '2px' }}>
                      {proj.top_opportunity_keyword} ({Math.round(proj.top_opportunity_score || 0)}/100)
                    </div>
                  </div>
                )}

                {proj.summary_snippet && (
                  <p style={{
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                    lineHeight: 1.4,
                    margin: 0,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}>
                    {proj.summary_snippet}
                  </p>
                )}
              </div>

              {/* Delete confirmation or normal action buttons */}
              {deletingId === proj.id ? (
                <div style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                  <div style={{ fontSize: '11px', color: '#f87171', marginBottom: '8px' }}>Delete this research dossier?</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn"
                      onClick={() => handleConfirmDelete(proj.id)}
                      style={{ background: '#ef4444', color: '#fff', fontSize: '11px', padding: '4px 10px', border: 'none' }}
                    >
                      Confirm Delete
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setDeletingId(null)}
                      style={{ fontSize: '11px', padding: '4px 10px' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingTop: '10px',
                  borderTop: '1px solid var(--border-subtle)'
                }}>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      className="btn btn-primary"
                      onClick={() => onOpenProject(proj)}
                      style={{ fontSize: '11px', padding: '4px 12px' }}
                    >
                      Open Dossier
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => onRefreshData(proj)}
                      style={{ fontSize: '11px', padding: '4px 10px' }}
                      title="Fetch latest YouTube data for this topic"
                    >
                      ⟳ Refresh
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: '6px' }}>
                    {proj.top_opportunity_keyword && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => onCreateVideoProject(proj.top_opportunity_keyword || proj.seed_topic)}
                        style={{ fontSize: '11px', padding: '4px 8px' }}
                        title="Create Video Project"
                      >
                        + Project
                      </button>
                    )}
                    <button
                      onClick={() => setDeletingId(proj.id)}
                      style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '13px', padding: '4px' }}
                      title="Delete dossier"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
