import React, { useEffect, useRef, useState, useCallback } from 'react'
import { researchApi, SIDECAR_DEFAULT_URL } from '../api/researchApi'
import { SimilarChannelCard } from './SimilarChannelCard'
import type {
  SimilarChannelResult,
  SimilarChannelRunProgress,
  SimilarChannelCandidateStatus,
  SimilarChannelCandidate,
  CompetitorAnalysisResult,
} from '../types/research.types'

const POLL_INTERVAL = 3000
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'])

const STAGE_LABELS: Record<string, string> = {
  STARTING: 'Initializing...',
  BUILDING_NICHE_FINGERPRINT: 'Building niche fingerprint & weighted terms...',
  SEARCHING_EXACT_MATCHES: 'Searching Pass 1 (Exact niche relevance)...',
  EXPANDING_SEARCH_QUERIES: 'Expanding queries (Pass 2 & 3 long-tail)...',
  SEARCHING_PERFORMANCE_RESULTS: 'Searching Pass 2 (ViewCount & Date order)...',
  RESOLVING_CHANNEL_IDS: 'Resolving real channel IDs from video metadata...',
  ENRICHING_90_DAY_WINDOW: 'Fetching exact 90-day uploads for candidate channels...',
  ENRICHING_12_MONTH_HISTORY: 'Analyzing 12-month publishing cadence & durability...',
  LOADING_GROWTH_SNAPSHOTS: 'Evaluating historical view snapshots...',
  SCORING_CANDIDATES: 'Evaluating qualification rules & computing niche match...',
  SELECTING_BEST_AVAILABLE: 'Selecting best available fallback candidates...',
  DEDUPLICATING_CHANNELS: 'Grouping candidates by channel...',
  ENRICHING_CHANNELS: 'Enriching candidate channels...',
  CALCULATING_GROWTH: 'Evaluating 90-day performance...',
  RANKING_CANDIDATES: 'Ranking candidates...',
  PERSISTING: 'Saving results & recording view snapshots...',
  COMPLETED: 'Discovery complete.',
  FAILED: 'Discovery failed.',
  CANCELLED: 'Cancelled.',
  INTERRUPTED: 'Interrupted.',
}

interface Props {
  competitor: CompetitorAnalysisResult
  market: string
  language: string
}

type FilterStatus = 'RECOMMENDED' | 'ALL' | SimilarChannelCandidateStatus

function fmt(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—'
  return (n * 100).toFixed(0) + '%'
}

export function SimilarChannelsPanel({ competitor, market, language }: Props) {
  const [runId, setRunId] = useState<string | null>(null)
  const [progress, setProgress] = useState<SimilarChannelRunProgress | null>(null)
  const [result, setResult] = useState<SimilarChannelResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [filter, setFilter] = useState<FilterStatus>('ALL')
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const runIdRef = useRef<string | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const fetchResult = useCallback(async (id: string) => {
    try {
      const res = await researchApi.getSimilarChannelsResult(id)
      setResult(res)
    } catch (e) {
      setError('Failed to fetch results: ' + String(e))
    }
  }, [])

  const poll = useCallback(async (id: string) => {
    try {
      const prog = await researchApi.getSimilarChannelsProgress(id)
      setProgress(prog)
      if (TERMINAL_STATUSES.has(prog.status)) {
        stopPolling()
        if (prog.status === 'COMPLETED') {
          await fetchResult(id)
        } else if (prog.error) {
          setError(prog.error)
        }
      }
    } catch (e) {
      // ignore transient poll errors
    }
  }, [stopPolling, fetchResult])

  const startDiscovery = useCallback(async () => {
    setIsStarting(true)
    setError(null)
    setResult(null)
    setProgress(null)
    stopPolling()
    try {
      const sourceVideos = (competitor.recent_videos || []).map((v: any) => ({
        video_id: v.video_id || '',
        title: v.title || '',
        published_at: v.published_at || '',
        views: v.views || 0,
      }))
      const resp = await researchApi.discoverSimilarChannels({
        source_channel_id: competitor.channel_id,
        source_channel_title: competitor.channel_title,
        source_videos: sourceVideos,
        market,
        language,
        window_days: 90,
        min_views: 10000,
        max_subscribers: 50000,
        min_evaluable_videos: 3,
        candidate_channel_limit: 40,
        search_query_budget: 18,
      })
      const id = resp.run_id
      setRunId(id)
      runIdRef.current = id
      pollRef.current = setInterval(() => poll(id), POLL_INTERVAL)
    } catch (e) {
      setError('Failed to start discovery: ' + String(e))
    } finally {
      setIsStarting(false)
    }
  }, [competitor, market, language, poll, stopPolling])

  const handleCancel = useCallback(async () => {
    if (!runId) return
    try {
      await researchApi.cancelSimilarChannels(runId)
      setProgress(p => p ? { ...p, status: 'CANCELLED', stage: 'CANCELLED' } : null)
      stopPolling()
    } catch (e) {
      setError('Cancel failed: ' + String(e))
    }
  }, [runId, stopPolling])

  const handleExport = useCallback(() => {
    if (!runId) return
    const url = researchApi.getSimilarChannelsExcelUrl(runId, SIDECAR_DEFAULT_URL)
    window.open(url, '_blank')
  }, [runId])

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  // Filter candidates
  const allCandidates: SimilarChannelCandidate[] = result?.candidates ?? []
  
  const recommendedCandidates = allCandidates.filter(
    c => c.status === 'QUALIFIED' || c.status === 'GROWING' || c.is_best_available || c.recommendation_tier === 'BEST_AVAILABLE'
  )

  const displayCandidates = filter === 'RECOMMENDED'
    ? recommendedCandidates
    : filter === 'ALL'
      ? allCandidates
      : allCandidates.filter(c => c.status === filter)

  const counts = {
    QUALIFIED: allCandidates.filter(c => c.status === 'QUALIFIED').length,
    GROWING: allCandidates.filter(c => c.status === 'GROWING').length,
    WATCHLIST: allCandidates.filter(c => c.status === 'WATCHLIST').length,
    REJECTED: allCandidates.filter(c => c.status === 'REJECTED').length,
  }

  const isRunning = progress && !TERMINAL_STATUSES.has(progress.status)
  const isFailed = progress?.status === 'FAILED' || progress?.status === 'CANCELLED'
  const isCompleted = result && result.status === 'COMPLETED'

  // Determine top featured banner candidate
  const qualifiedFirst = allCandidates.find(c => c.status === 'QUALIFIED')
  const growingFirst = allCandidates.find(c => c.status === 'GROWING')
  const bestAvailableFirst = allCandidates.find(c => c.is_best_available || c.recommendation_tier === 'BEST_AVAILABLE')
  const fallbackWatchlist = allCandidates.find(c => c.status === 'WATCHLIST')
  
  const featuredCandidate = qualifiedFirst || growingFirst || bestAvailableFirst || fallbackWatchlist

  const bannerType: 'QUALIFIED' | 'GROWING' | 'BEST_AVAILABLE' | null = qualifiedFirst
    ? 'QUALIFIED'
    : growingFirst
      ? 'GROWING'
      : (bestAvailableFirst || fallbackWatchlist)
        ? 'BEST_AVAILABLE'
        : null

  const bannerConfig = {
    QUALIFIED: {
      title: '★ #1 MOST PROMISING COMPETITOR',
      bg: 'linear-gradient(135deg, rgba(34,197,94,0.15) 0%, rgba(200,150,12,0.18) 100%)',
      border: '1.5px solid rgba(234,179,8,0.5)',
      badgeColor: '#f5c842',
      badgeBg: 'rgba(234,179,8,0.25)',
      accent: '#4ade80',
    },
    GROWING: {
      title: '↗ BEST GROWING CANDIDATE',
      bg: 'linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(99,102,241,0.12) 100%)',
      border: '1.5px solid rgba(96,165,250,0.45)',
      badgeColor: '#60a5fa',
      badgeBg: 'rgba(59,130,246,0.25)',
      accent: '#60a5fa',
    },
    BEST_AVAILABLE: {
      title: '◎ BEST AVAILABLE CANDIDATE',
      bg: 'linear-gradient(135deg, rgba(168,85,247,0.14) 0%, rgba(245,158,11,0.10) 100%)',
      border: '1.5px solid rgba(168,85,247,0.45)',
      badgeColor: '#c084fc',
      badgeBg: 'rgba(168,85,247,0.25)',
      accent: '#fbbf24',
    },
  }

  const currentBannerCfg = bannerType ? bannerConfig[bannerType] : null
  const diag = result?.discovery_diagnostics

  return (
    <div
      id="similar-channels-panel"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 14,
        padding: 20,
        marginTop: 20,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>
            🔍 Similar Channel Discovery
          </h3>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
            Multi-pass discovery in exact 90-day window · ≤ 50K subscribers · min. 10K views · progressive expansion
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!runId && !isStarting && (
            <button
              id="similar-channels-start-btn"
              onClick={startDiscovery}
              style={{
                background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                border: 'none', borderRadius: 8, padding: '8px 16px',
                color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}
            >
              ▶ Discover Similar Channels
            </button>
          )}
          {isStarting && (
            <button disabled style={{ background: 'rgba(99,102,241,0.4)', border: 'none', borderRadius: 8, padding: '8px 16px', color: '#fff', fontSize: 12, fontWeight: 700 }}>
              Starting...
            </button>
          )}
          {isRunning && (
            <button id="similar-channels-cancel-btn" onClick={handleCancel}
              style={{ background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.35)', borderRadius: 8, padding: '8px 14px', color: '#f87171', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              ✕ Cancel
            </button>
          )}
          {isCompleted && (
            <button id="similar-channels-export-btn" onClick={handleExport}
              style={{ background: 'linear-gradient(135deg, #059669, #10b981)', border: 'none', borderRadius: 8, padding: '8px 16px', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              ⬇ Export Excel
            </button>
          )}
          {(isFailed || (result && result.status !== 'COMPLETED')) && runId && (
            <button id="similar-channels-restart-btn" onClick={startDiscovery}
              style={{ background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 8, padding: '8px 14px', color: '#fbbf24', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              ↺ Retry
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      {progress && !isCompleted && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: isFailed ? '#f87171' : 'rgba(255,255,255,0.75)' }}>
              {STAGE_LABELS[progress.stage] || progress.stage}
            </span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
              {progress.elapsed_seconds > 0 && `${progress.elapsed_seconds}s`}
            </span>
          </div>
          <div style={{ height: 5, background: 'rgba(255,255,255,0.07)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${progress.progress_percent}%`,
              background: isFailed ? '#f87171' : progress.status === 'COMPLETED' ? '#4ade80' : 'linear-gradient(90deg, #6366f1, #8b5cf6)',
              borderRadius: 3, transition: 'width 0.5s ease',
            }} />
          </div>
          {progress.message && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 5, fontWeight: 500 }}>
              {progress.message}
            </div>
          )}
          {(progress.candidate_videos_found > 0 || progress.channels_enriched > 0) && (
            <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
              {progress.candidate_videos_found > 0 && <span>📹 {progress.candidate_videos_found.toLocaleString()} videos</span>}
              {progress.candidate_channels_found > 0 && <span>📺 {progress.candidate_channels_found} channels</span>}
              {progress.channels_enriched > 0 && <span>✓ {progress.channels_enriched} enriched</span>}
              {progress.channels_qualified > 0 && <span style={{ color: '#4ade80' }}>★ {progress.channels_qualified} qualified</span>}
              {(progress.channels_growing ?? 0) > 0 && <span style={{ color: '#60a5fa' }}>↗ {progress.channels_growing} growing</span>}
              {(progress.channels_watchlist ?? 0) > 0 && <span style={{ color: '#fbbf24' }}>◎ {progress.channels_watchlist} watchlist</span>}
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 12, color: '#f87171' }}>
          ⚠ {error}
        </div>
      )}

      {/* Results */}
      {isCompleted && result && (
        <>
          {/* Summary stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 8 }}>
            {[
              { label: 'Qualified', count: counts.QUALIFIED, color: '#4ade80', filterKey: 'QUALIFIED' as FilterStatus },
              { label: 'Growing', count: counts.GROWING, color: '#60a5fa', filterKey: 'GROWING' as FilterStatus },
              { label: 'Watchlist', count: counts.WATCHLIST, color: '#fbbf24', filterKey: 'WATCHLIST' as FilterStatus },
              { label: 'Rejected', count: counts.REJECTED, color: '#f87171', filterKey: 'REJECTED' as FilterStatus },
            ].map(({ label, count, color, filterKey }) => (
              <button
                key={label}
                id={`similar-filter-${filterKey}`}
                onClick={() => setFilter(ff => ff === filterKey ? 'ALL' : filterKey)}
                style={{
                  background: filter === filterKey ? `${color}18` : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${filter === filterKey ? color : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: 9, padding: '10px 0', cursor: 'pointer', textAlign: 'center',
                }}
              >
                <div style={{ fontSize: 20, fontWeight: 800, color }}>{count}</div>
                <div style={{ fontSize: 11, color: filter === filterKey ? color : 'rgba(255,255,255,0.5)', marginTop: 2 }}>{label}</div>
              </button>
            ))}
          </div>

          {/* Subtitle count line */}
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginBottom: 16, textAlign: 'center' }}>
            {result.candidate_channels_found} channels discovered · {result.channels_enriched} enriched · {recommendedCandidates.length} recommended
          </div>

          {/* Featured Candidate Banner */}
          {featuredCandidate && currentBannerCfg && (
            <div style={{
              background: currentBannerCfg.bg,
              border: currentBannerCfg.border,
              borderRadius: 12,
              padding: '16px 20px',
              marginBottom: 16,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, color: currentBannerCfg.badgeColor,
                  background: currentBannerCfg.badgeBg, padding: '3px 8px', borderRadius: 5,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                  {currentBannerCfg.title}
                </span>
                <a
                  href={featuredCandidate.channel_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 11, fontWeight: 700, color: currentBannerCfg.accent,
                    textDecoration: 'none', background: 'rgba(255,255,255,0.08)',
                    padding: '4px 10px', borderRadius: 6,
                  }}
                >
                  Open YouTube Channel ↗
                </a>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: 'rgba(255,255,255,0.95)' }}>
                  {featuredCandidate.channel_title}
                </div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
                  {fmt(featuredCandidate.subscriber_count)} subscribers
                </div>
              </div>

              {/* Metric stats row */}
              <div style={{ display: 'flex', gap: 16, margin: '10px 0', fontSize: 12, flexWrap: 'wrap' }}>
                <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Final Score: </span><strong style={{ color: currentBannerCfg.badgeColor }}>{featuredCandidate.scores.final_score.toFixed(1)}</strong></div>
                <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Median Views: </span><strong style={{ color: 'rgba(255,255,255,0.85)' }}>{fmt(featuredCandidate.median_recent_views)}</strong></div>
                <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Pass Rate: </span><strong style={{ color: 'rgba(255,255,255,0.85)' }}>{fmtPct(featuredCandidate.strict_success_ratio)}</strong></div>
                <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Niche Match: </span><strong style={{ color: '#818cf8' }}>{featuredCandidate.scores.niche_match_score.toFixed(0)}/100</strong></div>
              </div>

              {/* Strengths / Reasons */}
              {((featuredCandidate.qualification_reasons.length > 0) || (result.most_promising_reason.length > 0)) && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: currentBannerCfg.accent, marginBottom: 4, textTransform: 'uppercase' }}>
                    Key Strengths / Recommendations:
                  </div>
                  {(result.most_promising_reason.length > 0 ? result.most_promising_reason : featuredCandidate.qualification_reasons)
                    .slice(0, 3)
                    .map((r, i) => (
                      <div key={i} style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginBottom: 2 }}>
                        • {r}
                      </div>
                    ))}
                </div>
              )}

              {/* Unmet Criteria in Banner (if not fully qualified) */}
              {featuredCandidate.unmet_criteria && featuredCandidate.unmet_criteria.length > 0 && (
                <div style={{ marginTop: 10, background: 'rgba(0,0,0,0.2)', borderRadius: 7, padding: '8px 12px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#f87171', marginBottom: 4, textTransform: 'uppercase' }}>
                    Criteria Missing for Strict Qualification:
                  </div>
                  {featuredCandidate.unmet_criteria.slice(0, 3).map((u, i) => (
                    <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', marginBottom: 2 }}>
                      • {u}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* When no Qualified candidate exists */}
          {counts.QUALIFIED === 0 && allCandidates.length > 0 && (
            <div style={{
              background: 'rgba(251,191,36,0.06)',
              border: '1px solid rgba(251,191,36,0.25)',
              borderRadius: 10,
              padding: '12px 16px',
              marginBottom: 16,
              fontSize: 12,
              color: '#fbbf24',
              lineHeight: 1.5,
            }}>
              No channel met every strict qualification rule. The candidates below are the closest available matches discovered in this niche. They remain useful for research, but they are not labeled as fully qualified.
            </div>
          )}

          {/* Discovery Diagnostics Collapsible */}
          {diag && (
            <div style={{
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 9,
              marginBottom: 16,
              overflow: 'hidden',
            }}>
              <button
                id="similar-channels-diagnostics-toggle"
                onClick={() => setShowDiagnostics(d => !d)}
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  padding: '10px 14px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  color: 'rgba(255,255,255,0.65)',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <span>🔎 How candidates were found (Discovery Diagnostics)</span>
                <span>{showDiagnostics ? '▲' : '▼'}</span>
              </button>
              {showDiagnostics && (
                <div style={{ padding: '0 14px 14px', borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 10 }}>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Passes: </span>{diag.discovery_passes_run?.join(', ') || 'N/A'}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Queries Executed: </span>{diag.queries_executed ?? 0} / {diag.queries_generated ?? 0}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Search Calls: </span>{diag.search_calls_used ?? 0}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Raw Videos: </span>{diag.raw_videos_found ?? 0}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Unique Videos: </span>{diag.unique_videos_found ?? 0}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Unique Channels: </span>{diag.unique_channels_found ?? 0}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Enriched: </span>{diag.channels_enriched ?? 0}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>≤ 50K Subs: </span>{diag.channels_under_subscriber_limit ?? 'N/A'}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Niche Matches: </span>{diag.channels_matching_niche ?? 'N/A'}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Verified Dates: </span>{diag.videos_with_verified_dates ?? 0}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Approx Dates: </span>{diag.videos_with_approximate_dates ?? 0}</div>
                    <div><span style={{ color: 'rgba(255,255,255,0.35)' }}>Synthetic Resolved: </span>{diag.resolved_channel_ids ?? 0} / {diag.synthetic_channel_ids_found ?? 0}</div>
                  </div>
                  {diag.stop_reason && (
                    <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.45)' }}>
                      <span style={{ color: 'rgba(255,255,255,0.35)' }}>Stop Reason: </span>{diag.stop_reason}
                    </div>
                  )}
                  {diag.provider_breakdown && Object.keys(diag.provider_breakdown).length > 0 && (
                    <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.45)' }}>
                      <span style={{ color: 'rgba(255,255,255,0.35)' }}>Providers: </span>
                      {Object.entries(diag.provider_breakdown).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Filter Bar */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            {[
              { id: 'RECOMMENDED', label: `Recommended (${recommendedCandidates.length})` },
              { id: 'QUALIFIED', label: `Qualified (${counts.QUALIFIED})` },
              { id: 'GROWING', label: `Growing (${counts.GROWING})` },
              { id: 'WATCHLIST', label: `Watchlist (${counts.WATCHLIST})` },
              { id: 'REJECTED', label: `Rejected (${counts.REJECTED})` },
              { id: 'ALL', label: `All (${allCandidates.length})` },
            ].map(tab => (
              <button
                key={tab.id}
                id={`similar-filter-${tab.id}`}
                onClick={() => setFilter(tab.id as FilterStatus)}
                style={{
                  background: filter === tab.id ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${filter === tab.id ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.08)'}`,
                  borderRadius: 6,
                  padding: '5px 12px',
                  color: filter === tab.id ? '#fff' : 'rgba(255,255,255,0.6)',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontWeight: filter === tab.id ? 700 : 400,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Candidate Cards */}
          {displayCandidates.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.35)', fontSize: 13, padding: '30px 0' }}>
              No channels match the current filter.
            </div>
          ) : (
            displayCandidates.map(c => (
              <SimilarChannelCard
                key={c.channel_id}
                candidate={c}
                defaultExpanded={Boolean(c.is_most_promising || (counts.QUALIFIED === 0 && c.is_best_available && c.best_available_rank === 1))}
              />
            ))
          )}

          {/* Methodology note */}
          <div style={{ marginTop: 14, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: '10px 14px', fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>
            <strong style={{ color: 'rgba(255,255,255,0.55)' }}>Methodology:</strong> Multi-pass candidate retrieval with exact 90-day uploads evaluation. Qualified status requires 100% strict success ratio on evaluable videos (≥10K views or confirmed growth snapshots). Best Available fallback identifies the closest promising research candidates without compromising strict Qualified certification.
          </div>
        </>
      )}

      {!runId && !isStarting && !error && (
        <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 13, padding: '20px 0' }}>
          Click <strong style={{ color: 'rgba(255,255,255,0.55)' }}>Discover Similar Channels</strong> to find competitors in the same niche with a verified 90-day performance window.
        </div>
      )}
    </div>
  )
}
