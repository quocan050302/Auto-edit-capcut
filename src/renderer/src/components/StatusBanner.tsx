import React from 'react'

export type BannerVariant = 'info' | 'warning' | 'success' | 'error' | 'recovery'

export interface StatusBannerProps {
  variant: BannerVariant
  title?: React.ReactNode
  message: React.ReactNode
  action?: {
    label: string
    onClick: () => void
    variant?: 'primary' | 'secondary'
  }
  secondaryAction?: {
    label: string
    onClick: () => void
  }
  onDismiss?: () => void
  className?: string
}

export function StatusBanner({
  variant,
  title,
  message,
  action,
  secondaryAction,
  onDismiss,
  className = ''
}: StatusBannerProps): React.ReactElement {
  const variantIcons: Record<BannerVariant, string> = {
    info: 'ℹ️',
    warning: '⚠️',
    success: '✓',
    error: '✕',
    recovery: '⚡'
  }

  return (
    <div className={`status-banner status-banner--${variant} ${className}`.trim()} role="alert">
      <div className="status-banner__icon">
        <span>{variantIcons[variant]}</span>
      </div>

      <div className="status-banner__content">
        {title && <div className="status-banner__title">{title}</div>}
        <div className="status-banner__message">{message}</div>
      </div>

      {(action || secondaryAction || onDismiss) && (
        <div className="status-banner__actions">
          {secondaryAction && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </button>
          )}
          {action && (
            <button
              type="button"
              className={`btn ${action.variant === 'secondary' ? 'btn-secondary' : 'btn-primary'} btn-sm`}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              className="status-banner__dismiss"
              onClick={onDismiss}
              aria-label="Dismiss banner"
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  )
}
