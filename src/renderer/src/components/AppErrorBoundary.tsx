import React, { Component, ErrorInfo, ReactNode } from 'react'

export interface AppErrorBoundaryProps {
  children: ReactNode
  fallbackTitle?: string
  fallbackMessage?: string
  isRouteLevel?: boolean
  onRecover?: () => void
  onNavigateHome?: () => void
  onNavigateProduction?: () => void
}

interface AppErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
  copiedNotice: boolean
}

/**
 * AppErrorBoundary: Production-grade React Error Boundary that prevents the
 * application window from ever unmounting into a solid black screen.
 *
 * Can be deployed at the application level (full window fallback) and at the
 * route level inside the app shell (preserving sidebar and title bar).
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      copiedNotice: false
    }
  }

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return {
      hasError: true,
      error
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo })
    console.error('[AppErrorBoundary] Caught uncaught React error in UI tree:', error, errorInfo)
  }

  handleReload = (): void => {
    window.location.reload()
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      copiedNotice: false
    })
    this.props.onRecover?.()
  }

  handleCopyDiagnostics = (): void => {
    const { error, errorInfo } = this.state
    const diagnostics = [
      '=== Long-Form AI Video Factory UI Diagnostics ===',
      `Timestamp: ${new Date().toISOString()}`,
      `Error: ${error?.name || 'Error'}: ${error?.message || 'Unknown error'}`,
      'Stack Trace:',
      error?.stack || 'No stack available',
      'Component Stack:',
      errorInfo?.componentStack || 'No component stack available'
    ].join('\n\n')

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(diagnostics).then(() => {
        this.setState({ copiedNotice: true })
        setTimeout(() => this.setState({ copiedNotice: false }), 3000)
      }).catch(() => {
        // Fallback
      })
    }
  }

  render(): ReactNode {
    const { hasError, error, errorInfo, copiedNotice } = this.state
    const {
      children,
      fallbackTitle = 'Something went wrong displaying this page.',
      fallbackMessage = 'The application encountered an unexpected interface error. Your imported media, project configuration, and ongoing production work on disk remain completely safe.',
      isRouteLevel = false,
      onNavigateProduction,
      onNavigateHome
    } = this.props

    if (!hasError) {
      return children
    }

    const errorDetails = [
      error?.message,
      errorInfo?.componentStack
    ].filter(Boolean).join('\n')

    // If used at root level (entire app), include a minimal emergency titlebar so frameless window controls remain
    return (
      <div
        className={isRouteLevel ? 'route-error-boundary-container' : 'app-error-boundary-full'}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: isRouteLevel ? '400px' : '100vh',
          height: isRouteLevel ? '100%' : '100vh',
          width: '100%',
          backgroundColor: '#0a0a0f',
          color: '#f3f4f6',
          padding: '24px',
          boxSizing: 'border-box',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        }}
        role="alert"
      >
        <div
          style={{
            maxWidth: '680px',
            width: '100%',
            background: 'rgba(18, 18, 28, 0.95)',
            border: '1px solid rgba(239, 68, 68, 0.35)',
            borderRadius: '12px',
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6), 0 0 30px rgba(239, 68, 68, 0.1)',
            padding: '32px',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px'
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '10px',
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '22px',
                flexShrink: 0
              }}
            >
              ⚠️
            </div>
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: '18px',
                  fontWeight: 700,
                  color: '#ffffff',
                  letterSpacing: '-0.01em'
                }}
              >
                {fallbackTitle}
              </h2>
              <p
                style={{
                  margin: '4px 0 0 0',
                  fontSize: '13px',
                  color: '#9ca3af',
                  lineHeight: 1.5
                }}
              >
                {fallbackMessage}
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '10px',
              paddingTop: '6px'
            }}
          >
            {onNavigateProduction && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  this.handleReset()
                  onNavigateProduction()
                }}
                style={{
                  background: '#6366f1',
                  color: '#ffffff',
                  border: 'none',
                  padding: '9px 18px',
                  borderRadius: '6px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontSize: '13px'
                }}
              >
                Return to Production
              </button>
            )}

            {onNavigateHome && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  this.handleReset()
                  onNavigateHome()
                }}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  color: '#e5e7eb',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  padding: '9px 18px',
                  borderRadius: '6px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontSize: '13px'
                }}
              >
                Go to Project Home
              </button>
            )}

            <button
              type="button"
              className="btn btn-secondary"
              onClick={this.handleReset}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                color: '#e5e7eb',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                padding: '9px 18px',
                borderRadius: '6px',
                fontWeight: 500,
                cursor: 'pointer',
                fontSize: '13px'
              }}
            >
              Try Recovering Page
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={this.handleReload}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                color: '#e5e7eb',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                padding: '9px 18px',
                borderRadius: '6px',
                fontWeight: 500,
                cursor: 'pointer',
                fontSize: '13px'
              }}
            >
              Reload Interface
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={this.handleCopyDiagnostics}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                color: '#9ca3af',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                padding: '9px 16px',
                borderRadius: '6px',
                fontWeight: 500,
                cursor: 'pointer',
                fontSize: '13px',
                marginLeft: 'auto'
              }}
            >
              {copiedNotice ? '✓ Copied to Clipboard' : 'Copy Diagnostics'}
            </button>
          </div>

          {/* Collapsible Error Technical Details */}
          <details
            style={{
              marginTop: '4px',
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'rgba(0, 0, 0, 0.4)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              fontSize: '12px',
              color: '#9ca3af'
            }}
          >
            <summary style={{ cursor: 'pointer', color: '#cbd5e1', fontWeight: 600 }}>
              Technical Error Details ({error?.name || 'Error'})
            </summary>
            <pre
              style={{
                marginTop: '10px',
                marginBottom: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontFamily: 'Consolas, Monaco, monospace',
                fontSize: '11px',
                color: '#f87171',
                maxHeight: '220px',
                overflowY: 'auto'
              }}
            >
              {errorDetails || error?.message || 'No stack trace captured.'}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}
