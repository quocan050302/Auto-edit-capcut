import React, { useState } from 'react'
import type {
  SimilarChannelCandidate,
  SimilarChannelVideo,
  SimilarChannelCandidateStatus,
} from '../types/research.types'

const STATUS_CONFIG: Record<SimilarChannelCandidateStatus, { label: string; color: string; bg: string; border: string }> = {
  QUALIFIED: { label: 'Qualified', color: '#4ade80', bg: 'rgba(74,222,128,0.10)', border: 'rgba(74,222,128,0.35)' },
  GROWING: { label: 'Growing', color: '#60a5fa', bg: 'rgba(96,165,250,0.10)', border: 'rgba(96,165,250,0.35)' },
  WATCHLIST: { label: 'Watchlist', color: '#fbbf24', bg: 'rgba(251,191,36,0.10)', border: 'rgba(251,191,36,0.35)' },
  REJECTED: { label: 'Rejected', color: '#f87171', bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.20)' },
}

const VID_STATUS_COLOR: Record<string, string> = {
  PASS_VIEWS: '#4ade80', PASS_GROWTH_CONFIRMED: '#34d399',
  PASS_GROWTH_PROVISIONAL: '#60a5fa', PENDING_TOO_NEW: '#fbbf24',
  FAIL: '#f87171', EXCLUDED: '#9ca3af',
}

function fmt(n: number | null | undefined, d = 0): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString(undefined, { maximumFractionDigits: d })
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—'
  return (n * 100).toFixed(0) + '%'
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>
        <span>{label}</span>
        <span style={{ fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>{value.toFixed(1)}</span>
      </div>
      <div style={{ height: 4, background: 'rgba(255,255,255,0.07)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(value, 100)}%`, background: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
      </div>
    </div>
  )
}

function VideoRow({ v }: { v: SimilarChannelVideo }) {
  const c = VID_STATUS_COLOR[v.evaluation_status] || '#9ca3af'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px 80px 130px', gap: 6, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11 }}>
      <a href={v.video_url} target="_blank" rel="noopener noreferrer" style={{ color: 'rgba(255,255,255,0.7)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.title}>{v.title}</a>
      <span style={{ color: 'rgba(255,255,255,0.45)', textAlign: 'right' }}>{v.age_days.toFixed(0)}d</span>
      <span style={{ color: 'rgba(255,255,255,0.75)', textAlign: 'right' }}>{fmt(v.views)}</span>
      <span style={{ color: c, textAlign: 'right' }}>{v.lifetime_views_per_day.toFixed(0)} VPD</span>
      <span style={{ color: c, fontSize: 10, fontWeight: 700, textAlign: 'center', background: `${c}20`, borderRadius: 4, padding: '2px 5px', whiteSpace: 'nowrap' }} title={v.evaluation_reason}>
        {v.evaluation_status.replace(/_/g, ' ')}
      </span>
    </div>
  )
}

interface Props { candidate: SimilarChannelCandidate; defaultExpanded?: boolean }

export function SimilarChannelCard({ candidate, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [showVids, setShowVids] = useState(false)
  const cfg = STATUS_CONFIG[candidate.status] ?? STATUS_CONFIG.WATCHLIST
  const sc = candidate.scores
  const isMP = candidate.is_most_promising
  const isBestAvailable = Boolean(candidate.is_best_available || candidate.recommendation_tier === 'BEST_AVAILABLE')

  return (
    <div id={`similar-channel-card-${candidate.rank}`} style={{
      background: isMP
        ? 'linear-gradient(135deg, rgba(200,150,12,0.14) 0%, rgba(30,32,60,0.95) 100%)'
        : isBestAvailable
          ? 'linear-gradient(135deg, rgba(168,85,247,0.12) 0%, rgba(20,20,35,0.95) 100%)'
          : 'rgba(255,255,255,0.03)',
      border: isMP
        ? '1.5px solid rgba(200,150,12,0.45)'
        : isBestAvailable
          ? '1.5px solid rgba(168,85,247,0.4)'
          : `1px solid ${cfg.border}`,
      borderRadius: 12, marginBottom: 10, overflow: 'hidden',
      boxShadow: isMP
        ? '0 0 16px rgba(200,150,12,0.12)'
        : isBestAvailable
          ? '0 0 14px rgba(168,85,247,0.1)'
          : 'none',
    }}>
      {/* Header */}
      <div role="button" tabIndex={0} onClick={() => setExpanded(e => !e)} onKeyDown={e => e.key === 'Enter' && setExpanded(p => !p)}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', userSelect: 'none' }}>
        <div style={{
          minWidth: 32, height: 32, borderRadius: '50%',
          background: isMP ? 'rgba(200,150,12,0.3)' : isBestAvailable ? 'rgba(168,85,247,0.25)' : 'rgba(255,255,255,0.07)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
          color: isMP ? '#f5c842' : isBestAvailable ? '#c084fc' : 'rgba(255,255,255,0.7)',
        }}>
          #{candidate.rank}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <a href={candidate.channel_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
              style={{
                color: isMP ? '#f5c842' : isBestAvailable ? '#e9d5ff' : 'rgba(255,255,255,0.9)',
                textDecoration: 'none', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
              {candidate.channel_title}
            </a>
            {isMP && (
              <span style={{ fontSize: 10, padding: '2px 7px', background: 'rgba(200,150,12,0.3)', color: '#f5c842', borderRadius: 5, fontWeight: 700, whiteSpace: 'nowrap' }}>
                ★ {candidate.most_promising_label || 'Most Promising'}
              </span>
            )}
            {!isMP && isBestAvailable && (
              <span style={{ fontSize: 10, padding: '2px 7px', background: 'rgba(168,85,247,0.25)', color: '#c084fc', borderRadius: 5, fontWeight: 700, whiteSpace: 'nowrap', border: '1px solid rgba(168,85,247,0.4)' }}>
                ◎ Best Available {candidate.best_available_rank ? `#${candidate.best_available_rank}` : ''}
              </span>
            )}
            {candidate.recommendation_tier === 'STRICT_MATCH' && (
              <span style={{ fontSize: 10, padding: '2px 7px', background: 'rgba(74,222,128,0.2)', color: '#4ade80', borderRadius: 5, fontWeight: 700, whiteSpace: 'nowrap' }}>
                ✓ Strict Match
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.42)', marginTop: 2, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              {candidate.subscriber_count != null ? fmt(candidate.subscriber_count) + ' subs' : candidate.subscriber_status === 'HIDDEN_UNVERIFIED' ? 'Subscribers hidden' : 'Over limit'}
              {candidate.country && ` · ${candidate.country}`}
            </span>
            {candidate.window_coverage && candidate.window_coverage !== 'UNKNOWN' && (
              <span style={{ fontSize: 10, color: candidate.window_coverage === 'COMPLETE' ? '#4ade80' : '#fbbf24' }}>
                · Window: {candidate.window_coverage}
              </span>
            )}
            {candidate.date_quality && candidate.date_quality !== 'VERIFIED' && (
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
                · Dates: {candidate.date_quality}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexShrink: 0 }}>
          {[
            { v: sc.final_score.toFixed(1), l: 'Score' },
            { v: fmt(candidate.median_recent_views), l: 'Median Views' },
            { v: fmtPct(candidate.strict_success_ratio), l: 'Pass Rate' },
          ].map(({ v, l }) => (
            <div key={l} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>{v}</div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.38)' }}>{l}</div>
            </div>
          ))}
          <span style={{ padding: '4px 10px', borderRadius: 6, background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`, fontSize: 11, fontWeight: 700 }}>{cfg.label}</span>
          <span style={{ color: 'rgba(255,255,255,0.28)', fontSize: 16 }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 14 }}>
            {/* Score breakdown */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.45)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Score Breakdown</div>
              <ScoreBar label="Niche Match" value={sc.niche_match_score} color="#818cf8" />
              <ScoreBar label="Recent Consistency" value={sc.recent_consistency_score} color="#34d399" />
              <ScoreBar label="Growth Quality" value={sc.growth_quality_score} color="#60a5fa" />
              <ScoreBar label="Durability" value={sc.durability_score} color="#fb923c" />
              <ScoreBar label="Monetization" value={sc.monetization_viability_score} color="#f472b6" />
              <ScoreBar label="Data Confidence" value={sc.data_confidence_score} color="#a78bfa" />
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', marginTop: 8, paddingTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>
                <span>Final Score</span><span style={{ color: cfg.color }}>{sc.final_score.toFixed(1)}</span>
              </div>
            </div>
            {/* 90d perf */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.45)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>90-Day Performance</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7, marginBottom: 12 }}>
                {[
                  { l: 'Videos', v: candidate.recent_video_count, c: 'rgba(255,255,255,0.7)' },
                  { l: 'Evaluable', v: candidate.evaluable_video_count, c: 'rgba(255,255,255,0.7)' },
                  { l: 'Passed', v: candidate.passed_views_count + candidate.passed_growth_confirmed_count, c: '#4ade80' },
                  { l: 'Provisional', v: candidate.passed_growth_provisional_count, c: '#60a5fa' },
                  { l: 'Pending', v: candidate.pending_video_count, c: '#fbbf24' },
                  { l: 'Failed', v: candidate.failed_video_count, c: '#f87171' },
                ].map(({ l, v, c }) => (
                  <div key={l} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 7, padding: '6px 8px', textAlign: 'center' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: c }}>{v}</div>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.38)' }}>{l}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
                {[
                  ['Median Views', fmt(candidate.median_recent_views)],
                  ['Max Views', fmt(candidate.maximum_recent_views)],
                  ['Total Views', fmt(candidate.total_recent_views)],
                  ['Single-Hit Dep.', fmtPct(candidate.single_hit_dependency)],
                  ['Evergreen', fmtPct(candidate.evergreen_ratio)],
                  ['Active Months', `${candidate.active_months_last_12}/12`],
                ].map(([label, val]) => (
                  <div key={label}><span style={{ color: 'rgba(255,255,255,0.38)' }}>{label}: </span><span style={{ color: 'rgba(255,255,255,0.8)' }}>{val}</span></div>
                ))}
              </div>
            </div>
          </div>

          {/* Unmet Criteria (if any) */}
          {candidate.unmet_criteria && candidate.unmet_criteria.length > 0 && (
            <div style={{ marginTop: 12, background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.22)', borderRadius: 8, padding: '8px 12px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#f87171', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                ⚠ Unmet Strict Qualification Criteria
              </div>
              {candidate.unmet_criteria.map((c, i) => (
                <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 2 }}>• {c}</div>
              ))}
            </div>
          )}

          {/* Niche Match Evidence */}
          <div style={{ marginTop: 12, background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.18)', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#818cf8', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Niche Match Evidence ({candidate.scores.niche_match_score.toFixed(0)}/100)
            </div>
            {candidate.niche_match_reason && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 6 }}>
                {candidate.niche_match_reason}
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'rgba(255,255,255,0.5)', flexWrap: 'wrap' }}>
              {candidate.source_coverage != null && candidate.source_coverage > 0 && (
                <span>Source Coverage: {fmtPct(candidate.source_coverage)}</span>
              )}
              {candidate.candidate_precision != null && candidate.candidate_precision > 0 && (
                <span>Precision: {fmtPct(candidate.candidate_precision)}</span>
              )}
              {candidate.median_title_similarity != null && candidate.median_title_similarity > 0 && (
                <span>Title Similarity: {fmtPct(candidate.median_title_similarity)}</span>
              )}
              {candidate.matched_entities && candidate.matched_entities.length > 0 && (
                <span>Entities: {candidate.matched_entities.slice(0, 3).join(', ')}</span>
              )}
            </div>
          </div>

          {/* Reasons */}
          {(candidate.qualification_reasons.length > 0 || candidate.rejection_reasons.length > 0) && (
            <div style={{ marginTop: 12, display: 'flex', gap: 12 }}>
              {candidate.qualification_reasons.length > 0 && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#4ade80', marginBottom: 4, textTransform: 'uppercase' }}>✓ Why Qualified</div>
                  {candidate.qualification_reasons.map((r, i) => <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.62)', marginBottom: 2 }}>• {r}</div>)}
                </div>
              )}
              {candidate.rejection_reasons.length > 0 && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#f87171', marginBottom: 4, textTransform: 'uppercase' }}>✗ Rejection / Limitations</div>
                  {candidate.rejection_reasons.map((r, i) => <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.62)', marginBottom: 2 }}>• {r}</div>)}
                </div>
              )}
            </div>
          )}

          {candidate.confidence_limitations.length > 0 && (
            <div style={{ marginTop: 10, background: 'rgba(251,191,36,0.06)', borderRadius: 7, padding: '7px 11px', border: '1px solid rgba(251,191,36,0.18)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', marginBottom: 3 }}>⚠ Data Confidence Limitations</div>
              {candidate.confidence_limitations.map((l, i) => <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.52)', marginBottom: 2 }}>{l}</div>)}
            </div>
          )}

          <div style={{ marginTop: 10, display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
            {[
              { label: `Monetization: ${candidate.monetization_viability}`, color: candidate.monetization_viability === 'STRONG' ? '#4ade80' : candidate.monetization_viability === 'MODERATE' ? '#60a5fa' : '#f87171' },
              { label: `Confidence: ${candidate.data_confidence}`, color: '#a78bfa' },
            ].map(({ label, color }) => (
              <span key={label} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, background: `${color}18`, color, fontWeight: 700 }}>{label}</span>
            ))}
            {candidate.policy_risk_flags.map(f => (
              <span key={f} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, background: 'rgba(248,113,113,0.12)', color: '#f87171' }}>⚠ {f.replace(/_/g, ' ')}</span>
            ))}
          </div>

          {candidate.recent_videos.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button id={`similar-channel-videos-toggle-${candidate.rank}`} onClick={() => setShowVids(s => !s)}
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 7, padding: '5px 12px', color: 'rgba(255,255,255,0.65)', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                {showVids ? '▲' : '▼'} {showVids ? 'Hide' : 'Show'} Video Evidence ({candidate.recent_videos.length})
              </button>
              {showVids && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px 80px 130px', gap: 6, fontSize: 10, color: 'rgba(255,255,255,0.32)', fontWeight: 700, textTransform: 'uppercase', paddingBottom: 5, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    <span>Title</span><span style={{ textAlign: 'right' }}>Age</span><span style={{ textAlign: 'right' }}>Views</span><span style={{ textAlign: 'right' }}>VPD</span><span style={{ textAlign: 'center' }}>Status</span>
                  </div>
                  {candidate.recent_videos.slice(0, 15).map(v => <VideoRow key={v.video_id} v={v} />)}
                  {candidate.recent_videos.length > 15 && (
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.32)', marginTop: 5 }}>+{candidate.recent_videos.length - 15} more videos in Excel export</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
