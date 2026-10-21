import React, { useState } from 'react'
import type { EditorialGenerationSettings } from '../../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'

export interface EditorialSetupControlsProps {
  projectDir: string
  settings: EditorialGenerationSettings
  disabled: boolean
  promptModeEligible: boolean
  saving: boolean
  error?: string | null
  onChange: (patch: Partial<EditorialGenerationSettings>) => Promise<boolean | void>
  idSuffix?: string
}

export function EditorialSetupControls({
  settings,
  disabled,
  promptModeEligible,
  saving,
  error,
  onChange,
  idSuffix = ''
}: EditorialSetupControlsProps): React.ReactElement {
  const [showSourceOnlyConfirm, setShowSourceOnlyConfirm] = useState(false)

  const isEmbedded = settings.promptMode === 'embedded-editorial'
  const isSourceOnly = settings.renderOverlayMode === 'source-only'

  return (
    <div
      id={`editorial-setup-controls${idSuffix}`}
      style={{
        marginTop: '12px',
        padding: '16px',
        borderRadius: 'var(--radius-lg, 12px)',
        border: '1px solid rgba(129, 140, 248, 0.25)',
        background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(14, 165, 233, 0.04))',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.02em' }}>
            🎬 AI VIDEO EDITORIAL SETTINGS
          </span>
          {saving && (
            <span style={{ fontSize: '11px', color: 'var(--color-brand, #818cf8)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <span className="spinner-sm" style={{ width: '10px', height: '10px' }} /> Saving...
            </span>
          )}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
          Step 2 Setup Configuration
        </div>
      </div>

      {/* Error banner if save or load failed */}
      {error && (
        <div
          id={`editorial-setup-error${idSuffix}`}
          style={{
            padding: '8px 12px',
            borderRadius: '6px',
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#f87171',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <span>⚠️ {error}</span>
        </div>
      )}

      {/* Video Prompt Style Selector */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
              Video Prompt Style
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              Choose whether generated video prompts include on-screen editorial focus labels.
            </div>
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              id={`editorial-mode-classic${idSuffix}`}
              className={`btn btn-sm ${!isEmbedded ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: '11px', padding: '4px 10px' }}
              onClick={() => void onChange({ promptMode: 'classic' })}
              disabled={disabled || !promptModeEligible}
              title={!promptModeEligible ? 'Active in Custom Mix with Manual Prompt AI images.' : undefined}
            >
              Classic (Original)
            </button>
            <button
              type="button"
              id={`editorial-mode-embedded${idSuffix}`}
              className={`btn btn-sm ${isEmbedded ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: '11px', padding: '4px 10px' }}
              onClick={() => void onChange({ promptMode: 'embedded-editorial' })}
              disabled={disabled || !promptModeEligible}
              title={!promptModeEligible ? 'Active in Custom Mix with Manual Prompt AI images.' : undefined}
            >
              AI Embedded Editorial
            </button>
          </div>
        </div>

        {!promptModeEligible && (
          <div
            id={`editorial-prompt-ineligible-note${idSuffix}`}
            style={{
              fontSize: '11px',
              color: 'var(--text-secondary)',
              fontStyle: 'italic',
              padding: '4px 8px',
              borderRadius: '4px',
              background: 'rgba(255, 255, 255, 0.04)'
            }}
          >
            ℹ️ Video prompt styles apply when AI Image Mode is set to &ldquo;Prompt&rdquo; in Custom Mix. Previously saved editorial preferences remain preserved.
          </div>
        )}
      </div>

      {/* Embedded Editorial Options (Visible when Embedded is active and eligible) */}
      {isEmbedded && promptModeEligible && (
        <div
          id={`editorial-embedded-options${idSuffix}`}
          style={{
            padding: '10px 12px',
            borderRadius: '8px',
            background: 'rgba(0, 0, 0, 0.25)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}
        >
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-brand, #818cf8)' }}>
            Editorial Text &amp; Focus Options:
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px' }}>
            <label
              htmlFor={`editorial-senior-friendly-toggle${idSuffix}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                cursor: disabled ? 'default' : 'pointer',
                fontSize: '12px',
                color: 'var(--text-primary)'
              }}
            >
              <input
                type="checkbox"
                id={`editorial-senior-friendly-toggle${idSuffix}`}
                checked={settings.readability === 'senior-friendly'}
                onChange={(e) => void onChange({ readability: e.target.checked ? 'senior-friendly' : 'standard' })}
                disabled={disabled}
                style={{ marginTop: '2px' }}
              />
              <div>
                <div style={{ fontWeight: 600 }}>Senior-Friendly Readability (50+)</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  Large, high-contrast labels with restrained motion, easier to read for older viewers.
                </div>
              </div>
            </label>

            <label
              htmlFor={`editorial-density-toggle${idSuffix}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                cursor: disabled ? 'default' : 'pointer',
                fontSize: '12px',
                color: 'var(--text-primary)'
              }}
            >
              <input
                type="checkbox"
                id={`editorial-density-toggle${idSuffix}`}
                checked={settings.labelDensity === 'balanced'}
                onChange={(e) => void onChange({ labelDensity: e.target.checked ? 'balanced' : 'minimal' })}
                disabled={disabled}
                style={{ marginTop: '2px' }}
              />
              <div>
                <div style={{ fontWeight: 600 }}>Balanced Label Density</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  Allow grounded labels on additional scenes when they help explain the visual.
                </div>
              </div>
            </label>

            <label
              htmlFor={`editorial-leader-lines-toggle${idSuffix}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                cursor: disabled ? 'default' : 'pointer',
                fontSize: '12px',
                color: 'var(--text-primary)'
              }}
            >
              <input
                type="checkbox"
                id={`editorial-leader-lines-toggle${idSuffix}`}
                checked={settings.preferLeaderLines}
                onChange={(e) => void onChange({ preferLeaderLines: e.target.checked })}
                disabled={disabled}
                style={{ marginTop: '2px' }}
              />
              <div>
                <div style={{ fontWeight: 600 }}>Include Graphic Leader Lines</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  Use thin animated pointers to identify visible objects or mechanisms.
                </div>
              </div>
            </label>
          </div>

          <div
            style={{
              marginTop: '4px',
              padding: '6px 10px',
              borderRadius: '6px',
              background: 'rgba(234, 179, 8, 0.08)',
              border: '1px solid rgba(234, 179, 8, 0.25)',
              fontSize: '11px',
              color: '#facc15'
            }}
          >
            ⚠️ <strong>Review note:</strong> AI-generated text may contain spelling errors. Review the generated clips before importing.
          </div>
        </div>
      )}

      {/* Render Output Mode (Always visible per requirements 54 & 55) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
              ⚡ Render Output Mode:
            </span>
            <span style={{ fontSize: '11px', fontWeight: 600, color: isSourceOnly ? '#38bdf8' : '#a3e635' }}>
              {isSourceOnly ? 'Source Only' : 'Full Production'}
            </span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            {isSourceOnly
              ? 'Direct visuals & audio mixing. Dynamic captions and Remotion overlays omitted (lowest RAM).'
              : 'Full Remotion dynamic captions, proof visuals, and grammar overlays composited (standard).'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            id={`render-mode-full${idSuffix}`}
            className={`btn btn-sm ${!isSourceOnly ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '11px', padding: '4px 10px' }}
            onClick={() => void onChange({ renderOverlayMode: 'full' })}
            disabled={disabled}
          >
            Full Production
          </button>
          <button
            type="button"
            id={`render-mode-source-only${idSuffix}`}
            className={`btn btn-sm ${isSourceOnly ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '11px', padding: '4px 10px' }}
            onClick={() => {
              if (!isSourceOnly) {
                setShowSourceOnlyConfirm(true)
              }
            }}
            disabled={disabled}
          >
            Source Only (Low-Memory)
          </button>
        </div>
      </div>

      {/* Current Configuration Summary */}
      <div
        id={`editorial-setup-summary${idSuffix}`}
        style={{
          marginTop: '4px',
          padding: '8px 12px',
          borderRadius: '6px',
          background: 'rgba(0, 0, 0, 0.2)',
          border: '1px solid rgba(255, 255, 255, 0.05)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          fontSize: '11px'
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Summary:</span>
        <span
          style={{
            padding: '2px 6px',
            borderRadius: '4px',
            background: isEmbedded ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255, 255, 255, 0.08)',
            color: isEmbedded ? '#a5b4fc' : 'var(--text-secondary)'
          }}
        >
          {isEmbedded ? 'AI Embedded Editorial' : 'Classic Mode'}
        </span>
        {isEmbedded && (
          <>
            <span
              style={{
                padding: '2px 6px',
                borderRadius: '4px',
                background: settings.readability === 'senior-friendly' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                color: settings.readability === 'senior-friendly' ? '#38bdf8' : 'var(--text-secondary)'
              }}
            >
              {settings.readability === 'senior-friendly' ? 'Senior-Friendly (50+)' : 'Standard Readability'}
            </span>
            <span
              style={{
                padding: '2px 6px',
                borderRadius: '4px',
                background: settings.labelDensity === 'balanced' ? 'rgba(163, 230, 53, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                color: settings.labelDensity === 'balanced' ? '#a3e635' : 'var(--text-secondary)'
              }}
            >
              {settings.labelDensity === 'balanced' ? 'Balanced Labels' : 'Minimal Labels'}
            </span>
            <span
              style={{
                padding: '2px 6px',
                borderRadius: '4px',
                background: settings.preferLeaderLines ? 'rgba(168, 85, 247, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                color: settings.preferLeaderLines ? '#c084fc' : 'var(--text-secondary)'
              }}
            >
              {settings.preferLeaderLines ? 'Leader Lines' : 'No Leader Lines'}
            </span>
          </>
        )}
        <span
          style={{
            padding: '2px 6px',
            borderRadius: '4px',
            background: isSourceOnly ? 'rgba(56, 189, 248, 0.2)' : 'rgba(163, 230, 53, 0.2)',
            color: isSourceOnly ? '#38bdf8' : '#a3e635',
            fontWeight: 600
          }}
        >
          {isSourceOnly ? 'Source Only' : 'Full Production'}
        </span>
      </div>

      {/* Confirmation Dialog for Source Only */}
      <ConfirmDialog
        isOpen={showSourceOnlyConfirm}
        title="Activate Source Only Render Mode?"
        message={`Source Only mode renders directly from imported/generated visuals and audio without app-generated visual overlays.

Trade-offs:
• Remotion dynamic captions will NOT be rendered
• Proof Visual overlays will NOT be rendered
• Visual Scene Grammar overlays will NOT be rendered
• Opening graphic overlays will NOT be rendered

Recommended when:
• Running on low-memory systems or minimizing render time
• Generating visuals that already contain all necessary text`}
        confirmText="Activate Source Only"
        cancelText="Keep Full Production"
        onConfirm={() => {
          setShowSourceOnlyConfirm(false)
          void onChange({ renderOverlayMode: 'source-only' })
        }}
        onCancel={() => setShowSourceOnlyConfirm(false)}
      />
    </div>
  )
}
