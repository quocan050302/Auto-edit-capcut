import React, { useState, useEffect, useMemo } from 'react'
import type { ThumbnailPromptTemplate } from '../../../../shared/types'
import { THUMBNAIL_CATEGORIES } from '../../../../shared/types'
import { ThumbnailTemplateEditor } from '../components/thumbnail/ThumbnailTemplateEditor'

interface ThumbnailPromptLibraryPageProps {
  onBack?: () => void
  onSelectForProject?: (template: ThumbnailPromptTemplate) => void
}

export function ThumbnailPromptLibraryPage({
  onBack,
  onSelectForProject
}: ThumbnailPromptLibraryPageProps): React.ReactElement {
  const [templates, setTemplates] = useState<ThumbnailPromptTemplate[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('All')
  const [isLoading, setIsLoading] = useState(true)
  const [editingTemplate, setEditingTemplate] = useState<ThumbnailPromptTemplate | null>(null)
  const [isEditorOpen, setIsEditorOpen] = useState(false)
  const [previewTemplate, setPreviewTemplate] = useState<ThumbnailPromptTemplate | null>(null)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const loadTemplates = async (): Promise<void> => {
    try {
      setIsLoading(true)
      const res = await window.api.thumbnail.templates.list()
      if (res.success && res.templates) {
        setTemplates(res.templates)
      } else if (res.error) {
        setFeedback({ type: 'error', message: res.error })
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadTemplates()
  }, [])

  const filteredTemplates = useMemo(() => {
    return templates.filter((t) => {
      const matchesCategory = selectedCategory === 'All' || t.category === selectedCategory
      const query = searchQuery.toLowerCase().trim()
      const matchesSearch =
        !query ||
        t.name.toLowerCase().includes(query) ||
        (t.description && t.description.toLowerCase().includes(query)) ||
        t.category.toLowerCase().includes(query) ||
        t.promptText.toLowerCase().includes(query)
      return matchesCategory && matchesSearch
    })
  }, [templates, selectedCategory, searchQuery])

  const handleCreate = (): void => {
    setEditingTemplate(null)
    setIsEditorOpen(true)
  }

  const handleEdit = (template: ThumbnailPromptTemplate): void => {
    setEditingTemplate(template)
    setIsEditorOpen(true)
  }

  const handleDuplicate = async (template: ThumbnailPromptTemplate): Promise<void> => {
    try {
      const res = await window.api.thumbnail.templates.duplicate(template.id, `${template.name} (Copy)`)
      if (res.success) {
        setFeedback({ type: 'success', message: `Duplicated "${template.name}" successfully.` })
        await loadTemplates()
      } else {
        setFeedback({ type: 'error', message: res.error || 'Failed to duplicate template' })
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleDelete = async (template: ThumbnailPromptTemplate): Promise<void> => {
    if (template.isBuiltIn) {
      setFeedback({ type: 'error', message: 'Built-in master templates cannot be deleted.' })
      return
    }

    if (!window.confirm(`Are you sure you want to delete template "${template.name}"?`)) {
      return
    }

    try {
      const res = await window.api.thumbnail.templates.delete(template.id)
      if (res.success) {
        setFeedback({ type: 'success', message: `Deleted "${template.name}".` })
        await loadTemplates()
      } else {
        setFeedback({ type: 'error', message: res.error || 'Failed to delete template' })
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleSetDefault = async (template: ThumbnailPromptTemplate): Promise<void> => {
    try {
      const res = await window.api.thumbnail.templates.update(template.id, { isDefault: true })
      if (res.success) {
        setFeedback({ type: 'success', message: `"${template.name}" is now the default template.` })
        await loadTemplates()
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleSaveTemplate = async (data: {
    name: string
    description?: string
    category: string
    promptText: string
    isDefault?: boolean
  }): Promise<void> => {
    if (editingTemplate) {
      const res = await window.api.thumbnail.templates.update(editingTemplate.id, data)
      if (!res.success) throw new Error(res.error || 'Failed to update template')
      setFeedback({ type: 'success', message: `Updated "${data.name}".` })
    } else {
      const res = await window.api.thumbnail.templates.create(data)
      if (!res.success) throw new Error(res.error || 'Failed to create template')
      setFeedback({ type: 'success', message: `Created "${data.name}".` })
    }
    await loadTemplates()
  }

  const handleImport = async (): Promise<void> => {
    try {
      const res = await window.api.thumbnail.templates.import()
      if (res.success) {
        setFeedback({
          type: 'success',
          message: `Successfully imported ${res.importedCount || 0} template(s).`
        })
        await loadTemplates()
      } else if (res.error && res.error !== 'Import cancelled') {
        setFeedback({ type: 'error', message: res.error })
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleExportAll = async (): Promise<void> => {
    try {
      const res = await window.api.thumbnail.templates.export(undefined, true)
      if (res.success && res.filePath) {
        setFeedback({ type: 'success', message: `Exported templates to ${res.filePath}` })
      } else if (res.error && res.error !== 'Export cancelled') {
        setFeedback({ type: 'error', message: res.error })
      }
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="page-container" style={{ padding: '24px', maxWidth: '1300px', margin: '0 auto' }}>
      {/* Top Navigation & Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          {onBack && (
            <button type="button" className="btn btn-secondary" onClick={onBack}>
              ← Back
            </button>
          )}
          <div>
            <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Thumbnail Prompt Library
            </h1>
            <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
              Manage master prompt formulas for generating 5 YouTube thumbnails via Google Flow.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button type="button" className="btn btn-secondary" onClick={handleImport}>
            📥 Import JSON
          </button>
          <button type="button" className="btn btn-secondary" onClick={handleExportAll}>
            📤 Export All
          </button>
          <button type="button" className="btn btn-primary" onClick={handleCreate}>
            + Create Master Prompt
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          style={{
            padding: '12px 16px',
            marginBottom: '20px',
            borderRadius: 'var(--radius-sm, 6px)',
            backgroundColor: feedback.type === 'success' ? 'rgba(52, 211, 153, 0.12)' : 'rgba(239, 68, 68, 0.12)',
            border: `1px solid ${feedback.type === 'success' ? 'rgba(52, 211, 153, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            color: feedback.type === 'success' ? '#34d399' : '#f87171',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '13px'
          }}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Search & Category Filter Bar */}
      <div
        className="panel"
        style={{
          padding: '14px 18px',
          marginBottom: '20px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '12px',
          background: 'var(--bg-surface, #0f0f1a)'
        }}
      >
        <div style={{ flex: 1, minWidth: '240px' }}>
          <input
            type="text"
            className="input-field"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search prompt templates by name, keyword, or prompt..."
            style={{ width: '100%', height: '38px' }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn btn-sm ${selectedCategory === 'All' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSelectedCategory('All')}
          >
            All Categories ({templates.length})
          </button>
          {THUMBNAIL_CATEGORIES.map((cat) => {
            const count = templates.filter((t) => t.category === cat).length
            return (
              <button
                key={cat}
                type="button"
                className={`btn btn-sm ${selectedCategory === cat ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat} {count > 0 && `(${count})`}
              </button>
            )
          })}
        </div>
      </div>

      {/* Templates Grid */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
          Loading master prompt library...
        </div>
      ) : filteredTemplates.length === 0 ? (
        <div
          className="panel"
          style={{
            padding: '60px 20px',
            textAlign: 'center',
            color: 'var(--text-secondary)',
            background: 'var(--bg-surface, #0f0f1a)'
          }}
        >
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>🎨</div>
          <h3 style={{ margin: 0, fontSize: '18px', color: 'var(--text-primary)' }}>No templates found</h3>
          <p style={{ fontSize: '13px', marginTop: '6px' }}>
            {searchQuery
              ? `No templates matching "${searchQuery}" in ${selectedCategory}.`
              : `No templates found in category ${selectedCategory}.`}
          </p>
          <button type="button" className="btn btn-primary" onClick={handleCreate} style={{ marginTop: '12px' }}>
            + Create Template
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: '16px' }}>
          {filteredTemplates.map((template) => (
            <div
              key={template.id}
              className="panel"
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '20px',
                background: 'var(--bg-surface, #0f0f1a)',
                border: template.isDefault
                  ? '1px solid var(--brand-primary, #6c63ff)'
                  : '1px solid var(--border-default, rgba(255, 255, 255, 0.08))',
                borderRadius: 'var(--radius-md, 10px)',
                position: 'relative'
              }}
            >
              <div>
                {/* Badges & Category */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      background: 'rgba(108, 99, 255, 0.15)',
                      color: 'var(--brand-primary)',
                      fontWeight: 600
                    }}
                  >
                    {template.category}
                  </span>

                  {template.isBuiltIn && (
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '12px',
                        background: 'rgba(56, 189, 248, 0.15)',
                        color: 'var(--brand-accent, #38bdf8)',
                        fontWeight: 500
                      }}
                    >
                      Built-in
                    </span>
                  )}

                  {template.isDefault && (
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '12px',
                        background: 'rgba(251, 191, 36, 0.15)',
                        color: 'var(--color-warning, #fbbf24)',
                        fontWeight: 600
                      }}
                    >
                      ★ Default
                    </span>
                  )}
                </div>

                {/* Title */}
                <h3
                  style={{
                    margin: '0 0 8px 0',
                    fontSize: '16px',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    lineHeight: '1.4'
                  }}
                >
                  {template.name}
                </h3>

                {/* Description */}
                {template.description && (
                  <p
                    style={{
                      margin: '0 0 12px 0',
                      fontSize: '13px',
                      color: 'var(--text-secondary)',
                      lineHeight: '1.5'
                    }}
                  >
                    {template.description}
                  </p>
                )}

                {/* Prompt Preview Snippet */}
                <div
                  style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm, 6px)',
                    padding: '10px 12px',
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                    maxHeight: '80px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    lineHeight: '1.4',
                    marginBottom: '14px',
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {template.promptText.slice(0, 240)}...
                </div>
              </div>

              {/* Card Footer: Metadata and Actions */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                    marginBottom: '12px',
                    borderTop: '1px solid var(--border-subtle)',
                    paddingTop: '10px'
                  }}
                >
                  <span>Updated: {new Date(template.updatedAt).toLocaleDateString()}</span>
                  <span>ID: {template.id.slice(0, 12)}...</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setPreviewTemplate(template)}
                    title="View full prompt"
                  >
                    👁 Preview
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleDuplicate(template)}
                    title="Duplicate template"
                  >
                    ⎘ Duplicate
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleEdit(template)}
                    title="Edit template"
                  >
                    ✎ Edit
                  </button>

                  {!template.isDefault && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSetDefault(template)}
                      title="Set as default template for new projects"
                    >
                      ★ Set Default
                    </button>
                  )}

                  {!template.isBuiltIn && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleDelete(template)}
                      style={{ color: '#f87171' }}
                      title="Delete template"
                    >
                      🗑
                    </button>
                  )}

                  {onSelectForProject && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => onSelectForProject(template)}
                      style={{ marginLeft: 'auto' }}
                    >
                      Use for Project
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor Modal */}
      <ThumbnailTemplateEditor
        isOpen={isEditorOpen}
        template={editingTemplate}
        onSave={handleSaveTemplate}
        onClose={() => setIsEditorOpen(false)}
      />

      {/* Full Preview Modal */}
      {previewTemplate && (
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
          onClick={() => setPreviewTemplate(null)}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-surface, #0f0f1a)',
              border: '1px solid var(--border-strong, rgba(255, 255, 255, 0.15))',
              borderRadius: 'var(--radius-lg, 16px)',
              width: '100%',
              maxWidth: '820px',
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
                padding: '16px 24px',
                borderBottom: '1px solid var(--border-default)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', color: 'var(--text-primary)' }}>
                  {previewTemplate.name}
                </h3>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  Category: {previewTemplate.category} {previewTemplate.isBuiltIn && '• Built-in'}{' '}
                  {previewTemplate.isDefault && '• Default'}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setPreviewTemplate(null)}
              >
                ✕ Close
              </button>
            </div>

            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
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
                {previewTemplate.promptText}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
