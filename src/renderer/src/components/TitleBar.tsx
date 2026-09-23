import React, { useState } from 'react'

interface TitleBarProps {
  projectName: string | null
}

export function TitleBar({ projectName }: TitleBarProps): React.ReactElement {
  const [isMaximized, setIsMaximized] = useState(false)

  function handleMinimize(): void {
    window.api.window.minimize()
  }

  function handleMaximize(): void {
    window.api.window.maximize()
    setIsMaximized((v) => !v)
  }

  function handleClose(): void {
    window.api.window.close()
  }

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <div className="titlebar-logo">
          <div className="titlebar-logo-icon">
            <svg viewBox="0 0 24 24">
              <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
            </svg>
          </div>
          <span className="titlebar-title">AI Video Factory</span>
        </div>
      </div>

      {projectName && (
        <div className="titlebar-center">{projectName}</div>
      )}

      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={handleMinimize} title="Minimize">
          <svg width="10" height="10" viewBox="0 0 10 1" fill="currentColor">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button className="titlebar-btn" onClick={handleMaximize} title={isMaximized ? 'Restore' : 'Maximize'}>
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="2" y="0" width="8" height="8" />
              <rect x="0" y="2" width="8" height="8" fill="var(--bg-void)" />
              <rect x="0" y="2" width="8" height="8" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="0" y="0" width="10" height="10" />
            </svg>
          )}
        </button>
        <button className="titlebar-btn close" onClick={handleClose} title="Close">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="0" y1="0" x2="10" y2="10" />
            <line x1="10" y1="0" x2="0" y2="10" />
          </svg>
        </button>
      </div>
    </header>
  )
}
