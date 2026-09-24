import React, { useEffect, useState } from 'react'
import type { ProjectState, AudioSection, AudioSfxAssignment } from '../../../../shared/types'
import type { UseAudioDirectorReturn } from '../hooks/useAudioDirector'

// ─── Small helper sub-components ──────────────────────────────────────────────

function ProgressBar({ value }: { value: number }): React.ReactElement {
  return (
    <div style={{
      height: 4, borderRadius: 2,
      background: 'rgba(255,255,255,0.08)',
      overflow: 'hidden'
    }}>
      <div style={{
        width: `${Math.min(100, value * 100)}%`,
        height: '100%',
        background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
        transition: 'width 0.3s ease',
        borderRadius: 2
      }} />
    </div>
  )
}

function LicenseBadge({ license }: { license: string }): React.ReactElement {
  return (
    <span style={{
      fontSize: 10, padding: '2px 6px',
      borderRadius: 999,
      background: 'rgba(99,102,241,0.15)',
      color: '#a5b4fc',
      fontWeight: 600,
      letterSpacing: '0.03em',
      textTransform: 'uppercase'
    }}>
      CC {license}
    </span>
  )
}

function DurationBadge({ secs }: { secs: number }): React.ReactElement {
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return (
    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
      {m}:{String(s).padStart(2, '0')}
    </span>
  )
}

// ─── Music Section Card ────────────────────────────────────────────────────────

interface SectionCardProps {
  section: AudioSection
  projectDir: string
  onApprove: (sectionId: string, approved: boolean) => void
  onVolumeChange: (sectionId: string, db: number) => void
}

function SectionCard({ section, onApprove, onVolumeChange }: SectionCardProps): React.ReactElement {
  const [volumeDb, setVolumeDb] = useState(section.volumeDb ?? -30)

  const candidate = section.musicCandidate
  const downloaded = !!section.approvedLocalPath

  return (
    <div style={{
      background: section.approved
        ? 'rgba(99,102,241,0.08)'
        : 'rgba(255,255,255,0.03)',
      border: `1px solid ${section.approved ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.06)'}`,
      borderRadius: 12,
      padding: 18,
      transition: 'all 0.2s ease'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        {/* Mood icon */}
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0, fontSize: 18
        }}>
          🎵
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2, color: 'var(--text-primary)' }}>
            {section.sectionLabel}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 999,
              background: 'rgba(251,191,36,0.15)', color: '#fbbf24',
              fontWeight: 600, textTransform: 'uppercase'
            }}>{section.mood}</span>
            <DurationBadge secs={section.durationSecs} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {section.sceneIndexes.length} scene{section.sceneIndexes.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Status + toggle */}
        {section.status === 'found' && candidate ? (
          <button
            onClick={() => onApprove(section.sectionId, !section.approved)}
            style={{
              padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
              fontWeight: 600, fontSize: 12,
              background: section.approved
                ? 'rgba(52,211,153,0.15)' : 'rgba(99,102,241,0.15)',
              color: section.approved ? '#34d399' : '#a5b4fc',
              border: `1px solid ${section.approved ? 'rgba(52,211,153,0.3)' : 'rgba(99,102,241,0.3)'}`,
              transition: 'all 0.15s ease',
              flexShrink: 0
            }}
          >
            {section.approved ? '✓ Approved' : 'Approve'}
          </button>
        ) : (
          <span style={{ fontSize: 11, color: '#f87171', fontWeight: 600 }}>No result</span>
        )}
      </div>

      {/* Candidate info */}
      {candidate && (
        <div style={{
          background: 'rgba(255,255,255,0.03)',
          borderRadius: 8, padding: 12, marginBottom: 12
        }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--text-primary)', marginBottom: 2 }}>
                {candidate.title}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                by {candidate.creator}
                {candidate.durationSecs > 0 && <> · <DurationBadge secs={candidate.durationSecs} /></>}
              </div>
            </div>
            <LicenseBadge license={candidate.license} />
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {candidate.tags.slice(0, 5).map((tag) => (
              <span key={tag} style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 999,
                background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)'
              }}>{tag}</span>
            ))}
          </div>

          {/* Attribution link */}
          <div style={{ marginTop: 6 }}>
            <a
              href={candidate.pageUrl}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 10, color: '#6366f1', textDecoration: 'none' }}
            >
              View on Openverse ↗
            </a>
          </div>
        </div>
      )}

      {/* Volume slider (only when approved) */}
      {section.approved && candidate && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 110, flexShrink: 0 }}>
              🔉 Music: <strong style={{ color: '#a5b4fc' }}>{volumeDb} dB</strong>
            </span>
            <input
              type="range"
              min={-45}
              max={-10}
              step={1}
              value={volumeDb}
              onChange={(e) => {
                setVolumeDb(Number(e.target.value))
              }}
              onPointerUp={(e) => {
                // Only save to disk when user releases slider (avoid flooding IPC)
                const v = Number((e.target as HTMLInputElement).value)
                onVolumeChange(section.sectionId, v)
              }}
              style={{ flex: 1, accentColor: '#6366f1' }}
            />
            {downloaded && (
              <span style={{ fontSize: 10, color: '#34d399', flexShrink: 0 }}>✓ Downloaded</span>
            )}
          </div>
          {/* Visual hint bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 110 }}>
            <div style={{
              flex: 1, height: 3, borderRadius: 2,
              background: 'rgba(255,255,255,0.06)', overflow: 'hidden'
            }}>
              <div style={{
                width: `${((volumeDb + 45) / 35) * 100}%`,
                height: '100%',
                background: volumeDb > -20
                  ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
                  : 'linear-gradient(90deg, #6366f1, #34d399)',
                transition: 'width 0.1s ease, background 0.2s ease'
              }} />
            </div>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0, width: 80 }}>
              {volumeDb > -20 ? '⚠ May be loud' : volumeDb < -38 ? 'Very quiet' : 'Good level'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── SFX Row ──────────────────────────────────────────────────────────────────

interface SfxRowProps {
  sfx: AudioSfxAssignment
  projectDir: string
  onApprove: (sceneIndex: number, approved: boolean) => void
}

function SfxRow({ sfx, onApprove }: SfxRowProps): React.ReactElement {
  const candidate = sfx.sfxCandidate
  const downloaded = !!sfx.approvedLocalPath

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 14px',
      background: sfx.approved ? 'rgba(52,211,153,0.05)' : 'rgba(255,255,255,0.02)',
      borderRadius: 8,
      border: `1px solid ${sfx.approved ? 'rgba(52,211,153,0.2)' : 'rgba(255,255,255,0.05)'}`,
    }}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>🔊</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
          Scene {sfx.sceneIndex}
          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — {sfx.sfxQuery}</span>
        </div>
        {candidate && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {candidate.title} by {candidate.creator}
            {candidate.durationSecs > 0 && <> · <DurationBadge secs={candidate.durationSecs} /></>}
          </div>
        )}
      </div>
      {downloaded && <span style={{ fontSize: 10, color: '#34d399', flexShrink: 0 }}>✓</span>}
      {candidate && (
        <button
          onClick={() => onApprove(sfx.sceneIndex, !sfx.approved)}
          style={{
            padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
            fontWeight: 600, fontSize: 11,
            background: sfx.approved ? 'rgba(52,211,153,0.15)' : 'rgba(99,102,241,0.12)',
            color: sfx.approved ? '#34d399' : '#a5b4fc',
            border: `1px solid ${sfx.approved ? 'rgba(52,211,153,0.25)' : 'rgba(99,102,241,0.25)'}`,
            flexShrink: 0
          }}
        >
          {sfx.approved ? '✓' : 'Add'}
        </button>
      )}
    </div>
  )
}

// ─── Main AudioDirectorPage ────────────────────────────────────────────────────

interface AudioDirectorPageProps {
  project: ProjectState
  audioDirector: UseAudioDirectorReturn
}

export function AudioDirectorPage({ project, audioDirector }: AudioDirectorPageProps): React.ReactElement {
  const {
    plan,
    isSearching,
    isDownloading,
    progress,
    downloadProgress,
    lastError,
    runSearch,
    loadPlan,
    approveSection,
    approveSfx,
    approveAll,
    downloadApproved
  } = audioDirector

  const [activeTab, setActiveTab] = useState<'music' | 'sfx'>('music')

  useEffect(() => {
    loadPlan(project.projectDir)
  }, [project.projectDir])

  const approvedMusicCount = plan?.sections.filter((s) => s.approved).length ?? 0
  const downloadedMusicCount = plan?.sections.filter((s) => s.approvedLocalPath).length ?? 0
  const approvedSfxCount = plan?.sfxAssignments.filter((s) => s.approved).length ?? 0
  const downloadedSfxCount = plan?.sfxAssignments.filter((s) => s.approvedLocalPath).length ?? 0
  const hasApproved = approvedMusicCount > 0 || approvedSfxCount > 0
  const allDownloaded = downloadedMusicCount >= approvedMusicCount && downloadedSfxCount >= approvedSfxCount

  const currentProgress = isSearching ? progress : isDownloading ? downloadProgress : null

  return (
    <div className="page-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '24px 28px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18
              }}>🎼</div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Smart Audio Director</h1>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', maxWidth: 480 }}>
              Analyses your narration, groups scenes into musical sections, then finds CC-licensed music &amp; sound effects from Openverse.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {plan && !isSearching && (
              <>
                <button
                  onClick={() => approveAll(project.projectDir)}
                  disabled={isDownloading}
                  className="btn btn-secondary"
                  style={{ fontSize: 12, padding: '8px 14px' }}
                >
                  ✓ Approve All
                </button>
                {hasApproved && !allDownloaded && (
                  <button
                    onClick={() => downloadApproved(project.projectDir)}
                    disabled={isDownloading}
                    className="btn btn-primary"
                    style={{ fontSize: 12, padding: '8px 14px' }}
                  >
                    {isDownloading ? 'Downloading…' : '⬇ Download Approved'}
                  </button>
                )}
              </>
            )}
            <button
              onClick={() => runSearch(project.projectDir)}
              disabled={isSearching || isDownloading}
              className="btn btn-primary"
              style={{ fontSize: 12, padding: '8px 16px' }}
            >
              {isSearching ? '⟳ Searching…' : plan ? '↻ Re-search' : '🎵 Find Audio'}
            </button>
          </div>
        </div>

        {/* Progress bar */}
        {currentProgress && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{currentProgress.message}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{Math.round(currentProgress.progress * 100)}%</span>
            </div>
            <ProgressBar value={currentProgress.progress} />
          </div>
        )}

        {/* Stats row */}
        {plan && (
          <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
            {[
              { label: 'Sections', value: plan.sections.length, icon: '🎵' },
              { label: 'Music found', value: plan.sections.filter((s) => s.status === 'found').length, icon: '✓', color: '#34d399' },
              { label: 'Approved', value: approvedMusicCount, icon: '🎯', color: '#6366f1' },
              { label: 'Downloaded', value: downloadedMusicCount, icon: '💾', color: '#fbbf24' },
              { label: 'SFX', value: plan.sfxAssignments.length, icon: '🔊' }
            ].map((stat) => (
              <div key={stat.label} style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 8, padding: '8px 14px',
                display: 'flex', alignItems: 'center', gap: 8
              }}>
                <span style={{ fontSize: 14 }}>{stat.icon}</span>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: stat.color ?? 'var(--text-primary)' }}>
                    {stat.value}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{stat.label}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        {plan && (
          <div style={{ display: 'flex', gap: 2, marginBottom: -1 }}>
            {(['music', 'sfx'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '8px 18px', borderRadius: '8px 8px 0 0',
                  background: activeTab === tab ? 'rgba(99,102,241,0.12)' : 'transparent',
                  color: activeTab === tab ? '#a5b4fc' : 'var(--text-muted)',
                  border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
                  borderBottom: activeTab === tab ? '2px solid #6366f1' : '2px solid transparent',
                  transition: 'all 0.15s ease'
                }}
              >
                {tab === 'music' ? '🎵 Background Music' : '🔊 Sound Effects'}
                <span style={{
                  marginLeft: 6, fontSize: 10, padding: '1px 6px',
                  borderRadius: 999,
                  background: activeTab === tab ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.06)',
                  color: activeTab === tab ? '#a5b4fc' : 'var(--text-muted)'
                }}>
                  {tab === 'music' ? plan.sections.length : plan.sfxAssignments.length}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 28px 28px' }}>

        {/* Error banner */}
        {lastError && !isSearching && (
          <div style={{
            background: 'rgba(248,113,113,0.1)',
            border: '1px solid rgba(248,113,113,0.3)',
            borderRadius: 10, padding: '14px 18px',
            marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-start'
          }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: '#f87171', marginBottom: 4 }}>
                Search failed
              </div>
              <div style={{ fontSize: 12, color: 'rgba(248,113,113,0.8)' }}>
                {lastError}
              </div>
              {lastError.includes('edit plan') && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  💡 Go to <strong>AI Planning</strong> first to generate the edit plan, then come back here.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!plan && !isSearching && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: 320, gap: 16, textAlign: 'center'
          }}>
            <div style={{ fontSize: 56 }}>🎼</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>No audio plan yet</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 360 }}>
                Click <strong>Find Audio</strong> to analyse your narration and find CC-licensed background music &amp; sound effects from Openverse.
              </div>
            </div>
            <button
              onClick={() => runSearch(project.projectDir)}
              className="btn btn-primary"
              style={{ fontSize: 14, padding: '12px 24px' }}
            >
              🎵 Find Audio
            </button>
          </div>
        )}

        {/* Searching state */}
        {isSearching && !plan && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: 320, gap: 16
          }}>
            <div style={{ fontSize: 48, animation: 'spin 2s linear infinite' }}>🎵</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Searching for audio…</div>
            {progress && (
              <div style={{ width: 320 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, textAlign: 'center' }}>
                  {progress.message}
                </div>
                <ProgressBar value={progress.progress} />
              </div>
            )}
          </div>
        )}

        {/* Music tab */}
        {plan && activeTab === 'music' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {plan.sections.map((section) => (
              <SectionCard
                key={section.sectionId}
                section={section}
                projectDir={project.projectDir}
                onApprove={(sectionId, approved) => approveSection(project.projectDir, sectionId, approved)}
                onVolumeChange={(sectionId, db) => approveSection(project.projectDir, sectionId, true, { volumeDb: db })}
              />
            ))}
          </div>
        )}

        {/* SFX tab */}
        {plan && activeTab === 'sfx' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {plan.sfxAssignments.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 13 }}>
                No SFX candidates found. The engine assigns SFX only when a scene's visual description matches a known action (crowd, rain, footsteps, etc.)
              </div>
            ) : (
              plan.sfxAssignments.map((sfx) => (
                <SfxRow
                  key={sfx.sceneIndex}
                  sfx={sfx}
                  projectDir={project.projectDir}
                  onApprove={(sceneIndex, approved) => approveSfx(project.projectDir, sceneIndex, approved)}
                />
              ))
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
