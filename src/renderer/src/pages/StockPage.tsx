import React, { useState, useEffect, useMemo } from 'react'
import type {
  ProjectState,
  StockSceneAssignment,
  StockAsset,
  StockReviewData,
  GlobalScriptContext,
  StockCandidate,
  StoryboardSummary,
  ClaimEvidenceLedger,
  DocumentaryClaim,
  ClaimVerificationStatus,
  VisualTruthLabel
} from '../../../../shared/types'

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

type FilterType = 'all' | 'needs_review' | 'low_score' | 'missing' | 'locked' | 'manual' | 'approved'

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
  const c = colors[provider.toLowerCase()] ?? { bg: 'rgba(255,255,255,0.08)', fg: '#a0a0c0' }
  return (
    <span
      style={{
        fontSize: '9px',
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: '999px',
        background: c.bg,
        color: c.fg,
        letterSpacing: '0.05em',
        textTransform: 'uppercase'
      }}
    >
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
  return <span style={{ fontSize: '10px', fontWeight: 600, color: s.color }}>{s.label}</span>
}

function approvalBadge(status?: 'auto_selected' | 'approved' | 'needs_review'): React.ReactElement {
  if (status === 'approved') {
    return (
      <span
        style={{
          fontSize: '9px',
          fontWeight: 700,
          padding: '2px 7px',
          borderRadius: '999px',
          background: 'rgba(34,197,94,0.18)',
          color: '#22c55e',
          border: '1px solid rgba(34,197,94,0.4)'
        }}
      >
        ★ APPROVED
      </span>
    )
  }
  if (status === 'needs_review') {
    return (
      <span
        style={{
          fontSize: '9px',
          fontWeight: 700,
          padding: '2px 7px',
          borderRadius: '999px',
          background: 'rgba(245,158,11,0.18)',
          color: '#f59e0b',
          border: '1px solid rgba(245,158,11,0.4)'
        }}
      >
        ⚠ NEEDS REVIEW
      </span>
    )
  }
  return (
    <span
      style={{
        fontSize: '9px',
        fontWeight: 600,
        padding: '2px 7px',
        borderRadius: '999px',
        background: 'rgba(99,102,241,0.15)',
        color: 'var(--text-brand)',
        border: '1px solid rgba(99,102,241,0.3)'
      }}
    >
      AUTO SELECTED
    </span>
  )
}

function matchLabelBadge(label?: string): React.ReactElement | null {
  if (!label) return null
  const map: Record<string, { color: string; bg: string }> = {
    STRONG_MATCH: { color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
    EXACT_SUBJECT: { color: '#22c55e', bg: 'rgba(34,197,94,0.15)' },
    ACCEPTABLE: { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
    CONTEXTUAL_MATCH: { color: '#60a5fa', bg: 'rgba(96,165,250,0.15)' },
    ILLUSTRATIVE: { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
    HISTORICAL: { color: '#c084fc', bg: 'rgba(192,132,252,0.15)' },
    GENERIC_STOCK: { color: '#f97316', bg: 'rgba(249,115,22,0.15)' },
    CONTRADICTORY: { color: '#ef4444', bg: 'rgba(239,68,68,0.18)' },
    UNKNOWN: { color: '#9ca3af', bg: 'rgba(156,163,175,0.15)' },
    REJECTED: { color: '#f87171', bg: 'rgba(248,113,113,0.12)' }
  }
  const c = map[label] ?? { color: 'var(--text-muted)', bg: 'transparent' }
  return (
    <span
      style={{
        fontSize: '9px',
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: '999px',
        background: c.bg,
        color: c.color,
        letterSpacing: '0.04em'
      }}
    >
      {label.replace(/_/g, ' ')}
    </span>
  )
}

function claimStatusBadge(status?: string): React.ReactElement | null {
  if (!status) return null
  const map: Record<string, { color: string; bg: string }> = {
    VERIFIED: { color: '#22c55e', bg: 'rgba(34,197,94,0.15)' },
    PARTIALLY_VERIFIED: { color: '#60a5fa', bg: 'rgba(96,165,250,0.15)' },
    UNSOURCED: { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
    CONTRADICTED: { color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
    NOT_REQUIRED: { color: '#9ca3af', bg: 'rgba(156,163,175,0.15)' }
  }
  const c = map[status] ?? { color: 'var(--text-muted)', bg: 'transparent' }
  return (
    <span
      style={{
        fontSize: '9px',
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: '999px',
        background: c.bg,
        color: c.color,
        letterSpacing: '0.04em'
      }}
    >
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function tierBadge(tier?: string): React.ReactElement | null {
  if (!tier) return null
  const colors: Record<string, string> = { A: '#22c55e', B: '#60a5fa', C: '#f59e0b', D: '#f87171' }
  return (
    <span
      style={{
        fontSize: '9px',
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: '4px',
        background: 'rgba(255,255,255,0.06)',
        color: colors[tier] ?? '#a0a0c0'
      }}
    >
      Tier {tier}
    </span>
  )
}

// ─── Candidate Preview Modal ──────────────────────────────────────────────────

function PreviewModal({
  candidate,
  onClose
}: {
  candidate: StockCandidate
  onClose: () => void
}): React.ReactElement {
  const isVideo = candidate.result.mediaType === 'video'
  const src = candidate.result.previewUrl || candidate.result.downloadUrl

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          maxWidth: '720px',
          width: '100%',
          boxShadow: 'var(--shadow-lg)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border-subtle)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Candidate Preview
            </span>
            {providerBadge(candidate.result.provider)}
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {candidate.result.width}x{candidate.result.height} · Score: {candidate.score.totalScore}/100
            </span>
          </div>
          <button className="btn btn-sm btn-secondary" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        <div
          style={{
            background: '#000',
            minHeight: '320px',
            maxHeight: '480px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {isVideo && src ? (
            <video
              src={src}
              controls
              autoPlay
              style={{ maxWidth: '100%', maxHeight: '480px', objectFit: 'contain' }}
            />
          ) : src ? (
            <img
              src={src}
              alt={candidate.result.title}
              style={{ maxWidth: '100%', maxHeight: '480px', objectFit: 'contain' }}
            />
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Preview unavailable</div>
          )}
        </div>

        <div style={{ padding: '12px 16px', background: 'var(--bg-void)' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
            {candidate.result.title || 'Untitled Asset'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Creator: {candidate.result.creator || 'Unknown'} · Duration: {candidate.result.durationSecs || 0}s
          </div>
          {candidate.score.reasons.length > 0 && (
            <div style={{ marginTop: '6px', fontSize: '11px', color: '#22c55e' }}>
              ✓ {candidate.score.reasons.join(' · ')}
            </div>
          )}
        </div>
      </div>
    </div>
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
  const [query, setQuery] = useState(assignment.searchQueries?.[0] ?? assignment.usedQuery ?? '')
  const suggestions = assignment.searchQueries ?? []

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 999,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          width: '520px',
          boxShadow: 'var(--shadow-lg)'
        }}
      >
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
          Replace Media for Scene {assignment.sceneIndex}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
          {assignment.narrationText?.slice(0, 120)}
          {(assignment.narrationText?.length ?? 0) > 120 ? '…' : ''}
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
            Custom Search Query
          </label>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. vintage steam train mountains"
            style={{ width: '100%', fontSize: '12px' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim()) onConfirm(query.trim())
            }}
          />
        </div>

        {suggestions.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>AI Suggested Queries:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {suggestions.map((s, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="btn btn-sm btn-secondary"
                  style={{ fontSize: '10px', padding: '3px 8px' }}
                  onClick={() => setQuery(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => query.trim() && onConfirm(query.trim())}
            disabled={!query.trim()}
          >
            Search & Replace
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Scene Card with Filmstrip ────────────────────────────────────────────────

function StoryboardSceneCard({
  assignment,
  projectDir,
  candidates,
  claims,
  onReplace,
  onLock,
  onUpload,
  onCandidateSelected,
  onCandidateApproved,
  onUpdateClaimStatus
}: {
  assignment: StockSceneAssignment
  projectDir: string
  candidates: StockCandidate[]
  claims?: DocumentaryClaim[]
  onReplace: (sceneIndex: number, query: string) => Promise<StockAsset | null>
  onLock: (sceneIndex: number, locked: boolean) => Promise<void>
  onUpload: (sceneIndex: number) => Promise<void>
  onCandidateSelected: (candidateId: string) => Promise<void>
  onCandidateApproved: (candidateId?: string) => Promise<void>
  onUpdateClaimStatus?: (claimId: string, status: ClaimVerificationStatus) => Promise<void>
}): React.ReactElement {
  const [showReplace, setShowReplace] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [locking, setLocking] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [previewCandidate, setPreviewCandidate] = useState<StockCandidate | null>(null)
  const [showReasons, setShowReasons] = useState(false)
  const [narrationExpanded, setNarrationExpanded] = useState(false)

  const asset = assignment.asset
  const isAssigned = assignment.status === 'assigned' && !!asset
  const sceneCandidates = candidates.length > 0 ? candidates : assignment.candidates ?? []

  async function handleReplace(query: string): Promise<void> {
    setShowReplace(false)
    setReplacing(true)
    setActionError(null)
    const res = await onReplace(assignment.sceneIndex, query)
    if (!res) {
      setActionError('Replace failed to find or download media.')
    }
    setReplacing(false)
  }

  async function handleLock(): Promise<void> {
    setLocking(true)
    await onLock(assignment.sceneIndex, !assignment.locked)
    setLocking(false)
  }

  async function handleSelect(candidateId: string): Promise<void> {
    setActionError(null)
    try {
      const res = await window.api.stock.selectCandidate({
        projectDir,
        sceneIndex: assignment.sceneIndex,
        candidateId
      })
      if (!res.success) {
        setActionError(res.error || 'Failed to select candidate')
      } else {
        await onCandidateSelected(candidateId)
      }
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleApprove(candidateId?: string): Promise<void> {
    setActionError(null)
    try {
      const res = await window.api.stock.approveCandidate({
        projectDir,
        sceneIndex: assignment.sceneIndex,
        candidateId
      })
      if (!res.success) {
        setActionError(res.error || 'Failed to approve candidate')
      } else {
        await onCandidateApproved(candidateId)
      }
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  const duration = assignment.endTime - assignment.startTime

  return (
    <>
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: `1px solid ${
            assignment.locked
              ? 'rgba(251,191,36,0.35)'
              : assignment.approvalStatus === 'approved'
                ? 'rgba(34,197,94,0.35)'
                : isAssigned
                  ? 'var(--border-default)'
                  : 'rgba(248,113,113,0.3)'
          }`,
          borderRadius: 'var(--radius-md)',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          boxShadow: 'var(--shadow-sm)',
          position: 'relative'
        }}
      >
        {/* Top Header Bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 700, color: 'var(--text-brand)' }}>
              S{String(assignment.sceneIndex).padStart(3, '0')}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              ({assignment.sceneId})
            </span>
            {assignment.chapterTitle && (
              <span
                style={{
                  fontSize: '10px',
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-void)',
                  padding: '2px 6px',
                  borderRadius: '4px'
                }}
              >
                {assignment.chapterTitle}
              </span>
            )}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-muted)' }}>
              {fmt(assignment.startTime)}–{fmt(assignment.endTime)} ({duration.toFixed(1)}s)
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {tierBadge(assignment.tierUsed)}
            {matchLabelBadge(assignment.matchLabel)}
            {matchLabelBadge(assignment.visualTruthLabel)}
            {statusBadge(assignment.status)}
            {approvalBadge(assignment.approvalStatus)}
            {assignment.locked && (
              <span
                style={{
                  fontSize: '9px',
                  padding: '2px 6px',
                  borderRadius: '999px',
                  background: 'rgba(251,191,36,0.15)',
                  color: 'var(--color-warning)',
                  fontWeight: 700
                }}
              >
                🔒 LOCKED
              </span>
            )}
            {assignment.manualOverride && (
              <span
                style={{
                  fontSize: '9px',
                  padding: '2px 6px',
                  borderRadius: '999px',
                  background: 'rgba(96,165,250,0.15)',
                  color: 'var(--color-info)',
                  fontWeight: 700
                }}
              >
                📤 USER MEDIA
              </span>
            )}
          </div>
        </div>

        {/* Narration & Visual Intent */}
        <div style={{ background: 'var(--bg-void)', borderRadius: 'var(--radius-sm)', padding: '10px' }}>
          <div
            style={{
              fontSize: '11px',
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
              cursor: 'pointer'
            }}
            onClick={() => setNarrationExpanded(!narrationExpanded)}
          >
            <strong style={{ color: 'var(--text-primary)' }}>Narration:</strong>{' '}
            {narrationExpanded || (assignment.narrationText?.length ?? 0) <= 140
              ? assignment.narrationText || '(no narration)'
              : `${assignment.narrationText.slice(0, 140)}…`}
          </div>

          {assignment.visualIntent && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
              <strong style={{ color: 'var(--text-secondary)' }}>Visual Intent:</strong> {assignment.visualIntent}
            </div>
          )}

          {assignment.usedQuery && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
              🔍 Search Query: "{assignment.usedQuery}"
            </div>
          )}
        </div>

        {/* Documentary Claims in this scene */}
        {claims && claims.length > 0 && (
          <div style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-brand)' }}>
                ⚖ Documentary Claims ({claims.length})
              </span>
              <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Evidence Required</span>
            </div>
            {claims.map((cl) => (
              <div key={cl.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px', fontSize: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '3px', fontWeight: 600 }}>
                    {cl.type}
                  </span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>"{cl.normalizedClaim}"</span>
                  {claimStatusBadge(cl.verificationStatus)}
                  <select
                    value={cl.verificationStatus}
                    onChange={(e) => onUpdateClaimStatus?.(cl.id, e.target.value as ClaimVerificationStatus)}
                    style={{ fontSize: '9px', background: 'var(--bg-void)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', borderRadius: '3px', padding: '1px 4px' }}
                  >
                    <option value="UNSOURCED">UNSOURCED</option>
                    <option value="VERIFIED">VERIFIED</option>
                    <option value="PARTIALLY_VERIFIED">PARTIALLY_VERIFIED</option>
                    <option value="CONTRADICTED">CONTRADICTED</option>
                    <option value="NOT_REQUIRED">NOT_REQUIRED</option>
                  </select>
                </div>
                {cl.warnings.length > 0 && (
                  <div style={{ color: 'var(--color-warning)', fontSize: '9px' }}>
                    ℹ {cl.warnings[0]}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Selected Asset Header Overview */}
        {isAssigned && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              background: 'rgba(99,102,241,0.08)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '11px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Active Media:</span>
              {providerBadge(asset.provider)}
              <span style={{ color: 'var(--text-secondary)' }}>
                {asset.mediaType.toUpperCase()} {asset.creator ? `· by ${asset.creator}` : ''}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 700, color: assignment.score >= 70 ? '#22c55e' : '#f59e0b' }}>
                Score: {Math.round(assignment.score * (assignment.score <= 1 ? 100 : 1))}/100
              </span>
            </div>
          </div>
        )}

        {/* Filmstrip of Candidates (Top 3) */}
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '6px' }}>
            Candidate Storyboard {sceneCandidates.length > 0 ? `(${sceneCandidates.length} evaluated)` : ''}
          </div>

          {sceneCandidates.length === 0 ? (
            <div
              style={{
                padding: '12px',
                textAlign: 'center',
                background: 'var(--bg-void)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '11px',
                color: 'var(--text-muted)'
              }}
            >
              No candidate filmstrip available for this scene yet. Run Stock Search to generate ranked candidates.
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                gap: '10px'
              }}
            >
              {sceneCandidates.slice(0, 3).map((candidate, idx) => {
                const isWinner = candidate.selected || (idx === 0 && !candidate.rejected && !assignment.selectedCandidateId)
                const isCurrent = assignment.selectedCandidateId === candidate.candidateId || (isWinner && !assignment.selectedCandidateId)

                return (
                  <div
                    key={candidate.candidateId || idx}
                    style={{
                      background: 'var(--bg-void)',
                      border: `1px solid ${
                        isCurrent
                          ? 'var(--color-brand)'
                          : candidate.rejected
                            ? 'rgba(248,113,113,0.3)'
                            : 'var(--border-subtle)'
                      }`,
                      borderRadius: 'var(--radius-sm)',
                      overflow: 'hidden',
                      display: 'flex',
                      flexDirection: 'column'
                    }}
                  >
                    {/* Candidate Thumbnail Header */}
                    <div style={{ height: '95px', background: '#090a0f', position: 'relative', overflow: 'hidden' }}>
                      {candidate.result.thumbnailUrl ? (
                        <img
                          src={candidate.result.thumbnailUrl}
                          alt={candidate.result.title}
                          loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => {
                            ;(e.target as HTMLElement).style.display = 'none'
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--text-muted)',
                            fontSize: '24px'
                          }}
                        >
                          🎬
                        </div>
                      )}

                      {/* Rank tag */}
                      <div
                        style={{
                          position: 'absolute',
                          top: 6,
                          left: 6,
                          background: idx === 0 ? 'rgba(34,197,94,0.9)' : 'rgba(0,0,0,0.75)',
                          color: '#fff',
                          fontSize: '9px',
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: '3px'
                        }}
                      >
                        {idx === 0 ? '1 · RECOMMENDED' : `Candidate ${idx + 1}`}
                      </div>

                      {/* Current Selection Marker */}
                      {isCurrent && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 6,
                            right: 6,
                            background: 'var(--color-brand)',
                            color: '#fff',
                            fontSize: '9px',
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: '3px'
                          }}
                        >
                          ✓ ACTIVE
                        </div>
                      )}

                      {/* Score Badge */}
                      <div
                        style={{
                          position: 'absolute',
                          bottom: 4,
                          right: 6,
                          background: 'rgba(0,0,0,0.8)',
                          color: candidate.score.totalScore >= 70 ? '#22c55e' : '#f59e0b',
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '2px 5px',
                          borderRadius: '3px'
                        }}
                      >
                        {candidate.score.totalScore}/100
                      </div>
                    </div>

                    {/* Candidate Body */}
                    <div style={{ padding: '8px', flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px' }}>
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          {providerBadge(candidate.result.provider)}
                          <span style={{ fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                            {candidate.result.mediaType}
                          </span>
                        </div>
                        <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {candidate.result.width}x{candidate.result.height}
                          {candidate.result.durationSecs ? ` · ${candidate.result.durationSecs}s` : ''}
                        </span>
                      </div>

                      {/* Score breakdown chips */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', fontSize: '8px', color: 'var(--text-muted)' }}>
                        <span style={{ background: 'rgba(255,255,255,0.05)', padding: '1px 4px', borderRadius: '2px' }}>
                          Loc: {candidate.score.localRelevance}
                        </span>
                        <span style={{ background: 'rgba(255,255,255,0.05)', padding: '1px 4px', borderRadius: '2px' }}>
                          Glob: {candidate.score.globalContextFit}
                        </span>
                        <span style={{ background: 'rgba(255,255,255,0.05)', padding: '1px 4px', borderRadius: '2px' }}>
                          Mot: {candidate.score.motionSuitability}
                        </span>
                        <span style={{ background: 'rgba(255,255,255,0.05)', padding: '1px 4px', borderRadius: '2px' }}>
                          Div: {candidate.score.diversityScore}
                        </span>
                        {candidate.score.reusePenalty < 0 && (
                          <span style={{ background: 'rgba(248,113,113,0.15)', color: '#f87171', padding: '1px 4px', borderRadius: '2px' }}>
                            Pen: {candidate.score.reusePenalty}
                          </span>
                        )}
                      </div>

                      {/* Visual Truth Verification Info */}
                      {candidate.visualTruth && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px', margin: '2px 0' }}>
                          <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--text-secondary)' }}>Visual Truth:</span>
                          {matchLabelBadge(candidate.visualTruth.truthLabel)}
                        </div>
                      )}

                      {candidate.finalScore !== undefined && (
                        <div style={{ fontSize: '9px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                          <span>Meta: {candidate.score.totalScore}</span>
                          <span style={{ fontWeight: 600, color: candidate.finalScore >= 70 ? '#22c55e' : '#f59e0b' }}>
                            Vision: {candidate.finalScore}
                          </span>
                        </div>
                      )}

                      {/* Contradiction Warning if present */}
                      {candidate.visualTruth?.contradictionReasons?.[0] && (
                        <div style={{ fontSize: '9px', color: '#ef4444', fontWeight: 600 }}>
                          ⚠ {candidate.visualTruth.contradictionReasons[0]}
                        </div>
                      )}

                      {/* Candidate Reason Snippet */}
                      {candidate.score.reasons[0] && (
                        <div
                          style={{
                            fontSize: '9px',
                            color: '#22c55e',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          ✓ {candidate.score.reasons[0]}
                        </div>
                      )}

                      {/* Action buttons inside card */}
                      <div style={{ display: 'flex', gap: '4px', marginTop: 'auto', paddingTop: '4px' }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          style={{ fontSize: '9px', padding: '3px 6px', flex: 1 }}
                          onClick={() => setPreviewCandidate(candidate)}
                        >
                          👁 Preview
                        </button>

                        {!isCurrent && (
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            style={{ fontSize: '9px', padding: '3px 6px', flex: 1, borderColor: 'var(--color-brand)' }}
                            onClick={() => handleSelect(candidate.candidateId)}
                          >
                            ✓ Select
                          </button>
                        )}

                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{
                            fontSize: '9px',
                            padding: '3px 6px',
                            flex: 1,
                            background: candidate.approved ? 'rgba(34,197,94,0.2)' : 'var(--bg-overlay)',
                            color: candidate.approved ? '#22c55e' : 'var(--text-muted)'
                          }}
                          onClick={() => handleApprove(candidate.candidateId)}
                        >
                          {candidate.approved ? '★ Done' : '★ Approve'}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Explanation & Rejection Details (Collapsible) */}
        {showReasons && (
          <div
            style={{
              padding: '10px',
              background: 'var(--bg-void)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '10px',
              lineHeight: 1.6
            }}
          >
            <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Scoring & Diversity Explanation:
            </div>
            {sceneCandidates[0]?.score?.reasons?.map((r, i) => (
              <div key={i} style={{ color: '#22c55e' }}>
                ✓ {r}
              </div>
            ))}
            {sceneCandidates[0]?.score?.rejectionReasons?.map((r, i) => (
              <div key={i} style={{ color: '#f87171' }}>
                ⚠ {r}
              </div>
            ))}
          </div>
        )}

        {/* Action Error Alert */}
        {actionError && (
          <div
            style={{
              padding: '8px 12px',
              background: 'rgba(248,113,113,0.12)',
              border: '1px solid rgba(248,113,113,0.3)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '11px',
              color: 'var(--color-error)'
            }}
          >
            ⚠ {actionError}
          </div>
        )}

        {/* Scene Footer Action Buttons */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginTop: '2px' }}>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => handleApprove()}
            style={{
              fontSize: '10px',
              padding: '4px 10px',
              background: assignment.approvalStatus === 'approved' ? 'rgba(34,197,94,0.15)' : undefined,
              color: assignment.approvalStatus === 'approved' ? '#22c55e' : undefined
            }}
          >
            {assignment.approvalStatus === 'approved' ? '★ Approved' : '★ Approve Scene'}
          </button>

          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowReplace(true)}
            disabled={replacing || assignment.locked}
            style={{ fontSize: '10px', padding: '4px 10px' }}
          >
            {replacing ? '⟳' : '🔄'} Replace
          </button>

          <button
            className="btn btn-sm"
            onClick={handleLock}
            disabled={locking}
            style={{
              fontSize: '10px',
              padding: '4px 10px',
              background: assignment.locked ? 'rgba(251,191,36,0.1)' : 'var(--bg-overlay)',
              border: `1px solid ${assignment.locked ? 'rgba(251,191,36,0.4)' : 'var(--border-subtle)'}`,
              color: assignment.locked ? 'var(--color-warning)' : 'var(--text-muted)',
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm)'
            }}
          >
            {assignment.locked ? '🔓 Unlock' : '🔒 Lock'}
          </button>

          <button
            className="btn btn-sm"
            onClick={() => onUpload(assignment.sceneIndex)}
            style={{
              fontSize: '10px',
              padding: '4px 10px',
              background: 'var(--bg-overlay)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm)'
            }}
          >
            📤 Upload Media
          </button>

          <button
            className="btn btn-sm"
            onClick={() => setShowReasons(!showReasons)}
            style={{
              fontSize: '10px',
              padding: '4px 10px',
              background: 'transparent',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm)'
            }}
          >
            {showReasons ? 'Hide Breakdown' : 'ℹ View Reasons'}
          </button>
        </div>
      </div>

      {showReplace && (
        <ReplaceModal
          assignment={assignment}
          onConfirm={handleReplace}
          onClose={() => setShowReplace(false)}
        />
      )}

      {previewCandidate && (
        <PreviewModal
          candidate={previewCandidate}
          onClose={() => setPreviewCandidate(null)}
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

  const [globalCtx, setGlobalCtx] = useState<GlobalScriptContext | null>(null)
  const [ctxExpanded, setCtxExpanded] = useState(false)
  const [analyzingCtx, setAnalyzingCtx] = useState(false)
  const [ctxProgress, setCtxProgress] = useState<string | null>(null)

  const [filter, setFilter] = useState<FilterType>('all')
  const [candidatesStore, setCandidatesStore] = useState<Record<string, StockCandidate[]>>({})
  const [storyboardSummary, setStoryboardSummary] = useState<StoryboardSummary | null>(null)
  const [claimLedger, setClaimLedger] = useState<ClaimEvidenceLedger | null>(null)
  const [ledgerExpanded, setLedgerExpanded] = useState(false)
  const [exportingManifests, setExportingManifests] = useState(false)

  // Load existing GlobalContext, candidates, summary, and claims
  const loadData = async (): Promise<void> => {
    try {
      const [ctx, cands, summary, ledger] = await Promise.all([
        window.api.stock.getContext(project.projectDir),
        window.api.stock.getCandidates({ projectDir: project.projectDir }),
        window.api.stock.getStoryboardSummary(project.projectDir),
        window.api.claims.getLedger(project.projectDir)
      ])
      if (ctx) setGlobalCtx(ctx)
      if (cands && typeof cands === 'object') {
        setCandidatesStore(cands as Record<string, StockCandidate[]>)
      }
      if (summary) setStoryboardSummary(summary)
      if (ledger) setClaimLedger(ledger)
    } catch {
      // Ignore background load errors
    }
  }

  useEffect(() => {
    void loadData()
  }, [project.projectDir, review])

  async function handleAnalyzeContext(): Promise<void> {
    setAnalyzingCtx(true)
    setCtxProgress('Starting global context analysis...')
    const unsub = window.api.stock.onContextProgress((d) => setCtxProgress(d.message))
    try {
      const result = await window.api.stock.analyzeContext({
        projectDir: project.projectDir,
        forceRegenerate: true,
        scriptPath: project.inputs?.scriptPath ?? null
      })
      if (result.success && result.context) {
        setGlobalCtx(result.context)
        setCtxExpanded(true)
        if (result.warning) {
          setCtxProgress(`⚠ ${result.warning}`)
          setTimeout(() => setCtxProgress(null), 8000)
        } else {
          setCtxProgress(null)
        }
      } else {
        setCtxProgress(`⚠ ${result.error || 'Failed to analyze script'}`)
        setTimeout(() => setCtxProgress(null), 8000)
      }
    } catch (e: unknown) {
      setCtxProgress(`⚠ ${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setCtxProgress(null), 8000)
    } finally {
      setAnalyzingCtx(false)
      unsub()
    }
  }

  async function handleUpdateClaimStatus(claimId: string, status: ClaimVerificationStatus): Promise<void> {
    try {
      const res = await window.api.claims.updateStatus({
        projectDir: project.projectDir,
        claimId,
        status
      })
      if (res.success) {
        const updated = await window.api.claims.getLedger(project.projectDir)
        if (updated) setClaimLedger(updated)
      }
    } catch {
      /* ignore */
    }
  }

  async function handleExportManifests(): Promise<void> {
    try {
      setExportingManifests(true)
      const res = await window.api.claims.exportManifests({ projectDir: project.projectDir })
      if (res.success) {
        alert(`Exported Manifests successfully!\nCSV: ${res.csvPath}\nLicenses: ${res.licensesPath}`)
      } else {
        alert(`Export error: ${res.error}`)
      }
    } catch (err) {
      alert(`Export error: ${String(err)}`)
    } finally {
      setExportingManifests(false)
    }
  }

  // Filtered scenes
  const assignments = review?.assignments ?? []

  const filteredAssignments = useMemo(() => {
    switch (filter) {
      case 'needs_review':
        return assignments.filter((a) => a.approvalStatus === 'needs_review' || a.status === 'failed' || a.score < 50)
      case 'low_score':
        return assignments.filter((a) => a.score < 60)
      case 'missing':
        return assignments.filter((a) => !a.asset || a.status === 'failed')
      case 'locked':
        return assignments.filter((a) => a.locked)
      case 'manual':
        return assignments.filter((a) => a.manualOverride)
      case 'approved':
        return assignments.filter((a) => a.approvalStatus === 'approved')
      case 'all':
      default:
        return assignments
    }
  }, [assignments, filter])

  const total = assignments.length
  const assigned = storyboardSummary?.assignedScenes ?? review?.assignedScenes ?? 0
  const approved = storyboardSummary?.approvedScenes ?? assignments.filter((a) => a.approvalStatus === 'approved').length
  const needsReview = storyboardSummary?.needsReviewScenes ?? assignments.filter((a) => a.approvalStatus === 'needs_review' || a.status === 'failed' || a.score < 50).length
  const missing = storyboardSummary?.missingScenes ?? assignments.filter((a) => !a.asset || a.status === 'failed').length
  const avgScore = storyboardSummary?.averageScore ?? (total > 0 ? Math.round(assignments.reduce((acc, a) => acc + (a.score > 1 ? a.score : a.score * 100), 0) / total) : 0)
  const dedupAvoided = storyboardSummary?.duplicateAssetsAvoided ?? 0

  return (
    <div className="page-container">
      {/* ── Global Visual Context Panel ──────────────────────────────────────── */}
      <div className="panel" style={{ borderColor: globalCtx ? 'rgba(99,102,241,0.35)' : 'var(--border-subtle)' }}>
        <div className="panel-header" style={{ cursor: 'pointer' }} onClick={() => setCtxExpanded((e) => !e)}>
          <div className="panel-title">
            <span style={{ marginRight: 8 }}>🌐</span>
            Global Visual Context
            {globalCtx && (
              <span style={{ marginLeft: 8, fontSize: '10px', color: 'var(--text-muted)', fontWeight: 400 }}>
                v{globalCtx.version} · {globalCtx.primarySubject.slice(0, 60)}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {!globalCtx && (
              <span style={{ fontSize: '10px', color: 'var(--color-warning)' }}>
                ⚠ No context — run Analyze to improve stock accuracy
              </span>
            )}
            <button
              className="btn btn-secondary"
              style={{ fontSize: '11px', padding: '4px 12px' }}
              onClick={(e) => {
                e.stopPropagation()
                void handleAnalyzeContext()
              }}
              disabled={analyzingCtx}
            >
              {analyzingCtx ? '⟳ Analyzing...' : '🧠 Analyze Script'}
            </button>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{ctxExpanded ? '▲' : '▼'}</span>
          </div>
        </div>

        {ctxProgress && (
          <div
            style={{
              padding: '8px 16px',
              fontSize: '11px',
              color: ctxProgress.startsWith('⚠') ? 'var(--color-warning)' : 'var(--text-brand)',
              background: 'var(--bg-void)',
              borderBottom: '1px solid var(--border-subtle)'
            }}
          >
            {ctxProgress}
          </div>
        )}

        {ctxExpanded && globalCtx && (
          <div className="panel-body" style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <strong style={{ color: 'var(--text-primary)' }}>Subject:</strong>{' '}
              <span style={{ color: 'var(--text-secondary)' }}>{globalCtx.primarySubject}</span>
            </div>
            <div>
              <strong style={{ color: 'var(--text-primary)' }}>Central Thesis:</strong>{' '}
              <span style={{ color: 'var(--text-secondary)' }}>{globalCtx.centralThesis}</span>
            </div>
            <div>
              <strong style={{ color: 'var(--text-primary)' }}>Geography:</strong>{' '}
              <span style={{ color: 'var(--text-secondary)' }}>
                {[globalCtx.geography.primaryCountry, globalCtx.geography.primaryRegion, ...globalCtx.geography.secondaryLocations]
                  .filter(Boolean)
                  .join(', ')}
              </span>
            </div>
            <div>
              <strong style={{ color: 'var(--text-primary)' }}>Time Period:</strong>{' '}
              <span style={{ color: 'var(--text-secondary)' }}>
                {globalCtx.timeContext.primaryPeriod}
                {globalCtx.timeContext.historicalPeriods.length > 0 ? ` (${globalCtx.timeContext.historicalPeriods.join(', ')})` : ''}
              </span>
            </div>
            {globalCtx.forbiddenSubstitutions.length > 0 && (
              <div>
                <strong style={{ color: '#f87171' }}>Forbidden Substitutions:</strong>{' '}
                <span style={{ color: 'var(--text-muted)' }}>{globalCtx.forbiddenSubstitutions.join(' · ')}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Claim & Evidence Ledger Panel ────────────────────────────────────── */}
      <div className="panel" style={{ borderColor: claimLedger ? 'rgba(99,102,241,0.35)' : 'var(--border-subtle)' }}>
        <div className="panel-header" style={{ cursor: 'pointer' }} onClick={() => setLedgerExpanded((e) => !e)}>
          <div className="panel-title">
            <span style={{ marginRight: 8 }}>⚖️</span>
            Claim & Evidence Ledger
            {claimLedger && (
              <span style={{ marginLeft: 8, fontSize: '10px', color: 'var(--text-muted)', fontWeight: 400 }}>
                {claimLedger.claims.length} claims · {claimLedger.summary.coveragePct}% evidence coverage
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {claimLedger ? (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleExportManifests()
                  }}
                  disabled={exportingManifests}
                >
                  {exportingManifests ? 'Exporting...' : '📁 Export Sources (CSV/JSON)'}
                </button>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{ledgerExpanded ? '▲' : '▼'}</span>
              </>
            ) : (
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                Ledger generated after Global Visual Context analysis
              </span>
            )}
          </div>
        </div>

        {ledgerExpanded && claimLedger && (
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Ledger metrics bar */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }}>
              <div style={{ background: 'var(--bg-void)', padding: '8px', borderRadius: '4px', textAlign: 'center' }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>{claimLedger.summary.totalClaims}</div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>TOTAL CLAIMS</div>
              </div>
              <div style={{ background: 'var(--bg-void)', padding: '8px', borderRadius: '4px', textAlign: 'center' }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: '#22c55e' }}>{claimLedger.summary.verified}</div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>VERIFIED</div>
              </div>
              <div style={{ background: 'var(--bg-void)', padding: '8px', borderRadius: '4px', textAlign: 'center' }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: '#60a5fa' }}>{claimLedger.summary.partiallyVerified}</div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>PARTIAL</div>
              </div>
              <div style={{ background: 'var(--bg-void)', padding: '8px', borderRadius: '4px', textAlign: 'center' }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: claimLedger.summary.unsourced > 0 ? '#f59e0b' : 'var(--text-muted)' }}>{claimLedger.summary.unsourced}</div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>UNSOURCED</div>
              </div>
              <div style={{ background: 'var(--bg-void)', padding: '8px', borderRadius: '4px', textAlign: 'center' }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: claimLedger.summary.contradicted > 0 ? '#ef4444' : 'var(--text-muted)' }}>{claimLedger.summary.contradicted}</div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>CONTRADICTED</div>
              </div>
              <div style={{ background: 'var(--bg-void)', padding: '8px', borderRadius: '4px', textAlign: 'center' }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: claimLedger.summary.coveragePct >= 70 ? '#22c55e' : '#f59e0b' }}>{claimLedger.summary.coveragePct}%</div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>COVERAGE</div>
              </div>
            </div>

            {/* List of claims */}
            <div style={{ maxHeight: '240px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {claimLedger.claims.map((cl) => (
                <div
                  key={cl.id}
                  style={{
                    background: 'var(--bg-void)',
                    padding: '8px 10px',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    fontSize: '11px'
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '2px', flexWrap: 'wrap' }}>
                      <span style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '3px', fontSize: '9px', fontWeight: 600 }}>{cl.type}</span>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>"{cl.normalizedClaim}"</span>
                      {claimStatusBadge(cl.verificationStatus)}
                      <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Scenes: {cl.sceneIds.join(', ')}</span>
                    </div>
                    {cl.warnings.length > 0 && (
                      <div style={{ fontSize: '9px', color: 'var(--color-warning)' }}>
                        ℹ {cl.warnings[0]}
                      </div>
                    )}
                  </div>
                  <select
                    value={cl.verificationStatus}
                    onChange={(e) => void handleUpdateClaimStatus(cl.id, e.target.value as ClaimVerificationStatus)}
                    style={{
                      fontSize: '10px',
                      background: 'var(--bg-surface)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '4px',
                      padding: '3px 6px'
                    }}
                  >
                    <option value="UNSOURCED">UNSOURCED</option>
                    <option value="VERIFIED">VERIFIED</option>
                    <option value="PARTIALLY_VERIFIED">PARTIAL</option>
                    <option value="CONTRADICTED">CONTRADICTED</option>
                    <option value="NOT_REQUIRED">NOT REQUIRED</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Storyboard Summary Bar ───────────────────────────────────────────── */}
      {total > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px' }}>
          {[
            { label: 'Total Scenes', value: total, icon: '🎬', color: 'var(--text-primary)' },
            { label: 'Assigned', value: assigned, icon: '✓', color: 'var(--color-success)' },
            { label: 'Approved', value: approved, icon: '★', color: '#22c55e' },
            { label: 'Needs Review', value: needsReview, icon: '⚠', color: needsReview > 0 ? '#f59e0b' : 'var(--text-muted)' },
            { label: 'Missing', value: missing, icon: '✗', color: missing > 0 ? '#f87171' : 'var(--text-muted)' },
            { label: 'Avg Score', value: `${avgScore}%`, icon: '📊', color: 'var(--text-brand)' },
            { label: 'Dedup Avoided', value: dedupAvoided, icon: '🛡️', color: 'var(--color-info)' }
          ].map((s) => (
            <div
              key={s.label}
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 14px',
                textAlign: 'center'
              }}
            >
              <div style={{ fontSize: '16px', marginBottom: '2px' }}>{s.icon}</div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: s.color, fontFamily: 'var(--font-mono)' }}>
                {s.value}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Action / Filter Bar ──────────────────────────────────────────────── */}
      <div
        className="panel"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
          padding: '12px 16px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginRight: '4px' }}>
            FILTER:
          </span>
          {[
            { id: 'all', label: `All (${total})` },
            { id: 'needs_review', label: `Needs Review (${needsReview})` },
            { id: 'low_score', label: 'Low Score (<60)' },
            { id: 'missing', label: `Missing (${missing})` },
            { id: 'locked', label: 'Locked' },
            { id: 'manual', label: 'Manual' },
            { id: 'approved', label: `Approved (${approved})` }
          ].map((btn) => (
            <button
              key={btn.id}
              className="btn btn-sm"
              style={{
                fontSize: '10px',
                padding: '4px 10px',
                borderRadius: '999px',
                background: filter === btn.id ? 'var(--color-brand)' : 'var(--bg-void)',
                color: filter === btn.id ? '#fff' : 'var(--text-secondary)',
                border: `1px solid ${filter === btn.id ? 'var(--color-brand)' : 'var(--border-subtle)'}`
              }}
              onClick={() => setFilter(btn.id as FilterType)}
            >
              {btn.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            className="btn btn-primary"
            style={{ fontSize: '11px', padding: '6px 16px' }}
            onClick={onRun}
            disabled={isRunning}
          >
            {isRunning ? '⟳ Searching Stock...' : '⚡ Run Stock Search'}
          </button>
        </div>
      </div>

      {/* Progress Bar when running */}
      {isRunning && progress && (
        <div className="panel" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '11px' }}>
            <span style={{ color: 'var(--text-primary)' }}>{progress.message}</span>
            <span style={{ color: 'var(--text-brand)', fontFamily: 'var(--font-mono)' }}>
              {Math.round(progress.progress * 100)}%
            </span>
          </div>
          <div style={{ height: '6px', background: 'var(--bg-void)', borderRadius: '3px', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${Math.round(progress.progress * 100)}%`,
                background: 'var(--color-brand)',
                transition: 'width 0.3s ease'
              }}
            />
          </div>
        </div>
      )}

      {/* ── Empty State ──────────────────────────────────────────────────────── */}
      {!review && !isRunning && (
        <div className="panel" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🎬</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
            Candidate Stock Engine & Storyboard Review
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.8, maxWidth: '520px', margin: '0 auto 24px' }}>
            Click <strong>Run Stock Search</strong> to evaluate Pexels and Pixabay candidates, rank them on 8 quality
            dimensions, avoid duplicate repetitive clips, and inspect them in the Storyboard Filmstrip.
          </div>
          <button className="btn btn-primary" onClick={onRun} disabled={isRunning}>
            ⚡ Run Stock Search
          </button>
        </div>
      )}

      {/* ── Storyboard Scenes List ────────────────────────────────────────────── */}
      {assignments.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {filteredAssignments.map((a) => {
            const key = a.sceneId || `scene_${a.sceneIndex}`
            const cands = candidatesStore[key] || candidatesStore[String(a.sceneIndex)] || []
            return (
              <StoryboardSceneCard
                key={a.sceneId || a.sceneIndex}
                assignment={a}
                projectDir={project.projectDir}
                candidates={cands}
                onReplace={onReplace}
                onLock={onLock}
                onUpload={onUpload}
                onCandidateSelected={async () => {
                  await loadData()
                  onLoad()
                }}
                onCandidateApproved={async () => {
                  await loadData()
                  onLoad()
                }}
                claims={claimLedger?.claims.filter(
                  (c) => c.sceneIds.includes(a.sceneId) || c.sceneIds.includes(`scene_${a.sceneIndex}`)
                )}
                onUpdateClaimStatus={handleUpdateClaimStatus}
              />
            )
          })}
        </div>
      )}

      {/* ── License & Provider Footer ────────────────────────────────────────── */}
      {assignments.length > 0 && (
        <div className="panel" style={{ background: 'var(--bg-elevated)', padding: '12px 16px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
            <strong style={{ color: 'var(--text-secondary)' }}>Workflow note:</strong>{' '}
            Candidate review is optional. If you proceed directly to render, top-ranked candidates (Rank 1) are used automatically.
          </div>
        </div>
      )}
    </div>
  )
}
