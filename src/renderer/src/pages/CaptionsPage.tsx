/**
 * CaptionsPage.tsx (UPGRADED)
 *
 * Trang quản lý Dynamic Kinetic Captions Engine.
 *
 * FIX so với version cũ:
 * 1. totalDuration từ sourceDuration thật, không từ max(activeRanges)
 * 2. "Tạo lại Plan" thực sự regenerate (forceRegenerate: true)
 * 3. Button labels rõ ràng hơn
 * 4. Timeline có ruler tick marks
 * 5. Summary có Coverage metrics + Hook Coverage
 * 6. Fallback status badge rõ hơn (source, model)
 * 7. Tooltip trên RangePill có đủ thông tin
 * 8. Animation controls cho từng phrase (animationPreset, intensity, keyword)
 * 9. Không crash nếu activeRanges rỗng
 * 10. Generation badge (Gemini/Fallback)
 */

import React, { useState, useEffect, useCallback } from 'react'
import type { CaptionPlan, CaptionPhrase, CaptionActiveRange, CaptionEmphasis } from '../../../../shared/types'

// ─── Color map theo EmphasisType ─────────────────────────────────────────────

const EMPHASIS_COLORS: Record<CaptionEmphasis, { bg: string; text: string; label: string }> = {
  hook:            { bg: '#7c3aed', text: '#f3e8ff', label: '🪝 Hook' },
  list_transition: { bg: '#0369a1', text: '#e0f2fe', label: '📋 List' },
  shock_stat:      { bg: '#b91c1c', text: '#fee2e2', label: '⚡ Shock' },
  punchline:       { bg: '#d97706', text: '#fef3c7', label: '💥 Punch' },
  normal:          { bg: '#374151', text: '#f9fafb', label: '💬 Normal' }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function pct(n: number, total: number): string {
  if (total <= 0) return '0%'
  return ((n / total) * 100).toFixed(1) + '%'
}

// ─── Component: RangePill ────────────────────────────────────────────────────

interface RangePillProps {
  range: CaptionActiveRange
  totalDuration: number
  isSelected: boolean
  onClick: () => void
}

function RangePill({ range, totalDuration, isSelected, onClick }: RangePillProps): React.ReactElement {
  const colors = EMPHASIS_COLORS[range.reason]
  const leftPct = (range.startTime / totalDuration) * 100
  const widthPct = Math.max(0.5, ((range.endTime - range.startTime) / totalDuration) * 100)
  const dur = (range.endTime - range.startTime).toFixed(1)

  return (
    <div
      onClick={onClick}
      title={`${colors.label}\n${fmtTime(range.startTime)} → ${fmtTime(range.endTime)}\nDuration: ${dur}s`}
      style={{
        position: 'absolute',
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        top: 0,
        bottom: 0,
        backgroundColor: colors.bg,
        border: isSelected ? '2px solid #fff' : '1px solid rgba(255,255,255,0.2)',
        borderRadius: 4,
        cursor: 'pointer',
        transition: 'opacity 0.2s',
        opacity: isSelected ? 1 : 0.75,
        zIndex: isSelected ? 10 : 5,
        minWidth: 4,
        boxSizing: 'border-box'
      }}
    />
  )
}

// ─── Component: Timeline Ruler ────────────────────────────────────────────────

function TimelineRuler({ totalDuration }: { totalDuration: number }): React.ReactElement {
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <div style={{ position: 'relative', height: 16, marginBottom: 2 }}>
      {ticks.map(t => (
        <div key={t} style={{
          position: 'absolute',
          left: `${t * 100}%`,
          transform: 'translateX(-50%)',
          fontSize: 10,
          color: '#64748b',
          whiteSpace: 'nowrap'
        }}>
          {fmtTime(t * totalDuration)}
        </div>
      ))}
    </div>
  )
}

// ─── Component: AnimationControls ─────────────────────────────────────────────

interface AnimationControlsProps {
  phrase: CaptionPhrase
  onUpdate: (phraseId: string, updates: Partial<CaptionPhrase>) => void
}

const ANIMATION_PRESETS = [
  { value: undefined, label: 'Auto' },
  { value: 'smooth_kinetic', label: 'Smooth' },
  { value: 'punch', label: 'Punch' },
  { value: 'swipe_reveal', label: 'Swipe' },
  { value: 'blur_focus', label: 'Blur' },
  { value: 'impact_keyword', label: 'Impact' },
  { value: 'type_pop', label: 'Pop' },
] as const

const INTENSITIES = [
  { value: undefined, label: 'Auto' },
  { value: 'subtle', label: 'Subtle' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'Strong' },
] as const

const KEYWORD_EFFECTS = [
  { value: undefined, label: 'Auto' },
  { value: 'none', label: 'None' },
  { value: 'spring', label: 'Spring' },
  { value: 'impact', label: 'Impact' },
  { value: 'highlight', label: 'Highlight' },
] as const

function AnimationControls({ phrase, onUpdate }: AnimationControlsProps): React.ReactElement {
  const [open, setOpen] = useState(false)

  function chipStyle(active: boolean): React.CSSProperties {
    return {
      padding: '2px 7px',
      borderRadius: 8,
      fontSize: 10,
      border: '1px solid',
      borderColor: active ? '#7c3aed' : 'rgba(255,255,255,0.15)',
      background: active ? 'rgba(124,58,237,0.25)' : 'transparent',
      color: active ? '#c4b5fd' : '#94a3b8',
      cursor: 'pointer',
    }
  }

  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          fontSize: 10,
          padding: '2px 8px',
          borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.15)',
          background: 'transparent',
          color: '#94a3b8',
          cursor: 'pointer',
        }}
      >
        🎞 Animation {open ? '▲' : '▼'}
        {phrase.animationPreset && <span style={{ color: '#c4b5fd', marginLeft: 4 }}>● {phrase.animationPreset}</span>}
      </button>

      {open && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Preset row */}
          <div>
            <div style={{ fontSize: 9, color: '#64748b', marginBottom: 3 }}>PRESET</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {ANIMATION_PRESETS.map(p => (
                <button
                  key={String(p.value)}
                  style={chipStyle(phrase.animationPreset === p.value)}
                  onClick={() => onUpdate(phrase.id, { animationPreset: p.value as CaptionPhrase['animationPreset'] })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Intensity row */}
          <div>
            <div style={{ fontSize: 9, color: '#64748b', marginBottom: 3 }}>INTENSITY</div>
            <div style={{ display: 'flex', gap: 3 }}>
              {INTENSITIES.map(p => (
                <button
                  key={String(p.value)}
                  style={chipStyle(phrase.animationIntensity === p.value)}
                  onClick={() => onUpdate(phrase.id, { animationIntensity: p.value as CaptionPhrase['animationIntensity'] })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Keyword effect row */}
          <div>
            <div style={{ fontSize: 9, color: '#64748b', marginBottom: 3 }}>KEYWORD</div>
            <div style={{ display: 'flex', gap: 3 }}>
              {KEYWORD_EFFECTS.map(p => (
                <button
                  key={String(p.value)}
                  style={chipStyle(phrase.keywordAnimation === p.value)}
                  onClick={() => onUpdate(phrase.id, { keywordAnimation: p.value as CaptionPhrase['keywordAnimation'] })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Component: PhraseCard ────────────────────────────────────────────────────

interface PhraseCardProps {
  phrase: CaptionPhrase
  projectDir: string
  onUpdate: (phraseId: string, updates: Partial<CaptionPhrase>) => void
}

function PhraseCard({ phrase, projectDir: _projectDir, onUpdate }: PhraseCardProps): React.ReactElement {
  const colors = EMPHASIS_COLORS[phrase.emphasisType]
  const [editText, setEditText] = useState(phrase.text)
  const [editing, setEditing] = useState(false)

  function handleSave(): void {
    if (editText.trim() !== phrase.text) {
      onUpdate(phrase.id, { text: editText.trim() })
    }
    setEditing(false)
  }

  return (
    <div style={{
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 8,
      padding: '10px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      transition: 'background 0.2s'
    }}>
      {/* Header: timing + emphasis badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>
          {phrase.startTime.toFixed(2)}s – {phrase.endTime.toFixed(2)}s
        </span>
        <span style={{
          fontSize: 10,
          padding: '2px 7px',
          borderRadius: 10,
          backgroundColor: colors.bg,
          color: colors.text,
          fontWeight: 600
        }}>
          {colors.label}
        </span>
      </div>

      {/* Text phrase — có thể edit */}
      {editing ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false) }}
            style={{
              flex: 1,
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.3)',
              borderRadius: 4,
              color: '#fff',
              padding: '4px 8px',
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: 1,
              outline: 'none'
            }}
            autoFocus
          />
          <button onClick={handleSave} style={{ ...btnStyle, background: '#16a34a', padding: '4px 10px' }}>✓</button>
          <button onClick={() => setEditing(false)} style={{ ...btnStyle, background: '#6b7280', padding: '4px 10px' }}>✗</button>
        </div>
      ) : (
        <div
          onClick={() => setEditing(true)}
          style={{
            fontSize: 16,
            fontWeight: 800,
            letterSpacing: 1,
            color: '#fff',
            cursor: 'text',
            padding: '2px 4px',
            borderRadius: 3,
            border: '1px solid transparent',
            transition: 'border-color 0.2s'
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = 'transparent')}
          title="Click để chỉnh sửa"
        >
          {phrase.text.toUpperCase()}
        </div>
      )}

      {/* Style toggles */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <ToggleBadge
          label="📦 Box"
          active={phrase.style.boxHighlight}
          onChange={v => onUpdate(phrase.id, { style: { ...phrase.style, boxHighlight: v } })}
        />
        <ToggleBadge
          label="↗ Skew"
          active={phrase.style.skew}
          onChange={v => onUpdate(phrase.id, { style: { ...phrase.style, skew: v } })}
        />
        <ToggleBadge
          label="🔠 Serif"
          active={phrase.style.fontPreset === 'serif_italic'}
          onChange={v => onUpdate(phrase.id, { style: { ...phrase.style, fontPreset: v ? 'serif_italic' : 'sans_bold_caps' } })}
        />
      </div>

      {/* Highlight words */}
      {(phrase.highlightWords ?? []).length > 0 && (
        <div style={{ fontSize: 11, color: '#fbbf24' }}>
          ★ Highlight: {phrase.highlightWords!.join(', ')}
        </div>
      )}

      {/* Animation controls */}
      <AnimationControls phrase={phrase} onUpdate={onUpdate} />
    </div>
  )
}

// ─── ToggleBadge ─────────────────────────────────────────────────────────────

function ToggleBadge({ label, active, onChange }: {
  label: string
  active: boolean
  onChange: (v: boolean) => void
}): React.ReactElement {
  return (
    <button
      onClick={() => onChange(!active)}
      style={{
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 10,
        border: '1px solid',
        borderColor: active ? '#7c3aed' : 'rgba(255,255,255,0.2)',
        background: active ? 'rgba(124,58,237,0.3)' : 'transparent',
        color: active ? '#c4b5fd' : '#9ca3af',
        cursor: 'pointer',
        transition: 'all 0.2s'
      }}
    >
      {label}
    </button>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: 6,
  border: 'none',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
  background: '#4b5563',
  transition: 'opacity 0.2s'
}

// ─── Main Page ────────────────────────────────────────────────────────────────

interface CaptionsPageProps {
  projectDir: string
}

export function CaptionsPage({ projectDir }: CaptionsPageProps): React.ReactElement {
  const [plan, setPlan] = useState<CaptionPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [progress, setProgress] = useState<{ message: string; pct: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedRangeIdx, setSelectedRangeIdx] = useState<number | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)

  // ── Duration: dùng sourceDuration từ plan nếu có, fallback an toàn ─────────
  const totalDuration = plan
    ? (plan.sourceDuration ??
       (plan.activeRanges.length > 0
         ? Math.max(...plan.activeRanges.map(r => r.endTime), 60)
         : 120))
    : 120

  // Load plan lúc mount (KHÔNG regenerate — chỉ load nếu file tồn tại)
  useEffect(() => {
    let unsubProgress: (() => void) | null = null

    async function load(): Promise<void> {
      if (!projectDir) return
      try {
        const res = await window.api.captions.getPlan(projectDir)
        if (res.success && res.plan) setPlan(res.plan)
      } catch { /* chưa có plan */ }
    }

    unsubProgress = window.api.captions.onProgress(data => {
      setProgress({ message: data.message, pct: data.progress })
    })

    load()
    return () => { unsubProgress?.() }
  }, [projectDir])

  // "Tạo lại Plan" → THỰC SỰ regenerate (forceRegenerate: true)
  const handleRegenerate = useCallback(async () => {
    setLoading(true)
    setError(null)
    setProgress(null)
    try {
      const res = await window.api.captions.generatePlan({ projectDir, forceRegenerate: true })
      if (res.success && res.plan) {
        setPlan(res.plan)
        setSelectedRangeIdx(null)
        setPreviewPath(null)
      } else {
        setError(res.error ?? 'Không thể tạo caption plan')
        // Giữ plan cũ — không set null
      }
    } catch (e) {
      setError('Regenerate thất bại — vẫn giữ plan trước đó: ' + String(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }, [projectDir])

  // "Tạo mới lần đầu" → load cache nếu có (forceRegenerate: false)
  const handleGenerateFirst = useCallback(async () => {
    setLoading(true)
    setError(null)
    setProgress(null)
    try {
      const res = await window.api.captions.generatePlan({ projectDir, forceRegenerate: false })
      if (res.success && res.plan) {
        setPlan(res.plan)
      } else {
        setError(res.error ?? 'Không thể tạo caption plan')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }, [projectDir])

  // Update phrase
  const handleUpdatePhrase = useCallback(async (phraseId: string, updates: Partial<CaptionPhrase>) => {
    const res = await window.api.captions.updatePhrase({ projectDir, phraseId, updates })
    if (res.success && res.plan) setPlan(res.plan)
  }, [projectDir])

  // Toggle caption enabled
  const handleToggleEnabled = useCallback(async (enabled: boolean) => {
    const res = await window.api.captions.toggleRange({ projectDir, rangeIndex: -1, enabled: true, captionEnabled: enabled })
    if (res.success && res.plan) setPlan(res.plan)
    else if (plan) setPlan({ ...plan, enabled })
  }, [projectDir, plan])

  // Regenerate ASS
  const handleRegenerateAss = useCallback(async () => {
    setLoading(true)
    const res = await window.api.captions.regenerateAss({ projectDir })
    setLoading(false)
    if (!res.success) setError(res.error ?? 'Lỗi tạo file .ass')
  }, [projectDir])

  // Preview render
  const handlePreview = useCallback(async (range: CaptionActiveRange) => {
    setPreviewLoading(true)
    setError(null)
    const res = await window.api.captions.previewRender({
      projectDir,
      startTime: range.startTime,
      endTime: Math.min(range.endTime, range.startTime + 12)
    })
    setPreviewLoading(false)
    if (res.success && res.previewPath) {
      setPreviewPath(res.previewPath)
    } else {
      setError(res.error ?? 'Preview thất bại')
    }
  }, [projectDir])

  // Phrases của range đang chọn
  const selectedRange = selectedRangeIdx !== null ? plan?.activeRanges[selectedRangeIdx] : null
  const phrasesInRange = selectedRange && plan
    ? plan.phrases.filter(p =>
        p.startTime >= selectedRange.startTime && p.endTime <= selectedRange.endTime + 1
      )
    : []

  // ── Coverage metrics ──────────────────────────────────────────────────────
  const captionTimeSecs = plan?.activeRanges.reduce((a, r) => a + r.endTime - r.startTime, 0) ?? 0
  const hookWindowSecs = plan?.hookWindowSeconds ?? 30
  const hookRange = plan?.activeRanges.find(r => r.reason === 'hook')
  const hookCoveredSecs = hookRange ? (hookRange.endTime - hookRange.startTime) : 0
  const hookTargetSecs = Math.min(hookWindowSecs, totalDuration)

  // ── Generation badge ──────────────────────────────────────────────────────
  const isGemini = plan?.generationSource === 'gemini' || (!plan?.generatedByFallback && plan?.generationSource === undefined && plan?.generatedAt)
  const genLabel = plan?.generationSource === 'gemini'
    ? `🤖 Gemini${plan.generationModel ? ` (${plan.generationModel.replace('gemini-', '')})` : ''}`
    : plan?.generatedByFallback || plan?.generationSource === 'fallback'
    ? '⚙ Fallback'
    : null

  // ── Emphasis breakdown ────────────────────────────────────────────────────
  const emphasisCount = plan ? Object.fromEntries(
    (['hook', 'list_transition', 'shock_stat', 'punchline', 'normal'] as CaptionEmphasis[]).map(k => [
      k,
      plan.phrases.filter(p => p.emphasisType === k).length
    ])
  ) : {}

  return (
    <div style={{
      height: '100%',
      overflowY: 'auto',
      padding: '24px 28px',
      color: '#f1f5f9',
      fontFamily: 'Inter, system-ui, sans-serif',
      background: 'linear-gradient(160deg, #0a0a1a 0%, #0f1629 100%)'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.5, color: '#f8fafc' }}>
            🎬 Dynamic Kinetic Captions
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#94a3b8' }}>
            Chữ nhảy theo nhịp giọng đọc — tự động sinh từ transcript
          </p>
        </div>

        {/* Toggle tổng */}
        {plan && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, color: plan.enabled ? '#86efac' : '#9ca3af' }}>
              {plan.enabled ? '✅ Đang bật' : '⬜ Đang tắt'}
            </span>
            <button
              onClick={() => handleToggleEnabled(!plan.enabled)}
              style={{
                ...btnStyle,
                background: plan.enabled ? '#16a34a' : '#374151',
                padding: '8px 16px'
              }}
            >
              {plan.enabled ? 'Tắt Captions' : 'Bật Captions'}
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '10px 14px',
          borderRadius: 8,
          background: 'rgba(185,28,28,0.2)',
          border: '1px solid rgba(239,68,68,0.4)',
          color: '#fca5a5',
          fontSize: 13,
          marginBottom: 16
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* Progress bar */}
      {progress && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
            <span>{progress.message}</span>
            <span>{Math.round(progress.pct * 100)}%</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${progress.pct * 100}%`,
              background: 'linear-gradient(90deg, #7c3aed, #2563eb)',
              transition: 'width 0.3s',
              borderRadius: 2
            }} />
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
        {!plan ? (
          /* Lần đầu — load cache hoặc generate */
          <button
            onClick={handleGenerateFirst}
            disabled={loading}
            style={{ ...btnStyle, background: loading ? '#374151' : '#7c3aed', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? '⏳ Đang xử lý...' : '✨ Tạo Caption Plan'}
          </button>
        ) : (
          <>
            {/* "Tạo lại Plan" → THỰC SỰ regenerate */}
            <button
              onClick={handleRegenerate}
              disabled={loading}
              title="Chạy lại planner — bỏ qua cache. Dùng Gemini nếu có API key, fallback nếu không."
              style={{ ...btnStyle, background: loading ? '#374151' : '#7c3aed', opacity: loading ? 0.6 : 1 }}
            >
              {loading ? '⏳ Đang xử lý...' : '🔄 Tạo lại Plan'}
            </button>
            <button
              onClick={handleRegenerateAss}
              disabled={loading}
              style={{ ...btnStyle, background: '#065f46', opacity: loading ? 0.6 : 1 }}
            >
              📄 Tạo lại file .ass
            </button>
          </>
        )}
      </div>

      {/* Caption Plan Summary */}
      {plan && (
        <div style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          padding: '14px 18px',
          marginBottom: 20,
        }}>
          {/* Row 1: metrics */}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12 }}>
            <Stat label="Phrases" value={plan.phrases.length} />
            <Stat label="Active Ranges" value={plan.activeRanges.length} />
            <Stat label="Caption Time" value={`${captionTimeSecs.toFixed(0)}s`} />
            <Stat
              label="Coverage"
              value={`${pct(captionTimeSecs, totalDuration)}`}
              sub={`${captionTimeSecs.toFixed(0)}s / ${totalDuration.toFixed(0)}s`}
            />
            <Stat
              label="Hook Coverage"
              value={`${pct(hookCoveredSecs, hookTargetSecs)}`}
              sub={`${hookCoveredSecs.toFixed(0)}s / ${hookTargetSecs.toFixed(0)}s`}
              highlight={hookCoveredSecs >= hookTargetSecs - 0.5}
            />
          </div>

          {/* Row 2: generation badge + emphasis breakdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* Generation badge */}
            {genLabel && (
              <div style={{
                fontSize: 11,
                padding: '3px 10px',
                borderRadius: 6,
                background: isGemini ? 'rgba(37,99,235,0.15)' : 'rgba(251,191,36,0.12)',
                border: `1px solid ${isGemini ? 'rgba(96,165,250,0.3)' : 'rgba(251,191,36,0.3)'}`,
                color: isGemini ? '#93c5fd' : '#fbbf24',
              }}>
                {genLabel}
              </div>
            )}
            {/* Fallback reason if any */}
            {plan.generationReason && plan.generationSource === 'fallback' && (
              <div style={{ fontSize: 11, color: '#9ca3af' }}>
                {plan.generationReason.includes('No API') ? 'No API key' :
                 plan.generationReason.includes('Quota') ? 'Quota exhausted' :
                 plan.generationReason.includes('unavailable') ? 'Model unavailable' :
                 'Local algorithm'}
              </div>
            )}
            {/* Emphasis breakdown */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(emphasisCount).filter(([, c]) => (c as number) > 0).map(([key, count]) => {
                const c = EMPHASIS_COLORS[key as CaptionEmphasis]
                return (
                  <span key={key} style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 8,
                    background: `${c.bg}33`, color: c.text,
                    border: `1px solid ${c.bg}55`
                  }}>
                    {c.label.split(' ')[1]} {count as number}
                  </span>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      {plan && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          {(Object.entries(EMPHASIS_COLORS) as Array<[CaptionEmphasis, typeof EMPHASIS_COLORS[CaptionEmphasis]]>).map(([key, c]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
              <div style={{ width: 12, height: 12, borderRadius: 2, background: c.bg }} />
              <span style={{ color: '#94a3b8' }}>{c.label}</span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
            <div style={{ width: 12, height: 12, borderRadius: 2, background: '#1e293b', border: '1px solid #334155' }} />
            <span style={{ color: '#94a3b8' }}>Tắt</span>
          </div>
        </div>
      )}

      {/* Timeline ruler */}
      {plan && totalDuration > 0 && (
        <TimelineRuler totalDuration={totalDuration} />
      )}

      {/* Timeline */}
      {plan && (
        <div
          style={{
            position: 'relative',
            height: 40,
            borderRadius: 8,
            background: '#1e293b',
            border: '1px solid rgba(255,255,255,0.07)',
            marginBottom: 24,
            overflow: 'hidden',
            cursor: 'pointer'
          }}
        >
          {plan.activeRanges.map((range, idx) => (
            <RangePill
              key={idx}
              range={range}
              totalDuration={totalDuration}
              isSelected={selectedRangeIdx === idx}
              onClick={() => setSelectedRangeIdx(selectedRangeIdx === idx ? null : idx)}
            />
          ))}
          {plan.activeRanges.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#475569' }}>
              Không có active ranges
            </div>
          )}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 1, background: 'rgba(255,255,255,0.05)' }} />
        </div>
      )}

      {/* Selected Range Detail */}
      {selectedRange && plan && (
        <div style={{
          background: 'rgba(255,255,255,0.03)',
          border: `1px solid ${EMPHASIS_COLORS[selectedRange.reason].bg}44`,
          borderRadius: 10,
          padding: 18,
          marginBottom: 24
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                padding: '4px 10px',
                borderRadius: 10,
                background: EMPHASIS_COLORS[selectedRange.reason].bg,
                color: EMPHASIS_COLORS[selectedRange.reason].text,
                fontSize: 12,
                fontWeight: 700
              }}>
                {EMPHASIS_COLORS[selectedRange.reason].label}
              </span>
              <span style={{ fontSize: 13, color: '#94a3b8' }}>
                {fmtTime(selectedRange.startTime)} – {fmtTime(selectedRange.endTime)}
                &nbsp;•&nbsp;{(selectedRange.endTime - selectedRange.startTime).toFixed(1)}s
                &nbsp;•&nbsp;{phrasesInRange.length} phrases
              </span>
            </div>
            <button
              onClick={() => handlePreview(selectedRange)}
              disabled={previewLoading || loading}
              style={{
                ...btnStyle,
                background: previewLoading ? '#374151' : '#b45309',
                padding: '6px 14px',
                fontSize: 12,
                opacity: (previewLoading || loading) ? 0.6 : 1
              }}
            >
              {previewLoading ? '⏳ Đang render...' : '👁 Xem trước đoạn này'}
            </button>
          </div>

          {/* Danh sách phrases */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {phrasesInRange.length === 0 && (
              <div style={{ color: '#6b7280', fontSize: 13 }}>Không có phrases trong range này</div>
            )}
            {phrasesInRange.map(phrase => (
              <PhraseCard
                key={phrase.id}
                phrase={phrase}
                projectDir={projectDir}
                onUpdate={handleUpdatePhrase}
              />
            ))}
          </div>
        </div>
      )}

      {/* Preview video result */}
      {previewPath && (
        <div style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10,
          padding: 18,
          marginBottom: 24
        }}>
          <div style={{ fontSize: 13, color: '#86efac', marginBottom: 10 }}>
            ✅ Preview đã render: <code style={{ fontSize: 11 }}>{previewPath}</code>
          </div>
          <video
            src={`file://${previewPath}`}
            controls
            style={{ width: '100%', maxHeight: 240, borderRadius: 6, background: '#000' }}
          />
          <button
            onClick={() => setPreviewPath(null)}
            style={{ ...btnStyle, background: '#374151', fontSize: 12, marginTop: 10 }}
          >
            ✕ Đóng
          </button>
        </div>
      )}

      {/* Empty state */}
      {!plan && !loading && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: '60px 0',
          color: '#64748b'
        }}>
          <div style={{ fontSize: 48 }}>🎬</div>
          <div style={{ fontSize: 15, textAlign: 'center' }}>
            Chưa có Caption Plan cho project này.<br />
            Bấm <strong>Tạo Caption Plan</strong> để phân tích script với AI.
          </div>
          <div style={{ fontSize: 12, color: '#475569', textAlign: 'center', maxWidth: 400 }}>
            Cần có <strong>transcript.json</strong> và <strong>master-edit-plan.json</strong> trước.
            Nếu Gemini không khả dụng, hệ thống sẽ tự động dùng thuật toán fallback.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, highlight }: {
  label: string
  value: string | number
  sub?: string
  highlight?: boolean
}): React.ReactElement {
  return (
    <div style={{ textAlign: 'center', minWidth: 60 }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: highlight ? '#86efac' : '#f8fafc' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{sub}</div>}
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{label}</div>
    </div>
  )
}

export default CaptionsPage
