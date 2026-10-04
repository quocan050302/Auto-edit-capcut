import React from 'react'
import type { TrendRadarItem } from '../types/research.types'

interface Props {
  radarItems: TrendRadarItem[]
  onSelectTopic: (topic: string) => void
  onCreateProject: (topic: string) => void
}

export function TrendRadarTab({
  radarItems,
  onSelectTopic,
  onCreateProject
}: Props): React.ReactElement {
  const getTrendBadge = (state: string) => {
    switch (state) {
      case 'Emerging':
        return <span style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#f87171', padding: '2px 8px', borderRadius: '4px', fontWeight: 700, fontSize: '11px' }}>⚡ Emerging</span>
      case 'Rising':
        return <span style={{ background: 'rgba(245, 158, 11, 0.2)', color: '#fbbf24', padding: '2px 8px', borderRadius: '4px', fontWeight: 700, fontSize: '11px' }}>🔥 Rising</span>
      case 'Stable':
        return <span style={{ background: 'rgba(52, 211, 153, 0.2)', color: '#34d399', padding: '2px 8px', borderRadius: '4px', fontWeight: 700, fontSize: '11px' }}>✓ Stable</span>
      case 'Cooling':
      default:
        return <span style={{ background: 'rgba(148, 163, 184, 0.1)', color: '#94a3b8', padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>❄ Cooling</span>
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px 0' }}>
            Multi-Channel Trend Acceleration
          </h3>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
            Algorithmic detection of topic velocity acceleration validated across multiple independent creator channels.
          </p>
        </div>
      </div>

      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        overflowX: 'auto'
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
          <thead>
            <tr style={{ background: 'var(--bg-base)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
              <th style={{ padding: '10px 14px' }}>Topic Theme</th>
              <th style={{ padding: '10px 12px' }}>Trend State</th>
              <th style={{ padding: '10px 12px' }}>24h Uploads</th>
              <th style={{ padding: '10px 12px' }}>7d Uploads</th>
              <th style={{ padding: '10px 12px' }}>30d Uploads</th>
              <th style={{ padding: '10px 12px' }}>Median Velocity</th>
              <th style={{ padding: '10px 12px' }}>Breakouts</th>
              <th style={{ padding: '10px 12px' }}>Unique Channels</th>
              <th style={{ padding: '10px 12px' }}>Confidence</th>
              <th style={{ padding: '10px 14px', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {radarItems.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ padding: '36px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  No topic trend radar data available. Run a market analysis first.
                </td>
              </tr>
            ) : (
              radarItems.map((item, idx) => (
                <tr
                  key={idx}
                  style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '12px 14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {item.topic}
                  </td>
                  <td style={{ padding: '12px 12px' }}>
                    {getTrendBadge(item.trend_state)}
                  </td>
                  <td style={{ padding: '12px 12px', fontFamily: 'var(--font-mono)' }}>
                    {item.count_24h > 0 ? <strong style={{ color: '#f87171' }}>+{item.count_24h}</strong> : '0'}
                  </td>
                  <td style={{ padding: '12px 12px', fontFamily: 'var(--font-mono)' }}>
                    {item.count_7d > 0 ? <strong style={{ color: '#fbbf24' }}>+{item.count_7d}</strong> : '0'}
                  </td>
                  <td style={{ padding: '12px 12px', fontFamily: 'var(--font-mono)' }}>
                    {item.count_30d}
                  </td>
                  <td style={{ padding: '12px 12px', fontFamily: 'var(--font-mono)', color: '#818cf8', fontWeight: 600 }}>
                    {item.median_velocity.toLocaleString()} /day
                  </td>
                  <td style={{ padding: '12px 12px', fontFamily: 'var(--font-mono)' }}>
                    {item.breakout_count > 0 ? (
                      <span style={{ color: '#34d399', fontWeight: 700 }}>{item.breakout_count}</span>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td style={{ padding: '12px 12px' }}>
                    {item.unique_channels}
                  </td>
                  <td style={{ padding: '12px 12px', color: 'var(--text-secondary)' }}>
                    {item.confidence_level}
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                      <button
                        className="btn btn-secondary"
                        onClick={() => onSelectTopic(item.topic)}
                        style={{ fontSize: '10px', padding: '3px 8px' }}
                      >
                        Filter
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => onCreateProject(item.topic)}
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
      </div>
    </div>
  )
}
