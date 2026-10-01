import React, { useState } from 'react'
import type { CompetitorAnalysisResult, MarketCode } from '../types/research.types'

interface Props {
  onAnalyzeCompetitor: (url: string, market: MarketCode) => Promise<CompetitorAnalysisResult>
  onCreateProjectFromVideo: (title: string) => void
}

export function CompetitorTab({
  onAnalyzeCompetitor,
  onCreateProjectFromVideo
}: Props): React.ReactElement {
  const [channelUrl, setChannelUrl] = useState('')
  const [market, setMarket] = useState<MarketCode>('US')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<CompetitorAnalysisResult | null>(null)

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!channelUrl.trim() || loading) return

    setLoading(true)
    setError(null)
    try {
      const res = await onAnalyzeCompetitor(channelUrl.trim(), market)
      setData(res)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* ── Input Card ── */}
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '10px',
        padding: '24px'
      }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, margin: '0 0 6px 0', color: 'var(--text-primary)' }}>
          Public Channel Baseline Intelligence
        </h3>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 16px 0' }}>
          Analyze public baseline views, upload cadence, repeat topics, and breakout outliers from any creator channel.
        </p>

        <form onSubmit={handleAnalyze} style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text"
            placeholder="Enter YouTube Channel URL or handle (e.g. @EconomicsExplained or https://www.youtube.com/@Wendover)"
            value={channelUrl}
            onChange={(e) => setChannelUrl(e.target.value)}
            disabled={loading}
            style={{
              flex: 1,
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '6px',
              padding: '10px 14px',
              color: 'var(--text-primary)',
              fontSize: '13px'
            }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!channelUrl.trim() || loading}
            style={{ padding: '0 20px', minWidth: '130px' }}
          >
            {loading ? 'Analyzing...' : 'Analyze Channel'}
          </button>
        </form>

        {error && (
          <div style={{ marginTop: '12px', padding: '10px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px', color: '#f87171', fontSize: '12px' }}>
            ⚠ {error}
          </div>
        )}
      </div>

      {/* ── Analysis Results ── */}
      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Channel Header Banner */}
          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}>
            <div>
              <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Analyzed Creator</div>
              <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', margin: '4px 0 0 0' }}>
                {data.channel_title}
              </h2>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                {data.subscriber_count ? `${data.subscriber_count.toLocaleString()} subscribers` : 'Subscribers hidden'} • Country: {data.country || 'Unknown'} • Cadence: every ~{data.upload_cadence_days} days
              </div>
            </div>
            <a
              href={data.channel_url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => { e.preventDefault(); window.open(data.channel_url) }}
              className="btn btn-secondary"
              style={{ fontSize: '11px', padding: '6px 14px' }}
            >
              Open YouTube Channel ↗
            </a>
          </div>

          {/* Baseline Metrics Grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '12px'
          }}>
            <div style={{ background: 'var(--bg-elevated)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Median Recent Views</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#34d399', marginTop: '4px' }}>
                {data.median_recent_views.toLocaleString()}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Primary baseline</div>
            </div>
            <div style={{ background: 'var(--bg-elevated)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Mean Recent Views</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>
                {Math.round(data.mean_recent_views).toLocaleString()}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Average volume</div>
            </div>
            <div style={{ background: 'var(--bg-elevated)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>P75 High Watermark</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#60a5fa', marginTop: '4px' }}>
                {Math.round(data.p75_views).toLocaleString()}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Top quartile</div>
            </div>
            <div style={{ background: 'var(--bg-elevated)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Topic Consistency</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#c084fc', marginTop: '4px' }}>
                {data.topic_consistency}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Content discipline</div>
            </div>
          </div>

          {/* Repeated Topics & Title Patterns */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px'
          }}>
            <div style={{ background: 'var(--bg-elevated)', padding: '18px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <h4 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 10px 0' }}>
                Best Repeated Topic Themes
              </h4>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {data.best_repeated_topics.map((t, idx) => (
                  <span key={idx} style={{
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border-subtle)',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    color: '#818cf8',
                    fontWeight: 600
                  }}>
                    {t}
                  </span>
                ))}
              </div>
            </div>

            <div style={{ background: 'var(--bg-elevated)', padding: '18px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <h4 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 10px 0' }}>
                Winning Title Patterns Used
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {data.winning_title_patterns.map((p, idx) => (
                  <div key={idx} style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-base)',
                    padding: '6px 10px',
                    borderRadius: '4px',
                    color: '#fbbf24'
                  }}>
                    {p}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Outlier Videos Section */}
          {data.outlier_videos.length > 0 && (
            <div>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 12px 0' }}>
                Outlier Videos Above Baseline ({data.outlier_videos.length})
              </h4>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: '14px'
              }}>
                {data.outlier_videos.map((v) => (
                  <div key={v.video_id} style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '8px',
                    padding: '12px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between'
                  }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <span style={{ fontSize: '10px', color: '#34d399', fontWeight: 700 }}>
                          {v.outlier_ratio}x Outlier
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                          {v.views.toLocaleString()} views
                        </span>
                      </div>
                      <h5 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px 0', lineHeight: 1.4 }}>
                        {v.title}
                      </h5>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
                      <a
                        href={v.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => { e.preventDefault(); window.open(v.url) }}
                        style={{ fontSize: '10px', color: 'var(--text-brand)', textDecoration: 'none' }}
                      >
                        Watch ↗
                      </a>
                      <button
                        className="btn btn-secondary"
                        onClick={() => onCreateProjectFromVideo(v.title)}
                        style={{ fontSize: '10px', padding: '2px 8px' }}
                      >
                        + Project Draft
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
