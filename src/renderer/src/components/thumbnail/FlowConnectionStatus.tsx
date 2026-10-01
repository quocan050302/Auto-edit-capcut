import React from 'react'
import type { ThumbnailProviderHealth } from '../../../../shared/types'

interface FlowConnectionStatusProps {
  health: ThumbnailProviderHealth | null
  isChecking: boolean
  onCheck: () => void
  onOpenFlow: () => void
  onConfigure?: () => void
}

type CheckState = 'ready' | 'not-ready' | 'unknown'

function getCheckState(value: boolean | undefined, bridgeReachable: boolean, requiresBridge = true): CheckState {
  if (requiresBridge && !bridgeReachable) return 'unknown'
  if (value === undefined || value === null) return 'unknown'
  return value ? 'ready' : 'not-ready'
}

const DOT_COLORS: Record<CheckState, string> = {
  ready: '#22c55e',
  'not-ready': '#ef4444',
  unknown: '#6b7280'
}

function StatusDot({ state }: { state: CheckState }) {
  return (
    <span
      style={{
        color: DOT_COLORS[state],
        display: 'inline-block',
        width: '8px',
        textAlign: 'center'
      }}
    >
      ●
    </span>
  )
}

export const FlowConnectionStatus: React.FC<FlowConnectionStatusProps> = ({
  health,
  isChecking,
  onCheck,
  onOpenFlow,
  onConfigure
}) => {
  const bridgeReachable = Boolean(health?.reachable)
  const isHealthy = Boolean(
    health?.reachable &&
    health?.extensionConnected &&
    health?.signedIn &&
    health?.supportsImageGeneration
  )

  const bridgeState: CheckState = health === null ? 'unknown' : health.reachable ? 'ready' : 'not-ready'
  const extensionState = getCheckState(health?.extensionConnected, bridgeReachable)
  const signedInState = getCheckState(health?.signedIn, bridgeReachable)
  const imageModelState = getCheckState(health?.supportsImageGeneration, bridgeReachable)

  const borderColor = isHealthy
    ? 'rgba(34, 197, 94, 0.25)'
    : health === null || isChecking
      ? 'rgba(107, 114, 128, 0.3)'
      : 'rgba(239, 68, 68, 0.25)'

  const dotColor = isHealthy ? '#22c55e' : health === null ? '#6b7280' : '#ef4444'
  const dotShadow = isHealthy
    ? '0 0 8px rgba(34,197,94,0.5)'
    : health === null
      ? '0 0 8px rgba(107,114,128,0.3)'
      : '0 0 8px rgba(239,68,68,0.5)'

  return (
    <div
      style={{
        background: 'rgba(255, 255, 255, 0.03)',
        border: `1px solid ${borderColor}`,
        borderRadius: '10px',
        padding: '16px 20px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              background: dotColor,
              boxShadow: dotShadow,
              display: 'inline-block',
              flexShrink: 0
            }}
          />
          <span style={{ fontWeight: 600, color: '#f3f4f6', fontSize: '14px' }}>
            Google Flow Connector:{' '}
            {isChecking ? 'Checking...' : isHealthy ? 'Connected & Ready' : 'Attention Required'}
          </span>
        </div>

        {/* Status indicators — show gray when bridge is offline (state unknown) */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', fontSize: '12px', color: '#9ca3af', marginTop: '2px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <StatusDot state={bridgeState} />
            Bridge {bridgeState === 'unknown' ? 'Unknown' : health?.reachable ? 'Reachable' : 'Offline'}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <StatusDot state={extensionState} />
            Extension {extensionState === 'unknown' ? 'Unknown' : health?.extensionConnected ? 'Connected' : 'Disconnected'}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <StatusDot state={signedInState} />
            Google Flow {signedInState === 'unknown' ? 'Status Unknown' : health?.signedIn ? 'Signed In' : 'Not Signed In'}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <StatusDot state={imageModelState} />
            Image Generation {imageModelState === 'unknown' ? 'Unknown' : health?.supportsImageGeneration ? 'Ready' : 'Unavailable'}
          </span>
        </div>

        {/* Contextual message */}
        {health?.message && (
          <div style={{ fontSize: '12px', color: isHealthy ? '#38bdf8' : '#f87171', marginTop: '4px', lineHeight: '1.5' }}>
            {health.message}
          </div>
        )}

        {/* Contextual action hint when bridge offline */}
        {!isChecking && health !== null && !health.reachable && (
          <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px', lineHeight: '1.5' }}>
            <strong style={{ color: '#d1d5db' }}>To start FlowKit:</strong>{' '}
            run <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: '3px' }}>python -m agent.main</code>{' '}
            in your FlowKit folder, or use{' '}
            {onConfigure ? (
              <button
                onClick={onConfigure}
                style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: 0, fontSize: '11px', textDecoration: 'underline' }}
              >
                Managed Mode
              </button>
            ) : (
              'Managed Mode in Settings'
            )}.
          </div>
        )}

        {/* Extension disconnected hint */}
        {!isChecking && health?.reachable && !health.extensionConnected && (
          <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px', lineHeight: '1.5' }}>
            FlowKit is running but the Chrome extension is not connected.{' '}
            Open <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: '3px' }}>chrome://extensions</code>{' '}
            and reload the FlowKit extension, then open a Google Flow tab.
          </div>
        )}

        {/* Project ID missing hint */}
        {!isChecking && health?.reachable && health.extensionConnected && !health.signedIn && (
          <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
            Sign in at{' '}
            <button
              onClick={onOpenFlow}
              style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: 0, fontSize: '11px', textDecoration: 'underline' }}
            >
              flow.google.com
            </button>{' '}
            and keep the tab open.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexShrink: 0 }}>
        <button
          onClick={onCheck}
          disabled={isChecking}
          style={{
            fontSize: '12px',
            padding: '6px 14px',
            borderRadius: '6px',
            background: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            color: '#f3f4f6',
            cursor: isChecking ? 'not-allowed' : 'pointer',
            opacity: isChecking ? 0.6 : 1
          }}
        >
          {isChecking ? 'Checking...' : 'Test Connection'}
        </button>

        <button
          onClick={onOpenFlow}
          style={{
            fontSize: '12px',
            padding: '6px 14px',
            borderRadius: '6px',
            background: isHealthy ? '#22c55e' : '#3b82f6',
            color: '#ffffff',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 500
          }}
        >
          Open Google Flow ↗
        </button>
      </div>
    </div>
  )
}
