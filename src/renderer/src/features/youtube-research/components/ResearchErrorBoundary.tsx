import React, { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ResearchErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[YouTubeResearch:ErrorBoundary] Uncaught error:', error, errorInfo)
  }

  public handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px 24px',
          maxWidth: '800px',
          margin: '40px auto',
          background: 'var(--bg-elevated)',
          border: '1px solid rgba(248, 113, 113, 0.3)',
          borderRadius: 'var(--radius-lg, 12px)',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '32px', marginBottom: '16px' }}>⚠️</div>
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
            YouTube Research Module Notice
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px', lineHeight: 1.6 }}>
            The research module encountered an unexpected UI issue. Your video projects, media assets, and production pipeline are completely unaffected.
          </p>
          {this.state.error && (
            <pre style={{
              background: 'var(--bg-base)',
              padding: '12px',
              borderRadius: '8px',
              color: '#f87171',
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              textAlign: 'left',
              overflowX: 'auto',
              marginBottom: '20px'
            }}>
              {this.state.error.message}
            </pre>
          )}
          <button
            className="btn btn-primary"
            onClick={this.handleReset}
            style={{ padding: '8px 24px' }}
          >
            Reload Research Tab
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
