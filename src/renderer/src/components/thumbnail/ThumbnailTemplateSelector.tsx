import React, { useState } from 'react'
import type { ThumbnailPromptTemplate } from '../../../../../shared/types'

interface ThumbnailTemplateSelectorProps {
  templates: ThumbnailPromptTemplate[]
  selectedTemplateId?: string
  onChange: (templateId: string) => void
  onManageLibrary: () => void
  disabled?: boolean
}

export function ThumbnailTemplateSelector({
  templates,
  selectedTemplateId,
  onChange,
  onManageLibrary,
  disabled
}: ThumbnailTemplateSelectorProps): React.ReactElement {
  const [showPreviewModal, setShowPreviewModal] = useState(false)

  const selectedTemplate =
    templates.find((t) => t.id === selectedTemplateId) ||
    templates.find((t) => t.isDefault) ||
    templates[0]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <select
          className="input-field"
          value={selectedTemplate?.id || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          style={{ flex: 1, height: '40px' }}
        >
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name} {tpl.isDefault ? '★ (Default)' : ''} [{tpl.category}]
            </option>
          ))}
        </select>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setShowPreviewModal(true)}
          disabled={!selectedTemplate}
          style={{ height: '40px', padding: '0 12px', whiteSpace: 'nowrap' }}
          title="Preview the full prompt text of the selected template"
        >
          👁 Preview
        </button>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onManageLibrary}
          style={{ height: '40px', padding: '0 12px', whiteSpace: 'nowrap' }}
          title="Open Thumbnail Prompt Library Manager"
        >
          📚 Manage Library
        </button>
      </div>

      {selectedTemplate && (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '12px',
              background: 'rgba(108, 99, 255, 0.15)',
              color: 'var(--brand-primary)',
              fontWeight: 500
            }}
          >
            {selectedTemplate.category}
          </span>
          {selectedTemplate.description && (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedTemplate.description}
            </span>
          )}
        </div>
      )}

      {/* Preview Modal */}
      {showPreviewModal && selectedTemplate && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(8px)',
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px'
          }}
          onClick={() => setShowPreviewModal(false)}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-surface, #0f0f1a)',
              border: '1px solid var(--border-strong, rgba(255, 255, 255, 0.15))',
              borderRadius: 'var(--radius-lg, 16px)',
              width: '100%',
              maxWidth: '750px',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.8)',
              overflow: 'hidden'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border-default)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <div>
                <h4 style={{ margin: 0, fontSize: '16px', color: 'var(--text-primary)' }}>
                  {selectedTemplate.name}
                </h4>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Category: {selectedTemplate.category} {selectedTemplate.isBuiltIn ? '• Built-in' : ''}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowPreviewModal(false)}
              >
                ✕ Close
              </button>
            </div>

            <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: '12px',
                  lineHeight: '1.6',
                  color: 'var(--text-primary)',
                  background: 'rgba(0, 0, 0, 0.3)',
                  padding: '16px',
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: '1px solid var(--border-default)'
                }}
              >
                {selectedTemplate.promptText}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
