import React from 'react'
import type { ResearchSidecarStatus, ProviderSource } from '../types/research.types'

interface Props {
  sidecarStatus: ResearchSidecarStatus | null
  providerSource: ProviderSource
  activeRunId?: string
  sseConnected: boolean
}

export function DeveloperDebugPanel({
  sidecarStatus,
  providerSource,
  activeRunId,
  sseConnected
}: Props): React.ReactElement {
  return (
    <div style={{
      marginTop: '28px',
      padding: '16px 20px',
      background: 'var(--bg-base, #0a0a0f)',
      border: '1px dashed rgba(99, 102, 241, 0.4)',
      borderRadius: '8px',
      fontSize: '11px',
      fontFamily: 'var(--font-mono)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <span style={{ fontWeight: 700, color: '#818cf8', textTransform: 'uppercase' }}>
          🛠 Developer Debug Panel (Debug Mode Active)
        </span>
        <span style={{ color: 'var(--text-muted)' }}>Local Diagnostics</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', color: 'var(--text-secondary)' }}>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Sidecar URL:</span> {sidecarStatus?.url || 'http://127.0.0.1:8765'}
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Sidecar PID:</span> {sidecarStatus?.pid || 'N/A'}
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Active Run:</span> {activeRunId || 'None'}
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>SSE Stream:</span>{' '}
          <span style={{ color: sseConnected ? '#34d399' : 'var(--text-muted)' }}>
            {sseConnected ? 'Connected' : 'Idle'}
          </span>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Provider Provenance:</span> {providerSource}
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Service Status:</span> {sidecarStatus?.status || 'unknown'}
        </div>
      </div>
    </div>
  )
}
