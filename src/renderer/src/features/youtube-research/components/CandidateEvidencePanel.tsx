import React, { useState } from 'react'
import type { CandidateVideoItem, FilterFunnel, NearMatchSuggestion, ResearchFilters } from '../types/research.types'

interface Props {
  exactMatches: CandidateVideoItem[]
  unverifiedMatches: CandidateVideoItem[]
  nearMatches: CandidateVideoItem[]
  filterFunnel?: FilterFunnel
  nearMatchSuggestions?: NearMatchSuggestion[]
  appliedFilters?: ResearchFilters
  onRelaxFilters?: (field: string, value: number) => void
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function CandidateCard({ video }: { video: CandidateVideoItem }) {
  const isUnverified = video.subscriber_status === 'UNVERIFIED_MATCH'
  const subLabel = isUnverified
    ? '👁 Subscriber hidden'
    : video.channel_subscribers != null
    ? `${formatNumber(video.channel_subscribers)} subs`
    : '—'

  return (
    <div style={{
      background: 'var(--bg-base, #0a0a0f)',
      border: '1px solid var(--border-subtle)',
      borderRadius: '8px',
      padding: '10px 12px',
      display: 'flex',
      gap: '10px',
      alignItems: 'flex-start',
    }}>
      {/* Thumbnail */}
      {video.thumbnail_url ? (
        <img
          src={video.thumbnail_url}
          alt=""
          style={{ width: '72px', height: '40px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
          loading="lazy"
        />
      ) : (
        <div style={{ width: '72px', height: '40px', background: 'var(--bg-elevated)', borderRadius: '4px', flexShrink: 0 }} />
      )}

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <a
          href={video.url}
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            textDecoration: 'none',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            lineHeight: '1.4',
          }}
          title={video.title}
        >
          {video.title}
        </a>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {video.channel_title}
        </div>
        <div style={{ display: 'flex', gap: '12px', marginTop: '5px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            👁 {formatNumber(video.views)} views
          </span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            📈 {video.views_per_day.toFixed(0)}/day
          </span>
          <span style={{
            fontSize: '10px',
            color: isUnverified ? '#fbbf24' : 'var(--text-muted)'
          }}>
            👥 {subLabel}
          </span>
          {video.outlier_ratio != null && (
            <span style={{ fontSize: '10px', color: video.outlier_ratio >= 3 ? '#34d399' : 'var(--text-muted)' }}>
              ⚡ {video.outlier_ratio.toFixed(1)}x outlier
            </span>
          )}
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            📅 {video.age_days.toFixed(0)}d ago
          </span>
        </div>
      </div>

      {/* Badge */}
      <div style={{ flexShrink: 0, paddingTop: '2px' }}>
        {video.subscriber_status === 'VERIFIED_MATCH' && (
          <span style={{
            fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px',
            background: 'rgba(52,211,153,0.15)', color: '#34d399', border: '1px solid rgba(52,211,153,0.3)'
          }}>EXACT</span>
        )}
        {video.subscriber_status === 'UNVERIFIED_MATCH' && (
          <span style={{
            fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px',
            background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)'
          }}>UNVERIFIED</span>
        )}
        {video.subscriber_status === 'REJECTED' && video.filter_distance < 0.5 && (
          <span style={{
            fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px',
            background: 'rgba(148,163,184,0.1)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.2)'
          }}>NEAR</span>
        )}
      </div>
    </div>
  )
}

function FunnelBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.max(3, (value / total) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
      <span style={{ width: '150px', color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: '4px', background: 'var(--bg-elevated)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '2px', transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ width: '36px', textAlign: 'right', color: 'var(--text-primary)', fontWeight: 600 }}>{value}</span>
    </div>
  )
}

export function CandidateEvidencePanel({
  exactMatches,
  unverifiedMatches,
  nearMatches,
  filterFunnel,
  nearMatchSuggestions = [],
  appliedFilters = {},
  onRelaxFilters,
}: Props) {
  const [activeTab, setActiveTab] = useState<'exact' | 'unverified' | 'near' | 'funnel'>('exact')
  const totalEvidence = exactMatches.length + unverifiedMatches.length

  const hasAnyFilters = Boolean(
    appliedFilters.min_views || appliedFilters.max_subscribers ||
    appliedFilters.min_views_per_day || appliedFilters.min_outlier_ratio
  )

  const tabStyle = (id: string) => ({
    fontSize: '11px',
    padding: '5px 12px',
    borderRadius: '4px',
    border: '1px solid transparent',
    cursor: 'pointer',
    background: activeTab === id ? 'var(--accent-primary, #7c3aed)' : 'transparent',
    color: activeTab === id ? '#fff' : 'var(--text-muted)',
    borderColor: activeTab === id ? 'transparent' : 'var(--border-subtle)',
    fontWeight: activeTab === id ? 700 : 400,
    transition: 'all 0.15s ease',
  })

  const currentList = activeTab === 'exact' ? exactMatches
    : activeTab === 'unverified' ? unverifiedMatches
    : nearMatches

  return (
    <div style={{
      background: 'var(--bg-elevated, #13141c)',
      border: '1px solid var(--border-subtle)',
      borderRadius: '10px',
      padding: '16px',
      marginTop: '16px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
            🎯 Candidate Evidence
          </h4>
          <p style={{ margin: '3px 0 0 0', fontSize: '11px', color: 'var(--text-muted)' }}>
            Videos matching your research criteria — sorted by filter closeness
          </p>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {totalEvidence} evidence videos found
          </span>
        </div>
      </div>

      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <button style={tabStyle('exact')} onClick={() => setActiveTab('exact')}>
          ✅ Exact Match ({exactMatches.length})
        </button>
        <button style={tabStyle('unverified')} onClick={() => setActiveTab('unverified')}>
          👁 Unverified ({unverifiedMatches.length})
        </button>
        <button style={tabStyle('near')} onClick={() => setActiveTab('near')}>
          〰️ Near Match ({nearMatches.length})
        </button>
        {filterFunnel && (
          <button style={tabStyle('funnel')} onClick={() => setActiveTab('funnel')}>
            📊 Filter Funnel
          </button>
        )}
      </div>

      {/* Empty state for exact */}
      {activeTab === 'exact' && exactMatches.length === 0 && hasAnyFilters && (
        <div style={{
          padding: '16px',
          background: 'rgba(248,113,113,0.05)',
          border: '1px solid rgba(248,113,113,0.15)',
          borderRadius: '8px',
          marginBottom: '12px',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#f87171', marginBottom: '8px' }}>
            No Exact Matches Found
          </div>
          {filterFunnel && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.7' }}>
              <div>Universe collected: <strong style={{ color: 'var(--text-primary)' }}>{filterFunnel.raw_collected}</strong> videos</div>
              <div>Passed min views: <strong style={{ color: 'var(--text-primary)' }}>{filterFunnel.above_min_views}</strong></div>
              <div>Subscriber known: <strong style={{ color: 'var(--text-primary)' }}>{filterFunnel.subscriber_known}</strong> / unknown: <strong style={{ color: '#fbbf24' }}>{filterFunnel.subscriber_unknown}</strong></div>
              <div>Exact matches: <strong style={{ color: '#f87171' }}>0</strong></div>
              <div>Unverified matches: <strong style={{ color: '#fbbf24' }}>{filterFunnel.unverified_matches}</strong></div>
              <div>Near matches: <strong style={{ color: 'var(--text-primary)' }}>{filterFunnel.near_matches}</strong></div>
            </div>
          )}

          {nearMatchSuggestions.length > 0 && (
            <div style={{ marginTop: '10px' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>
                💡 Suggestions to find more candidates:
              </div>
              {nearMatchSuggestions.map((s, i) => (
                <div key={i} style={{
                  fontSize: '11px', color: 'var(--text-muted)',
                  padding: '6px 8px', background: 'var(--bg-base)',
                  borderRadius: '4px', marginBottom: '4px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                }}>
                  <span>
                    {s.description}
                    <span style={{ color: '#34d399', marginLeft: '6px' }}>
                      (+{s.would_add_candidates} candidates)
                    </span>
                  </span>
                  {onRelaxFilters && (
                    <button
                      className="btn btn-secondary"
                      onClick={() => onRelaxFilters(s.field, Number(s.suggested_value))}
                      style={{ fontSize: '10px', padding: '2px 8px', marginLeft: '8px' }}
                    >
                      Apply
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: '10px', display: 'flex', gap: '8px' }}>
            <button
              className="btn btn-secondary"
              onClick={() => setActiveTab('unverified')}
              style={{ fontSize: '11px' }}
            >
              Show Unverified ({unverifiedMatches.length})
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setActiveTab('near')}
              style={{ fontSize: '11px' }}
            >
              Show Near Matches ({nearMatches.length})
            </button>
          </div>
        </div>
      )}

      {/* Filter Funnel Tab */}
      {activeTab === 'funnel' && filterFunnel && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <FunnelBar label="Raw collected" value={filterFunnel.raw_collected} total={filterFunnel.raw_collected} color="#6366f1" />
          <FunnelBar label="After dedup" value={filterFunnel.unique_after_dedupe} total={filterFunnel.raw_collected} color="#818cf8" />
          <FunnelBar label="Above min views" value={filterFunnel.above_min_views} total={filterFunnel.raw_collected} color="#a78bfa" />
          <FunnelBar label="Subscriber known" value={filterFunnel.subscriber_known} total={filterFunnel.raw_collected} color="#34d399" />
          <FunnelBar label="Sub unknown" value={filterFunnel.subscriber_unknown} total={filterFunnel.raw_collected} color="#fbbf24" />
          <FunnelBar label="Exact matches ✅" value={filterFunnel.exact_matches} total={filterFunnel.raw_collected} color="#34d399" />
          <FunnelBar label="Unverified 👁" value={filterFunnel.unverified_matches} total={filterFunnel.raw_collected} color="#fbbf24" />
          <FunnelBar label="Near matches 〰️" value={filterFunnel.near_matches} total={filterFunnel.raw_collected} color="#94a3b8" />
          {filterFunnel.excluded_by_reason && Object.entries(filterFunnel.excluded_by_reason).map(([reason, count]) =>
            count > 0 ? (
              <FunnelBar key={reason} label={`Excl. ${reason}`} value={count} total={filterFunnel.raw_collected} color="#f87171" />
            ) : null
          )}
        </div>
      )}

      {/* Video List */}
      {activeTab !== 'funnel' && (
        <div>
          {/* Unverified explanation banner */}
          {activeTab === 'unverified' && unverifiedMatches.length > 0 && (
            <div style={{
              fontSize: '11px', color: '#fbbf24',
              padding: '8px 10px', background: 'rgba(251,191,36,0.06)',
              border: '1px solid rgba(251,191,36,0.2)', borderRadius: '6px', marginBottom: '10px',
            }}>
              👁 <strong>Subscriber count is hidden</strong> on these channels. They pass all other filters but subscriber count cannot be verified. They are shown separately from confirmed exact matches.
            </div>
          )}

          {/* Near match explanation */}
          {activeTab === 'near' && nearMatches.length > 0 && (
            <div style={{
              fontSize: '11px', color: '#94a3b8',
              padding: '8px 10px', background: 'rgba(148,163,184,0.05)',
              border: '1px solid rgba(148,163,184,0.15)', borderRadius: '6px', marginBottom: '10px',
            }}>
              〰️ These videos are close to your filter criteria but don't fully match. They may become exact matches if you slightly relax your filters.
            </div>
          )}

          {currentList.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
              No {activeTab === 'exact' ? 'exact matches' : activeTab === 'unverified' ? 'unverified candidates' : 'near matches'} found.
              {!hasAnyFilters && activeTab === 'exact' && ' Enable Advanced Filters to see candidate classification.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {currentList.slice(0, 20).map((v) => (
                <CandidateCard key={v.video_id} video={v} />
              ))}
              {currentList.length > 20 && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '8px' }}>
                  + {currentList.length - 20} more candidates not shown
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
