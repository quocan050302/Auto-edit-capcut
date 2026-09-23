import React from 'react'
import type { ProjectState } from '../../../../shared/types'

type Page = 'home' | 'input' | 'settings' | 'analysis' | 'render' | 'qa'

interface SidebarProps {
  project: ProjectState | null
  currentPage: Page
  onNavigate: (page: Page) => void
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

const NAV_ITEMS: { id: Page; label: string; icon: React.ReactNode; requiresProject: boolean }[] = [
  {
    id: 'home',
    label: 'Project',
    requiresProject: false,
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
      </svg>
    )
  },
  {
    id: 'input',
    label: 'Inputs',
    requiresProject: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
        <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clipRule="evenodd" />
      </svg>
    )
  },
  {
    id: 'settings',
    label: 'Settings',
    requiresProject: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
        <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
      </svg>
    )
  },
  {
    id: 'analysis',
    label: 'Analysis',
    requiresProject: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
        <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
      </svg>
    )
  },
  {
    id: 'render',
    label: 'Render',
    requiresProject: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
      </svg>
    )
  },
  {
    id: 'qa',
    label: 'QA & Export',
    requiresProject: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
      </svg>
    )
  }
]

export function Sidebar({ project, currentPage, onNavigate }: SidebarProps): React.ReactElement {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-section-label">Navigation</div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`sidebar-nav-item ${currentPage === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
            disabled={item.requiresProject && !project}
            title={item.requiresProject && !project ? 'Create or open a project first' : undefined}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
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
      </div>
    </aside>
  )
}
