import React, { useState, useEffect } from 'react'
import type { ThumbnailProviderHealth, ProjectThumbnailSettings } from '../../../../shared/types'

interface GoogleFlowSettingsSectionProps {
  projectDir?: string
}

export const GoogleFlowSettingsSection: React.FC<GoogleFlowSettingsSectionProps> = ({
  projectDir
}) => {
  const [bridgeUrl, setBridgeUrl] = useState<string>('http://127.0.0.1:8100')
  const [imageModel, setImageModel] = useState<string>('GEM_PIX_2')
  const [exportQuality, setExportQuality] = useState<'4k'>('4k')
  const [health, setHealth] = useState<ThumbnailProviderHealth | null>(null)
  const [isChecking, setIsChecking] = useState<boolean>(false)
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false)

  useEffect(() => {
    if (projectDir) {
      window.api.thumbnail.settings.get(projectDir).then((res) => {
        if (res.success && res.settings) {
          if (res.settings.imageModel) setImageModel(res.settings.imageModel)
          if (res.settings.outputQuality) setExportQuality(res.settings.outputQuality)
        }
      }).catch(() => {})
    }

    handleCheckHealth()
  }, [projectDir])

  const handleCheckHealth = async (customUrl?: string) => {
    setIsChecking(true)
    try {
      const res = await window.api.thumbnail.flow.checkHealth(customUrl || bridgeUrl)
      setHealth(res)
    } finally {
      setIsChecking(false)
    }
  }

  const handleSaveSettings = async () => {
    if (!projectDir) return
    const current = await window.api.thumbnail.settings.get(projectDir)
    const base = current.settings || {
      enabled: true,
      autoGenerateAfterRender: true,
      variantCount: 5 as const,
      outputLanguage: 'en-US' as const,
      provider: 'google-flow' as const,
      imageModel: 'GEM_PIX_2',
      outputQuality: '4k' as const
    }

    const updated: ProjectThumbnailSettings = {
      ...base,
      imageModel,
      outputQuality: exportQuality
    }

    await window.api.thumbnail.settings.save(projectDir, updated)
    setSaveSuccess(true)
    setTimeout(() => setSaveSuccess(false), 2500)
  }

  const handleOpenFlow = async () => {
    await window.api.thumbnail.flow.openFlow()
  }

  return (
    <div className="panel" style={{ marginBottom: '24px' }}>
      <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>🎨</span>
          <span>Google Flow Connector</span>
        </div>
        <span
          className="panel-badge"
          style={{
            background: health?.reachable ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            color: health?.reachable ? '#22c55e' : '#ef4444'
          }}
        >
          {health?.reachable ? 'Bridge Connected' : 'Bridge Offline'}
        </span>
      </div>

      <div className="panel-body">
        <div className="settings-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '20px' }}>
          {/* Bridge URL */}
          <div className="settings-field">
            <label className="settings-label" style={{ display: 'block', marginBottom: '6px' }}>
              Bridge URL
            </label>
            <input
              type="text"
              className="input-text font-mono"
              value={bridgeUrl}
              onChange={(e) => setBridgeUrl(e.target.value)}
              placeholder="http://127.0.0.1:8100"
              style={{ width: '100%' }}
            />
          </div>

          {/* Image Model */}
          <div className="settings-field">
            <label className="settings-label" style={{ display: 'block', marginBottom: '6px' }}>
              Image Model
            </label>
            <select
              className="settings-select"
              value={imageModel}
              onChange={(e) => setImageModel(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="GEM_PIX_2">Nano Banana Pro / GEM_PIX_2 (Default)</option>
              <option value="NARWHAL">Imagen 3 Fast (NARWHAL)</option>
              <option value="HARBOR_SEAL">Imagen 3 Quality (HARBOR_SEAL)</option>
            </select>
          </div>

          {/* Export Quality */}
          <div className="settings-field">
            <label className="settings-label" style={{ display: 'block', marginBottom: '6px' }}>
              Export Quality
            </label>
            <input
              type="text"
              className="input-text font-mono"
              value="4K (3840 × 2160)"
              disabled
              style={{ width: '100%', opacity: 0.8 }}
            />
          </div>
        </div>

        {/* Connection Status List */}
        <div
          style={{
            background: 'rgba(0, 0, 0, 0.25)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '8px',
            padding: '14px 18px',
            marginBottom: '20px'
          }}
        >
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#f3f4f6', marginBottom: '10px' }}>
            Connection Status
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: health?.reachable ? '#22c55e' : '#ef4444' }}>●</span>
              <span style={{ color: '#d1d5db' }}>FlowKit bridge reachable</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: health?.extensionConnected ? '#22c55e' : '#ef4444' }}>●</span>
              <span style={{ color: '#d1d5db' }}>Chrome extension connected</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: health?.signedIn ? '#22c55e' : '#ef4444' }}>●</span>
              <span style={{ color: '#d1d5db' }}>Google Flow signed in</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: health?.supportsImageGeneration ? '#22c55e' : '#ef4444' }}>●</span>
              <span style={{ color: '#d1d5db' }}>Image generation ready</span>
            </div>
          </div>

          {health?.message && (
            <div style={{ marginTop: '10px', fontSize: '12px', color: health.reachable ? '#38bdf8' : '#f87171' }}>
              {health.message}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => handleCheckHealth()}
              disabled={isChecking}
            >
              {isChecking ? 'Checking...' : 'Test Connection'}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleOpenFlow}
            >
              Open Google Flow ↗
            </button>
          </div>

          {projectDir && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleSaveSettings}
              style={{ borderColor: saveSuccess ? '#22c55e' : undefined, color: saveSuccess ? '#22c55e' : undefined }}
            >
              {saveSuccess ? '✓ Saved' : 'Save Flow Settings'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
