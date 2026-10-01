import React, { useState, useEffect } from 'react'
import type { ThumbnailPromptTemplate } from '../../../../../shared/types'
import { THUMBNAIL_CATEGORIES } from '../../../../../shared/types'

interface ThumbnailTemplateEditorProps {
  isOpen: boolean
  template?: ThumbnailPromptTemplate | null
  onSave: (data: {
    name: string
    description?: string
    category: string
    promptText: string
    isDefault?: boolean
  }) => Promise<void>
  onClose: () => void
}

const SUPPORTED_VARIABLES = [
  { tag: '{{SCRIPT}}', label: 'Full Script (Required)', required: true },
  { tag: '{{VIDEO_TITLE}}', label: 'Video Title', required: false },
  { tag: '{{GLOBAL_VISUAL_CONTEXT}}', label: 'Visual Context', required: false },
  { tag: '{{VARIANT_COUNT}}', label: 'Variants (5)', required: false },
  { tag: '{{PREVIOUS_CONCEPTS}}', label: 'Prev Concepts', required: false },
  { tag: '{{OUTPUT_LANGUAGE}}', label: 'Output Lang', required: false }
]

export function ThumbnailTemplateEditor({
  isOpen,
  template,
  onSave,
  onClose
}: ThumbnailTemplateEditorProps): React.ReactElement | null {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<string>('US Grocery')
  const [promptText, setPromptText] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (template) {
      setName(template.name)
      setDescription(template.description || '')
      setCategory(template.category || 'US Grocery')
      setPromptText(template.promptText)
      setIsDefault(template.isDefault)
    } else {
      setName('')
      setDescription('')
      setCategory('Custom')
      setPromptText('Analyze script: {{SCRIPT}}\nCreate {{VARIANT_COUNT}} distinct YouTube thumbnail prompts.')
      setIsDefault(false)
    }
    setError(null)
  }, [template, isOpen])

  if (!isOpen) return null

  const handleInsertVariable = (tag: string): void => {
    setPromptText((prev) => `${prev} ${tag}`)
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Please provide a prompt template name.')
      return
    }
    if (!promptText.trim()) {
      setError('Prompt text cannot be empty.')
      return
    }
    if (!promptText.includes('{{SCRIPT}}')) {
      setError('Prompt must include {{SCRIPT}} variable so the AI can ground the thumbnails in the script.')
      return
    }

    try {
      setIsSaving(true)
      setError(null)
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        category,
        promptText: promptText.trim(),
        isDefault
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: 'var(--bg-surface, #0f0f1a)',
          border: '1px solid var(--border-strong, rgba(255, 255, 255, 0.15))',
          borderRadius: 'var(--radius-lg, 16px)',
          width: '100%',
          maxWidth: '820px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.8)',
          overflow: 'hidden'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-default, rgba(255, 255, 255, 0.08))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>
              {template ? 'Edit Master Prompt Template' : 'Create Master Prompt Template'}
            </h3>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Master prompts define the exact creative instructions and 5 visual hooks sent to Google Flow.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            style={{ padding: '4px 10px' }}
          >
            ✕
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {error && (
              <div
                style={{
                  padding: '10px 14px',
                  backgroundColor: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: 'var(--radius-sm, 6px)',
                  color: '#f87171',
                  fontSize: '13px'
                }}
              >
                ⚠️ {error}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Template Name *
                </label>
                <input
                  type="text"
                  className="input-field"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. US Grocery & Preparedness — Script Grounded"
                  required
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Niche / Category
                </label>
                <select
                  className="input-field"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  style={{ width: '100%', height: '38px' }}
                >
                  {THUMBNAIL_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                Description (Optional)
              </label>
              <input
                type="text"
                className="input-field"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief summary of when to use this master prompt..."
                style={{ width: '100%' }}
              />
            </div>

            {/* Variable Insertion Chips */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)' }}>
                  Master Prompt Text *
                </label>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Click chips below to insert variables:
                </span>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                {SUPPORTED_VARIABLES.map((v) => (
                  <button
                    key={v.tag}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleInsertVariable(v.tag)}
                    style={{
                      fontSize: '11px',
                      padding: '3px 8px',
                      borderColor: v.required ? 'var(--brand-primary)' : 'var(--border-default)',
                      color: v.required ? 'var(--brand-primary)' : 'var(--text-secondary)'
                    }}
                    title={`Insert ${v.tag}`}
                  >
                    + {v.tag} {v.required && '★'}
                  </button>
                ))}
              </div>

              <textarea
                className="input-field"
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                rows={14}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: '12px',
                  lineHeight: '1.5',
                  resize: 'vertical'
                }}
                placeholder="Enter master prompt instructions..."
                required
              />
            </div>

            <div>
              <label className="checkbox-label" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                />
                <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                  Set as default prompt for new projects
                </span>
              </label>
            </div>
          </div>

          {/* Footer Actions */}
          <div
            style={{
              padding: '16px 24px',
              borderTop: '1px solid var(--border-default, rgba(255, 255, 255, 0.08))',
              backgroundColor: 'rgba(0, 0, 0, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '12px'
            }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSaving}
              style={{ minWidth: '120px' }}
            >
              {isSaving ? 'Saving...' : template ? 'Save Changes' : 'Create Template'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
