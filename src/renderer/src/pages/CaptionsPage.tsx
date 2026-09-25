/**
 * CaptionsPage.tsx
 *
 * Trang quản lý Dynamic Kinetic Captions Engine:
 *  - Toggle bật/tắt toàn bộ captions
 *  - Timeline ngang hiển thị activeRanges theo màu
 *  - Click vào range → xem & sửa phrases bên trong
 *  - Preview render nhanh 5-10s
 *  - Nút "Tạo lại Caption Plan" (Gemini + fallback)
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

// ─── Component: ActiveRange pill trên timeline ───────────────────────────────

interface RangePillProps {
  range: CaptionActiveRange
  totalDuration: number
  isSelected: boolean
  onClick: () => void
}

function RangePill({ range, totalDuration, isSelected, onClick }: RangePillProps): React.ReactElement {
  const colors = EMPHASIS_COLORS[range.reason]
  const leftPct = (range.startTime / totalDuration) * 100
  const widthPct = Math.max(1, ((range.endTime - range.startTime) / totalDuration) * 100)

  return (
    <div
      onClick={onClick}
      title={`${colors.label}: ${range.startTime.toFixed(1)}s – ${range.endTime.toFixed(1)}s`}
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
  const [progress, setProgress] = useState<{ message: string; pct: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedRangeIdx, setSelectedRangeIdx] = useState<number | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)

  // Tổng duration ước tính từ range cuối cùng
  const totalDuration = plan
    ? Math.max(...plan.activeRanges.map(r => r.endTime), 60)
    : 120

  // Load plan lúc mount
  useEffect(() => {
    let unsubProgress: (() => void) | null = null

    async function load(): Promise<void> {
      if (!projectDir) return
      try {
        const res = await window.api.captions.getPlan(projectDir)
        if (res.success && res.plan) setPlan(res.plan)
      } catch { /* chưa có plan */ }
    }

    // Subscribe progress
    unsubProgress = window.api.captions.onProgress(data => {
      setProgress({ message: data.message, pct: data.progress })
    })

    load()

    return () => { unsubProgress?.() }
  }, [projectDir])

  // Generate plan
  const handleGenerate = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    setProgress(null)
    try {
      const res = await window.api.captions.generatePlan({ projectDir, forceRegenerate: force })
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
    else if (plan) setPlan({ ...plan, enabled })  // optimistic update
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
    setLoading(true)
    setError(null)
    const res = await window.api.captions.previewRender({
      projectDir,
      startTime: range.startTime,
      endTime: Math.min(range.endTime, range.startTime + 12)
    })
    setLoading(false)
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
        <button
          onClick={() => handleGenerate(false)}
          disabled={loading}
          style={{ ...btnStyle, background: loading ? '#374151' : '#7c3aed', opacity: loading ? 0.6 : 1 }}
        >
          {loading ? '⏳ Đang xử lý...' : plan ? '🔄 Tạo lại Plan' : '✨ Tạo Caption Plan'}
        </button>
        {plan && (
          <>
            <button
              onClick={() => handleGenerate(true)}
              disabled={loading}
              style={{ ...btnStyle, background: '#0369a1', opacity: loading ? 0.6 : 1 }}
            >
              🔄 Force Regenerate (Gemini)
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
          display: 'flex',
          gap: 24,
          flexWrap: 'wrap'
        }}>
          <Stat label="Phrases" value={plan.phrases.length} />
          <Stat label="Active Ranges" value={plan.activeRanges.length} />
          <Stat label="Tổng thời gian BẬT" value={`${plan.activeRanges.reduce((a, r) => a + r.endTime - r.startTime, 0).toFixed(0)}s`} />
          {plan.generatedByFallback && (
            <div style={{ fontSize: 11, color: '#fbbf24', padding: '2px 8px', background: 'rgba(251,191,36,0.1)', borderRadius: 4, alignSelf: 'center' }}>
              ⚠️ Fallback — chưa qua Gemini
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      {plan && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
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
          {/* Thước thời gian */}
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
                {selectedRange.startTime.toFixed(1)}s – {selectedRange.endTime.toFixed(1)}s
                &nbsp;•&nbsp;{phrasesInRange.length} phrases
              </span>
            </div>
            <button
              onClick={() => handlePreview(selectedRange)}
              disabled={loading}
              style={{ ...btnStyle, background: '#b45309', padding: '6px 14px', fontSize: 12, opacity: loading ? 0.6 : 1 }}
            >
              👁 Xem trước đoạn này
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
          padding: 18
        }}>
          <div style={{ fontSize: 13, color: '#86efac', marginBottom: 10 }}>
            ✅ Preview đã render: <code style={{ fontSize: 11 }}>{previewPath}</code>
          </div>
          <button
            onClick={() => setPreviewPath(null)}
            style={{ ...btnStyle, background: '#374151', fontSize: 12 }}
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

function Stat({ label, value }: { label: string; value: string | number }): React.ReactElement {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: '#f8fafc' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{label}</div>
    </div>
  )
}

export default CaptionsPage
