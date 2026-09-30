import React, { useState, useEffect, useRef } from 'react'
import type {
  ProjectState,
  VideoTransitionType,
  TransitionRenderMode,
  RenderQaReport
} from '../../../../shared/types'
import { CollapsibleSection } from '../components/CollapsibleSection'

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
  preflightReport?: RenderQaReport
  qaReport?: RenderQaReport
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
  const [isPreflightRunning, setIsPreflightRunning] = useState(false)
  const [preflightReport, setPreflightReport] = useState<RenderQaReport | null>(null)
  const [showPreflightDetails, setShowPreflightDetails] = useState(false)
  const [copied, setCopied] = useState(false)
  const [progress, setProgress] = useState<RenderProgress | null>(null)
  const [captionProgress, setCaptionProgress] = useState<{ message: string; progress: number } | null>(null)
  const [result, setResult] = useState<RenderResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasPlan, setHasPlan] = useState(false)
  const [sceneCount, setSceneCount] = useState(0)
  const [mediaReadyCount, setMediaReadyCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [audioReady, setAudioReady] = useState(0)
  const startTimeRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Render settings (Preserved exact defaults & types)
  const [resolution, setResolution] = useState<'1920x1080' | '1280x720' | '3840x2160'>('1920x1080')
  const [fps, setFps] = useState<30 | 24 | 60>(30)
  const [outputName, setOutputName] = useState('final_output')

  // Scene transition settings (Preserved exact defaults & types)
  const [transitionEnabled, setTransitionEnabled] = useState(true)
  const [transitionMode, setTransitionMode] = useState<TransitionRenderMode>('smart')
  const [selectedTransition, setSelectedTransition] = useState<VideoTransitionType>('dissolve')
  const [transitionDuration, setTransitionDuration] = useState(0.35)
  const [chapterDuration, setChapterDuration] = useState(0.65)

  const voiceoverPath = project.inputs?.voiceoverPath ?? ''
  const resMap = {
    '1920x1080': { width: 1920, height: 1080 },
    '1280x720': { width: 1280, height: 720 },
    '3840x2160': { width: 3840, height: 2160 }
  }

  // Load plan and initial preflight
  useEffect(() => {
    window.api.plan.get(project.projectDir).then(async (p) => {
      if (p) {
        setHasPlan(true)
        const plan = p as {
          chapters: Array<{
            sequences?: Array<{ scenes?: Array<{ sceneIndex?: number; localPath?: string; mediaFile?: string; localAsset?: string }> }>
            chapters_seq?: Array<{ scenes?: Array<{ sceneIndex?: number; localPath?: string; mediaFile?: string; localAsset?: string }> }>
          }>
        }
        const allScenes = (plan.chapters || []).flatMap(
          (ch) => (ch.sequences ?? ch.chapters_seq ?? []).flatMap((seq) => seq.scenes ?? [])
        )
        setSceneCount(allScenes.length)

        let stockAssignments: Array<{ sceneIndex?: number; sceneId?: string; status?: string; asset?: { localPath?: string } }> = []
        try {
          const review = await window.api.stock?.getReview?.(project.projectDir)
          stockAssignments = review?.assignments ?? []
        } catch { /* ignore */ }

        const ready = allScenes.filter((s) => {
          if (s.localPath || s.mediaFile || s.localAsset) return true
          return stockAssignments.some(
            (a) =>
              (a.sceneIndex === s.sceneIndex || a.sceneId === `scene_${s.sceneIndex}`) &&
              a.status === 'assigned' &&
              !!a.asset?.localPath
          )
        }).length
        setMediaReadyCount(ready)

        // Run background preflight check
        try {
          const initialPreflight = await window.api.render.runPreflight({ projectDir: project.projectDir })
          setPreflightReport(initialPreflight)
          // If preflight has fatal issues, auto-expand details
          if (initialPreflight && initialPreflight.status === 'failed') {
            setShowPreflightDetails(true)
          }
        } catch { /* ignore initial preflight error */ }
      }
    })
    // Check audio plan
    window.api.audio.getPlan(project.projectDir).then((ap) => {
      if (ap) {
        const downloaded = ap.sections.filter((s) => s.approved && s.approvedLocalPath).length
        setAudioReady(downloaded)
      }
    }).catch(() => {})
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

  async function handleCheckPreflight(): Promise<void> {
    setIsPreflightRunning(true)
    setError(null)
    try {
      const pf = await window.api.render.runPreflight({ projectDir: project.projectDir })
      setPreflightReport(pf)
      if (pf && pf.status === 'failed') {
        setShowPreflightDetails(true)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsPreflightRunning(false)
    }
  }

  async function handleRender(): Promise<void> {
    setIsRendering(true)
    setError(null)
    setResult(null)
    setCaptionProgress(null)

    // Step 1: Run preflight QA
    setIsPreflightRunning(true)
    setProgress({ stage: 'Running Preflight QA check...', progress: 0.02 })
    let pfReport: RenderQaReport | null = null
    try {
      pfReport = await window.api.render.runPreflight({ projectDir: project.projectDir })
      setPreflightReport(pfReport)
    } catch (pfErr) {
      console.warn('[RenderPage] Preflight check error:', pfErr)
    } finally {
      setIsPreflightRunning(false)
    }

    // Blocking condition: fatal preflight errors prevent rendering
    if (pfReport && pfReport.status === 'failed') {
      setIsRendering(false)
      setProgress(null)
      setShowPreflightDetails(true)
      const fatalIssues = pfReport.issues.filter((i) => i.severity === 'fatal')
      setError(`Cannot render yet: Preflight QA failed with ${fatalIssues.length} fatal error(s). Render blocked until resolved.`)
      return
    }

    // Step 2: Start render pipeline
    setProgress({ stage: 'Starting render...', progress: 0.05 })
    startTimer()

    const unsub = window.api.render.onProgress((data) => setProgress(data))

    const unsubCaption = window.api.captions?.onRenderProgress?.(
      (data: { message: string; progress: number }) => setCaptionProgress(data)
    )

    const unsubQa = window.api.render.onQaProgress?.(
      (data: { stage: string; progress: number; message: string }) => {
        setProgress({ stage: `QA: ${data.stage} (${data.message})`, progress: data.progress })
      }
    )

    try {
      const res = resolution as keyof typeof resMap
      const response = await window.api.render.start({
        projectDir: project.projectDir,
        voiceoverPath,
        outputName,
        resolution: resMap[res],
        fps,
        transitionSettings: {
          enabled: transitionEnabled,
          mode: transitionMode,
          singleType: transitionMode === 'single' ? selectedTransition : undefined,
          defaultDuration: transitionDuration,
          chapterDuration
        }
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
      setCaptionProgress(null)
      stopTimer()
      unsub()
      unsubCaption?.()
      unsubQa?.()
    }
  }

  const pct = progress ? Math.round(progress.progress * 100) : 0
  const isPreflightFailed = preflightReport?.status === 'failed'
  const isPreflightWarning = preflightReport?.status === 'passed_with_warnings'
  const isPreflightPassed = preflightReport?.status === 'passed'

  return (
    <div className="page-container render-page-shell">
      {/* ── LAYER 1: CLIENT SUMMARY & ABOVE-THE-FOLD PRIMARY ACTION ── */}
      <div className="panel render-hero-card">
        <div className="panel-header render-hero-header">
          <div className="panel-title">
            <span className="panel-title-icon">🎬</span>
            {result ? 'Render Complete' : isRendering ? 'Rendering Video' : isPreflightFailed ? 'Cannot render yet' : 'Ready to render'}
          </div>
          {result && <span className="panel-badge badge-success">✓ Output Ready</span>}
          {isRendering && (
            <span className="panel-badge badge-warning" style={{ animation: 'pulse 1.5s infinite' }}>
              ● Rendering... {pct}%
            </span>
          )}
          {!result && !isRendering && (
            <span className={`panel-badge ${isPreflightFailed ? 'badge-error' : 'badge-success'}`}>
              {isPreflightFailed ? 'Issues to resolve' : 'Preflight OK'}
            </span>
          )}
        </div>

        <div className="panel-body">
          {/* Summary Cards Grid */}
          <div className="render-summary-grid">
            <div className="render-summary-card">
              <span className="render-summary-card__label">Scenes</span>
              <span className={`render-summary-card__value ${mediaReadyCount >= sceneCount && sceneCount > 0 ? 'text-success' : ''}`}>
                {sceneCount > 0 ? `${mediaReadyCount}/${sceneCount} ready` : '—'}
              </span>
            </div>

            <div className="render-summary-card">
              <span className="render-summary-card__label">Voiceover</span>
              <span className={`render-summary-card__value ${voiceoverPath ? 'text-success' : 'text-muted'}`}>
                {voiceoverPath ? 'Ready' : 'Not set'}
              </span>
            </div>

            <div className="render-summary-card">
              <span className="render-summary-card__label">Captions</span>
              <span className={`render-summary-card__value ${hasPlan ? 'text-success' : 'text-muted'}`}>
                {hasPlan ? 'Ready' : 'Pending'}
              </span>
            </div>

            <div className="render-summary-card">
              <span className="render-summary-card__label">Soundtrack</span>
              <span className={`render-summary-card__value ${audioReady > 0 ? 'text-brand' : 'text-muted'}`}>
                {audioReady > 0 ? `${audioReady} tracks` : 'Voice only'}
              </span>
            </div>

            <div className="render-summary-card">
              <span className="render-summary-card__label">Quality Check</span>
              <span className={`render-summary-card__value ${
                isPreflightFailed
                  ? 'text-error'
                  : isPreflightWarning
                  ? 'text-warning'
                  : isPreflightPassed
                  ? 'text-success'
                  : 'text-muted'
              }`}>
                {isPreflightFailed
                  ? `${preflightReport?.fatalCount} blocking`
                  : isPreflightWarning
                  ? `Passed (${preflightReport?.warningCount} notices)`
                  : isPreflightPassed
                  ? 'Passed'
                  : 'Pending'}
              </span>
            </div>

            <div className="render-summary-card">
              <span className="render-summary-card__label">Output Format</span>
              <span className="render-summary-card__value">
                {resolution.split('x')[1]}p · {fps}fps
              </span>
            </div>
          </div>

          {/* PRIMARY ACTION BAR - ABOVE THE FOLD */}
          <div className="render-action-bar">
            <div className="render-action-bar__left">
              <button
                id="btn-start-render"
                type="button"
                className="btn btn-primary btn-lg"
                onClick={handleRender}
                disabled={isRendering || isPreflightRunning || !hasPlan || isPreflightFailed}
                style={{ minWidth: '220px', minHeight: '44px', fontWeight: 700 }}
              >
                {isRendering || isPreflightRunning ? (
                  <>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      style={{ animation: 'spin 1s linear infinite', marginRight: '8px' }}
                    >
                      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                      <path d="M12 2a10 10 0 0110 10" strokeLinecap="round" />
                    </svg>
                    {isPreflightRunning ? 'Running Preflight...' : `Rendering... ${pct}%`}
                  </>
                ) : result ? (
                  '🔄 Re-render Video'
                ) : isPreflightFailed ? (
                  'Cannot render yet'
                ) : (
                  '▶ Start Render'
                )}
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCheckPreflight}
                disabled={isRendering || isPreflightRunning || !hasPlan}
                style={{ minHeight: '44px' }}
              >
                <span>🛡️</span>
                <span>Re-check Quality</span>
              </button>
            </div>

            {isRendering && (
              <div className="render-action-bar__right">
                <span className="text-sm font-mono text-muted">
                  ⏱ Elapsed: {fmt(elapsed)}
                </span>
              </div>
            )}
          </div>

          {/* Preflight QA Summary Bar with View Details toggle */}
          {preflightReport && (
            <div className={`preflight-summary-bar ${isPreflightFailed ? 'is-failed' : isPreflightWarning ? 'is-warning' : 'is-passed'}`}>
              <div className="preflight-summary-bar__left">
                <span className="preflight-summary-bar__icon">
                  {isPreflightFailed ? '❌' : isPreflightWarning ? '⚠️' : '✓'}
                </span>
                <span className="preflight-summary-bar__text">
                  {isPreflightFailed && `Quality check blocked: ${preflightReport.fatalCount} fatal error(s) must be resolved before rendering.`}
                  {isPreflightWarning && `Quality check passed: ${preflightReport.warningCount} non-blocking recommendations.`}
                  {isPreflightPassed && 'Quality check passed: All media, timing and audio tracks verified.'}
                </span>
              </div>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowPreflightDetails((prev) => !prev)}
              >
                {showPreflightDetails ? 'Hide Details' : 'View Details'}
              </button>
            </div>
          )}

          {/* Detailed Preflight Metrics & Issues (Toggled or Auto-opened on Fatal) */}
          {showPreflightDetails && preflightReport && (
            <div className="preflight-details-panel">
              {/* 7 Preflight Metrics */}
              <div className="preflight-metrics-grid">
                {[
                  { label: 'Scenes checked', value: preflightReport.totalScenes, ok: preflightReport.totalScenes > 0 },
                  { label: 'Media resolved', value: `${preflightReport.resolvedScenes}/${preflightReport.totalScenes}`, ok: preflightReport.resolvedScenes === preflightReport.totalScenes },
                  { label: 'Missing media', value: preflightReport.missingScenes, ok: preflightReport.missingScenes === 0, isWarn: preflightReport.missingScenes > 0 },
                  { label: 'Duration expected', value: fmt(preflightReport.expectedDuration), ok: preflightReport.expectedDuration > 0 },
                  {
                    label: 'Caption notices',
                    value: preflightReport.issues.filter((i) => i.category === 'caption').length,
                    ok: preflightReport.issues.filter((i) => i.category === 'caption').length === 0,
                    isWarn: preflightReport.issues.filter((i) => i.category === 'caption').length > 0
                  },
                  {
                    label: 'Audio notices',
                    value: preflightReport.issues.filter((i) => i.category === 'audio').length,
                    ok: preflightReport.issues.filter((i) => i.category === 'audio').length === 0,
                    isWarn: preflightReport.issues.filter((i) => i.category === 'audio').length > 0
                  },
                  {
                    label: 'Transition notices',
                    value: preflightReport.issues.filter((i) => i.category === 'transition').length,
                    ok: preflightReport.issues.filter((i) => i.category === 'transition').length === 0,
                    isWarn: preflightReport.issues.filter((i) => i.category === 'transition').length > 0
                  }
                ].map((m) => (
                  <div key={m.label} className="preflight-metric-card">
                    <div className="preflight-metric-label">{m.label}</div>
                    <div className={`preflight-metric-value ${m.ok ? 'text-success' : m.isWarn ? 'text-warning' : 'text-error'}`}>
                      {m.value}
                    </div>
                  </div>
                ))}
              </div>

              {/* Issue list */}
              {preflightReport.issues.length > 0 && (
                <div className="preflight-issues-list">
                  {preflightReport.issues.map((issue) => (
                    <div
                      key={issue.id}
                      className={`preflight-issue-item ${issue.severity === 'fatal' ? 'is-fatal' : issue.severity === 'warning' ? 'is-warning' : 'is-info'}`}
                    >
                      <span className="preflight-issue-icon">
                        {issue.severity === 'fatal' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️'}
                      </span>
                      <div className="preflight-issue-content">
                        <div className="preflight-issue-header">
                          <span className="preflight-issue-badge">{issue.category}</span>
                          <span className="preflight-issue-severity">
                            {issue.severity === 'fatal' ? 'Blocking Error' : 'Recommendation'}
                          </span>
                        </div>
                        <div className="preflight-issue-msg">{issue.message}</div>
                        {issue.suggestion && (
                          <div className="preflight-issue-suggestion">💡 {issue.suggestion}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── LAYER 2: ADVANCED RENDER SETTINGS ACCORDION ── */}
      <CollapsibleSection
        title="Advanced render settings"
        subtitle="Resolution, frame rate, output naming, and FFmpeg cinematic scene transitions."
        summaryWhenClosed={`${resolution} · ${fps}fps · Transitions: ${transitionEnabled ? (transitionMode === 'smart' ? 'Smart / Auto' : selectedTransition) : 'Disabled'}`}
        icon={<span>⚙️</span>}
        defaultOpen={false}
        className="advanced-settings-panel"
      >
        <div className="advanced-settings-grid">
          <div className="settings-field">
            <label className="settings-label">Output Resolution</label>
            <select
              className="settings-select"
              value={resolution}
              onChange={(e) => setResolution(e.target.value as typeof resolution)}
              disabled={isRendering}
            >
              <option value="1280x720">1280×720 HD</option>
              <option value="1920x1080">1920×1080 Full HD (Recommended)</option>
              <option value="3840x2160">3840×2160 4K Ultra HD</option>
            </select>
          </div>

          <div className="settings-field">
            <label className="settings-label">Frame Rate (FPS)</label>
            <select
              className="settings-select"
              value={fps}
              onChange={(e) => setFps(Number(e.target.value) as typeof fps)}
              disabled={isRendering}
            >
              <option value={24}>24 fps (Cinematic)</option>
              <option value={30}>30 fps (Standard)</option>
              <option value={60}>60 fps (Smooth)</option>
            </select>
          </div>

          <div className="settings-field" style={{ gridColumn: 'span 2' }}>
            <label className="settings-label">Output Filename</label>
            <input
              className="input-text font-mono"
              value={outputName}
              onChange={(e) => setOutputName(e.target.value)}
              disabled={isRendering}
              placeholder="final_output"
            />
          </div>
        </div>

        {/* Scene Transitions Sub-section */}
        <div className="transition-settings-box">
          <div className="transition-header-row">
            <div>
              <div className="text-sm font-semibold">Cinematic Scene Transitions</div>
              <div className="text-xs text-muted">FFmpeg hardware-accelerated transitions between cut scenes</div>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={transitionEnabled}
                onChange={(e) => setTransitionEnabled(e.target.checked)}
                disabled={isRendering}
              />
              <span>Enable transitions</span>
            </label>
          </div>

          {transitionEnabled && (
            <div className="transition-controls-grid">
              <div className="settings-field">
                <label className="settings-label">Transition Mode</label>
                <select
                  className="settings-select"
                  value={transitionMode}
                  onChange={(e) => setTransitionMode(e.target.value as TransitionRenderMode)}
                  disabled={isRendering}
                >
                  <option value="smart">Smart / Follow Edit Plan</option>
                  <option value="single">Single Transition</option>
                </select>
              </div>

              {transitionMode === 'single' && (
                <div className="settings-field">
                  <label className="settings-label">Transition Type</label>
                  <select
                    className="settings-select"
                    value={selectedTransition}
                    onChange={(e) => setSelectedTransition(e.target.value as VideoTransitionType)}
                    disabled={isRendering}
                  >
                    <option value="fade">Fade</option>
                    <option value="dissolve">Dissolve</option>
                    <option value="wipeleft">Wipe Left</option>
                    <option value="wiperight">Wipe Right</option>
                    <option value="slideleft">Slide Left</option>
                    <option value="slideright">Slide Right</option>
                    <option value="smoothleft">Smooth Left</option>
                    <option value="smoothright">Smooth Right</option>
                    <option value="circleopen">Circle Open</option>
                    <option value="circleclose">Circle Close</option>
                    <option value="pixelize">Pixelize</option>
                    <option value="zoomin">Zoom In</option>
                  </select>
                </div>
              )}

              <div className="settings-field">
                <label className="settings-label">Default Duration (s)</label>
                <input
                  type="number"
                  min={0.15}
                  max={1.0}
                  step={0.05}
                  value={transitionDuration}
                  onChange={(e) => setTransitionDuration(parseFloat(e.target.value) || 0.35)}
                  disabled={isRendering}
                  className="input-text font-mono"
                />
              </div>

              <div className="settings-field">
                <label className="settings-label">Chapter Duration (s)</label>
                <input
                  type="number"
                  min={0.25}
                  max={1.2}
                  step={0.05}
                  value={chapterDuration}
                  onChange={(e) => setChapterDuration(parseFloat(e.target.value) || 0.65)}
                  disabled={isRendering}
                  className="input-text font-mono"
                />
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* ── RENDERING PROGRESS OVERLAY / CARD ── */}
      {isRendering && progress && (
        <div className="panel render-progress-card">
          <div className="panel-header">
            <div className="panel-title">Render Progress</div>
            <span className="font-mono text-brand font-bold">{pct}%</span>
          </div>
          <div className="panel-body">
            <div className="progress-bar-wrap" style={{ height: '8px', marginBottom: '8px' }}>
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
            <div className="text-sm text-secondary">{progress.stage}</div>

            {/* Remotion caption overlay progress */}
            {captionProgress && (
              <div className="mt-4">
                <div className="flex justify-between text-xs text-muted mb-2">
                  <span>🎬 Dynamic Captions Overlay</span>
                  <span className="font-mono text-brand">
                    {Math.round(captionProgress.progress * 100)}%
                  </span>
                </div>
                <div className="progress-bar-wrap" style={{ height: '6px' }}>
                  <div
                    className="progress-bar-fill"
                    style={{
                      width: `${Math.max(1, Math.round(captionProgress.progress * 100))}%`,
                      background: 'linear-gradient(90deg, #6366f1, #a5b4fc)'
                    }}
                  />
                </div>
                <div className="text-xs text-muted mt-2">{captionProgress.message}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ERROR ALERT ── */}
      {error && (
        <div className="status-banner status-banner--error">
          <div className="status-banner__icon"><span>✕</span></div>
          <div className="status-banner__content">
            <div className="status-banner__title">Render Interrupted</div>
            <div className="status-banner__message font-mono text-xs">{error}</div>
          </div>
        </div>
      )}

      {/* ── COMPLETED RESULT CARD ── */}
      {result && (
        <div className="panel render-result-card">
          <div className="panel-header">
            <div className="panel-title">
              <span className="panel-title-icon text-success">✓</span>
              Render Complete!
            </div>
            <span className="panel-badge badge-success">
              {fmtBytes(result.fileSizeBytes)}
            </span>
          </div>

          <div className="panel-body">
            <div className="stats-grid mb-4">
              <div className="stat-card">
                <div className="stat-value accent">{fmt(result.durationSecs)}</div>
                <div className="stat-label">Duration</div>
              </div>
              <div className="stat-card">
                <div className="stat-value accent">{fmtBytes(result.fileSizeBytes)}</div>
                <div className="stat-label">File Size</div>
              </div>
              <div className="stat-card">
                <div className="stat-value accent">{fmt(elapsed)}</div>
                <div className="stat-label">Render Time</div>
              </div>
              <div className="stat-card">
                <div className="stat-value accent">{resolution}</div>
                <div className="stat-label">Resolution</div>
              </div>
            </div>

            {/* Postflight QA Audit notes */}
            {result.qaReport && result.qaReport.issues.length > 0 && (
              <div className="postflight-audit-box mb-4">
                <div className="text-xs font-semibold text-secondary mb-2">
                  🛡️ Postflight QA Audit ({result.qaReport.issues.length} notice{result.qaReport.issues.length > 1 ? 's' : ''})
                </div>
                <div className="flex flex-col gap-2">
                  {result.qaReport.issues.map((iss) => (
                    <div key={iss.id} className="text-xs text-muted">
                      {iss.severity === 'warning' ? '⚠️' : 'ℹ️'} {iss.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="output-path-pill mb-4 font-mono text-xs">
              📁 {result.outputPath}
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  navigator.clipboard.writeText(result.outputPath)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 3000)
                }}
              >
                {copied ? '✓ Path Copied to Clipboard!' : '📋 Copy Output Path'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
