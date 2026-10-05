import React, { useState, useMemo } from 'react'
import type { BreakoutVideoItem } from '../types/research.types'

interface Props {
  breakoutVideos: BreakoutVideoItem[]
  onCreateProjectFromVideo: (title: string) => void
}

type SortOption = 'outlier' | 'velocity' | 'views' | 'age'

export function BreakoutVideosTab({
  breakoutVideos,
  onCreateProjectFromVideo
}: Props): React.ReactElement {
  const [minOutlier, setMinOutlier] = useState<number>(3.0)
  const [onlySmallChannel, setOnlySmallChannel] = useState<boolean>(false)
  const [sortBy, setSortBy] = useState<SortOption>('outlier')
  const [searchFilter, setSearchFilter] = useState<string>('')

  const filtered = useMemo(() => {
    return breakoutVideos.filter((v) => {
      if (searchFilter && !v.title.toLowerCase().includes(searchFilter.toLowerCase()) && !v.channel_title.toLowerCase().includes(searchFilter.toLowerCase())) {
        return false
      }
      if (v.outlier_ratio < minOutlier) return false
      if (onlySmallChannel && !v.is_small_channel_breakout) return false
      return true
    })
  }, [breakoutVideos, searchFilter, minOutlier, onlySmallChannel])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortBy === 'outlier') return b.outlier_ratio - a.outlier_ratio
      if (sortBy === 'velocity') return b.views_per_day - a.views_per_day
      if (sortBy === 'views') return b.views - a.views
      if (sortBy === 'age') return a.age_days - b.age_days
      return 0
    })
  }, [filtered, sortBy])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* ── Toolbar ── */}
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: '280px' }}>
          <input
            type="text"
            placeholder="Search breakout titles or channels..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            style={{
              width: '100%',
              maxWidth: '280px',
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '6px',
              padding: '6px 12px',
              color: 'var(--text-primary)',
              fontSize: '12px'
            }}
          />

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={onlySmallChannel}
              onChange={(e) => setOnlySmallChannel(e.target.checked)}
            />
            <span>🐟 Small Channel Wins Only</span>
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Min Outlier Slider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Min Outlier:</span>
            <select
              value={minOutlier}
              onChange={(e) => setMinOutlier(parseFloat(e.target.value))}
              style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '11px'
              }}
            >
              <option value={2.0}>2.0x</option>
              <option value={3.0}>3.0x</option>
              <option value={5.0}>5.0x (High Outlier)</option>
              <option value={10.0}>10.0x (Mega Breakout)</option>
            </select>
          </div>

          {/* Sort */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '11px'
              }}
            >
              <option value="outlier">Highest Outlier Ratio</option>
              <option value="velocity">Fastest Views / Day</option>
              <option value="views">Most Absolute Views</option>
              <option value="age">Newest First</option>
            </select>
          </div>
        </div>
      </div>

      {/* ── Breakout Grid ── */}
      {sorted.length === 0 ? (
        <div style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '40px',
          textAlign: 'center',
          color: 'var(--text-muted)'
        }}>
          No breakout videos match the selected filters. Try lowering the minimum outlier ratio.
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: '16px'
        }}>
          {sorted.map((video) => (
            <div
              key={video.video_id}
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 2px 10px rgba(0, 0, 0, 0.2)'
              }}
            >
              {/* Thumbnail Container */}
              <div style={{ position: 'relative', width: '100%', height: '170px', background: '#000' }}>
                {video.thumbnail_url && (
                  <img
                    src={video.thumbnail_url}
                    alt={video.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    loading="lazy"
                  />
                )}
                {/* Outlier Ratio Badge */}
                <span style={{
                  position: 'absolute',
                  top: '10px',
                  right: '10px',
                  background: 'rgba(0, 0, 0, 0.85)',
                  border: '1px solid rgba(52, 211, 153, 0.4)',
                  color: '#34d399',
                  fontSize: '11px',
                  fontWeight: 800,
                  fontFamily: 'var(--font-mono)',
                  padding: '2px 8px',
                  borderRadius: '4px'
                }}>
                  {video.outlier_ratio}x Outlier
                </span>

                {video.is_small_channel_breakout && (
                  <span style={{
                    position: 'absolute',
                    top: '10px',
                    left: '10px',
                    background: 'rgba(99, 102, 241, 0.95)',
                    color: '#fff',
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: '4px',
                    boxShadow: '0 2px 6px rgba(0,0,0,0.4)'
                  }}>
                    🐟 Small Channel Breakout
                  </span>
                )}
              </div>

              {/* Video Content */}
              <div style={{ padding: '14px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <h4 style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    margin: '0 0 8px 0',
                    lineHeight: 1.4,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}>
                    {video.title}
                  </h4>

                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                    <strong>{video.channel_title}</strong>
                    {video.channel_subscribers ? ` • ${video.channel_subscribers.toLocaleString()} subs` : ' • Hidden subs'}
                  </div>

                  {/* Metrics Box */}
                  <div style={{
                    background: 'var(--bg-base)',
                    padding: '8px 10px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-subtle)',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gap: '6px',
                    fontSize: '10px',
                    color: 'var(--text-muted)'
                  }}>
                    <div>
                      Views: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{video.views.toLocaleString()}</span>
                    </div>
                    <div>
                      Velocity: <span style={{ color: '#818cf8', fontWeight: 600 }}>{video.views_per_day.toLocaleString()} /day</span>
                    </div>
                    <div>
                      Channel Median: <span style={{ color: 'var(--text-primary)' }}>{video.channel_median_views ? video.channel_median_views.toLocaleString() : 'N/A'}</span>
                    </div>
                    <div>
                      Age: <span style={{ color: 'var(--text-primary)' }}>{Math.round(video.age_days)} days</span>
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: '14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <a
                    href={video.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => { e.preventDefault(); window.open(video.url) }}
                    style={{ fontSize: '11px', color: 'var(--text-brand)', textDecoration: 'none' }}
                  >
                    Open on YouTube ↗
                  </a>
                  <button
                    className="btn btn-primary"
                    onClick={() => onCreateProjectFromVideo(video.title)}
                    style={{ fontSize: '10px', padding: '4px 10px' }}
                  >
                    + Video Project
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
