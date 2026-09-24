import React, { useState, useEffect } from 'react'
import type { ProjectState, ProjectSettings, VideoType, AspectRatio, Pacing } from '../../../../shared/types'

interface SettingsPageProps {
  project: ProjectState
  onUpdateSettings: (s: Partial<ProjectSettings>) => Promise<void>
}

function SegControl<T extends string>({
  options, value, onChange, id
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  id: string
}): React.ReactElement {
  return (
    <div className="seg-control" id={id}>
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`seg-option ${value === opt.value ? 'active' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── API Key Row ──────────────────────────────────────────────────────────────

function ApiKeyRow({ label, configKey, placeholder, hint, link, linkLabel }: {
  label: string
  configKey: string
  placeholder: string
  hint: string
  link?: string
  linkLabel?: string
}): React.ReactElement {
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [show, setShow] = useState(false)

  useEffect(() => {
    window.api.config.get(configKey).then((v) => {
      if (v) setValue(v)
      setLoading(false)
    })
  }, [configKey])

  async function handleSave(): Promise<void> {
    await window.api.config.set(configKey, value.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const hasValue = value.trim().length > 0
  const isGemini = configKey === 'geminiApiKey'
  const isGeminiFormat = !isGemini || value.trim().startsWith('AIza')
  const isValid = hasValue && value.trim().length > 10 && isGeminiFormat

  return (
    <div style={{
      padding: '16px',
      background: 'var(--bg-elevated)',
      borderRadius: 'var(--radius-md)',
      border: `1px solid ${hasValue && isValid ? 'var(--border-brand)' : (hasValue && !isValid ? 'rgba(248,113,113,0.4)' : 'var(--border-subtle)')}`,
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      transition: 'border-color 0.2s'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{label}</span>
          {hasValue && isValid && (
            <span style={{
              fontSize: '10px', padding: '2px 8px',
              background: 'rgba(52,211,153,0.15)', color: 'var(--color-success)',
              borderRadius: '999px', fontWeight: 600
            }}>✓ SET</span>
          )}
          {hasValue && !isValid && (
            <span style={{
              fontSize: '10px', padding: '2px 8px',
              background: 'rgba(248,113,113,0.15)', color: 'var(--color-error)',
              borderRadius: '999px', fontWeight: 600
            }}>
              {isGemini && !isGeminiFormat ? '✗ CẦN KEY "AIzaSy..."' : '✗ INVALID FORMAT'}
            </span>
          )}
        </div>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => { e.preventDefault(); window.open(link) }}
            style={{ fontSize: '11px', color: 'var(--text-brand)', textDecoration: 'none' }}
          >
            {linkLabel ?? 'Get API Key ↗'}
          </a>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            id={`input-${configKey}`}
            type={show ? 'text' : 'password'}
            placeholder={loading ? 'Loading...' : placeholder}
            value={value}
            onChange={(e) => { setValue(e.target.value); setSaved(false) }}
            disabled={loading}
            style={{
              width: '100%',
              background: 'var(--bg-base)',
              border: `1px solid ${hasValue && !isValid ? 'rgba(248,113,113,0.5)' : 'var(--border-default)'}`,
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              padding: '9px 36px 9px 12px',
              outline: 'none',
              letterSpacing: show ? 'normal' : '2px'
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
          />
          <button
            onClick={() => setShow(!show)}
            style={{
              position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: '13px', padding: '2px'
            }}
            title={show ? 'Hide' : 'Show'}
          >
            {show ? '🙈' : '👁️'}
          </button>
        </div>
        <button
          className={`btn ${saved ? 'btn-success' : 'btn-primary'}`}
          onClick={handleSave}
          disabled={!hasValue || loading}
          style={{ minWidth: '80px', flexShrink: 0 }}
        >
          {saved ? '✓ Saved' : 'Save'}
        </button>
      </div>

      {hasValue && isGemini && !isGeminiFormat ? (
        <div style={{ fontSize: '11px', color: '#f87171' }}>
          ⚠️ Key Gemini hiện tại không bắt đầu bằng &quot;AIzaSy...&quot;. Hãy lấy API key từ Google AI Studio (aistudio.google.com/apikey).
        </div>
      ) : (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{hint}</div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function SettingsPage({ project, onUpdateSettings }: SettingsPageProps): React.ReactElement {
  const s = project.settings

  // ── Storage directory ───────────────────────────────────────────────────────
  const [storageDir, setStorageDir] = useState('')
  const [storageSaved, setStorageSaved] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [storageSaving, setStorageSaving] = useState(false)

  useEffect(() => {
    window.api.project.getDir().then((dir) => {
      if (dir) setStorageDir(dir)
    }).catch(() => {})
  }, [])

  async function handleSaveStorageDir(): Promise<void> {
    if (!storageDir.trim()) return
    setStorageSaving(true)
    setStorageError(null)
    try {
      const res = await window.api.project.setDir(storageDir.trim())
      if (res.success) {
        setStorageSaved(true)
        setTimeout(() => setStorageSaved(false), 3000)
      } else {
        setStorageError(res.error ?? 'Failed to save')
      }
    } catch (err: unknown) {
      setStorageError(err instanceof Error ? err.message : String(err))
    } finally {
      setStorageSaving(false)
    }
  }

  function update<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void {
    onUpdateSettings({ [key]: value })
  }

  function setResolution(w: number, h: number): void {
    onUpdateSettings({ resolution: { width: w, height: h } })
  }

  return (
    <div className="page-container">

      {/* ── Storage Location ──────────────────────────── */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path fillRule="evenodd" d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1H8a3 3 0 00-3 3v1.5a1.5 1.5 0 01-3 0V6z" clipRule="evenodd" />
                <path d="M6 12a2 2 0 012-2h8a2 2 0 012 2v2a2 2 0 01-2 2H2h2a2 2 0 002-2v-2z" />
              </svg>
            </div>
            Storage Location
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Where all projects are saved
          </span>
        </div>
        <div className="panel-body">
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
              Projects directory — all new projects will be created here
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="settings-input"
                value={storageDir}
                onChange={(e) => setStorageDir(e.target.value)}
                placeholder="D:\Video_factory_hutteries"
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveStorageDir() }}
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
              <button
                className={`btn ${storageSaved ? 'btn-success' : 'btn-primary'}`}
                onClick={handleSaveStorageDir}
                disabled={storageSaving || !storageDir.trim()}
                style={{ minWidth: 80, flexShrink: 0 }}
              >
                {storageSaving ? '…' : storageSaved ? '✓ Saved' : 'Save'}
              </button>
            </div>
            {storageError && (
              <div style={{ fontSize: 11, color: '#f87171', marginTop: 6 }}>⚠ {storageError}</div>
            )}
            {storageSaved && (
              <div style={{ fontSize: 11, color: '#34d399', marginTop: 6 }}>
                ✓ Path saved — new projects will be created in <code style={{ fontFamily: 'var(--font-mono)' }}>{storageDir}</code>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── API Keys ─────────────────────────────────── */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path fillRule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clipRule="evenodd" />
              </svg>
            </div>
            AI API Keys
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Stored locally — never uploaded
          </span>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <ApiKeyRow
            label="Gemini API Key"
            configKey="geminiApiKey"
            placeholder="AIzaSy..."
            hint='Required for Phase 3 Edit Planning. Free tier: 1500 requests/day.'
            link="https://aistudio.google.com/apikey"
            linkLabel="Get free key at aistudio.google.com ↗"
          />
        </div>
      </div>

      {/* ── Stock API Keys ──────────────────────────────── */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm3 2h6v4H7V5zm8 8v2h1v-2h-1zm-2-2H7v4h6v-4zm2 0h1V9h-1v2zm1-4V5h-1v2h1zM5 5v2H4V5h1zm-1 4h1v2H4V9zm1 4H4v2h1v-2z" clipRule="evenodd" />
              </svg>
            </div>
            API Providers — Stock Media
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Stored locally — never uploaded
          </span>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <ApiKeyRow
            label="Pexels API Key"
            configKey="pexelsApiKey"
            placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            hint="Primary stock video provider. Free tier — 200 requests/hour."
            link="https://www.pexels.com/api/"
            linkLabel="Get free key at pexels.com/api ↗"
          />
          <ApiKeyRow
            label="Pixabay API Key"
            configKey="pixabayApiKey"
            placeholder="00000000-xxxxxxxxxxxxxxxxxxxxxxxx"
            hint="Fallback stock provider. Free tier — 100 requests/minute."
            link="https://pixabay.com/api/docs/"
            linkLabel="Get free key at pixabay.com/api/docs ↗"
          />
          <ApiKeyRow
            label="Giphy API Key (optional)"
            configKey="giphyApiKey"
            placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            hint="Optional. Not used as a primary documentary stock provider."
            link="https://developers.giphy.com/"
            linkLabel="Get key at developers.giphy.com ↗"
          />
        </div>
      </div>


      {/* ── Video Type ───────────────────────────────── */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6zM14.553 7.106A1 1 0 0014 8v4a1 1 0 00.553.894l2 1A1 1 0 0018 13V7a1 1 0 00-1.447-.894l-2 1z" />
              </svg>
            </div>
            Video Type
          </div>
        </div>
        <div className="panel-body">
          <div className="settings-grid">
            {VIDEO_TYPES.map((vt) => (
              <button
                key={vt.value}
                onClick={() => update('videoType', vt.value as VideoType)}
                style={{
                  cursor: 'pointer',
                  border: `1px solid ${s.videoType === vt.value ? 'var(--border-brand)' : 'var(--border-subtle)'}`,
                  background: s.videoType === vt.value ? 'var(--brand-gradient-subtle)' : 'var(--bg-elevated)',
                  padding: '14px 16px',
                  textAlign: 'left',
                  transition: 'all 0.15s ease',
                  borderRadius: 'var(--radius-md)'
                }}
              >
                <div style={{ fontSize: '20px', marginBottom: '6px' }}>{vt.icon}</div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: s.videoType === vt.value ? 'var(--text-brand)' : 'var(--text-primary)', marginBottom: '3px' }}>
                  {vt.label}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{vt.desc}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Format & Output ──────────────────────────── */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <div className="panel-title-icon">
              <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--brand-primary)">
                <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h6a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            Format & Output
          </div>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="settings-field">
            <label className="settings-label">Aspect Ratio</label>
            <SegControl<AspectRatio>
              id="setting-aspect-ratio"
              value={s.aspectRatio}
              onChange={(v) => {
                update('aspectRatio', v)
                if (v === '16:9') setResolution(1920, 1080)
                else if (v === '9:16') setResolution(1080, 1920)
                else setResolution(1080, 1080)
              }}
              options={[
                { value: '16:9', label: '16:9  Landscape' },
                { value: '9:16', label: '9:16  Portrait' },
                { value: '1:1', label: '1:1  Square' }
              ]}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Resolution</label>
            <SegControl<string>
              id="setting-resolution"
              value={`${s.resolution.width}x${s.resolution.height}`}
              onChange={(v) => {
                const [w, h] = v.split('x').map(Number)
                setResolution(w, h)
              }}
              options={RESOLUTIONS.filter((r) => {
                if (s.aspectRatio === '16:9') return r.ar === '16:9'
                if (s.aspectRatio === '9:16') return r.ar === '9:16'
                return r.ar === '1:1'
              }).map((r) => ({ value: r.value, label: r.label }))}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Frame Rate</label>
            <SegControl<string>
              id="setting-fps"
              value={String(s.fps)}
              onChange={(v) => update('fps', Number(v) as 24 | 25 | 30 | 60)}
              options={[
                { value: '24', label: '24 fps' },
                { value: '25', label: '25 fps' },
                { value: '30', label: '30 fps' },
                { value: '60', label: '60 fps' }
              ]}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Pacing</label>
            <SegControl<Pacing>
              id="setting-pacing"
              value={s.pacing}
              onChange={(v) => update('pacing', v)}
              options={[
                { value: 'slow', label: 'Slow' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'fast', label: 'Fast' },
                { value: 'cinematic', label: 'Cinematic' }
              ]}
            />
          </div>
        </div>
      </div>

      {/* Config summary */}
      <div className="panel" style={{ background: 'var(--bg-elevated)' }}>
        <div className="panel-body">
          <div className="settings-label" style={{ marginBottom: '10px' }}>Current Configuration</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 2 }}>
            {[
              ['type', s.videoType],
              ['ratio', s.aspectRatio],
              ['res', `${s.resolution.width}×${s.resolution.height}`],
              ['fps', String(s.fps)],
              ['pacing', s.pacing]
            ].map(([k, v]) => (
              <div key={k}>
                <span style={{ color: 'var(--text-muted)', display: 'inline-block', width: '60px' }}>{k}</span>
                <span style={{ color: 'var(--text-brand)' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const VIDEO_TYPES: { value: VideoType; label: string; icon: string; desc: string }[] = [
  { value: 'documentary', label: 'Documentary', icon: '🎞️', desc: 'Observational storytelling' },
  { value: 'history', label: 'History', icon: '📜', desc: 'Historical narration' },
  { value: 'storytelling', label: 'Storytelling', icon: '📖', desc: 'Narrative-driven content' },
  { value: 'educational', label: 'Educational', icon: '🎓', desc: 'Explanatory & educational' },
  { value: 'cinematic-documentary', label: 'Cinematic', icon: '🎬', desc: 'Cinematic documentary style' }
]

const RESOLUTIONS = [
  { value: '1920x1080', label: '1920×1080  FHD', ar: '16:9' },
  { value: '2560x1440', label: '2560×1440  2K', ar: '16:9' },
  { value: '3840x2160', label: '3840×2160  4K', ar: '16:9' },
  { value: '1080x1920', label: '1080×1920  FHD', ar: '9:16' },
  { value: '1080x1080', label: '1080×1080', ar: '1:1' }
]
