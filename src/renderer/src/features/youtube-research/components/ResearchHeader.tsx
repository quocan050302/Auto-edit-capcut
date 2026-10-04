import React from 'react'
import type { ProviderSource, ApiConnectionStatus } from '../types/research.types'

interface Props {
  providerSource: ProviderSource
  isAdvancedView: boolean
  onToggleView: () => void
  onOpenSettings: () => void
  sidecarStatus: 'running' | 'stopped' | 'starting' | 'error' | 'degraded'
  apiReachabilityStatus: ApiConnectionStatus
  onRestartSidecar: () => void
  onRetryConnection?: () => void
  hasExecutedRun?: boolean
  lastResearchTopic?: string
}

export function ResearchHeader({
  providerSource,
  isAdvancedView,
  onToggleView,
  onOpenSettings,
  sidecarStatus,
  apiReachabilityStatus,
  onRestartSidecar,
  onRetryConnection,
  hasExecutedRun = false,
  lastResearchTopic
}: Props): React.ReactElement {
  const getProviderColor = (p: ProviderSource) => {
    if (p === 'OFFICIAL') return 'var(--color-success, #34d399)'
    if (p === 'MIXED') return 'var(--color-info, #60a5fa)'
    return 'var(--text-muted, #94a3b8)'
  }

  const getSidecarBadge = () => {
    if (apiReachabilityStatus === 'checking') {
      return (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          fontSize: '11px',
          color: '#60a5fa',
          background: 'rgba(96, 165, 250, 0.12)',
          border: '1px solid rgba(96, 165, 250, 0.3)',
          borderRadius: '999px',
          padding: '2px 8px'
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#60a5fa' }} />
          Connecting…
        </span>
      )
    }

    if (sidecarStatus === 'running' && apiReachabilityStatus === 'reachable') {
      return (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          fontSize: '11px',
          color: '#34d399',
          background: 'rgba(52, 211, 153, 0.12)',
          border: '1px solid rgba(52, 211, 153, 0.3)',
          borderRadius: '999px',
          padding: '2px 8px'
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399' }} />
          Service Active
        </span>
      )
    }

    if (sidecarStatus === 'running' && apiReachabilityStatus === 'blocked') {
      return (
        <button
          onClick={onRetryConnection}
          className="btn btn-secondary"
          style={{
            fontSize: '10px',
            padding: '2px 8px',
            color: '#f87171',
            background: 'rgba(248, 113, 113, 0.12)',
            border: '1px solid rgba(248, 113, 113, 0.3)'
          }}
          title="The Python service is running locally, but Renderer requests are blocked. Click to retry connection."
        >
          ● Service Running — API Connection Blocked (Retry ⟳)
        </button>
      )
    }

    if (sidecarStatus === 'degraded') {
      return (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          fontSize: '11px',
          color: '#fbbf24',
          background: 'rgba(251, 191, 36, 0.12)',
          border: '1px solid rgba(251, 191, 36, 0.3)',
          borderRadius: '999px',
          padding: '2px 8px'
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fbbf24' }} />
          Degraded (Fallback)
        </span>
      )
    }

    return (
      <button
        onClick={onRestartSidecar}
        className="btn btn-secondary"
        style={{ fontSize: '10px', padding: '2px 8px', color: '#f87171' }}
        title="Click to restart local Python research service"
      >
        ● Service Offline (Restart ⟳)
      </button>
    )
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      padding: '20px 24px',
      borderBottom: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
      background: 'var(--bg-elevated, #13141c)'
    }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
            YouTube Research
          </h1>
          <span style={{
            fontSize: '10px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            padding: '2px 6px',
            borderRadius: '4px',
            background: 'rgba(99, 102, 241, 0.15)',
            color: '#a5b4fc',
            border: '1px solid rgba(99, 102, 241, 0.3)'
          }}>
            Foreign Market Intelligence
          </span>
        </div>
        <p style={{
          fontSize: '12px',
          color: 'var(--text-muted, #94a3b8)',
          margin: '4px 0 0 0',
          maxWidth: '650px',
          lineHeight: 1.4
        }}>
          Discover rising topics, breakout videos and foreign-market opportunities using public YouTube signals.
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        {/* Sidecar & API Reachability Status */}
        {getSidecarBadge()}

        {/* Provider Source */}
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '11px',
          color: 'var(--text-secondary)',
          background: 'var(--bg-base)',
          padding: '4px 10px',
          borderRadius: 'var(--radius-sm, 6px)',
          border: '1px solid var(--border-subtle)'
        }}>
          <span style={{ color: 'var(--text-muted)' }}>
            {apiReachabilityStatus === 'checking' ? 'Provider:' : (hasExecutedRun ? 'Provider used:' : 'Provider: ')}
          </span>
          <span style={{ fontWeight: 600, color: apiReachabilityStatus === 'checking' ? 'var(--text-muted)' : getProviderColor(providerSource) }}>
            {apiReachabilityStatus === 'checking'
              ? 'Checking…'
              : (providerSource === 'OFFICIAL' ? 'Official API' : (providerSource === 'MIXED' ? 'Mixed Mode' : 'Free Public Scraper')) + (!hasExecutedRun ? ' configured' : '')}
          </span>
        </span>

        {/* View Mode Toggle */}
        <button
          className="btn btn-secondary"
          onClick={onToggleView}
          style={{ fontSize: '11px', padding: '5px 12px' }}
          title={isAdvancedView ? 'Switch to Simple View for clean overview' : 'Switch to Advanced View for deep analytics and scores'}
        >
          {isAdvancedView ? '📊 Advanced View' : '✨ Simple View'}
        </button>

        {/* Settings CTA */}
        <button
          className="btn btn-secondary"
          onClick={onOpenSettings}
          style={{ fontSize: '11px', padding: '5px 12px' }}
          title="Configure YouTube API, Market Defaults, and AI"
        >
          ⚙ Settings
        </button>
      </div>
    </div>
  )
}
