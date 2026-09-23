import React, { useEffect, useRef } from 'react'
import type { LogEntry } from '../../../../shared/types'

interface ProgressLogProps {
  logs: LogEntry[]
  scanProgress?: { message: string; progress: number } | null
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export function ProgressLog({ logs, scanProgress }: ProgressLogProps): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  return (
    <div className="log-panel">
      <div className="log-panel-header">
        <span className="log-panel-title">Activity Log</span>
        {scanProgress && (
          <div className="flex items-center gap-3" style={{ flex: 1, marginLeft: '16px', marginRight: '16px' }}>
            <div className="progress-bar-wrap" style={{ flex: 1 }}>
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.round(scanProgress.progress * 100)}%` }}
              />
            </div>
            <span className="text-xs text-muted" style={{ whiteSpace: 'nowrap', minWidth: '30px' }}>
              {Math.round(scanProgress.progress * 100)}%
            </span>
          </div>
        )}
        <span className="text-xs text-muted">{logs.length} entries</span>
      </div>

      <div className="log-entries">
        {logs.length === 0 ? (
          <div className="log-entry" style={{ color: 'var(--text-disabled)', fontFamily: 'var(--font-mono)', fontSize: '11px', padding: '8px 0' }}>
            — No activity yet —
          </div>
        ) : (
          logs.map((entry, i) => (
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
  )
}
