import React, { useState, useEffect } from 'react'
import type {
  ThumbnailPromptTemplate,
  ProjectThumbnailSettings
} from '../../../../../shared/types'
import { ThumbnailTemplateSelector } from './ThumbnailTemplateSelector'

interface ThumbnailInputAutomationCardProps {
  projectDir: string
  onManageLibrary: () => void
  disabled?: boolean
}

export function ThumbnailInputAutomationCard({
  projectDir,
  onManageLibrary,
  disabled
}: ThumbnailInputAutomationCardProps): React.ReactElement {
  const [settings, setSettings] = useState<ProjectThumbnailSettings | null>(null)
  const [templates, setTemplates] = useState<ThumbnailPromptTemplate[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    async function loadData(): Promise<void> {
      try {
        setIsLoading(true)
        const [tplRes, setRes] = await Promise.all([
          window.api.thumbnail.templates.list(),
          window.api.thumbnail.settings.get(projectDir)
        ])

        if (!mounted) return

        const loadedTemplates = tplRes.success && tplRes.templates ? tplRes.templates : []
        setTemplates(loadedTemplates)

        if (setRes.success && setRes.settings) {
          const loadedSettings = setRes.settings
          // If no template was selected yet, pick the default one
          if (!loadedSettings.selectedTemplateId && loadedTemplates.length > 0) {
            const def = loadedTemplates.find((t) => t.isDefault) || loadedTemplates[0]
            loadedSettings.selectedTemplateId = def.id
            loadedSettings.templateSnapshot = def.promptText
            await window.api.thumbnail.settings.save(projectDir, loadedSettings)
          }
          setSettings(loadedSettings)
        }
      } catch (err) {
        console.error('Failed to load thumbnail settings for input page:', err)
      } finally {
        if (mounted) setIsLoading(false)
      }
    }

    if (projectDir) {
      loadData()
    }

    return () => {
      mounted = false
    }
  }, [projectDir])

  const handleToggleEnabled = async (checked: boolean): Promise<void> => {
    if (!settings) return
    const updated: ProjectThumbnailSettings = {
      ...settings,
      enabled: checked,
      autoGenerateAfterRender: checked
    }
    setSettings(updated)
    await window.api.thumbnail.settings.save(projectDir, updated)
  }

  const handleSelectTemplate = async (templateId: string): Promise<void> => {
    if (!settings) return
    const target = templates.find((t) => t.id === templateId)
    const updated: ProjectThumbnailSettings = {
      ...settings,
      selectedTemplateId: templateId,
      templateSnapshot: target?.promptText || settings.templateSnapshot
    }
    setSettings(updated)
    await window.api.thumbnail.settings.save(projectDir, updated)
  }

  const handleTitleChange = async (val: string): Promise<void> => {
    if (!settings) return
    const updated: ProjectThumbnailSettings = {
      ...settings,
      existingVideoTitle: val
    }
    setSettings(updated)
    await window.api.thumbnail.settings.save(projectDir, updated)
  }

  if (isLoading || !settings) {
    return (
      <div className="panel" style={{ padding: '16px', background: 'var(--bg-surface, #0f0f1a)' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Loading thumbnail automation settings...</div>
      </div>
    )
  }

  const hasSelectedTemplate = Boolean(settings.selectedTemplateId)

  return (
    <div
      className="panel"
      style={{
        background: 'var(--bg-surface, #0f0f1a)',
        border: '1px solid var(--border-default, rgba(255, 255, 255, 0.08))',
        borderRadius: 'var(--radius-md, 10px)',
        overflow: 'hidden',
        marginBottom: '16px'
      }}
    >
      <div
        style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(255, 255, 255, 0.02)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '18px' }}>🎨</span>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
              Thumbnail Automation
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Generate 5 YouTube 4K thumbnails automatically using Google Flow after video render finishes.
            </div>
          </div>
        </div>

        <span
          style={{
            fontSize: '11px',
            padding: '3px 10px',
            borderRadius: '12px',
            background: settings.enabled ? 'rgba(52, 211, 153, 0.15)' : 'rgba(148, 163, 184, 0.15)',
            color: settings.enabled ? 'var(--color-success, #34d399)' : 'var(--text-muted)',
            fontWeight: 600
          }}
        >
          {settings.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {/* Enable Checkbox */}
        <label className="checkbox-label" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.enabled && settings.autoGenerateAfterRender}
            onChange={(e) => handleToggleEnabled(e.target.checked)}
            disabled={disabled}
          />
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>
            Automatically create thumbnails after render
          </span>
        </label>

        {settings.enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', paddingTop: '4px' }}>
            {/* Warning if no template selected */}
            {!hasSelectedTemplate && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-sm, 6px)',
                  background: 'rgba(251, 191, 36, 0.12)',
                  border: '1px solid rgba(251, 191, 36, 0.3)',
                  color: 'var(--color-warning, #fbbf24)',
                  fontSize: '12px'
                }}
              >
                ⚠️ No master prompt selected. Thumbnail generation will pause for review after render.
              </div>
            )}

            {/* Template Selector */}
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                Prompt template
              </label>
              <ThumbnailTemplateSelector
                templates={templates}
                selectedTemplateId={settings.selectedTemplateId}
                onChange={handleSelectTemplate}
                onManageLibrary={onManageLibrary}
                disabled={disabled}
              />
            </div>

            {/* Existing Video Title (Optional) */}
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                Existing video title (Optional)
              </label>
              <input
                type="text"
                className="input-field"
                value={settings.existingVideoTitle || ''}
                onChange={(e) => handleTitleChange(e.target.value)}
                placeholder="Optional: current video title to help the prompt align with title hooks..."
                disabled={disabled}
                style={{ width: '100%', height: '38px' }}
              />
            </div>

            {/* Fixed parameters grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '12px',
                paddingTop: '6px'
              }}
            >
              <div
                style={{
                  background: 'rgba(0, 0, 0, 0.25)',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: '1px solid var(--border-subtle)'
                }}
              >
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Variants</div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '2px' }}>
                  5 — fixed (A, B, C, D, E)
                </div>
              </div>

              <div
                style={{
                  background: 'rgba(0, 0, 0, 0.25)',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: '1px solid var(--border-subtle)'
                }}
              >
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Provider</div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--brand-primary)', marginTop: '2px' }}>
                  Google Flow
                </div>
              </div>

              <div
                style={{
                  background: 'rgba(0, 0, 0, 0.25)',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: '1px solid var(--border-subtle)'
                }}
              >
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Target Quality</div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-warning)', marginTop: '2px' }}>
                  4K (3840 × 2160)
                </div>
              </div>

              <div
                style={{
                  background: 'rgba(0, 0, 0, 0.25)',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: '1px solid var(--border-subtle)'
                }}
              >
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Image Model</div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '2px' }}>
                  Nano Banana Pro
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
