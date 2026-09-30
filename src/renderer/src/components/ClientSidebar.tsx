import React from 'react'
import type { ProjectState } from '../../../../shared/types'

export interface ClientSidebarProps {
  project: ProjectState | null
  currentPage: string
  onNavigate: (page: string) => void
  onToggleMode: () => void
  stockCoverage?: { assigned: number; total: number } | null
}

function statusClass(status: string | undefined): string {
  if (!status) return 'pending'
  const s = status.toLowerCase()
  if (s === 'new') return 'new'
  if (s === 'complete') return 'complete'
  if (s.includes('render')) return 'rendering'
  if (s === 'error') return 'error'
  return 'ready'
}

export function ClientSidebar({
  project,
  currentPage,
  onNavigate,
  onToggleMode,
  stockCoverage
}: ClientSidebarProps): React.ReactElement {
  const navItems = [
    {
      id: 'home',
      label: '1. Project',
      requiresProject: false,
      icon: (
        <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
      )
    },
    {
      id: 'input',
      label: '2. Setup',
      requiresProject: true,
      icon: (
        <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
          <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clipRule="evenodd" />
        </svg>
      ),
      badge: project?.inputs?.scriptPath && project?.inputs?.voiceoverPath ? 'Ready' : undefined
    },
    {
      id: 'production',
      label: '3. Production',
      requiresProject: true,
      icon: (
        <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
          <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" />
        </svg>
      )
    },
    {
      id: 'stock',
      label: '4. Review',
      requiresProject: true,
      icon: (
        <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
          <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm3 2h6v4H7V5zm8 8v2h1v-2h-1zm-2-2H7v4h6v-4zm2 0h1V9h-1v2zm1-4V5h-1v2h1zM5 5v2H4V5h1zm-1 4h1v2H4V9zm1 4H4v2h1v-2z" clipRule="evenodd" />
        </svg>
      ),
      badge: stockCoverage && stockCoverage.total > 0 ? `${stockCoverage.assigned}/${stockCoverage.total}` : undefined
    },
    {
      id: 'render',
      label: '5. Export',
      requiresProject: true,
      icon: (
        <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
        </svg>
      )
    }
  ]

  // Map internal technical pages to the corresponding client menu
  const getActiveId = (page: string) => {
    if (page === 'home') return 'home'
    if (page === 'input') return 'input'
    if (page === 'production') return 'production'
    if (page === 'stock') return 'stock'
    if (page === 'render' || page === 'qa') return 'render'
    // Deep technical stages opened in simple mode map to nearest step
    if (page === 'transcribe' || page === 'planning' || page === 'captions' || page === 'audio') {
      return 'production'
    }
    return page
  }

  const activeNavId = getActiveId(currentPage)

  return (
    <aside className="sidebar client-sidebar">
      <div className="sidebar-header">
        <div className="sidebar-section-label">Workflow</div>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => {
          const isActive = activeNavId === item.id
          const isDisabled = item.requiresProject && !project

          return (
            <button
              key={item.id}
              className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
              disabled={isDisabled}
              title={isDisabled ? 'Create or open a project first' : undefined}
            >
              {item.icon}
              <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
              {item.badge && (
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    background: item.badge === 'Ready' ? 'rgba(52,211,153,0.2)' : 'rgba(96,165,250,0.2)',
                    color: item.badge === 'Ready' ? 'var(--color-success)' : 'var(--color-info)',
                    borderRadius: '999px',
                    padding: '1px 6px',
                    flexShrink: 0
                  }}
                >
                  {item.badge}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        {/* Project info */}
        {project ? (
          <div className="sidebar-project-info">
            <div className="sidebar-project-name">{project.name}</div>
            <div className="sidebar-project-status">
              <span className={`status-dot ${statusClass(project.status)}`} />
              {project.status.replace(/_/g, ' ')}
            </div>
          </div>
        ) : (
          <div className="sidebar-project-info">
            <div className="sidebar-project-name" style={{ color: 'var(--text-muted)' }}>
              No project open
            </div>
          </div>
        )}

        {/* Quick Settings Action */}
        <button
          type="button"
          className="sidebar-footer-btn"
          onClick={() => onNavigate('settings')}
          disabled={!project}
          title={!project ? 'Open a project first' : 'Project & Engine Settings'}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
          <span>Settings</span>
        </button>

        {/* Mode Switcher Toggle */}
        <div className="sidebar-mode-switcher">
          <button
            type="button"
            className="sidebar-mode-toggle-btn"
            onClick={onToggleMode}
            title="Switch to Advanced Mode to access all technical screens"
          >
            <span className="sidebar-mode-label">Simple Mode</span>
            <span className="sidebar-mode-switch-tag">Switch to Advanced</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
