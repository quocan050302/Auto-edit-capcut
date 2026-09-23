import React from 'react'
import type { ProjectState, ProjectSettings, VideoType, AspectRatio, Pacing } from '../../../../shared/types'

interface SettingsPageProps {
  project: ProjectState
  onUpdateSettings: (s: Partial<ProjectSettings>) => Promise<void>
}

function SegControl<T extends string>({
  options,
  value,
  onChange,
  id
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

export function SettingsPage({ project, onUpdateSettings }: SettingsPageProps): React.ReactElement {
  const s = project.settings

  function update<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void {
    onUpdateSettings({ [key]: value })
  }

  function setResolution(w: number, h: number): void {
    onUpdateSettings({ resolution: { width: w, height: h } })
  }

  return (
    <div className="page-container">
      {/* Video Type */}
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
                className={`panel ${s.videoType === vt.value ? 'active' : ''}`}
                onClick={() => update('videoType', vt.value as VideoType)}
                style={{
                  cursor: 'pointer',
                  border: `1px solid ${s.videoType === vt.value ? 'var(--border-brand)' : 'var(--border-subtle)'}`,
                  background:
                    s.videoType === vt.value
                      ? 'var(--brand-gradient-subtle)'
                      : 'var(--bg-elevated)',
                  padding: '14px 16px',
                  textAlign: 'left',
                  transition: 'all 0.15s ease',
                  borderRadius: 'var(--radius-md)'
                }}
              >
                <div
                  style={{
                    fontSize: '20px',
                    marginBottom: '6px'
                  }}
                >
                  {vt.icon}
                </div>
                <div
                  style={{
                    fontSize: '13px',
                    fontWeight: 700,
                    color: s.videoType === vt.value ? 'var(--text-brand)' : 'var(--text-primary)',
                    marginBottom: '3px'
                  }}
                >
                  {vt.label}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{vt.desc}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Format Settings */}
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
          {/* Aspect Ratio */}
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

          {/* Resolution */}
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

          {/* FPS */}
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

          {/* Pacing */}
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

      {/* Current config summary */}
      <div className="panel" style={{ background: 'var(--bg-elevated)' }}>
        <div className="panel-body">
          <div className="settings-label" style={{ marginBottom: '10px' }}>Current Configuration</div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              color: 'var(--text-secondary)',
              lineHeight: 2
            }}
          >
            <div>
              <span style={{ color: 'var(--text-muted)' }}>type</span>{'    '}
              <span style={{ color: 'var(--text-brand)' }}>{s.videoType}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>ratio</span>{'   '}
              <span style={{ color: 'var(--text-brand)' }}>{s.aspectRatio}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>res</span>{'     '}
              <span style={{ color: 'var(--text-brand)' }}>
                {s.resolution.width}×{s.resolution.height}
              </span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>fps</span>{'     '}
              <span style={{ color: 'var(--text-brand)' }}>{s.fps}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>pacing</span>{'  '}
              <span style={{ color: 'var(--text-brand)' }}>{s.pacing}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const VIDEO_TYPES: {
  value: VideoType
  label: string
  icon: string
  desc: string
}[] = [
  { value: 'documentary', label: 'Documentary', icon: '🎞️', desc: 'Observational storytelling' },
  { value: 'history', label: 'History', icon: '📜', desc: 'Historical narration' },
  { value: 'storytelling', label: 'Storytelling', icon: '📖', desc: 'Narrative-driven content' },
  { value: 'educational', label: 'Educational', icon: '🎓', desc: 'Explanatory & educational' },
  {
    value: 'cinematic-documentary',
    label: 'Cinematic',
    icon: '🎬',
    desc: 'Cinematic documentary style'
  }
]

const RESOLUTIONS = [
  { value: '1920x1080', label: '1920×1080  FHD', ar: '16:9' },
  { value: '2560x1440', label: '2560×1440  2K', ar: '16:9' },
  { value: '3840x2160', label: '3840×2160  4K', ar: '16:9' },
  { value: '1080x1920', label: '1080×1920  FHD', ar: '9:16' },
  { value: '1080x1080', label: '1080×1080', ar: '1:1' }
]
