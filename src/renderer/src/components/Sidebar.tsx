import React from 'react'
import type { ProjectState } from '../../../../shared/types'

type Page = 'home' | 'input' | 'transcribe' | 'planning' | 'stock' | 'settings' | 'analysis' | 'render' | 'qa'

interface SidebarProps {
  project: ProjectState | null
  currentPage: Page
  onNavigate: (page: Page) => void
  hasTranscript?: boolean
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

const NAV_ITEMS: {
  id: Page
  label: string
  icon: React.ReactNode
  requiresProject: boolean
  badge?: string
}[] = [
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
    id: 'transcribe',
    label: 'Transcribe',
    requiresProject: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
        <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
      </svg>
    )
  },
  {
    id: 'planning',
    label: 'AI Planning',
    requiresProject: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
        <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z" />
      </svg>
    )
  },
  {
    id: 'stock',
    label: 'Stock Media',
    requiresProject: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="nav-icon">
        <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm3 2h6v4H7V5zm8 8v2h1v-2h-1zm-2-2H7v4h6v-4zm2 0h1V9h-1v2zm1-4V5h-1v2h1zM5 5v2H4V5h1zm-1 4h1v2H4V9zm1 4H4v2h1v-2z" clipRule="evenodd" />
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

export function Sidebar({
  project,
  currentPage,
  onNavigate,
  hasTranscript,
  stockCoverage
}: SidebarProps): React.ReactElement {
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
            <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
            {/* Badge: transcription done */}
            {item.id === 'transcribe' && hasTranscript && (
              <span style={{
                width: 6, height: 6,
                borderRadius: '50%',
                background: 'var(--color-success)',
                flexShrink: 0
              }} />
            )}
            {/* Badge: stock coverage */}
            {item.id === 'stock' && stockCoverage && stockCoverage.total > 0 && (
              <span style={{
                fontSize: '9px', fontWeight: 700,
                background: stockCoverage.assigned === stockCoverage.total
                  ? 'rgba(52,211,153,0.2)' : 'rgba(96,165,250,0.2)',
                color: stockCoverage.assigned === stockCoverage.total
                  ? 'var(--color-success)' : 'var(--color-info)',
                borderRadius: '999px', padding: '1px 5px', flexShrink: 0
              }}>
                {stockCoverage.assigned}/{stockCoverage.total}
              </span>
            )}
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
