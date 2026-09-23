import React, { useState } from 'react'
import type { ProjectState } from '../../../../shared/types'
import type { TranscriptData } from '../hooks/useTranscribe'

interface TranscriptionPageProps {
  project: ProjectState
  transcript: TranscriptData | null
  isTranscribing: boolean
  transcribeProgress: { message: string; progress: number } | null
  onStartTranscription: (modelName: 'tiny' | 'base' | 'small' | 'medium') => Promise<void>
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}

const MODEL_OPTIONS: {
  value: 'tiny' | 'base' | 'small' | 'medium'
  label: string
  size: string
  speed: string
  quality: string
}[] = [
  { value: 'tiny', label: 'Tiny', size: '~75 MB', speed: 'Fastest', quality: 'Basic' },
  { value: 'base', label: 'Base', size: '~150 MB', speed: 'Fast', quality: 'Good' },
  { value: 'small', label: 'Small', size: '~490 MB', speed: 'Medium', quality: 'Better' },
  { value: 'medium', label: 'Medium', size: '~1.5 GB', speed: 'Slow', quality: 'Best' }
]

export function TranscriptionPage({
  project,
  transcript,
  isTranscribing,
  transcribeProgress,
  onStartTranscription
}: TranscriptionPageProps): React.ReactElement {
  const [selectedModel, setSelectedModel] = useState<'tiny' | 'base' | 'small' | 'medium'>('base')
  const [searchQuery, setSearchQuery] = useState('')

  const hasVoiceover = project.inputs.voiceoverPath !== null

  const filteredSegments = transcript?.segments.filter((seg) =>
    searchQuery ? seg.text.toLowerCase().includes(searchQuery.toLowerCase()) : true
  ) ?? []

  return (
    <div className="page-container">
      {/* Model Selection */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
              </svg>
            </div>
            Audio Transcription
          </div>
          {transcript && (
            <span className="panel-badge badge-success">
              ✓ {transcript.segments.length} segments
            </span>
          )}
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Model picker */}
          <div>
            <div className="settings-label" style={{ marginBottom: '8px' }}>Whisper Model</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px' }}>
              {MODEL_OPTIONS.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setSelectedModel(m.value)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-md)',
                    border: `1px solid ${selectedModel === m.value ? 'var(--border-brand)' : 'var(--border-subtle)'}`,
                    background: selectedModel === m.value ? 'var(--brand-gradient-subtle)' : 'var(--bg-elevated)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s'
                  }}
                >
                  <div style={{ fontSize: '13px', fontWeight: 700, color: selectedModel === m.value ? 'var(--text-brand)' : 'var(--text-primary)', marginBottom: '4px' }}>
                    {m.label}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    {m.size}<br />{m.speed} · {m.quality}
                  </div>
                </button>
              ))}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
              💡 Model sẽ tự download lần đầu (~{MODEL_OPTIONS.find(m => m.value === selectedModel)?.size}). Lần sau dùng lại cache.
            </div>
          </div>

          {/* Voiceover info */}
          <div style={{
            padding: '12px 16px',
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px'
          }}>
            <span style={{ fontSize: '20px' }}>🎙️</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>VOICEOVER</div>
              <div style={{
                fontSize: '12px',
                fontFamily: 'var(--font-mono)',
                color: hasVoiceover ? 'var(--text-secondary)' : 'var(--text-disabled)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>
                {hasVoiceover ? project.inputs.voiceoverPath : 'Chưa chọn voiceover'}
              </div>
            </div>
            {hasVoiceover && <span style={{ color: 'var(--color-success)', fontSize: '16px' }}>✓</span>}
          </div>

          {/* Action */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              className="btn btn-primary"
              onClick={() => onStartTranscription(selectedModel)}
              disabled={!hasVoiceover || isTranscribing}
              id="btn-start-transcription"
              style={{ minWidth: '180px' }}
            >
              {isTranscribing ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    style={{ animation: 'spin 1s linear infinite' }}>
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                    <path d="M12 2a10 10 0 0110 10" strokeLinecap="round" />
                  </svg>
                  Transcribing...
                </>
              ) : transcript ? (
                'Re-transcribe'
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clipRule="evenodd" />
                  </svg>
                  Transcribe Voiceover
                </>
              )}
            </button>

            {isTranscribing && transcribeProgress && (
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {transcribeProgress.message}
                </div>
                <div className="progress-bar-wrap">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${Math.max(0, Math.round(transcribeProgress.progress * 100))}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Transcript viewer */}
      {transcript && (
        <>
          {/* Stats */}
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-value accent">{transcript.segments.length}</div>
              <div className="stat-label">Segments</div>
            </div>
            <div className="stat-card">
              <div className="stat-value accent">{transcript.wordCount}</div>
              <div className="stat-label">Words</div>
            </div>
            <div className="stat-card">
              <div className="stat-value accent">{formatDuration(transcript.duration)}</div>
              <div className="stat-label">Duration</div>
            </div>
            <div className="stat-card">
              <div className="stat-value accent">{transcript.language.toUpperCase()}</div>
              <div className="stat-label">Language</div>
            </div>
          </div>

          {/* Segment table */}
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">Transcript Segments</div>
              <input
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '12px',
                  padding: '6px 10px',
                  outline: 'none',
                  width: '200px'
                }}
                placeholder="Search transcript..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    {['ID', 'Start', 'End', 'Dur', 'Narration Text'].map((h) => (
                      <th key={h} style={{
                        padding: '8px 12px',
                        textAlign: 'left',
                        color: 'var(--text-muted)',
                        fontWeight: 600,
                        fontSize: '10px',
                        letterSpacing: '0.6px',
                        textTransform: 'uppercase',
                        whiteSpace: 'nowrap'
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredSegments.slice(0, 500).map((seg) => (
                    <tr
                      key={seg.id}
                      style={{ borderBottom: '1px solid var(--border-subtle)', transition: 'background 0.1s' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}
                    >
                      <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {seg.id}
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', color: 'var(--color-info)', whiteSpace: 'nowrap' }}>
                        {formatTimestamp(seg.start)}
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {formatTimestamp(seg.end)}
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {seg.duration.toFixed(1)}s
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-primary)', maxWidth: '600px' }}>
                        {searchQuery ? (
                          <HighlightText text={seg.text} query={searchQuery} />
                        ) : seg.text}
                      </td>
                    </tr>
                  ))}
                  {filteredSegments.length > 500 && (
                    <tr>
                      <td colSpan={5} style={{ padding: '8px 12px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        … and {filteredSegments.length - 500} more segments
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!transcript && !isTranscribing && (
        <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
            <div style={{ fontSize: '36px', marginBottom: '12px' }}>🎙️</div>
            Chưa có transcript. Chọn model và nhấn <strong>Transcribe Voiceover</strong>.
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function HighlightText({ text, query }: { text: string; query: string }): React.ReactElement {
  const parts = text.split(new RegExp(`(${query})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} style={{ background: 'rgba(168,85,247,0.3)', color: 'var(--text-primary)', borderRadius: '2px' }}>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}
