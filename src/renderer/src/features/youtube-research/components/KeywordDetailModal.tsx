import React from 'react'
import type { KeywordMetricRecord } from '../types/research.types'

interface Props {
  record: KeywordMetricRecord | null
  onClose: () => void
  onCreateProject: (keyword: string) => void
}

export function KeywordDetailModal({
  record,
  onClose,
  onCreateProject
}: Props): React.ReactElement | null {
  if (!record) return null

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.75)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      backdropFilter: 'blur(4px)'
    }}>
      <div style={{
        background: 'var(--bg-elevated, #13141c)',
        border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.15))',
        borderRadius: 'var(--radius-lg, 12px)',
        width: '740px',
        maxWidth: '92vw',
        maxHeight: '88vh',
        overflowY: 'auto',
        padding: '28px',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.6)',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px'
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '16px' }}>
          <div>
            <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.8px' }}>
              Keyword Deep Intelligence
            </div>
            <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', margin: '4px 0 0 0' }}>
              {record.keyword}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '20px',
              cursor: 'pointer',
              padding: '4px'
            }}
          >
            ✕
          </button>
        </div>

        {/* Opportunity & Confidence Ribbon */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '12px',
          background: 'var(--bg-base)',
          padding: '16px',
          borderRadius: '8px'
        }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Opportunity Score</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: '#34d399', marginTop: '2px' }}>
              {Math.round(record.opportunity_score)}/100
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Data Confidence</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>
              {record.confidence_level} ({Math.round(record.confidence_score)}%)
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Trend State</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#818cf8', marginTop: '4px' }}>
              {record.freshness_state}
            </div>
          </div>
        </div>

        {/* Metric Cards Grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '12px'
        }}>
          {/* Demand */}
          <div style={{ background: 'var(--bg-base)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span>Demand Score</span>
              <span title="Calculated from median and P75 views, winsorized against anomalies">ℹ</span>
            </div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', margin: '4px 0' }}>
              {Math.round(record.demand_score)}/100
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
              {record.breakdown?.demand_details || `${record.median_views.toLocaleString()} median views`}
            </div>
          </div>

          {/* Velocity */}
          <div style={{ background: 'var(--bg-base)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span>Velocity Score</span>
              <span title="Lifetime velocity: views / age days. Distinct from observed realtime velocity snapshots">ℹ</span>
            </div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#60a5fa', margin: '4px 0' }}>
              {Math.round(record.velocity_score)}/100
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
              {record.breakdown?.velocity_details || `${record.median_views_per_day.toLocaleString()} views/day`}
            </div>
          </div>

          {/* Outlier */}
          <div style={{ background: 'var(--bg-base)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span>Peak Outlier</span>
              <span title="Ratio of video views compared strictly against identical channel content baseline">ℹ</span>
            </div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#34d399', margin: '4px 0' }}>
              {record.best_outlier_ratio}x
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
              {record.breakdown?.outlier_details || 'Channel baseline multiplier'}
            </div>
          </div>

          {/* Competition */}
          <div style={{ background: 'var(--bg-base)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span>Competition</span>
              <span title="Analyzes video saturation, mega channel share, and small channel win rate">ℹ</span>
            </div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#fbbf24', margin: '4px 0' }}>
              {record.competition_level} ({Math.round(record.competition_score)})
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
              {record.breakdown?.competition_details || 'Market saturation level'}
            </div>
          </div>

          {/* Market Fit */}
          <div style={{ background: 'var(--bg-base)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span>Market Signal</span>
              <span title="Estimated public-data signal, not private audience geography">ℹ</span>
            </div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#a5b4fc', margin: '4px 0' }}>
              {Math.round(record.market_fit_score)}/100
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
              {record.breakdown?.market_fit_details || 'Estimated regional relevance'}
            </div>
          </div>

          {/* Cross Channel */}
          <div style={{ background: 'var(--bg-base)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span>Channel Diversity</span>
              <span title="Validates that multiple independent channels succeed on this topic">ℹ</span>
            </div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', margin: '4px 0' }}>
              {record.channel_count} Channels
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
              {record.breakdown?.cross_channel_details || `${record.video_count} videos analyzed`}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: '8px 18px' }}>
            Close
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onCreateProject(record.keyword)
              onClose()
            }}
            style={{ padding: '8px 20px' }}
          >
            + Create Video Project from Keyword
          </button>
        </div>
      </div>
    </div>
  )
}
