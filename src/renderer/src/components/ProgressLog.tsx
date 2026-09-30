import React, { useState, useEffect, useRef } from 'react'
import type { LogEntry } from '../../../../shared/types'

export interface ProgressLogProps {
  logs: LogEntry[]
  scanProgress?: { message: string; progress: number } | null
  defaultExpanded?: boolean
}

type LogFilter = 'all' | 'info' | 'warn' | 'error'

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  } catch {
    return '00:00:00'
  }
}

export function ProgressLog({
  logs,
  scanProgress,
  defaultExpanded = false
}: ProgressLogProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [filter, setFilter] = useState<LogFilter>('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const [clearedIndex, setClearedIndex] = useState(0)
  const [copied, setCopied] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const prevErrorCountRef = useRef(0)

  const errorCount = logs.filter((l) => l.level === 'error').length
  const warningCount = logs.filter((l) => l.level === 'warn').length

  // Auto-expand drawer when a new fatal error arrives
  useEffect(() => {
    if (errorCount > prevErrorCountRef.current) {
      setIsExpanded(true)
    }
    prevErrorCountRef.current = errorCount
  }, [errorCount])

  // Scroll to bottom when new logs arrive and autoScroll is active
  useEffect(() => {
    if (isExpanded && autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs.length, isExpanded, autoScroll])

  const visibleLogs = logs
    .slice(clearedIndex)
    .filter((entry) => {
      if (filter === 'all') return true
      if (filter === 'info') return entry.level === 'info' || entry.level === 'success'
      if (filter === 'warn') return entry.level === 'warn'
      if (filter === 'error') return entry.level === 'error'
      return true
    })

  const latestEntry = logs.length > 0 ? logs[logs.length - 1] : null

  function handleCopyLogs(): void {
    const text = visibleLogs
      .map((l) => `[${formatTime(l.timestamp)}] [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleClearView(): void {
    setClearedIndex(logs.length)
  }

  return (
    <div
      className={`activity-drawer ${isExpanded ? 'activity-drawer--expanded' : 'activity-drawer--collapsed'}`}
      role="region"
      aria-label="Activity Log Drawer"
    >
      {/* Drawer Header Bar */}
      <div
        className="activity-drawer__header"
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        <div className="activity-drawer__title-area">
          <span className="activity-drawer__icon">⚡</span>
          <span className="activity-drawer__title">Activity</span>

          {/* Badges for Warnings / Errors */}
          {errorCount > 0 && (
            <span className="activity-drawer__pill activity-drawer__pill--error">
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          )}
          {warningCount > 0 && (
            <span className="activity-drawer__pill activity-drawer__pill--warning">
              {warningCount} {warningCount === 1 ? 'warning' : 'warnings'}
            </span>
          )}
        </div>

        {/* Center: Latest status message / scan progress when collapsed */}
        <div className="activity-drawer__center">
          {scanProgress ? (
            <div className="activity-drawer__scan-wrap">
              <span className="activity-drawer__scan-msg truncate">
                {scanProgress.message}
              </span>
              <div className="progress-bar-wrap" style={{ width: 120 }}>
                <div
                  className="progress-bar-fill"
                  style={{ width: `${Math.round(scanProgress.progress * 100)}%` }}
                />
              </div>
              <span className="text-xs text-muted">
                {Math.round(scanProgress.progress * 100)}%
              </span>
            </div>
          ) : latestEntry ? (
            <span className="activity-drawer__latest-msg truncate">
              {latestEntry.message}
            </span>
          ) : (
            <span className="activity-drawer__latest-msg text-muted">
              Ready for production
            </span>
          )}
        </div>

        {/* Right Actions */}
        <div className="activity-drawer__actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="activity-drawer__toggle-btn"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-label={isExpanded ? 'Collapse activity log' : 'Expand activity log'}
          >
            <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
            <svg
              className={`collapsible-chevron ${isExpanded ? 'rotate-180' : ''}`}
              width="14"
              height="14"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Expanded Body Drawer */}
      {isExpanded && (
        <div className="activity-drawer__body">
          {/* Controls Bar */}
          <div className="activity-drawer__toolbar">
            <div className="activity-drawer__filters">
              <button
                type="button"
                className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
                onClick={() => setFilter('all')}
              >
                All ({logs.length - clearedIndex})
              </button>
              <button
                type="button"
                className={`filter-btn ${filter === 'info' ? 'active' : ''}`}
                onClick={() => setFilter('info')}
              >
                Info
              </button>
              <button
                type="button"
                className={`filter-btn ${filter === 'warn' ? 'active' : ''}`}
                onClick={() => setFilter('warn')}
              >
                Warnings ({warningCount})
              </button>
              <button
                type="button"
                className={`filter-btn ${filter === 'error' ? 'active' : ''}`}
                onClick={() => setFilter('error')}
              >
                Errors ({errorCount})
              </button>
            </div>

            <div className="activity-drawer__tool-actions">
              <label className="activity-drawer__autoscroll-label">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                />
                <span>Auto-scroll</span>
              </label>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleCopyLogs}
                disabled={visibleLogs.length === 0}
              >
                {copied ? '✓ Copied' : 'Copy Logs'}
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleClearView}
                disabled={visibleLogs.length === 0}
                title="Clears the current log view only. Backend logs are preserved."
              >
                Clear View
              </button>
            </div>
          </div>

          {/* Log Entries List */}
          <div className="activity-drawer__logs-scroll">
            {visibleLogs.length === 0 ? (
              <div className="activity-drawer__empty">— No activity logs to display —</div>
            ) : (
              visibleLogs.map((entry, i) => (
                <div key={i} className={`log-entry ${entry.level}`}>
                  <span className="log-entry-time">{formatTime(entry.timestamp)}</span>
                  <span className={`log-entry-level ${entry.level}`}>{entry.level}</span>
                  <span className="log-entry-msg">{entry.message}</span>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </div>
  )
}
