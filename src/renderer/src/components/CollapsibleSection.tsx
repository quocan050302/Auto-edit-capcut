import React, { useState } from 'react'

export interface CollapsibleSectionProps {
  title: React.ReactNode
  subtitle?: React.ReactNode
  summaryWhenClosed?: React.ReactNode
  badge?: React.ReactNode
  icon?: React.ReactNode
  isOpen?: boolean
  defaultOpen?: boolean
  onToggle?: (isOpen: boolean) => void
  children: React.ReactNode
  className?: string
  headerAction?: React.ReactNode
  id?: string
}

export function CollapsibleSection({
  title,
  subtitle,
  summaryWhenClosed,
  badge,
  icon,
  isOpen: controlledOpen,
  defaultOpen = false,
  onToggle,
  children,
  className = '',
  headerAction,
  id
}: CollapsibleSectionProps): React.ReactElement {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const isExpanded = controlledOpen !== undefined ? controlledOpen : internalOpen

  function handleToggle(): void {
    const next = !isExpanded
    if (controlledOpen === undefined) {
      setInternalOpen(next)
    }
    onToggle?.(next)
  }

  const contentId = id ? `${id}-content` : undefined
  const headerId = id ? `${id}-header` : undefined

  return (
    <div className={`collapsible-section ${isExpanded ? 'is-open' : 'is-closed'} ${className}`.trim()}>
      <div
        className="collapsible-section-header"
        onClick={handleToggle}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        id={headerId}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleToggle()
          }
        }}
      >
        <div className="collapsible-header-left">
          {icon && <span className="collapsible-icon">{icon}</span>}
          <div className="collapsible-title-wrap">
            <div className="collapsible-title-row">
              <span className="collapsible-title">{title}</span>
              {badge && <span className="collapsible-badge">{badge}</span>}
            </div>
            {subtitle && <div className="collapsible-subtitle">{subtitle}</div>}
            {!isExpanded && summaryWhenClosed && (
              <div className="collapsible-summary-closed">{summaryWhenClosed}</div>
            )}
          </div>
        </div>

        <div className="collapsible-header-right" onClick={(e) => e.stopPropagation()}>
          {headerAction}
          <button
            type="button"
            className="collapsible-chevron-btn"
            onClick={handleToggle}
            aria-label={isExpanded ? 'Collapse section' : 'Expand section'}
          >
            <svg
              className={`collapsible-chevron ${isExpanded ? 'rotate-180' : ''}`}
              width="16"
              height="16"
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

      {isExpanded && (
        <div className="collapsible-section-body" id={contentId} role="region" aria-labelledby={headerId}>
          {children}
        </div>
      )}
    </div>
  )
}
