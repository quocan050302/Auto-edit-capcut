import React, { useState, useEffect } from 'react'
import type { ProjectState } from '../../../../shared/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScenePlan {
  sceneIndex: number
  mediaFile: string
  mediaType: 'video' | 'image'
  startTime: number
  endTime: number
  duration: number
  narrativeText: string
  transcriptSegmentIds: string[]
  transitionIn?: string
  visualNote?: string
}

interface SequencePlan {
  sequenceIndex: number
  title: string
  startTime: number
  endTime: number
  scenes: ScenePlan[]
}

interface ChapterPlan {
  chapterIndex: number
  title: string
  startTime: number
  endTime: number
  sequences: SequencePlan[]
}

interface MasterEditPlan {
  projectName: string
  totalDuration: number
  totalScenes: number
  language: string
  chapters: ChapterPlan[]
  generatedAt: string
  modelUsed: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── Scene Row ────────────────────────────────────────────────────────────────

function SceneRow({ scene, globalIdx }: { scene: ScenePlan; globalIdx: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      style={{
        borderLeft: `3px solid ${scene.mediaType === 'video' ? 'var(--color-info)' : 'var(--color-warning)'}`,
        paddingLeft: '12px',
        marginBottom: '6px',
        cursor: 'pointer'
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-muted)', minWidth: '28px' }}>
          {String(globalIdx).padStart(3, '0')}
        </span>
        <span style={{
          fontSize: '10px', padding: '2px 7px', borderRadius: '999px', fontWeight: 600,
          background: scene.mediaType === 'video' ? 'rgba(96,165,250,0.1)' : 'rgba(251,191,36,0.1)',
          color: scene.mediaType === 'video' ? 'var(--color-info)' : 'var(--color-warning)'
        }}>
          {scene.mediaType === 'video' ? '▶ VID' : '🖼 IMG'}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-brand)', minWidth: '60px' }}>
          {fmt(scene.startTime)}–{fmt(scene.endTime)}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', minWidth: '38px' }}>
          {scene.duration.toFixed(1)}s
        </span>
        <span style={{
          fontSize: '11px', color: 'var(--text-secondary)',
          flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>
          {scene.mediaFile}
        </span>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '8px 0 8px 38px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontStyle: 'italic', lineHeight: 1.5 }}>
            "{scene.narrativeText}"
          </div>
          {scene.visualNote && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              💡 {scene.visualNote}
            </div>
          )}
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            Segments: {scene.transcriptSegmentIds?.join(', ')} · Transition: {scene.transitionIn ?? 'cut'}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Chapter Card ─────────────────────────────────────────────────────────────

function ChapterCard({ chapter, sceneOffset }: { chapter: ChapterPlan; sceneOffset: number }): React.ReactElement {
  const [open, setOpen] = useState(true)
  const allScenes = chapter.sequences.flatMap(s => s.scenes)
  const videoCount = allScenes.filter(s => s.mediaType === 'video').length
  const imageCount = allScenes.filter(s => s.mediaType === 'image').length

  return (
    <div className="panel">
      <div
        className="panel-header"
        onClick={() => setOpen(!open)}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <div className="panel-title">
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: '11px',
            color: 'var(--brand-primary)',
            background: 'var(--brand-gradient-subtle)',
            padding: '2px 8px', borderRadius: '4px', marginRight: '8px'
          }}>
            CH {chapter.chapterIndex}
          </span>
          {chapter.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            {fmt(chapter.startTime)} – {fmt(chapter.endTime)}
          </span>
          <span className="panel-badge badge-new">{allScenes.length} scenes</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {open && (
        <div style={{ padding: '12px 20px' }}>
          <div style={{ display: 'flex', gap: '16px', marginBottom: '12px' }}>
            <span style={{ fontSize: '11px', color: 'var(--color-info)' }}>▶ {videoCount} videos</span>
            <span style={{ fontSize: '11px', color: 'var(--color-warning)' }}>🖼 {imageCount} images</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{chapter.sequences.length} sequences</span>
          </div>
          {chapter.sequences.map((seq) => (
            <div key={seq.sequenceIndex} style={{ marginBottom: '16px' }}>
              <div style={{
                fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)',
                textTransform: 'uppercase', letterSpacing: '0.5px',
                marginBottom: '8px', paddingBottom: '4px',
                borderBottom: '1px solid var(--border-subtle)'
              }}>
                SEQ {seq.sequenceIndex}: {seq.title}
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '8px' }}>
                  {fmt(seq.startTime)}–{fmt(seq.endTime)}
                </span>
              </div>
              {seq.scenes.map((scene, si) => (
                <SceneRow
                  key={scene.sceneIndex}
                  scene={scene}
                  globalIdx={sceneOffset + si + 1}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

interface PlanningPageProps {
  project: ProjectState
}

export function PlanningPage({ project }: PlanningPageProps): React.ReactElement {
  const [plan, setPlan] = useState<MasterEditPlan | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [progress, setProgress] = useState<{ message: string; progress: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [selectedModel, setSelectedModel] = useState('gemini-3.6-flash')

  useEffect(() => {
    // Load cached plan
    window.api.plan.get(project.projectDir).then((p) => {
      if (p) setPlan(p as MasterEditPlan)
    })
    // Check key
    window.api.config.get('geminiApiKey').then((k) => setHasKey(!!k && k.trim().length > 10))
  }, [project.projectDir])

  async function handleGenerate(): Promise<void> {
    setIsGenerating(true)
    setError(null)
    setProgress({ message: 'Starting...', progress: 0 })

    const unsub = window.api.plan.onProgress((data) => {
      setProgress(data)
    })

    try {
      const result = await window.api.plan.generate({ projectDir: project.projectDir, model: selectedModel })
      if (result.success && result.plan) {
        setPlan(result.plan as MasterEditPlan)
      } else {
        setError(result.error ?? 'Unknown error')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsGenerating(false)
      setProgress(null)
      unsub()
    }
  }

  // Compute scene offset per chapter
  const sceneOffsets: number[] = []
  let running = 0
  if (plan) {
    for (const ch of plan.chapters) {
      sceneOffsets.push(running)
      running += ch.sequences.reduce((a, s) => a + s.scenes.length, 0)
    }
  }

  return (
    <div className="page-container">
      {/* Control panel */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z" />
              </svg>
            </div>
            AI Edit Planning
          </div>
          {plan && (
            <span className="panel-badge badge-success">
              ✓ {plan.chapters.length} chapters · {plan.totalScenes} scenes
            </span>
          )}
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Status row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
            {[
              { label: 'Transcript', ok: true, value: '✓ Ready' },
              { label: 'Media Library', ok: true, value: '✓ Ready' },
              { label: 'Gemini API Key', ok: hasKey === true, value: hasKey === true ? '✓ Set' : hasKey === false ? '✗ Missing → Settings' : '...' }
            ].map(({ label, ok, value }) => (
              <div key={label} style={{
                padding: '10px 14px',
                background: 'var(--bg-elevated)',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${ok ? 'var(--border-brand)' : 'var(--border-subtle)'}`
              }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: ok ? 'var(--color-success)' : 'var(--color-error)' }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Model selector + Generate button + progress */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {/* Model dropdown */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Model</div>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isGenerating}
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontSize: '12px',
                  padding: '7px 10px',
                  outline: 'none',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  minWidth: '220px'
                }}
              >
                {GEMINI_MODELS.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              className="btn btn-primary"
              onClick={handleGenerate}
              disabled={isGenerating || hasKey !== true}
              id="btn-generate-plan"
              style={{ minWidth: '180px', alignSelf: 'flex-end', marginBottom: '1px' }}
            >
              {isGenerating ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    style={{ animation: 'spin 1s linear infinite' }}>
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                    <path d="M12 2a10 10 0 0110 10" strokeLinecap="round" />
                  </svg>
                  Generating...
                </>
              ) : plan ? (
                '🔄 Regenerate Plan'
              ) : (
                '✨ Generate Edit Plan'
              )}
            </button>

            {isGenerating && progress && (
              <div style={{ flex: 1, minWidth: '200px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {progress.message}
                </div>
                <div className="progress-bar-wrap">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${Math.max(2, Math.round(progress.progress * 100))}%` }}
                  />
                </div>
              </div>
            )}

            {hasKey === false && !isGenerating && (
              <div style={{ fontSize: '12px', color: 'var(--color-error)' }}>
                ⚠ Set Gemini API key in <strong>Settings</strong> first
              </div>
            )}
          </div>

          {error && (
            <div style={{
              padding: '12px 16px',
              background: 'rgba(248,113,113,0.1)',
              border: '1px solid rgba(248,113,113,0.3)',
              borderRadius: 'var(--radius-md)',
              fontSize: '12px', color: '#fca5a5'
            }}>
              ❌ {error}
            </div>
          )}

          {plan && (
            <div style={{
              fontSize: '11px', color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)'
            }}>
              Generated {new Date(plan.generatedAt).toLocaleString()} · Model: {plan.modelUsed}
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      {plan && (
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-value accent">{plan.chapters.length}</div>
            <div className="stat-label">Chapters</div>
          </div>
          <div className="stat-card">
            <div className="stat-value accent">{plan.chapters.reduce((a, c) => a + c.sequences.length, 0)}</div>
            <div className="stat-label">Sequences</div>
          </div>
          <div className="stat-card">
            <div className="stat-value accent">{plan.totalScenes}</div>
            <div className="stat-label">Scenes</div>
          </div>
          <div className="stat-card">
            <div className="stat-value accent">{fmt(plan.totalDuration)}</div>
            <div className="stat-label">Duration</div>
          </div>
        </div>
      )}

      {/* Chapter breakdown */}
      {plan && plan.chapters.map((chapter, idx) => (
        <ChapterCard
          key={chapter.chapterIndex}
          chapter={chapter}
          sceneOffset={sceneOffsets[idx] ?? 0}
        />
      ))}

      {!plan && !isGenerating && (
        <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
            <div style={{ fontSize: '40px', marginBottom: '12px' }}>🤖</div>
            Click <strong>Generate Edit Plan</strong> để AI phân tích transcript và tạo timeline.
            <br />
            <span style={{ fontSize: '11px', marginTop: '4px', display: 'block' }}>
              Dùng Gemini 1.5 Flash — mất khoảng 30–60 giây
            </span>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

const GEMINI_MODELS = [
  { id: 'gemini-3.6-flash',               label: 'gemini-3.6-flash  (recommended)' },
  { id: 'gemini-3.8-flash',               label: 'gemini-3.8-flash  (latest)' },
  { id: 'gemini-2.5-flash-preview-04-17', label: 'gemini-2.5-flash-preview' },
  { id: 'gemini-2.0-flash',               label: 'gemini-2.0-flash  (stable)' },
  { id: 'gemini-1.5-flash-latest',        label: 'gemini-1.5-flash-latest (legacy)' },
]
