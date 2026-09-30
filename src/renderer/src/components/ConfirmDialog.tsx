import React, { useEffect, useRef } from 'react'

export interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  isDestructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isDestructive = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.ReactElement | null {
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (isOpen) {
      confirmBtnRef.current?.focus()
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onCancel])

  if (!isOpen) return null

  return (
    <div className="modal-backdrop" onClick={onCancel} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <div
        className="modal-box confirm-dialog-box"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '440px' }}
      >
        <div className="modal-header">
          <div className="modal-title" id="dialog-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isDestructive ? (
              <span style={{ color: 'var(--color-error)' }}>⚠️</span>
            ) : (
              <span style={{ color: 'var(--brand-accent)' }}>ℹ️</span>
            )}
            {title}
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <div className="modal-body" style={{ padding: '16px 20px', color: 'var(--text-secondary)', fontSize: '13px', lineHeight: 1.6 }}>
          {message}
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', padding: '14px 20px' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button
            type="button"
            ref={confirmBtnRef}
            className={`btn ${isDestructive ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            style={isDestructive ? { background: '#dc2626', borderColor: '#ef4444', color: '#fff' } : undefined}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
