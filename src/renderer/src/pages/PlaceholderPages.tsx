import React from 'react'

export function RenderPage(): React.ReactElement {
  return (
    <div className="page-container">
      <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🎬</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
            Rendering — Coming in Phase 4
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '380px' }}>
            Complete Phases 2 (Audio Transcription) and 3 (Edit Planning) first. The render engine
            will become available after the master edit plan is generated.
          </div>
          <div
            style={{
              marginTop: '24px',
              padding: '12px 20px',
              background: 'var(--brand-gradient-subtle)',
              border: '1px solid var(--border-brand)',
              borderRadius: 'var(--radius-md)',
              display: 'inline-flex',
              flexDirection: 'column',
              gap: '6px',
              textAlign: 'left'
            }}
          >
            {['Phase 2 — Audio Transcription', 'Phase 3 — Edit Planning & Scene Matching', 'Phase 4 — Remotion Renderer', 'Phase 5 — Segment Rendering & Resume', 'Phase 6 — QA & Auto-Repair'].map(
              (p, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: '12px',
                    color: i === 0 ? 'var(--color-info)' : 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)'
                  }}
                >
                  {i === 0 ? '→' : '○'} {p}
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function QAPage(): React.ReactElement {
  return (
    <div className="page-container">
      <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
            QA & Export — Coming in Phase 6
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Automated quality assurance, segment validation, and final FFmpeg assembly.
          </div>
        </div>
      </div>
    </div>
  )
}
