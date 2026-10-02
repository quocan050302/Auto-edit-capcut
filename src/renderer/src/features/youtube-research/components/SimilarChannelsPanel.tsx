import React, { useEffect, useRef, useState, useCallback } from 'react'
import { researchApi, SIDECAR_DEFAULT_URL } from '../api/researchApi'
import { SimilarChannelCard } from './SimilarChannelCard'
import type {
  SimilarChannelResult,
  SimilarChannelRunProgress,
  SimilarChannelCandidateStatus,
  CompetitorAnalysisResult,
} from '../types/research.types'

const POLL_INTERVAL = 3000
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'])

const STAGE_LABELS: Record<string, string> = {
  STARTING: 'Initializing...',
  BUILDING_NICHE_FINGERPRINT: 'Building niche fingerprint...',
  GENERATING_SEARCH_QUERIES: 'Generating search queries...',
  SEARCHING_CANDIDATE_VIDEOS: 'Searching YouTube for candidates...',
  DEDUPLICATING_CHANNELS: 'Grouping by channel...',
  ENRICHING_CHANNELS: 'Enriching candidate channels...',
  CALCULATING_GROWTH: 'Evaluating 90-day performance...',
  RANKING_CANDIDATES: 'Ranking and scoring candidates...',
  PERSISTING: 'Saving results...',
  COMPLETED: 'Analysis complete.',
  FAILED: 'Analysis failed.',
  CANCELLED: 'Cancelled.',
  INTERRUPTED: 'Interrupted.',
}

interface Props {
  competitor: CompetitorAnalysisResult
  market: string
  language: string
}

type FilterStatus = 'ALL' | SimilarChannelCandidateStatus

export function SimilarChannelsPanel({ competitor, market, language }: Props) {
  const [runId, setRunId] = useState<string | null>(null)
  const [progress, setProgress] = useState<SimilarChannelRunProgress | null>(null)
  const [result, setResult] = useState<SimilarChannelResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [filter, setFilter] = useState<FilterStatus>('ALL')
  const [showQualifiedOnly, setShowQualifiedOnly] = useState(false)
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
        search_query_budget: 10,
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
  const allCandidates = result?.candidates ?? []
  const filtered = filter === 'ALL' ? allCandidates : allCandidates.filter(c => c.status === filter)
  const displayCandidates = showQualifiedOnly
    ? filtered.filter(c => c.status === 'QUALIFIED' || c.status === 'GROWING')
    : filtered

  const counts = {
    QUALIFIED: allCandidates.filter(c => c.status === 'QUALIFIED').length,
    GROWING: allCandidates.filter(c => c.status === 'GROWING').length,
    WATCHLIST: allCandidates.filter(c => c.status === 'WATCHLIST').length,
    REJECTED: allCandidates.filter(c => c.status === 'REJECTED').length,
  }

  const isRunning = progress && !TERMINAL_STATUSES.has(progress.status)
  const isFailed = progress?.status === 'FAILED' || progress?.status === 'CANCELLED'
  const isCompleted = result && result.status === 'COMPLETED'
  const mostPromising = allCandidates.find(c => c.is_most_promising)

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
            Finds channels in the same niche over a strict 90-day window · ≤ 50K subscribers · min. 10K views/video
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
            <span style={{ fontSize: 12, color: isFailed ? '#f87171' : 'rgba(255,255,255,0.65)' }}>
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
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>{progress.message}</div>
          )}
          {(progress.candidate_videos_found > 0 || progress.channels_enriched > 0) && (
            <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
              {progress.candidate_videos_found > 0 && <span>📹 {progress.candidate_videos_found.toLocaleString()} candidate videos</span>}
              {progress.candidate_channels_found > 0 && <span>📺 {progress.candidate_channels_found} channels</span>}
              {progress.channels_enriched > 0 && <span>✓ {progress.channels_enriched} enriched</span>}
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
            {[
              { label: 'Qualified', count: result.qualified_count, color: '#4ade80', filter: 'QUALIFIED' as FilterStatus },
              { label: 'Growing', count: result.growing_count, color: '#60a5fa', filter: 'GROWING' as FilterStatus },
              { label: 'Watchlist', count: result.watchlist_count, color: '#fbbf24', filter: 'WATCHLIST' as FilterStatus },
              { label: 'Rejected', count: result.rejected_count, color: '#f87171', filter: 'REJECTED' as FilterStatus },
            ].map(({ label, count, color, filter: f }) => (
              <button key={label} id={`similar-filter-${f}`} onClick={() => setFilter(ff => ff === f ? 'ALL' : f)}
                style={{
                  background: filter === f ? `${color}18` : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${filter === f ? color : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: 9, padding: '10px 0', cursor: 'pointer', textAlign: 'center',
                }}>
                <div style={{ fontSize: 20, fontWeight: 800, color }}>{count}</div>
                <div style={{ fontSize: 11, color: filter === f ? color : 'rgba(255,255,255,0.5)', marginTop: 2 }}>{label}</div>
              </button>
            ))}
          </div>

          {/* Most Promising Banner */}
          {mostPromising && (
            <div style={{ background: 'linear-gradient(135deg, rgba(200,150,12,0.18) 0%, rgba(99,102,241,0.10) 100%)', border: '1.5px solid rgba(200,150,12,0.4)', borderRadius: 12, padding: '14px 18px', marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#f5c842', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                ★ Most Promising Competitor
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'rgba(255,255,255,0.9)', marginBottom: 4 }}>
                <a href={mostPromising.channel_url} target="_blank" rel="noopener noreferrer" style={{ color: '#f5c842', textDecoration: 'none' }}>
                  {mostPromising.channel_title}
                </a>
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginLeft: 10 }}>— {mostPromising.status}</span>
              </div>
              {result.most_promising_reason.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {result.most_promising_reason.map((r, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginBottom: 3 }}>• {r}</div>
                  ))}
                </div>
              )}
              {result.limitations.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(251,191,36,0.7)' }}>
                  ⚠ {result.limitations[0]}
                </div>
              )}
            </div>
          )}

          {!mostPromising && allCandidates.length > 0 && (
            <div style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 14, fontSize: 12, color: '#fbbf24' }}>
              ⚠ No fully qualified competitor found in this niche within the 90-day window.
              Channels below are listed for monitoring purposes.
            </div>
          )}

          {/* Filter bar */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <button id="similar-filter-ALL" onClick={() => setFilter('ALL')}
              style={{ background: filter === 'ALL' ? 'rgba(255,255,255,0.12)' : 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '4px 12px', color: 'rgba(255,255,255,0.75)', fontSize: 11, cursor: 'pointer', fontWeight: filter === 'ALL' ? 700 : 400 }}>
              All ({allCandidates.length})
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(255,255,255,0.55)', cursor: 'pointer' }}>
              <input type="checkbox" checked={showQualifiedOnly} onChange={e => setShowQualifiedOnly(e.target.checked)} />
              Qualified & Growing only
            </label>
          </div>

          {/* Cards */}
          {displayCandidates.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.35)', fontSize: 13, padding: '30px 0' }}>
              No channels match the current filter.
            </div>
          ) : (
            displayCandidates.map(c => (
              <SimilarChannelCard
                key={c.channel_id}
                candidate={c}
                defaultExpanded={c.is_most_promising}
              />
            ))
          )}

          {/* Methodology note */}
          <div style={{ marginTop: 14, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: '10px 14px', fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>
            <strong style={{ color: 'rgba(255,255,255,0.55)' }}>Methodology:</strong> Discovery uses public-data scraping only. Subscriber counts may be rounded or hidden. Monetization Viability is an estimate — not a YPP status declaration. Watch hours, RPM, CPM, and revenue data are not publicly accessible. Growth confirmation is provisional until a second data snapshot is captured.
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
