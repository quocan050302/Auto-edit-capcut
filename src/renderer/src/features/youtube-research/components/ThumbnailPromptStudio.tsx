/**
 * ThumbnailPromptStudio — AI Thumbnail Prompt Studio
 * Xuất hiện ngay dưới Recommended Blueprint trong Basic và Advanced View.
 * Không tạo ảnh. Chỉ tạo 5 prompt concept để copy vào công cụ tạo ảnh bên ngoài.
 */
import { useState, useRef, useCallback } from 'react'
import type {
  ThumbnailBlueprint,
  ThumbnailIntelligenceResult,
  MarketCode,
  ThumbnailPromptVariant,
  ThumbnailPromptGenerationResponse,
} from '../types/research.types'
import { researchApi } from '../api/researchApi'

// ── Props ──────────────────────────────────────────────────────────────────────

interface ThumbnailPromptStudioProps {
  channelTitle: string
  blueprint: ThumbnailBlueprint
  thumbnailIntelligence: ThumbnailIntelligenceResult
  market?: MarketCode
}

// ── Copy helper ────────────────────────────────────────────────────────────────

function useCopyState() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = useCallback((key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopiedKey(null), 2000)
    })
  }, [])

  return { copiedKey, copy }
}

// ── Overlay preview ────────────────────────────────────────────────────────────

function OverlayPreview({ variant }: { variant: ThumbnailPromptVariant }) {
  const ot = variant.overlay_text
  const isTop = ot.placement.includes('upper') || ot.placement.includes('top')
  const isCenter = ot.placement.includes('center')
  return (
    <div style={{
      aspectRatio: '16/9',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
      borderRadius: 6,
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      alignItems: isTop ? 'flex-start' : isCenter ? 'center' : 'flex-end',
      justifyContent: ot.placement.includes('left') ? 'flex-start' : ot.placement.includes('right') ? 'flex-end' : 'center',
      padding: '8%',
      border: '1px solid rgba(255,255,255,0.1)',
      minWidth: 0,
    }}>
      <div style={{
        fontFamily: 'Impact, "Arial Narrow", sans-serif',
        fontWeight: 900,
        lineHeight: 1.1,
        color: ot.text_color || '#fff',
        textShadow: `2px 2px 0 ${ot.outline_color || '#000'}, -2px -2px 0 ${ot.outline_color || '#000'}, 2px -2px 0 ${ot.outline_color || '#000'}, -2px 2px 0 ${ot.outline_color || '#000'}`,
        fontSize: 'clamp(10px, 2.5vw, 20px)',
        letterSpacing: '0.02em',
        maxWidth: '70%',
      }}>
        <div>{ot.line_1}</div>
        {ot.line_2 && <div>{ot.line_2}</div>}
      </div>
    </div>
  )
}

// ── Variant Card ───────────────────────────────────────────────────────────────

const LABEL_COLORS: Record<string, string> = {
  A: '#7c3aed',
  B: '#0891b2',
  C: '#059669',
  D: '#d97706',
  E: '#e11d48',
}

function VariantCard({
  variant,
  copiedKey,
  onCopy,
}: {
  variant: ThumbnailPromptVariant
  copiedKey: string | null
  onCopy: (key: string, text: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const color = LABEL_COLORS[variant.option_label] || '#6b7280'

  const copyFull = () => onCopy(`full_${variant.id}`, variant.full_image_prompt)
  const copyOverlay = () => onCopy(`overlay_${variant.id}`, variant.overlay_text.combined_text)
  const copyAll = () => {
    const text = [
      `=== OPTION ${variant.option_label}: ${variant.concept_name} ===`,
      `Strategic Angle: ${variant.strategic_angle}`,
      ``,
      `OVERLAY TEXT:`,
      `Line 1: "${variant.overlay_text.line_1}"`,
      variant.overlay_text.line_2 ? `Line 2: "${variant.overlay_text.line_2}"` : '',
      ``,
      `FULL IMAGE PROMPT:`,
      variant.full_image_prompt,
      ``,
      `NEGATIVE PROMPT:`,
      variant.negative_prompt,
    ].filter(Boolean).join('\n')
    onCopy(`all_${variant.id}`, text)
  }

  const isCopiedFull = copiedKey === `full_${variant.id}`
  const isCopiedOverlay = copiedKey === `overlay_${variant.id}`
  const isCopiedAll = copiedKey === `all_${variant.id}`

  return (
    <div style={{
      background: 'var(--bg-elevated, #1a1d23)',
      border: `1px solid ${color}44`,
      borderRadius: 10,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        background: `${color}18`,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        cursor: 'pointer',
        userSelect: 'none',
      }} onClick={() => setExpanded(e => !e)}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: color, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, fontWeight: 900, color: '#fff', flexShrink: 0,
        }}>
          {variant.option_label}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary, #f1f5f9)', marginBottom: 2 }}>
            {variant.concept_name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted, #94a3b8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {variant.strategic_angle}
          </div>
        </div>
        <div style={{ flexShrink: 0, textAlign: 'right' }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: color,
            background: `${color}22`, padding: '2px 8px', borderRadius: 4,
            fontFamily: 'Impact, sans-serif', letterSpacing: '0.05em',
          }}>
            "{variant.overlay_text.combined_text}"
          </div>
        </div>
        <div style={{ color: 'var(--text-muted, #94a3b8)', fontSize: 12 }}>
          {expanded ? '▲' : '▼'}
        </div>
      </div>

      {/* Collapsed info */}
      {!expanded && (
        <div style={{ padding: '10px 16px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, fontSize: 11, color: 'var(--text-muted, #94a3b8)' }}>
            <span style={{ color: '#a5b4fc' }}>Hook:</span> {variant.overlay_text.placement} ·{' '}
            <span style={{ color: '#a5b4fc' }}>Why:</span> {variant.why_it_works.substring(0, 80)}…
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={e => { e.stopPropagation(); copyFull() }}
              style={btnStyle(isCopiedFull)}>
              {isCopiedFull ? '✓ Copied' : 'Copy Prompt'}
            </button>
            <button onClick={e => { e.stopPropagation(); setExpanded(true) }}
              style={btnStyle(false, true)}>
              Expand ↓
            </button>
          </div>
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '0 16px 16px 16px' }}>
          {/* Overlay Preview */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted, #94a3b8)', marginBottom: 6 }}>
              📐 Overlay Text Preview
            </div>
            <OverlayPreview variant={variant} />
          </div>

          <Row label="Title Interpretation" value={variant.title_interpretation} />
          <Row label="Visual Concept" value={variant.visual_concept} />
          <Row label="Subject" value={variant.subject_direction} />
          <Row label="Composition" value={variant.composition_direction} />
          <Row label="Background" value={variant.background_direction} />
          <Row label="Colors" value={variant.color_direction} />
          <Row label="Lighting" value={variant.lighting_direction} />
          <Row label="Mobile Readability" value={variant.mobile_readability_direction} />
          <Row label="Title-Thumbnail Relationship" value={variant.title_thumbnail_relationship} />

          {variant.competitor_traits_used.length > 0 && (
            <TagRow label="✓ Competitor Traits Used" items={variant.competitor_traits_used} color="#4ade80" />
          )}
          {variant.evidence.length > 0 && (
            <TagRow label="📊 Evidence" items={variant.evidence} color="#93c5fd" />
          )}
          {variant.originality_changes.length > 0 && (
            <TagRow label="🔄 Originality Changes" items={variant.originality_changes} color="#fbbf24" />
          )}

          {/* Full image prompt */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#a5b4fc' }}>📝 Full Image Prompt</span>
              <button onClick={copyFull} style={btnStyle(isCopiedFull)}>
                {isCopiedFull ? '✓ Copied' : 'Copy Prompt'}
              </button>
            </div>
            <div style={{
              background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: 10,
              fontSize: 11, color: '#e2e8f0', lineHeight: 1.7, whiteSpace: 'pre-wrap',
              maxHeight: 250, overflowY: 'auto', fontFamily: 'monospace',
            }}>
              {variant.full_image_prompt}
            </div>
          </div>

          {/* Negative prompt */}
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#f87171' }}>🚫 Negative Prompt</span>
            </div>
            <div style={{
              background: 'rgba(239,68,68,0.06)', borderRadius: 6, padding: 8,
              fontSize: 10, color: '#fca5a5', lineHeight: 1.5, fontFamily: 'monospace',
            }}>
              {variant.negative_prompt}
            </div>
          </div>

          {/* Warnings */}
          {variant.warnings.length > 0 && (
            <div style={{ marginTop: 8, padding: '6px 10px', background: 'rgba(251,191,36,0.08)', borderRadius: 6, border: '1px solid rgba(251,191,36,0.2)' }}>
              {variant.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 10, color: '#fbbf24' }}>⚠ {w}</div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button onClick={copyFull} style={btnStyle(isCopiedFull)}>
              {isCopiedFull ? '✓ Copied' : 'Copy Full Prompt'}
            </button>
            <button onClick={copyOverlay} style={btnStyle(isCopiedOverlay, true)}>
              {isCopiedOverlay ? '✓ Copied' : 'Copy Overlay Text'}
            </button>
            <button onClick={copyAll} style={btnStyle(isCopiedAll, true)}>
              {isCopiedAll ? '✓ Copied' : 'Copy Entire Option'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 8, fontSize: 11 }}>
      <span style={{ color: '#a5b4fc', flexShrink: 0, minWidth: 100, fontWeight: 600 }}>{label}:</span>
      <span style={{ color: '#cbd5e1', lineHeight: 1.5 }}>{value}</span>
    </div>
  )
}

function TagRow({ label, items, color }: { label: string; items: string[]; color: string }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color, marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {items.map((it, i) => (
          <span key={i} style={{
            fontSize: 10, background: `${color}18`, color,
            padding: '2px 8px', borderRadius: 20, border: `1px solid ${color}33`,
          }}>{it}</span>
        ))}
      </div>
    </div>
  )
}

function btnStyle(active: boolean, secondary = false): React.CSSProperties {
  return {
    padding: '5px 12px',
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    background: active ? '#4ade80' : secondary ? 'rgba(165,180,252,0.12)' : '#6d28d9',
    color: active ? '#000' : '#e2e8f0',
    transition: 'all 0.15s',
  }
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ThumbnailPromptStudio({
  channelTitle,
  blueprint,
  thumbnailIntelligence,
  market = 'US',
}: ThumbnailPromptStudioProps) {
  const [title, setTitle] = useState('')
  const [context, setContext] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ThumbnailPromptGenerationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { copiedKey, copy } = useCopyState()

  const titleValid = title.trim().length >= 3
  const canGenerate = titleValid && !loading

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return
    setLoading(true)
    setError(null)

    try {
      const resp = await researchApi.generateThumbnailPrompts({
        title: title.trim(),
        video_context: context.trim() || undefined,
        channel_title: channelTitle,
        market,
        blueprint,
        thumbnail_intelligence: thumbnailIntelligence,
      })
      setResult(resp)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [canGenerate, title, context, channelTitle, market, blueprint, thumbnailIntelligence])

  const handleCopyAll = () => {
    if (!result) return
    const all = result.variants.map((v, i) => [
      `=== OPTION ${v.option_label}: ${v.concept_name} ===`,
      `Overlay: "${v.overlay_text.combined_text}"`,
      ``,
      v.full_image_prompt,
      ``,
      `Negative: ${v.negative_prompt}`,
      i < result.variants.length - 1 ? '\n' + '─'.repeat(80) + '\n' : '',
    ].join('\n')).join('\n')
    copy('all_prompts', all)
  }

  return (
    <div style={{
      background: 'var(--bg-elevated, #1a1d23)',
      border: '1px solid rgba(139,92,246,0.3)',
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(109,40,217,0.25), rgba(30,64,175,0.15))',
        borderBottom: '1px solid rgba(139,92,246,0.2)',
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <span style={{ fontSize: 22 }}>✨</span>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: '#c4b5fd' }}>
            AI Thumbnail Prompt Studio
          </h3>
          <p style={{ margin: 0, fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
            Turn your video title into 5 competitor-informed thumbnail concepts.
          </p>
        </div>
      </div>

      <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Title */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#a5b4fc', marginBottom: 5 }}>
              Video Title <span style={{ color: '#f87171' }}>*</span>
            </label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={200}
              placeholder="Example: Why These Communities Never Go Bankrupt"
              style={{
                width: '100%',
                background: 'rgba(0,0,0,0.3)',
                border: `1px solid ${title.trim().length > 0 && title.trim().length < 3 ? '#ef4444' : 'rgba(255,255,255,0.12)'}`,
                borderRadius: 8,
                padding: '9px 12px',
                fontSize: 13,
                color: '#f1f5f9',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
              {title.trim().length > 0 && title.trim().length < 3 && (
                <span style={{ fontSize: 10, color: '#f87171' }}>Minimum 3 characters</span>
              )}
              <span style={{ fontSize: 10, color: '#64748b', marginLeft: 'auto' }}>
                {title.length}/200
              </span>
            </div>
          </div>

          {/* Context */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#94a3b8', marginBottom: 5 }}>
              Video Context / Script Summary{' '}
              <span style={{ fontWeight: 400, color: '#64748b' }}>(optional)</span>
            </label>
            <textarea
              value={context}
              onChange={e => setContext(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Describe the video content to help AI avoid misinterpreting the title…"
              style={{
                width: '100%',
                background: 'rgba(0,0,0,0.2)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                padding: '9px 12px',
                fontSize: 12,
                color: '#cbd5e1',
                outline: 'none',
                resize: 'vertical',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
              }}
            />
            <div style={{ textAlign: 'right', fontSize: 10, color: '#64748b', marginTop: 2 }}>
              {context.length}/2000
            </div>
          </div>

          {/* Blueprint source (readonly) */}
          <div style={{
            background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 12px',
            border: '1px solid rgba(255,255,255,0.07)',
            display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
          }}>
            <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>📐 Blueprint:</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#c4b5fd' }}>{blueprint.name}</span>
            <span style={{
              fontSize: 10, padding: '1px 7px', borderRadius: 10,
              background: blueprint.is_statistically_validated ? 'rgba(74,222,128,0.15)' : 'rgba(251,191,36,0.15)',
              color: blueprint.is_statistically_validated ? '#4ade80' : '#fbbf24',
              border: `1px solid ${blueprint.is_statistically_validated ? 'rgba(74,222,128,0.3)' : 'rgba(251,191,36,0.3)'}`,
            }}>
              {blueprint.is_statistically_validated ? '✓ Validated' : '⚠ Not Validated'}
            </span>
            <span style={{ fontSize: 10, color: '#64748b' }}>
              {blueprint.blueprint_mode?.replace(/_/g, ' ')} · hook: {blueprint.target_hook}
            </span>
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            style={{
              padding: '11px 20px',
              fontSize: 13,
              fontWeight: 700,
              borderRadius: 8,
              border: 'none',
              cursor: canGenerate ? 'pointer' : 'not-allowed',
              background: canGenerate
                ? 'linear-gradient(135deg, #7c3aed, #4f46e5)'
                : 'rgba(100,116,139,0.3)',
              color: canGenerate ? '#fff' : '#64748b',
              transition: 'all 0.2s',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {loading ? (
              <>
                <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                Analyzing title against competitor thumbnail patterns…
              </>
            ) : (
              '✨ Generate 5 Thumbnail Prompts'
            )}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: '10px 14px',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#f87171', marginBottom: 4 }}>Generation Failed</div>
            <div style={{ fontSize: 11, color: '#fca5a5' }}>{error}</div>
            <button onClick={handleGenerate} style={{ ...btnStyle(false), marginTop: 8 }}>
              Retry
            </button>
          </div>
        )}

        {/* Results */}
        {result && (
          <div>
            {/* Analysis summary */}
            <div style={{
              background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
              borderRadius: 8, padding: '10px 14px', marginBottom: 14,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#a5b4fc', marginBottom: 6 }}>
                🧠 Title Analysis Summary
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: 11 }}>
                <InfoRow label="Subject" value={result.analysis_summary.title_subject} />
                <InfoRow label="Promise" value={result.analysis_summary.title_promise} />
                <InfoRow label="Viewer Tension" value={result.analysis_summary.viewer_tension} />
                <InfoRow label="Recommended Hook" value={result.analysis_summary.recommended_hook} />
              </div>
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 6 }}>
                {result.analysis_summary.overlay_style_summary}
              </div>
              {result.fallback_used && (
                <div style={{ marginTop: 6, fontSize: 10, color: '#fbbf24' }}>
                  ⚠ Fallback used: {result.fallback_reason}
                </div>
              )}
              <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>
                Provider: {result.provider} · Model: {result.model} · {result.used_ai ? 'AI-generated' : 'Deterministic'}
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <button onClick={handleCopyAll} style={btnStyle(copiedKey === 'all_prompts')}>
                {copiedKey === 'all_prompts' ? '✓ Copied All' : 'Copy All 5 Prompts'}
              </button>
              <button onClick={handleGenerate} style={btnStyle(false, true)}>
                🔄 Regenerate 5 Variants
              </button>
            </div>

            {/* 5 Variant cards */}
            <div style={{ fontSize: 13, fontWeight: 700, color: '#c4b5fd', marginBottom: 10 }}>
              5 Thumbnail Prompt Variants
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {result.variants.map(v => (
                <VariantCard
                  key={v.id}
                  variant={v}
                  copiedKey={copiedKey}
                  onCopy={copy}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        input:focus, textarea:focus { border-color: rgba(139,92,246,0.6) !important; }
      `}</style>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <span style={{ color: '#a5b4fc', fontWeight: 600, flexShrink: 0 }}>{label}:</span>
      <span style={{ color: '#cbd5e1' }}>{value}</span>
    </div>
  )
}
