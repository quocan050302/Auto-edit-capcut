import React, { useState, useEffect, useRef } from 'react'
import type { ProjectState } from '../../../../shared/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RenderProgress {
  stage: string
  sceneIndex?: number
  totalScenes?: number
  progress: number
}

interface RenderResult {
  outputPath: string
  durationSecs: number
  fileSizeBytes: number
}

interface RenderPageProps {
  project: ProjectState
}

function fmt(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtBytes(bytes: number): string {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

// ─── Render Page ──────────────────────────────────────────────────────────────

export function RenderPage({ project }: RenderPageProps): React.ReactElement {
  const [isRendering, setIsRendering] = useState(false)
  const [progress, setProgress] = useState<RenderProgress | null>(null)
  const [result, setResult] = useState<RenderResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasPlan, setHasPlan] = useState(false)
  const [sceneCount, setSceneCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const startTimeRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Render settings
  const [resolution, setResolution] = useState<'1920x1080' | '1280x720' | '3840x2160'>('1920x1080')
  const [fps, setFps] = useState<30 | 24 | 60>(30)
  const [outputName, setOutputName] = useState('final_output')

  const voiceoverPath = project.inputs?.voiceoverPath ?? ''
  const resMap = {
    '1920x1080': { width: 1920, height: 1080 },
    '1280x720': { width: 1280, height: 720 },
    '3840x2160': { width: 3840, height: 2160 }
  }

  useEffect(() => {
    window.api.plan.get(project.projectDir).then((p) => {
      if (p) {
        setHasPlan(true)
        const plan = p as { chapters: Array<{ sequences: Array<{ scenes: unknown[] }> }> }
        const total = plan.chapters.reduce(
          (a, ch) => a + ch.sequences.reduce((b, seq) => b + seq.scenes.length, 0), 0
        )
        setSceneCount(total)
      }
    })
  }, [project.projectDir])

  function startTimer(): void {
    startTimeRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - (startTimeRef.current ?? Date.now())) / 1000))
    }, 1000)
  }

  function stopTimer(): void {
    if (timerRef.current) clearInterval(timerRef.current)
  }

  async function handleRender(): Promise<void> {
    setIsRendering(true)
    setError(null)
    setResult(null)
    setProgress({ stage: 'Starting...', progress: 0 })
    startTimer()

    const unsub = window.api.render.onProgress((data) => setProgress(data))

    try {
      const res = resolution as keyof typeof resMap
      const response = await window.api.render.start({
        projectDir: project.projectDir,
        voiceoverPath,
        outputName,
        resolution: resMap[res],
        fps
      })

      if (response.success && response.result) {
        setResult(response.result as RenderResult)
      } else {
        setError(response.error ?? 'Render failed')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRendering(false)
      setProgress(null)
      stopTimer()
      unsub()
    }
  }

  const pct = progress ? Math.round(progress.progress * 100) : 0

  return (
    <div className="page-container">

      {/* ── Status bar ─────────────────────────────── */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
              </svg>
            </div>
            Render Video
          </div>
          {result && <span className="panel-badge badge-success">✓ Complete</span>}
          {isRendering && <span className="panel-badge badge-warning" style={{ animation: 'pulse 1.5s infinite' }}>● Rendering</span>}
        </div>
        <div className="panel-body">
          {/* Pre-flight checks */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginBottom: '20px' }}>
            {[
              { label: 'Edit Plan', ok: hasPlan, value: hasPlan ? '✓ Ready' : '✗ Missing → AI Planning' },
              { label: 'Voiceover', ok: !!voiceoverPath, value: voiceoverPath ? `✓ ${voiceoverPath.split(/[\/\\]/).pop()}` : '⚠ Not set (optional)' },
              { label: 'Output Format', ok: true, value: `${resolution} · ${fps}fps` }
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

          {/* Settings row */}
          <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', marginBottom: '20px', flexWrap: 'wrap' }}>
            <div className="settings-field" style={{ flex: 1, minWidth: '180px' }}>
              <label className="settings-label">Resolution</label>
              <select
                className="settings-select"
                value={resolution}
                onChange={(e) => setResolution(e.target.value as typeof resolution)}
                disabled={isRendering}
              >
                <option value="1280x720">1280×720 HD</option>
                <option value="1920x1080">1920×1080 Full HD</option>
                <option value="3840x2160">3840×2160 4K</option>
              </select>
            </div>
            <div className="settings-field" style={{ flex: 1, minWidth: '120px' }}>
              <label className="settings-label">Frame Rate</label>
              <select
                className="settings-select"
                value={fps}
                onChange={(e) => setFps(Number(e.target.value) as typeof fps)}
                disabled={isRendering}
              >
                <option value={24}>24 fps</option>
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </div>
            <div className="settings-field" style={{ flex: 2, minWidth: '200px' }}>
              <label className="settings-label">Output filename</label>
              <input
                style={{
                  background: 'var(--bg-base)', border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)', fontSize: '12px',
                  padding: '9px 12px', outline: 'none', width: '100%'
                }}
                value={outputName}
                onChange={(e) => setOutputName(e.target.value)}
                disabled={isRendering}
                placeholder="final_output"
              />
            </div>
          </div>

          {/* Action button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button
              id="btn-start-render"
              className={`btn btn-primary btn-lg`}
              onClick={handleRender}
              disabled={isRendering || !hasPlan}
              style={{ minWidth: '200px' }}
            >
              {isRendering ? (
                <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ animation: 'spin 1s linear infinite', marginRight: '8px' }}>
                  <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                  <path d="M12 2a10 10 0 0110 10" strokeLinecap="round" />
                </svg>Rendering... {pct}%</>
              ) : result ? (
                '🔄 Re-render'
              ) : (
                '▶ Start Render'
              )}
            </button>
            {isRendering && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                ⏱ {fmt(elapsed)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Progress ────────────────────────────────── */}
      {isRendering && progress && (
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Render Progress</div>
            <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--brand-primary)' }}>
              {pct}%
            </span>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="progress-bar-wrap" style={{ height: '10px' }}>
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.max(2, pct)}%`, transition: 'width 0.4s ease' }}
              />
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              {progress.stage}
            </div>
            {progress.sceneIndex && progress.totalScenes && (
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {Array.from({ length: progress.totalScenes }, (_, i) => (
                  <div
                    key={i}
                    style={{
                      width: '20px', height: '6px', borderRadius: '3px',
                      background: i < (progress.sceneIndex ?? 0)
                        ? 'var(--color-success)'
                        : i === (progress.sceneIndex ?? 0) - 1
                          ? 'var(--brand-primary)'
                          : 'var(--bg-active)',
                      transition: 'background 0.3s'
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Error ───────────────────────────────────── */}
      {error && (
        <div className="panel" style={{ border: '1px solid rgba(248,113,113,0.3)' }}>
          <div className="panel-body">
            <div style={{ fontSize: '13px', color: '#fca5a5', fontWeight: 600, marginBottom: '8px' }}>
              ❌ Render Failed
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {error}
            </div>
          </div>
        </div>
      )}

      {/* ── Result ──────────────────────────────────── */}
      {result && (
        <div className="panel" style={{ border: '1px solid rgba(52,211,153,0.3)' }}>
          <div className="panel-header">
            <div className="panel-title">
              <div className="panel-title-icon" style={{ background: 'rgba(52,211,153,0.2)' }}>
                <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--color-success)">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              </div>
              Render Complete!
            </div>
            <span style={{ fontSize: '11px', color: 'var(--color-success)', fontWeight: 700 }}>
              ✓ {fmtBytes(result.fileSizeBytes)}
            </span>
          </div>
          <div className="panel-body">
            <div className="stats-grid" style={{ marginBottom: '16px' }}>
              {[
                { label: 'Duration', value: fmt(result.durationSecs) },
                { label: 'File Size', value: fmtBytes(result.fileSizeBytes) },
                { label: 'Render Time', value: fmt(elapsed) },
                { label: 'Resolution', value: resolution }
              ].map(({ label, value }) => (
                <div key={label} className="stat-card">
                  <div className="stat-value accent" style={{ fontSize: '16px' }}>{value}</div>
                  <div className="stat-label">{label}</div>
                </div>
              ))}
            </div>

            <div style={{
              padding: '12px 16px',
              background: 'var(--bg-base)',
              borderRadius: 'var(--radius-md)',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              color: 'var(--color-success)',
              marginBottom: '12px',
              wordBreak: 'break-all'
            }}>
              📁 {result.outputPath}
            </div>

            <button
              className="btn btn-secondary"
              onClick={() => {
                // Copy path to clipboard as fallback
                navigator.clipboard.writeText(result!.outputPath)
                alert(`Output saved to:\n${result!.outputPath}\n\n(Path copied to clipboard)`)
              }}
              style={{ marginRight: '8px' }}
            >
              📋 Copy Output Path
            </button>
          </div>
        </div>
      )}

      {/* ── Info panel ──────────────────────────────── */}
      {!isRendering && !result && !error && (
        <div className="panel" style={{ background: 'var(--bg-elevated)' }}>
          <div className="panel-body">
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 2 }}>
              <div>🎬 <strong style={{ color: 'var(--text-secondary)' }}>{sceneCount} scenes</strong> sẽ được ghép theo edit plan</div>
              <div>🎵 Voiceover audio sẽ được mix vào toàn bộ video</div>
              <div>⚡ FFmpeg xử lý từng scene → concat → mix audio</div>
              <div>💾 Output lưu tại <code style={{ fontSize: '11px', color: 'var(--brand-primary)' }}>{project.projectDir}\output\</code></div>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
