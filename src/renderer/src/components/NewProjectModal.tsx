import React, { useState } from 'react'

interface NewProjectModalProps {
  onConfirm: (name: string) => void
  onCancel: () => void
  isCreating: boolean
}

export function NewProjectModal({
  onConfirm,
  onCancel,
  isCreating
}: NewProjectModalProps): React.ReactElement {
  const [name, setName] = useState('')

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length >= 2) onConfirm(trimmed)
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <div className="modal-title">New Project</div>
        <div className="modal-subtitle">
          Enter a name for your documentary project. A folder will be created automatically.
        </div>
        <form onSubmit={handleSubmit}>
          <input
            className="modal-input"
            type="text"
            placeholder="e.g. The Industrial Revolution"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={80}
          />
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={isCreating}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={name.trim().length < 2 || isCreating}
            >
              {isCreating ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
