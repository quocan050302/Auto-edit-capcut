import React, { useState, useMemo } from 'react'
import type { KeywordMetricRecord } from '../types/research.types'

interface Props {
  keywords: KeywordMetricRecord[]
  isAdvancedView: boolean
  onOpenDetail: (record: KeywordMetricRecord) => void
  onCreateProject: (keyword: string) => void
}

type SortField =
  | 'opportunity_score'
  | 'demand_score'
  | 'velocity_score'
  | 'outlier_score'
  | 'competition_score'
  | 'market_fit_score'
  | 'freshness_score'
  | 'median_views'
  | 'median_views_per_day'
  | 'best_outlier_ratio'
  | 'keyword'

export function KeywordExplorerTab({
  keywords,
  isAdvancedView,
  onOpenDetail,
  onCreateProject
}: Props): React.ReactElement {
  const [searchFilter, setSearchFilter] = useState('')
  const [badgeFilter, setBadgeFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<SortField>('opportunity_score')
  const [sortAsc, setSortAsc] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 50

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc)
    } else {
      setSortField(field)
      setSortAsc(false)
    }
  }

  const filtered = useMemo(() => {
    return keywords.filter((k) => {
      if (searchFilter && !k.keyword.toLowerCase().includes(searchFilter.toLowerCase())) {
        return false
      }
      if (badgeFilter === 'rising' && !k.is_rising) return false
      if (badgeFilter === 'low_comp' && !k.is_low_competition) return false
      if (badgeFilter === 'breakout' && !k.is_breakout) return false
      if (badgeFilter === 'small_win' && !k.is_small_channel_win) return false
      return true
    })
  }, [keywords, searchFilter, badgeFilter])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let vA = a[sortField]
      let vB = b[sortField]
      if (typeof vA === 'string') {
        const res = (vA as string).localeCompare(vB as string)
        return sortAsc ? res : -res
      }
      const numA = (vA as number) ?? 0
      const numB = (vB as number) ?? 0
      return sortAsc ? numA - numB : numB - numA
    })
  }, [filtered, sortField, sortAsc])

  const paginated = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return sorted.slice(start, start + pageSize)
  }, [sorted, currentPage])

  const totalPages = Math.ceil(sorted.length / pageSize) || 1

  const handleExportCsv = () => {
    if (!sorted.length) return
    const headers = [
      'Keyword',
      'Opportunity',
      'Confidence',
      'Demand',
      'Velocity',
      'Outlier',
      'Competition',
      'Market Fit',
      'Freshness',
      'Videos',
      'Channels',
      'Median Views',
      'Median Views/Day',
      'Best Outlier Ratio'
    ]
    const rows = sorted.map((k) => [
      `"${k.keyword.replace(/"/g, '""')}"`,
      k.opportunity_score,
      k.confidence_level,
      k.demand_score,
      k.velocity_score,
      k.outlier_score,
      k.competition_score,
      k.market_fit_score,
      k.freshness_score,
      k.video_count,
      k.channel_count,
      k.median_views,
      k.median_views_per_day,
      k.best_outlier_ratio
    ])

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `youtube-research-keywords-${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const renderOpportunityBadge = (score: number) => {
    let color = '#34d399'
    let bg = 'rgba(52, 211, 153, 0.15)'
    if (score < 50) {
      color = '#f87171'
      bg = 'rgba(248, 113, 113, 0.15)'
    } else if (score < 75) {
      color = '#fbbf24'
      bg = 'rgba(251, 191, 36, 0.15)'
    }
    return (
      <span style={{
        background: bg,
        color: color,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        padding: '3px 8px',
        borderRadius: '4px'
      }}>
        {Math.round(score)}
      </span>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* ── Toolbar: Search, Filters, Badges, Export ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
        background: 'var(--bg-elevated)',
        padding: '14px 18px',
        borderRadius: '8px',
        border: '1px solid var(--border-subtle)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: '260px' }}>
          <input
            type="text"
            placeholder="Search keywords in results..."
            value={searchFilter}
            onChange={(e) => {
              setSearchFilter(e.target.value)
              setCurrentPage(1)
            }}
            style={{
              width: '100%',
              maxWidth: '300px',
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '6px',
              padding: '6px 12px',
              color: 'var(--text-primary)',
              fontSize: '12px'
            }}
          />

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              className={`btn ${badgeFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setBadgeFilter('all')}
              style={{ fontSize: '11px', padding: '4px 10px' }}
            >
              All ({keywords.length})
            </button>
            <button
              className={`btn ${badgeFilter === 'rising' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setBadgeFilter('rising')}
              style={{ fontSize: '11px', padding: '4px 10px' }}
            >
              🔥 Rising
            </button>
            <button
              className={`btn ${badgeFilter === 'low_comp' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setBadgeFilter('low_comp')}
              style={{ fontSize: '11px', padding: '4px 10px' }}
            >
              💎 Low Comp
            </button>
            <button
              className={`btn ${badgeFilter === 'breakout' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setBadgeFilter('breakout')}
              style={{ fontSize: '11px', padding: '4px 10px' }}
            >
              🚀 Breakout
            </button>
            <button
              className={`btn ${badgeFilter === 'small_win' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setBadgeFilter('small_win')}
              style={{ fontSize: '11px', padding: '4px 10px' }}
            >
              🐟 Small Win
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Showing {sorted.length} keywords
          </span>
          <button
            className="btn btn-secondary"
            onClick={handleExportCsv}
            disabled={!sorted.length}
            style={{ fontSize: '11px', padding: '6px 12px' }}
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* ── Table Container ── */}
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        overflowX: 'auto'
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
          <thead>
            <tr style={{ background: 'var(--bg-base)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
              <th style={{ padding: '10px 14px', cursor: 'pointer' }} onClick={() => handleSort('keyword')}>
                Keyword {sortField === 'keyword' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th style={{ padding: '10px 12px', cursor: 'pointer' }} onClick={() => handleSort('opportunity_score')}>
                Opportunity {sortField === 'opportunity_score' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th style={{ padding: '10px 12px' }}>Confidence</th>
              <th style={{ padding: '10px 12px', cursor: 'pointer' }} onClick={() => handleSort('competition_score')}>
                Competition {sortField === 'competition_score' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th style={{ padding: '10px 12px', cursor: 'pointer' }} onClick={() => handleSort('market_fit_score')}>
                Market Fit {sortField === 'market_fit_score' ? (sortAsc ? '▲' : '▼') : ''}
              </th>

              {isAdvancedView && (
                <>
                  <th style={{ padding: '10px 12px', cursor: 'pointer' }} onClick={() => handleSort('demand_score')}>
                    Demand {sortField === 'demand_score' ? (sortAsc ? '▲' : '▼') : ''}
                  </th>
                  <th style={{ padding: '10px 12px', cursor: 'pointer' }} onClick={() => handleSort('velocity_score')}>
                    Velocity {sortField === 'velocity_score' ? (sortAsc ? '▲' : '▼') : ''}
                  </th>
                  <th style={{ padding: '10px 12px', cursor: 'pointer' }} onClick={() => handleSort('best_outlier_ratio')}>
                    Best Outlier {sortField === 'best_outlier_ratio' ? (sortAsc ? '▲' : '▼') : ''}
                  </th>
                  <th style={{ padding: '10px 12px' }}>Videos / Chans</th>
                  <th style={{ padding: '10px 12px', cursor: 'pointer' }} onClick={() => handleSort('median_views')}>
                    Median Views {sortField === 'median_views' ? (sortAsc ? '▲' : '▼') : ''}
                  </th>
                </>
              )}

              <th style={{ padding: '10px 12px' }}>Signals</th>
              <th style={{ padding: '10px 14px', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={isAdvancedView ? 11 : 6} style={{ padding: '36px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  No keywords match the active search or filters.
                </td>
              </tr>
            ) : (
              paginated.map((rec) => (
                <tr
                  key={rec.keyword}
                  style={{
                    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                    transition: 'background 0.15s'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Keyword Title & Link to detail */}
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>
                    <button
                      onClick={() => onOpenDetail(rec)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        padding: 0,
                        fontSize: '12px',
                        fontWeight: 600
                      }}
                      title="Click to view detailed metrics and videos"
                    >
                      {rec.keyword}
                    </button>
                  </td>

                  {/* Opportunity */}
                  <td style={{ padding: '10px 12px' }}>
                    {renderOpportunityBadge(rec.opportunity_score)}
                  </td>

                  {/* Confidence */}
                  <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>
                    {rec.confidence_level}
                  </td>

                  {/* Competition */}
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{
                      color: rec.competition_level === 'LOW' ? '#34d399' : (rec.competition_level === 'HIGH' ? '#f87171' : '#fbbf24'),
                      fontWeight: 600
                    }}>
                      {rec.competition_level} ({Math.round(rec.competition_score)})
                    </span>
                  </td>

                  {/* Market Fit */}
                  <td style={{ padding: '10px 12px', color: '#60a5fa', fontWeight: 600 }}>
                    {Math.round(rec.market_fit_score)}/100
                  </td>

                  {/* Advanced Columns */}
                  {isAdvancedView && (
                    <>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)' }}>
                        {Math.round(rec.demand_score)}
                      </td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)' }}>
                        {Math.round(rec.velocity_score)}
                      </td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', color: rec.best_outlier_ratio >= 5.0 ? '#34d399' : 'inherit' }}>
                        {rec.best_outlier_ratio}x
                      </td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>
                        {rec.video_count} vids / {rec.channel_count} ch
                      </td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)' }}>
                        {rec.median_views.toLocaleString()}
                      </td>
                    </>
                  )}

                  {/* Signals Badges */}
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      {rec.is_rising && (
                        <span style={{ fontSize: '10px', background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', padding: '1px 5px', borderRadius: '3px' }}>
                          🔥 Rising
                        </span>
                      )}
                      {rec.is_low_competition && (
                        <span style={{ fontSize: '10px', background: 'rgba(52, 211, 153, 0.15)', color: '#34d399', padding: '1px 5px', borderRadius: '3px' }}>
                          💎 Low Comp
                        </span>
                      )}
                      {rec.is_breakout && (
                        <span style={{ fontSize: '10px', background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8', padding: '1px 5px', borderRadius: '3px' }}>
                          🚀 Breakout
                        </span>
                      )}
                      {rec.is_small_channel_win && (
                        <span style={{ fontSize: '10px', background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', padding: '1px 5px', borderRadius: '3px' }}>
                          🐟 Small Win
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Actions */}
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                      <button
                        className="btn btn-secondary"
                        onClick={() => onOpenDetail(rec)}
                        style={{ fontSize: '10px', padding: '3px 8px' }}
                      >
                        Inspect
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => onCreateProject(rec.keyword)}
                        style={{ fontSize: '10px', padding: '3px 8px' }}
                      >
                        + Project
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* ── Pagination ── */}
        {totalPages > 1 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderTop: '1px solid var(--border-subtle)',
            fontSize: '11px',
            color: 'var(--text-muted)'
          }}>
            <div>
              Page {currentPage} of {totalPages}
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                className="btn btn-secondary"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage(currentPage - 1)}
                style={{ padding: '4px 10px', fontSize: '11px' }}
              >
                Previous
              </button>
              <button
                className="btn btn-secondary"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage(currentPage + 1)}
                style={{ padding: '4px 10px', fontSize: '11px' }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
