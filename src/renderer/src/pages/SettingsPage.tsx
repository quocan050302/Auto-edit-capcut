import React, { useState, useEffect, useRef } from 'react'
import type { ProjectState, ProjectSettings, VideoType, AspectRatio, Pacing, ApiKeyStatus } from '../../../../shared/types'
import { normalizeApiKey } from '../../../../shared/api-key'
import { ResearchSettingsModal } from '../features/youtube-research/components/ResearchSettingsModal'
import { GoogleFlowSettingsSection } from '../components/thumbnail/GoogleFlowSettingsSection'

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

const API_KEY_STATUS_CONFIG: Record<ApiKeyStatus, {
  label: string
  bg: string
  color: string
  border: string
  containerBorder: string
  defaultMsg?: string
}> = {
  EMPTY: {
    label: 'EMPTY',
    bg: 'rgba(148, 163, 184, 0.1)',
    color: 'var(--text-muted)',
    border: '1px solid rgba(148, 163, 184, 0.2)',
    containerBorder: 'var(--border-subtle)'
  },
  UNSAVED: {
    label: '● UNSAVED',
    bg: 'rgba(234, 179, 8, 0.15)',
    color: '#eab308',
    border: '1px solid rgba(234, 179, 8, 0.3)',
    containerBorder: 'rgba(234, 179, 8, 0.4)',
    defaultMsg: 'Có thay đổi chưa lưu. Hãy nhấn "Save" để lưu và kiểm tra key.'
  },
  SAVING: {
    label: 'SAVING...',
    bg: 'rgba(96, 165, 250, 0.15)',
    color: '#60a5fa',
    border: '1px solid rgba(96, 165, 250, 0.3)',
    containerBorder: 'var(--border-brand)',
    defaultMsg: 'Đang lưu API key vào cấu hình...'
  },
  SAVED_NOT_VERIFIED: {
    label: 'SAVED (NOT VERIFIED)',
    bg: 'rgba(96, 165, 250, 0.15)',
    color: '#60a5fa',
    border: '1px solid rgba(96, 165, 250, 0.3)',
    containerBorder: 'var(--border-brand)'
  },
  VERIFYING: {
    label: '⟳ VERIFYING...',
    bg: 'rgba(168, 85, 247, 0.15)',
    color: '#c084fc',
    border: '1px solid rgba(168, 85, 247, 0.3)',
    containerBorder: 'var(--border-brand)',
    defaultMsg: 'Đang gửi yêu cầu kiểm tra tới provider...'
  },
  VERIFIED: {
    label: '✓ VERIFIED',
    bg: 'rgba(52, 211, 153, 0.15)',
    color: '#34d399',
    border: '1px solid rgba(52, 211, 153, 0.3)',
    containerBorder: 'rgba(52, 211, 153, 0.5)',
    defaultMsg: 'API key hợp lệ và đã sẵn sàng sử dụng.'
  },
  INVALID_KEY: {
    label: '✗ INVALID KEY',
    bg: 'rgba(248, 113, 113, 0.15)',
    color: '#f87171',
    border: '1px solid rgba(248, 113, 113, 0.3)',
    containerBorder: 'rgba(248, 113, 113, 0.5)',
    defaultMsg: 'Provider phản hồi: API key không hợp lệ hoặc đã bị thu hồi.'
  },
  QUOTA_EXCEEDED: {
    label: '⚠️ QUOTA EXCEEDED',
    bg: 'rgba(251, 146, 60, 0.15)',
    color: '#fb923c',
    border: '1px solid rgba(251, 146, 60, 0.3)',
    containerBorder: 'rgba(251, 146, 60, 0.5)',
    defaultMsg: 'Key hợp lệ nhưng đã vượt quá quota (Rate limit / Resource exhausted).'
  },
  PERMISSION_DENIED: {
    label: '⛔ PERMISSION DENIED',
    bg: 'rgba(248, 113, 113, 0.15)',
    color: '#f87171',
    border: '1px solid rgba(248, 113, 113, 0.3)',
    containerBorder: 'rgba(248, 113, 113, 0.5)',
    defaultMsg: 'Tài khoản không có quyền truy cập API này (Permission denied).'
  },
  MODEL_UNAVAILABLE: {
    label: '⚠ MODEL UNAVAILABLE',
    bg: 'rgba(192, 132, 252, 0.15)',
    color: '#c084fc',
    border: '1px solid rgba(192, 132, 252, 0.3)',
    containerBorder: 'rgba(192, 132, 252, 0.5)',
    defaultMsg: 'Model Gemini chỉ định hiện không khả dụng với tài khoản này.'
  },
  NETWORK_ERROR: {
    label: '⚡ NETWORK ERROR',
    bg: 'rgba(250, 204, 21, 0.15)',
    color: '#facc15',
    border: '1px solid rgba(250, 204, 21, 0.3)',
    containerBorder: 'rgba(250, 204, 21, 0.5)',
    defaultMsg: 'Không thể kết nối tới máy chủ Google (Lỗi mạng hoặc mất kết nối).'
  },
  SERVICE_UNAVAILABLE: {
    label: '☁️ SERVICE UNAVAILABLE',
    bg: 'rgba(251, 146, 60, 0.15)',
    color: '#fb923c',
    border: '1px solid rgba(251, 146, 60, 0.3)',
    containerBorder: 'rgba(251, 146, 60, 0.5)',
    defaultMsg: 'Máy chủ Google AI đang tạm thời quá tải (503 Service Unavailable).'
  }
}

function ApiKeyRow({ label, configKey, placeholder, hint, link, linkLabel }: {
  label: string
  configKey: string
  placeholder: string
  hint: string
  link?: string
  linkLabel?: string
}): React.ReactElement {
  const [value, setValue] = useState('')
  const [savedValue, setSavedValue] = useState('')
  const [status, setStatus] = useState<ApiKeyStatus>('EMPTY')
  const [statusMsg, setStatusMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [show, setShow] = useState(false)

  const isGemini = configKey === 'geminiApiKey'
  const lastVerifiedStatusRef = useRef<ApiKeyStatus | null>(null)
  const lastVerifiedMsgRef = useRef<string>('')

  const runVerification = async (keyToVerify: string): Promise<void> => {
    const clean = normalizeApiKey(keyToVerify)
    if (!clean) {
      setStatus('EMPTY')
      setStatusMsg('')
      return
    }

    // Safety check: verify if the method exists on window.api.config
    if (!window.api?.config || typeof window.api.config.verifyKey !== 'function') {
      console.warn('[Settings] window.api.config.verifyKey is not available in running Electron instance.')
      setStatus('SAVED_NOT_VERIFIED')
      setStatusMsg('Đã lưu API key vào cấu hình. Hãy khởi động lại dev server (npm run dev) để nạp tính năng kiểm tra trực tiếp.')
      return
    }

    setStatus('VERIFYING')
    setStatusMsg('Đang gửi yêu cầu xác thực tới Google AI API...')
    try {
      const res = await window.api.config.verifyKey({ key: clean, configKey })
      if (res && res.status) {
        setStatus(res.status)
        setStatusMsg(res.message ?? '')
        lastVerifiedStatusRef.current = res.status
        lastVerifiedMsgRef.current = res.message ?? ''
      } else {
        setStatus('SAVED_NOT_VERIFIED')
        setStatusMsg('Đã lưu API key.')
      }
    } catch (err: unknown) {
      console.error('[VerifyKey Error]', err)
      const errStr = String(err)
      if (errStr.includes('No handler registered') || errStr.includes('is not a function')) {
        setStatus('SAVED_NOT_VERIFIED')
        setStatusMsg('Đã lưu API key vào cấu hình. Hãy khởi động lại dev server (npm run dev) để nạp handler kiểm tra.')
      } else {
        setStatus('NETWORK_ERROR')
        setStatusMsg('Không thể kết nối tới dịch vụ xác thực.')
      }
    }
  }

  useEffect(() => {
    window.api.config.get(configKey).then((saved) => {
      const clean = normalizeApiKey(saved ?? '')
      setValue(clean)
      setSavedValue(clean)
      setLoading(false)

      if (!clean) {
        setStatus('EMPTY')
        setStatusMsg('')
      } else if (isGemini) {
        setStatus('SAVED_NOT_VERIFIED')
        runVerification(clean)
      } else {
        setStatus('SAVED_NOT_VERIFIED')
        setStatusMsg('')
      }
    })
  }, [configKey])

  async function handleSave(): Promise<void> {
    const clean = normalizeApiKey(value)
    if (!clean) {
      setStatus('SAVING')
      await window.api.config.set(configKey, '')
      setValue('')
      setSavedValue('')
      setStatus('EMPTY')
      setStatusMsg('Đã xóa API key.')
      lastVerifiedStatusRef.current = null
      lastVerifiedMsgRef.current = ''
      return
    }

    setStatus('SAVING')
    setStatusMsg('Đang lưu API key...')
    await window.api.config.set(configKey, clean)
    setSavedValue(clean)
    setValue(clean)

    if (isGemini) {
      setStatus('SAVED_NOT_VERIFIED')
      await runVerification(clean)
    } else {
      setStatus('SAVED_NOT_VERIFIED')
      setStatusMsg('Đã lưu thành công.')
      setTimeout(() => {
        setStatusMsg('')
      }, 3000)
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const raw = e.target.value
    setValue(raw)
    const clean = normalizeApiKey(raw)

    if (!clean) {
      setStatus('EMPTY')
      setStatusMsg('')
    } else if (clean !== savedValue) {
      setStatus('UNSAVED')
      setStatusMsg('Thay đổi chưa được lưu. Hãy bấm Save để lưu và xác thực key.')
    } else {
      // Reverted to current savedValue
      setStatus(lastVerifiedStatusRef.current || 'SAVED_NOT_VERIFIED')
      setStatusMsg(lastVerifiedMsgRef.current || '')
    }
  }

  const conf = API_KEY_STATUS_CONFIG[status]
  const badgeLabel = !isGemini && status === 'SAVED_NOT_VERIFIED' ? '✓ SET' : conf.label
  const badgeColor = !isGemini && status === 'SAVED_NOT_VERIFIED' ? 'var(--color-success)' : conf.color
  const badgeBg = !isGemini && status === 'SAVED_NOT_VERIFIED' ? 'rgba(52,211,153,0.15)' : conf.bg
  const badgeBorder = !isGemini && status === 'SAVED_NOT_VERIFIED' ? '1px solid rgba(52,211,153,0.3)' : conf.border
  const displayMsg = statusMsg || conf.defaultMsg

  return (
    <div style={{
      padding: '16px',
      background: 'var(--bg-elevated)',
      borderRadius: 'var(--radius-md)',
      border: `1px solid ${conf.containerBorder}`,
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      transition: 'border-color 0.2s'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{label}</span>
          <span style={{
            fontSize: '10px',
            padding: '2px 8px',
            background: badgeBg,
            color: badgeColor,
            border: badgeBorder,
            borderRadius: '999px',
            fontWeight: 600
          }}>
            {badgeLabel}
          </span>
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
            onChange={handleChange}
            disabled={loading || status === 'SAVING'}
            style={{
              width: '100%',
              background: 'var(--bg-base)',
              border: `1px solid ${conf.containerBorder}`,
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

        {isGemini && (
          <button
            className="btn btn-secondary"
            onClick={() => runVerification(normalizeApiKey(value || savedValue))}
            disabled={loading || status === 'SAVING' || status === 'VERIFYING' || !normalizeApiKey(value || savedValue)}
            title="Kiểm tra trực tiếp với Google AI API"
            style={{ minWidth: '70px', flexShrink: 0 }}
          >
            {status === 'VERIFYING' ? '⟳ Checking...' : 'Verify'}
          </button>
        )}

        <button
          className={`btn ${status === 'VERIFIED' ? 'btn-success' : 'btn-primary'}`}
          onClick={handleSave}
          disabled={loading || status === 'SAVING' || status === 'VERIFYING' || (status === 'EMPTY' && !savedValue)}
          style={{ minWidth: '70px', flexShrink: 0 }}
        >
          {status === 'SAVING' ? 'Saving...' : (status === 'UNSAVED' ? 'Save' : (status === 'VERIFIED' ? '✓ Saved' : 'Save'))}
        </button>
      </div>

      {displayMsg && status !== 'EMPTY' && (
        <div style={{
          fontSize: '11px',
          color: badgeColor,
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}>
          <span>{displayMsg}</span>
        </div>
      )}

      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{hint}</div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function SettingsPage({ project, onUpdateSettings }: SettingsPageProps): React.ReactElement {
  const s = project.settings
  const [researchSettingsOpen, setResearchSettingsOpen] = useState(false)

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
            placeholder="Paste your Gemini API key here..."
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

      {/* YouTube Foreign Market Research Settings */}
      <div className="panel" style={{ border: '1px solid rgba(239, 68, 68, 0.2)', background: 'rgba(239, 68, 68, 0.03)' }}>
        <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="panel-title" style={{ fontSize: '15px', fontWeight: 600 }}>YouTube Foreign Market Researcher</span>
              <span style={{ fontSize: '10px', background: 'rgba(239, 68, 68, 0.2)', color: '#f87171', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>NEW MODULE</span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Configure YouTube Data API v3, Scraper priority, target foreign markets, scoring weights, and local AI (Ollama).
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setResearchSettingsOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
              <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
            </svg>
            <span>Research Settings</span>
          </button>
        </div>
      </div>

      {researchSettingsOpen && (
        <ResearchSettingsModal
          onClose={() => setResearchSettingsOpen(false)}
          onSettingsUpdated={() => setResearchSettingsOpen(false)}
        />
      )}

      {/* Google Flow Connector Settings */}
      <GoogleFlowSettingsSection projectDir={project.projectDir} />

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
