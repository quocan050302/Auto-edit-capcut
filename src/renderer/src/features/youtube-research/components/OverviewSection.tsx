import React from 'react'
import type { ResearchRunResult, BreakoutVideoItem } from '../types/research.types'
import { CandidateEvidencePanel } from './CandidateEvidencePanel'

interface Props {
  result: ResearchRunResult
  onSelectKeyword: (kw: string) => void
  onCreateProjectFromKeyword: (kw: string, angle?: string) => void
  onRetry?: () => void
}

export function OverviewSection({
  result,
  onSelectKeyword,
  onCreateProjectFromKeyword,
  onRetry
}: Props): React.ReactElement {
  const topOpp = result.top_opportunity
  const metrics = result.overview_metrics
  const ai = result.ai_insights
  const filterSummary = result.filter_summary

  if (result.keywords.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', alignItems: 'center', marginTop: '60px' }}>
        <div style={{ fontSize: '48px' }}>📭</div>
        <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>No Results Found</h2>
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', maxWidth: '400px', lineHeight: 1.6 }}>
          Your search did not yield any keywords that met all the advanced filter criteria. Try adjusting your filters or running the research without filters to see the raw data.
        </p>
        
        {filterSummary && filterSummary.applied_filters && Object.keys(filterSummary.applied_filters).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', marginTop: '12px' }}>
            {Object.entries(filterSummary.applied_filters).map(([key, value]) => (
              <span key={key} style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#f87171',
                padding: '4px 10px',
                borderRadius: '999px',
                fontSize: '11px'
              }}>
                {key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}: {value as React.ReactNode}
              </span>
            ))}
          </div>
        )}

        <div style={{ marginTop: '24px' }}>
          <button
            className="btn btn-primary"
            onClick={onRetry}
            style={{ padding: '8px 24px', fontSize: '13px' }}
          >
            Run Without Filters
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* ── Applied Filters Summary ── */}
      {filterSummary && filterSummary.applied_filters && Object.keys(filterSummary.applied_filters).length > 0 && (
        <div style={{
          background: 'rgba(99, 102, 241, 0.05)',
          border: '1px solid rgba(99, 102, 241, 0.2)',
          borderRadius: '8px',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap'
        }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Applied Filters:</span>
          {Object.entries(filterSummary.applied_filters).map(([key, value]) => (
            <span key={key} style={{
              background: 'rgba(99, 102, 241, 0.15)',
              border: '1px solid rgba(99, 102, 241, 0.3)',
              color: '#a5b4fc',
              padding: '2px 8px',
              borderRadius: '999px',
              fontSize: '11px'
            }}>
              {key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}: {value as React.ReactNode}
            </span>
          ))}
          <div style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-muted)' }}>
            Excluded {filterSummary.keywords_before_filters - filterSummary.keywords_after_filters} keywords / {filterSummary.raw_videos_collected - filterSummary.videos_after_all_filters} videos
          </div>
        </div>
      )}
      {/* ── Top Market Opportunity Card ── */}
      {topOpp && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(139, 92, 246, 0.08) 100%)',
          border: '1px solid rgba(99, 102, 241, 0.4)',
          borderRadius: 'var(--radius-lg, 12px)',
          padding: '24px',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.2)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '1px',
              color: '#818cf8'
            }}>
              🔥 Top Market Opportunity Identified
            </span>
            <button
              className="btn btn-primary"
              onClick={() => onCreateProjectFromKeyword(topOpp.keyword, ai?.winning_angles?.[0])}
              style={{ fontSize: '11px', padding: '6px 14px' }}
            >
              + Create Video Project
            </button>
          </div>

          <h2 style={{
            fontSize: '22px',
            fontWeight: 800,
            textTransform: 'uppercase',
            color: '#ffffff',
            margin: '0 0 16px 0',
            letterSpacing: '0.5px'
          }}>
            {topOpp.keyword}
          </h2>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: '16px',
            background: 'rgba(0, 0, 0, 0.25)',
            padding: '16px',
            borderRadius: '8px'
          }}>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Opportunity Score</div>
              <div style={{ fontSize: '24px', fontWeight: 800, color: '#34d399', marginTop: '2px' }}>
                {Math.round(topOpp.opportunity_score)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Data Confidence</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>
                {topOpp.confidence_level}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Market Fit</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#60a5fa', marginTop: '4px' }}>
                {Math.round(topOpp.market_fit_score)}/100
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Competition</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#fbbf24', marginTop: '4px' }}>
                {Math.round(topOpp.competition_score)}/100
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Trend Velocity</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#c084fc', marginTop: '4px' }}>
                {topOpp.trend_state}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Summary Metrics Bar ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(6, 1fr)',
        gap: '12px'
      }}>
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '14px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Videos Analyzed</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>{metrics.videos_analyzed}</div>
        </div>
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '14px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Unique Channels</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>{metrics.unique_channels}</div>
        </div>
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '14px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Keywords Discovered</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>{metrics.keywords_found}</div>
        </div>
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '14px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Breakout Videos</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: '#34d399', marginTop: '4px' }}>{metrics.breakouts_found}</div>
        </div>
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '14px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Small Channel Wins</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: '#818cf8', marginTop: '4px' }}>{metrics.small_channel_wins}</div>
        </div>
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '14px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Data Confidence</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: '#60a5fa', marginTop: '4px' }}>{metrics.data_confidence}</div>
        </div>
      </div>

      {/* ── AI Insights & Angles Grid ── */}
      {ai && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '20px'
        }}>
          {/* Left: Summary & Angles */}
          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <div>
              <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px 0' }}>
                Executive Intelligence
              </h3>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
                {ai.summary}
              </p>
            </div>

            <div>
              <h4 style={{ fontSize: '12px', fontWeight: 700, color: '#818cf8', margin: '0 0 8px 0' }}>
                Proven Winning Angles
              </h4>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {ai.winning_angles.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          </div>

          {/* Right: Title Patterns & Content Gaps */}
          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <div>
              <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px 0' }}>
                Winning Title Patterns
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {ai.title_patterns.map((p, i) => (
                  <div key={i} style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-base)',
                    padding: '6px 10px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-subtle)',
                    color: '#a5b4fc'
                  }}>
                    {p}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h4 style={{ fontSize: '12px', fontWeight: 700, color: '#fbbf24', margin: '0 0 8px 0' }}>
                Identified Content Gaps
              </h4>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {ai.content_gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ── Top Breakout Video Evidence Preview ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Breakout Video Evidence
          </h3>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            High outlier videos outperforming their channel average
          </span>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '16px'
        }}>
          {result.breakout_videos.slice(0, 3).map((video) => (
            <div key={video.video_id} style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column'
            }}>
              <div style={{ position: 'relative', width: '100%', height: '120px', background: '#000' }}>
                {video.thumbnail_url && (
                  <img
                    src={video.thumbnail_url}
                    alt={video.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    loading="lazy"
                  />
                )}
                {video.is_small_channel_breakout && (
                  <span style={{
                    position: 'absolute',
                    top: '8px',
                    left: '8px',
                    background: 'rgba(99, 102, 241, 0.9)',
                    color: '#fff',
                    fontSize: '9px',
                    fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: '4px'
                  }}>
                    🐟 Small Channel Win
                  </span>
                )}
                <span style={{
                  position: 'absolute',
                  bottom: '8px',
                  right: '8px',
                  background: 'rgba(0, 0, 0, 0.8)',
                  color: '#34d399',
                  fontSize: '10px',
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: '4px'
                }}>
                  {video.outlier_ratio}x Outlier
                </span>
              </div>
              <div style={{ padding: '12px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <h4 style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    margin: '0 0 6px 0',
                    lineHeight: 1.4,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}>
                    {video.title}
                  </h4>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {video.channel_title} • {video.views.toLocaleString()} views
                  </div>
                </div>

                <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '10px', color: '#818cf8', fontWeight: 600 }}>
                    {video.views_per_day.toLocaleString()} views/day
                  </span>
                  <a
                    href={video.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => { e.preventDefault(); window.open(video.url) }}
                    style={{ fontSize: '11px', color: 'var(--text-brand)', textDecoration: 'none' }}
                  >
                    Open YouTube ↗
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Data Provenance & Tooltip Disclaimer ── */}
      <div style={{
        padding: '12px 16px',
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '6px',
        fontSize: '11px',
        color: 'var(--text-muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div>
          ℹ <strong style={{ color: 'var(--text-secondary)' }}>Data Transparency:</strong> All metrics, outliers, and baseline estimates are computed from public YouTube API and web signals.
        </div>
        <div style={{ fontStyle: 'italic', color: '#a5b4fc' }}>
          * This is an estimated public-data signal, not private audience geography.
        </div>
      </div>

      {/* V2: Candidate Evidence Panel (only shown when V2 data exists) */}
      {(result.exact_matches || result.unverified_matches || result.near_matches) && (
        <CandidateEvidencePanel
          exactMatches={result.exact_matches || []}
          unverifiedMatches={result.unverified_matches || []}
          nearMatches={result.near_matches || []}
          filterFunnel={result.filter_funnel}
          nearMatchSuggestions={result.near_match_suggestions || []}
        />
      )}
    </div>
  )
}
