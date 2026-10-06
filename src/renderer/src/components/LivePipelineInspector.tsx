import React, { useEffect, useRef, useState } from 'react'
import type { AutoPipelineState, PipelineStage, StageStatus, ClaimEvidenceLedger } from '../../../../shared/types'
import { STAGE_DESCRIPTIONS } from '../navigation/pipelineStageNavigation'

export interface LivePipelineInspectorProps {
  isOpen: boolean
  pipelineState: AutoPipelineState | null
  selectedStage: PipelineStage | null
  followCurrentStage: boolean
  onSelectStage: (stage: PipelineStage) => void
  onFollowCurrentStageChange: (follow: boolean) => void
  onClose: () => void
  onOpenFullWorkspace: (stage: PipelineStage) => void
  onRetryStage?: (stage: PipelineStage) => Promise<boolean>
}

const EXECUTION_STAGES: PipelineStage[] = [
  'validating',
  'transcribing',
  'planning',
  'captions',
  'global-context',
  'stock-search',
  'audio-search',
  'preflight',
  'rendering',
  'postflight'
]

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return '—'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m ${remSecs}s`
}

function formatTime(isoString?: string): string {
  if (!isoString) return '—'
  try {
    const d = new Date(isoString)
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return '—'
  }
}

export function LivePipelineInspector({
  isOpen,
  pipelineState,
  selectedStage,
  followCurrentStage,
  onSelectStage,
  onFollowCurrentStageChange,
  onClose,
  onOpenFullWorkspace,
  onRetryStage
}: LivePipelineInspectorProps): React.ReactElement | null {
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const [claimLedger, setClaimLedger] = useState<ClaimEvidenceLedger | null>(null)
  const [visualTruthData, setVisualTruthData] = useState<any>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const previousActiveElementRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!isOpen || !pipelineState?.projectDir) return
    window.api.claims?.getLedger(pipelineState.projectDir).then((l) => {
      if (l) setClaimLedger(l)
    }).catch(() => {})
    window.api.visualTruth?.getData(pipelineState.projectDir).then((vt) => {
      if (vt) setVisualTruthData(vt)
    }).catch(() => {})
  }, [isOpen, pipelineState?.projectDir, selectedStage])

  // Lưu focus element trước khi mở drawer để trả lại focus khi đóng
  useEffect(() => {
    if (isOpen) {
      previousActiveElementRef.current = document.activeElement as HTMLElement
      drawerRef.current?.focus()
    } else if (previousActiveElementRef.current) {
      previousActiveElementRef.current.focus()
      previousActiveElementRef.current = null
    }
  }, [isOpen])

  // Lắng nghe phím Escape để đóng drawer
  useEffect(() => {
    if (!isOpen) return

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  // Fallback stage nếu selectedStage null
  const currentStage = (pipelineState?.currentStage as PipelineStage) || 'validating'
  const effectiveStage: PipelineStage = selectedStage || currentStage

  const stageData = pipelineState?.stages?.[effectiveStage]
  const stageStatus: StageStatus = stageData?.status ?? 'pending'
  const progressPct = Math.min(100, Math.max(0, Math.round((stageData?.progress ?? 0) * 100)))

  const stageMeta = STAGE_DESCRIPTIONS[effectiveStage] || {
    title: effectiveStage,
    friendlyAction: 'Processing step',
    description: 'Autonomous video generation step in progress.',
    stageNumber: EXECUTION_STAGES.indexOf(effectiveStage) + 1 || 1,
    totalStages: 10,
    workspacePageTitle: 'Workspace'
  }

  const isCurrentActive = currentStage === effectiveStage && pipelineState?.overallStatus === 'running'
  const isInterrupted = pipelineState?.overallStatus === 'interrupted' || pipelineState?.overallStatus === 'recovering'

  async function handleRetry(): Promise<void> {
    if (!onRetryStage || isRetrying) return
    try {
      setIsRetrying(true)
      await onRetryStage(effectiveStage)
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <>
      {/* Backdrop trên màn hình nhỏ */}
      <div
        className="live-inspector-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        ref={drawerRef}
        className="live-inspector-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Inspect Stage: ${stageMeta.title}`}
        tabIndex={-1}
      >
        {/* Drawer Header */}
        <div className="live-inspector-header">
          <div className="live-inspector-header-left">
            <div className="live-inspector-tag">
              <span className="live-inspector-step-num">
                Stage {stageMeta.stageNumber} of {stageMeta.totalStages}
              </span>
              {isCurrentActive ? (
                <span className="inspector-badge inspector-badge--live">
                  <span className="live-dot" /> LIVE
                </span>
              ) : stageStatus === 'completed' ? (
                <span className="inspector-badge inspector-badge--completed">✓ Completed</span>
              ) : stageStatus === 'failed' ? (
                <span className="inspector-badge inspector-badge--failed">✕ Failed</span>
              ) : isInterrupted ? (
                <span className="inspector-badge inspector-badge--paused">⏸ Paused</span>
              ) : (
                <span className="inspector-badge inspector-badge--waiting">○ Waiting</span>
              )}
            </div>
            <h3 className="live-inspector-title">{stageMeta.title}</h3>
            <p className="live-inspector-action-subtitle">{stageMeta.friendlyAction}</p>
          </div>

          <button
            type="button"
            className="live-inspector-close-btn"
            onClick={onClose}
            aria-label="Close Inspector"
            title="Close Inspector (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Live Follow & Stage Selector Bar */}
        <div className="live-inspector-controls-bar">
          <label className="live-inspector-follow-toggle">
            <input
              type="checkbox"
              checked={followCurrentStage}
              onChange={(e) => onFollowCurrentStageChange(e.target.checked)}
            />
            <span className="toggle-label-text">Follow live stage</span>
          </label>

          {!followCurrentStage && currentStage !== effectiveStage && (
            <button
              type="button"
              className="btn btn-secondary btn-xs live-inspector-jump-btn"
              onClick={() => {
                onSelectStage(currentStage)
                onFollowCurrentStageChange(true)
              }}
              title={`Jump to current stage: ${currentStage}`}
            >
              ⚡ Jump to Current ({currentStage})
            </button>
          )}
        </div>

        {/* Stage Pills Navigation */}
        <div className="live-inspector-stage-tabs" role="tablist">
          {EXECUTION_STAGES.map((stgKey, idx) => {
            const stgInfo = pipelineState?.stages?.[stgKey]
            const stgStat = stgInfo?.status ?? 'pending'
            const isSel = stgKey === effectiveStage
            const isRunningNow = currentStage === stgKey && pipelineState?.overallStatus === 'running'

            return (
              <button
                key={stgKey}
                type="button"
                role="tab"
                aria-selected={isSel}
                className={`live-inspector-stage-tab ${isSel ? 'is-selected' : ''} ${stgStat}`}
                onClick={() => {
                  onSelectStage(stgKey)
                  if (stgKey !== currentStage) {
                    onFollowCurrentStageChange(false)
                  }
                }}
                title={`${idx + 1}. ${STAGE_DESCRIPTIONS[stgKey]?.title || stgKey} (${stgStat})`}
              >
                <span className="tab-num">{idx + 1}</span>
                {isRunningNow && <span className="tab-live-dot" />}
                {stgStat === 'completed' && <span className="tab-check">✓</span>}
              </button>
            )
          })}
        </div>

        {/* Drawer Body Content */}
        <div className="live-inspector-body">
          {/* Progress Overview Section */}
          <div className="live-inspector-card">
            <div className="live-inspector-card-header">
              <span className="live-inspector-card-label">Execution Progress</span>
              <span className="live-inspector-pct-value">{progressPct}%</span>
            </div>

            <div className="progress-bar-wrap" style={{ height: '8px', margin: '8px 0 12px 0' }}>
              <div
                className={`progress-bar-fill ${stageStatus === 'completed' ? 'is-complete' : ''}`}
                style={{ width: `${Math.max(3, progressPct)}%` }}
              />
            </div>

            <div className="live-inspector-message-box">
              <span className="message-box-label">Current Activity:</span>
              <div className="message-box-text">
                {stageData?.message || (stageStatus === 'completed' ? 'Stage completed successfully' : 'Waiting in queue...')}
              </div>
            </div>
          </div>

          {/* Stage Purpose Description */}
          <div className="live-inspector-card">
            <span className="live-inspector-card-label">What happens in this stage</span>
            <p className="live-inspector-description-text">{stageMeta.description}</p>
          </div>

          {/* Timing & Stats Metrics */}
          <div className="live-inspector-card">
            <span className="live-inspector-card-label">Timing & Diagnostics</span>
            <div className="live-inspector-metrics-grid">
              <div className="inspector-metric-item">
                <span className="metric-label">Started</span>
                <span className="metric-val">{formatTime(stageData?.startedAt)}</span>
              </div>
              <div className="inspector-metric-item">
                <span className="metric-label">Completed</span>
                <span className="metric-val">{formatTime(stageData?.completedAt)}</span>
              </div>
              <div className="inspector-metric-item">
                <span className="metric-label">Duration</span>
                <span className="metric-val">{formatDuration(stageData?.durationMs)}</span>
              </div>
              <div className="inspector-metric-item">
                <span className="metric-label">Snapshot Version</span>
                <span className="metric-val">v{pipelineState?.version ?? 1}</span>
              </div>
            </div>
          </div>

          {/* Claim & Evidence Ledger Inspection (when inspecting global-context or if claims exist) */}
          {(effectiveStage === 'global-context' || claimLedger) && claimLedger && (
            <div className="live-inspector-card" style={{ borderColor: 'rgba(99,102,241,0.3)' }}>
              <div className="live-inspector-card-header">
                <span className="live-inspector-card-label" style={{ color: 'var(--color-brand)' }}>
                  ⚖ Documentary Claim & Evidence Ledger
                </span>
                <span className="inspector-badge inspector-badge--completed">
                  {claimLedger.summary.coveragePct}% Coverage
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', margin: '8px 0', fontSize: '11px' }}>
                <div style={{ background: 'var(--bg-void)', padding: '6px 8px', borderRadius: '4px' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '9px', display: 'block' }}>TOTAL CLAIMS</span>
                  <strong>{claimLedger.summary.totalClaims}</strong>
                </div>
                <div style={{ background: 'var(--bg-void)', padding: '6px 8px', borderRadius: '4px' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '9px', display: 'block' }}>VERIFIED</span>
                  <strong style={{ color: '#22c55e' }}>{claimLedger.summary.verified}</strong>
                </div>
                <div style={{ background: 'var(--bg-void)', padding: '6px 8px', borderRadius: '4px' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '9px', display: 'block' }}>UNSOURCED</span>
                  <strong style={{ color: claimLedger.summary.unsourced > 0 ? '#f59e0b' : 'var(--text-muted)' }}>
                    {claimLedger.summary.unsourced}
                  </strong>
                </div>
              </div>
              {claimLedger.summary.criticalUnsourced > 0 && (
                <div style={{ fontSize: '10px', color: '#f59e0b', marginTop: '4px' }}>
                  ⚠ {claimLedger.summary.criticalUnsourced} critical/high importance claims need documentary sources
                </div>
              )}
            </div>
          )}

          {/* Visual Acquisition & Mixed Mode Inspection (Section 56 & 64) */}
          {effectiveStage === 'stock-search' && (
            <div className="live-inspector-card" style={{ borderColor: 'rgba(99,102,241,0.3)' }}>
              <div className="live-inspector-card-header">
                <span className="live-inspector-card-label" style={{ color: 'var(--color-brand)' }}>
                  🎬 Visual Acquisition Strategy
                </span>
                <span className="inspector-badge inspector-badge--completed">
                  {(stageData?.stats?.detectedProfile as string) ||
                    (pipelineState?.options?.contentType === 'health' ? 'Health Explainer' : 'General Documentary')}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px', fontSize: '11px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                  <span>Requested Visual Mix:</span>
                  <strong style={{ color: 'var(--text-primary)' }}>
                    AI Images: {typeof stageData?.stats?.requestedAiPercent === 'number' ? stageData.stats.requestedAiPercent : Math.round((pipelineState?.options?.visualMixConfig?.aiImageRatio ?? 0.8) * 100)}% · Real Footage: {typeof stageData?.stats?.requestedStockPercent === 'number' ? stageData.stats.requestedStockPercent : Math.round((pipelineState?.options?.visualMixConfig?.stockFootageRatio ?? 0.2) * 100)}%
                  </strong>
                </div>

                {stageData?.stats?.failureBehavior !== undefined && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                    <span>Failure behavior:</span>
                    <strong style={{ color: 'var(--text-primary)' }}>
                      {stageData.stats.failureBehavior === 'stock-fallback' ? 'Allow Stock fallback' : 'Keep selected mix'}
                    </strong>
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '4px' }}>
                  <div style={{ background: 'var(--bg-void)', padding: '6px 8px', borderRadius: '4px' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '9px', display: 'block' }}>AI IMAGES</span>
                    <strong>
                      {stageData?.stats?.aiGeneratedScenes !== undefined
                        ? `${stageData.stats.aiGeneratedScenes} / ${stageData.stats.targetAiScenes ?? stageData.stats.aiGeneratedScenes}`
                        : 'Generating'} ready
                    </strong>
                  </div>
                  <div style={{ background: 'var(--bg-void)', padding: '6px 8px', borderRadius: '4px' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '9px', display: 'block' }}>REAL FOOTAGE</span>
                    <strong>
                      {stageData?.stats?.stockScenes !== undefined
                        ? `${stageData.stats.stockScenes} / ${stageData.stats.targetStockScenes ?? stageData.stats.stockScenes}`
                        : 'Searching'} ready
                    </strong>
                  </div>
                </div>

                {typeof stageData?.stats?.aiFallbackToStock === 'number' && (stageData.stats.aiFallbackToStock as number) > 0 && (
                  <div style={{ fontSize: '10px', color: '#f59e0b' }}>
                    ⚡ {stageData.stats.aiFallbackToStock} AI scene{(stageData.stats.aiFallbackToStock as number) > 1 ? 's' : ''} fell back to stock footage
                  </div>
                )}
                {typeof stageData?.stats?.failedAiScenes === 'number' && (stageData.stats.failedAiScenes as number) > 0 && (
                  <div id="ai-visuals-need-attention" style={{ fontSize: '10px', color: '#f87171' }}>
                    AI Visuals Need Attention — {stageData.stats.failedAiScenes} failed
                    {Array.isArray(stageData.stats.failedAiSceneIndices)
                      ? ` (scenes ${(stageData.stats.failedAiSceneIndices as number[]).join(', ')})`
                      : ''}. Re-run the stage to retry only the failed AI visuals.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Visual Truth Reranker Inspection (when inspecting stock-search) */}
          {effectiveStage === 'stock-search' && (
            <div className="live-inspector-card" style={{ borderColor: 'rgba(34,197,94,0.3)' }}>
              <div className="live-inspector-card-header">
                <span className="live-inspector-card-label" style={{ color: '#22c55e' }}>
                  🎯 Visual Truth Reranker
                </span>
                <span className="inspector-badge inspector-badge--live">
                  Two-Tier Verification
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: '6px' }}>
                <div>• Frame Sampling: FFmpeg extracts representative frames at 20%, 50%, 80%</div>
                <div>• Vision Evaluation: Multi-factor scoring against Global Context & Forbidden Substitutions</div>
                <div>• Verified Candidates: {visualTruthData ? Object.keys(visualTruthData.verifications || {}).length : 0} analyzed</div>
                <div>• Fail-Safe Fallback: Active (auto-switches to metadata ranking on timeout or rate limit)</div>
              </div>
            </div>
          )}

          {/* Warnings Banner if any */}
          {stageData?.warning && (
            <div className="live-inspector-banner live-inspector-banner--warning">
              <strong>Notice:</strong> {stageData.warning}
            </div>
          )}

          {/* Error Banner if any */}
          {stageData?.error && (
            <div className="live-inspector-banner live-inspector-banner--error">
              <strong>Issue:</strong> {stageData.error}
            </div>
          )}

          {/* Collapsible Technical Details */}
          <div className="live-inspector-card">
            <button
              type="button"
              className="live-inspector-toggle-details-btn"
              onClick={() => setShowTechnicalDetails((prev) => !prev)}
            >
              <span>Technical Activity & Output</span>
              <span>{showTechnicalDetails ? '▲ Hide' : '▼ Expand'}</span>
            </button>

            {showTechnicalDetails && (
              <div className="live-inspector-raw-details">
                {stageData?.artifactPath && (
                  <div className="raw-detail-row">
                    <span className="raw-label">Artifact:</span>
                    <code className="raw-code" title={stageData.artifactPath}>
                      {stageData.artifactPath}
                    </code>
                  </div>
                )}

                {stageData?.stats && Object.keys(stageData.stats).length > 0 && (
                  <div className="raw-stats-container">
                    <span className="raw-label">Stage Stats:</span>
                    <pre className="raw-stats-json">
                      {JSON.stringify(stageData.stats, null, 2)}
                    </pre>
                  </div>
                )}

                <div className="raw-detail-row">
                  <span className="raw-label">Internal Status:</span>
                  <span className="raw-code">{stageStatus}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Drawer Footer Actions */}
        <div className="live-inspector-footer">
          {stageStatus === 'failed' && onRetryStage && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleRetry}
              disabled={isRetrying}
            >
              {isRetrying ? 'Retrying...' : '↺ Retry Stage'}
            </button>
          )}

          <button
            type="button"
            className="btn btn-primary live-inspector-workspace-btn"
            onClick={() => onOpenFullWorkspace(effectiveStage)}
            title={`Open full ${stageMeta.workspacePageTitle} workspace`}
          >
            <span>Open Full Workspace</span>
            <span className="btn-arrow">↗</span>
          </button>
        </div>
      </aside>
    </>
  )
}
