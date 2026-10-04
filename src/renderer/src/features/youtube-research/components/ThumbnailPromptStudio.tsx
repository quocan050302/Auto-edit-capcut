/**
 * ThumbnailPromptStudio — AI Thumbnail Prompt Studio (Hook Intelligence v2)
 *
 * Xuất hiện dưới Recommended Blueprint.
 * KHÔNG tạo ảnh. Chỉ tạo 5 hook-intelligent prompt concepts.
 * Hiển thị Hook Quality Score — KHÔNG hiển thị "Predicted CTR" hoặc "Guaranteed".
 */
import { useState, useRef, useCallback } from 'react'
import type {
  ThumbnailBlueprint,
  ThumbnailIntelligenceResult,
  MarketCode,
  ThumbnailPromptVariant,
  ThumbnailPromptGenerationResponse,
  ThumbnailHookQuality,
} from '../types/research.types'
import { researchApi } from '../api/researchApi'

// ── Props ──────────────────────────────────────────────────────────────────────

interface ThumbnailPromptStudioProps {
  channelTitle: string
  blueprint: ThumbnailBlueprint
  thumbnailIntelligence: ThumbnailIntelligenceResult
  market?: MarketCode
  onOpenSettings?: () => void
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function scoreColor(score: number): string {
  if (score >= 80) return '#4ade80'
  if (score >= 70) return '#fbbf24'
  return '#f87171'
}

function scoreBadge(score: number): string {
  if (score >= 80) return 'Strong Hook'
  if (score >= 70) return 'Usable'
  return 'Needs Improvement'
}

const HOOK_FAMILY_LABELS: Record<string, string> = {
  visual_contradiction: 'Visual Contradiction',
  hidden_mechanism: 'Hidden Mechanism',
  proof_object_anomaly: 'Proof Object Anomaly',
  expectation_vs_reality: 'Expectation vs Reality',
  moment_before_discovery: 'Moment Before Discovery',
  personal_consequence: 'Personal Consequence',
  scale_difference: 'Scale Difference',
  missing_information: 'Missing Information',
  social_reaction: 'Social Reaction',
  forbidden_or_overlooked_detail: 'Overlooked Detail',
}

const LABEL_COLORS: Record<string, string> = {
  A: '#7c3aed', B: '#0891b2', C: '#059669', D: '#d97706', E: '#e11d48',
}

// ── Score breakdown display ───────────────────────────────────────────────────

function HookScoreBreakdown({ hq }: { hq: ThumbnailHookQuality }) {
  const rows = [
    { label: 'Curiosity Gap', val: hq.curiosity_gap, max: 20 },
    { label: '1-Second Clarity', val: hq.one_second_clarity, max: 15 },
    { label: 'Title Complementarity', val: hq.title_complementarity, max: 15 },
    { label: 'Visual Tension', val: hq.visual_tension, max: 15 },
    { label: 'Specificity & Proof', val: hq.specificity_and_proof, max: 10 },
    { label: 'Mobile Readability', val: hq.mobile_readability, max: 10 },
    { label: 'Promise Integrity', val: hq.promise_integrity, max: 10 },
    { label: 'Competitor Fit', val: hq.competitor_fit, max: 5 },
  ]
  return (
    <div style={{ fontSize: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {rows.map(r => (
        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: '#94a3b8', minWidth: 130, flexShrink: 0 }}>{r.label}</span>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.06)', borderRadius: 4, height: 5, overflow: 'hidden' }}>
            <div style={{
              width: `${(r.val / r.max) * 100}%`,
              height: '100%',
              background: r.val >= r.max * 0.8 ? '#4ade80' : r.val >= r.max * 0.6 ? '#fbbf24' : '#f87171',
              borderRadius: 4,
            }} />
          </div>
          <span style={{ color: '#e2e8f0', minWidth: 32, textAlign: 'right' }}>{r.val}/{r.max}</span>
        </div>
      ))}
      {hq.penalties < 0 && (
        <div style={{ color: '#f87171', marginTop: 2 }}>Penalties: {hq.penalties}</div>
      )}
      {hq.rejection_reasons.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {hq.rejection_reasons.map((r, i) => (
            <div key={i} style={{ color: '#fbbf24', fontSize: 9 }}>⚠ {r}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Overlay text preview ───────────────────────────────────────────────────────

function OverlayPreview({ variant }: { variant: ThumbnailPromptVariant }) {
  const ot = variant.overlay_text
  const isTop = ot.placement?.includes('upper') || ot.placement?.includes('top')
  const isCenterH = ot.placement?.includes('center')
  return (
    <div style={{
      aspectRatio: '16/9',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%)',
      borderRadius: 6,
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      alignItems: isTop ? 'flex-start' : 'flex-end',
      justifyContent: isCenterH ? 'center' : ot.placement?.includes('right') ? 'flex-end' : 'flex-start',
      padding: '7%',
      border: '1px solid rgba(255,255,255,0.08)',
    }}>
      <div style={{
        fontFamily: 'Impact, "Arial Narrow", Arial Black, sans-serif',
        fontWeight: 900,
        lineHeight: 1.0,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}>
        <div style={{
          fontSize: 'clamp(10px, 2.8vw, 22px)',
          color: ot.line_1_color || '#FFE600',
          textShadow: `2px 2px 0 ${ot.outline_color || '#050505'}, -2px -2px 0 ${ot.outline_color}, 2px -2px 0 ${ot.outline_color}, -2px 2px 0 ${ot.outline_color}`,
          letterSpacing: '0.02em',
        }}>
          {ot.line_1}
        </div>
        {ot.line_2 && (
          <div style={{
            fontSize: 'clamp(9px, 2.5vw, 19px)',
            color: ot.line_2_color || '#FFFFFF',
            textShadow: `2px 2px 0 ${ot.outline_color || '#050505'}, -2px -2px 0 ${ot.outline_color}, 2px -2px 0 ${ot.outline_color}, -2px 2px 0 ${ot.outline_color}`,
            letterSpacing: '0.02em',
          }}>
            {ot.line_2}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Row helpers ────────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 7, fontSize: 11 }}>
      <span style={{ color: '#a5b4fc', flexShrink: 0, minWidth: 110, fontWeight: 600 }}>{label}:</span>
      <span style={{ color: '#cbd5e1', lineHeight: 1.5 }}>{value}</span>
    </div>
  )
}

function TagRow({ label, items, color }: { label: string; items: string[]; color: string }) {
  if (!items.length) return null
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

function btnStyle(active: boolean, secondary = false, danger = false): React.CSSProperties {
  return {
    padding: '5px 12px', fontSize: 11, fontWeight: 600, borderRadius: 6,
    border: 'none', cursor: 'pointer',
    background: active ? '#4ade80' : danger ? 'rgba(239,68,68,0.15)' : secondary ? 'rgba(165,180,252,0.12)' : '#6d28d9',
    color: active ? '#000' : danger ? '#f87171' : '#e2e8f0',
    transition: 'all 0.15s',
  }
}

// ── Variant Card ───────────────────────────────────────────────────────────────

function VariantCard({
  variant, copiedKey, onCopy,
}: {
  variant: ThumbnailPromptVariant
  copiedKey: string | null
  onCopy: (key: string, text: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const color = LABEL_COLORS[variant.option_label] || '#6b7280'
  const hq = variant.hook_quality ?? { total_score: 0, promise_integrity: 0, one_second_clarity: 0, curiosity_gap: 0, title_complementarity: 0, visual_tension: 0, specificity_and_proof: 0, mobile_readability: 0, competitor_fit: 0, penalties: 0, rejection_reasons: [] }
  const score = hq.total_score ?? 0
  const sColor = scoreColor(score)
  const sBadge = scoreBadge(score)
  const isAB = variant.recommended_for_ab_test ?? false
  const rank = variant.recommended_test_rank ?? 5

  const copyFull = () => onCopy(`full_${variant.id}`, variant.full_image_prompt)
  const copyOverlay = () => onCopy(`overlay_${variant.id}`, variant.overlay_text.combined_text)
  const copyAll = () => {
    const text = [
      `=== OPTION ${variant.option_label}: ${variant.concept_name} ===`,
      `Hook Family: ${HOOK_FAMILY_LABELS[variant.hook_family] || variant.hook_family}`,
      `Visual Question: ${variant.visual_question}`,
      `Test Hypothesis: ${variant.test_hypothesis}`,
      `Hook Quality Score: ${score}/100 (${sBadge})`,
      ``,
      `OVERLAY TEXT:`,
      `Line 1 (Yellow): "${variant.overlay_text.line_1}"`,
      variant.overlay_text.line_2 ? `Line 2 (White): "${variant.overlay_text.line_2}"` : '',
      ``,
      `FULL IMAGE PROMPT:`,
      variant.full_image_prompt,
      ``,
      `NEGATIVE PROMPT:`,
      variant.negative_prompt,
    ].filter(v => v !== undefined && v !== null).join('\n')
    onCopy(`all_${variant.id}`, text)
  }

  const isCopiedFull = copiedKey === `full_${variant.id}`
  const isCopiedOverlay = copiedKey === `overlay_${variant.id}`
  const isCopiedAll = copiedKey === `all_${variant.id}`

  return (
    <div style={{
      background: 'rgba(15,18,26,0.8)',
      border: `1px solid ${isAB ? color + '66' : color + '33'}`,
      borderRadius: 10,
      overflow: 'hidden',
      boxShadow: isAB ? `0 0 0 1px ${color}22` : 'none',
    }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          background: `${color}14`,
          padding: '11px 14px',
          display: 'flex', alignItems: 'center', gap: 10,
          cursor: 'pointer', userSelect: 'none',
          borderBottom: expanded ? `1px solid ${color}22` : 'none',
        }}
      >
        {/* Label badge */}
        <div style={{
          width: 30, height: 30, borderRadius: 7, background: color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 900, color: '#fff', flexShrink: 0,
        }}>
          {variant.option_label}
        </div>

        {/* Rank & A/B badge */}
        <div style={{ flexShrink: 0 }}>
          {isAB ? (
            <span style={{
              fontSize: 9, fontWeight: 700, background: `${color}33`, color,
              padding: '2px 6px', borderRadius: 4, border: `1px solid ${color}44`,
            }}>
              🏆 Rank #{rank} · A/B Test
            </span>
          ) : (
            <span style={{
              fontSize: 9, color: '#64748b', background: 'rgba(100,116,139,0.1)',
              padding: '2px 6px', borderRadius: 4,
            }}>
              Rank #{rank} · Alternative
            </span>
          )}
        </div>

        {/* Hook family */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary, #f1f5f9)', marginBottom: 1 }}>
            {variant.concept_name}
          </div>
          <div style={{ fontSize: 10, color: '#94a3b8' }}>
            {HOOK_FAMILY_LABELS[variant.hook_family] || variant.hook_family}
          </div>
        </div>

        {/* Score */}
        <div style={{ flexShrink: 0, textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: sColor }}>{score}</div>
          <div style={{ fontSize: 9, color: sColor }}>{sBadge}</div>
          <div style={{ fontSize: 9, color: '#475569' }}>Hook Quality</div>
        </div>

        {/* Overlay preview text */}
        <div style={{ flexShrink: 0, maxWidth: 130, textAlign: 'right' }}>
          <div style={{
            fontSize: 11, fontWeight: 900,
            fontFamily: 'Impact, sans-serif',
            color: variant.overlay_text.line_1_color || '#FFE600',
            textShadow: `1px 1px 0 #050505, -1px -1px 0 #050505`,
            lineHeight: 1.1,
          }}>
            {variant.overlay_text.line_1}
          </div>
          {variant.overlay_text.line_2 && (
            <div style={{
              fontSize: 10, fontWeight: 900, fontFamily: 'Impact, sans-serif',
              color: variant.overlay_text.line_2_color || '#fff',
              textShadow: `1px 1px 0 #050505, -1px -1px 0 #050505`,
            }}>
              {variant.overlay_text.line_2}
            </div>
          )}
        </div>

        <div style={{ color: '#64748b', fontSize: 10 }}>{expanded ? '▲' : '▼'}</div>
      </div>

      {/* Collapsed quick view */}
      {!expanded && (
        <div style={{ padding: '8px 14px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, fontSize: 11, color: '#64748b' }}>
            <span style={{ color: '#93c5fd' }}>❓</span>{' '}
            <span style={{ color: '#cbd5e1' }}>{variant.visual_question}</span>
          </div>
          <div style={{ display: 'flex', gap: 5 }}>
            <button onClick={e => { e.stopPropagation(); copyFull() }} style={btnStyle(isCopiedFull)}>
              {isCopiedFull ? '✓ Copied' : 'Copy Prompt'}
            </button>
            <button onClick={e => { e.stopPropagation(); setExpanded(true) }} style={btnStyle(false, true)}>
              Expand ↓
            </button>
          </div>
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '14px 16px' }}>
          {/* Overlay preview */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 5 }}>📐 Overlay Text Preview (16:9)</div>
            <OverlayPreview variant={variant} />
          </div>

          {/* Hook fields */}
          <div style={{
            background: 'rgba(139,92,246,0.06)', borderRadius: 8,
            padding: '10px 12px', marginBottom: 14,
            border: '1px solid rgba(139,92,246,0.15)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#a5b4fc', marginBottom: 6 }}>
              🎯 Hook Intelligence
            </div>
            <DetailRow label="Visual Question" value={variant.visual_question} />
            <DetailRow label="Hidden Info" value={variant.hidden_information} />
            <DetailRow label="Test Hypothesis" value={variant.test_hypothesis} />
            <DetailRow label="Title Complement" value={variant.title_thumbnail_relationship} />
            <DetailRow label="Title Interpretation" value={variant.title_interpretation} />
          </div>

          {/* Visual directions */}
          <div style={{
            background: 'rgba(8,145,178,0.06)', borderRadius: 8,
            padding: '10px 12px', marginBottom: 14,
            border: '1px solid rgba(8,145,178,0.15)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#67e8f9', marginBottom: 6 }}>
              🎬 Visual Directions
            </div>
            <DetailRow label="Subject" value={variant.subject_direction} />
            <DetailRow label="Composition" value={variant.composition_direction} />
            <DetailRow label="Background" value={variant.background_direction} />
            <DetailRow label="Colors" value={variant.color_direction} />
            <DetailRow label="Lighting" value={variant.lighting_direction} />
            <DetailRow label="Mobile" value={variant.mobile_readability_direction} />
            <DetailRow label="Strategic Angle" value={variant.strategic_angle} />
            <DetailRow label="Why It Works" value={variant.why_it_works} />
          </div>

          {/* Hook quality breakdown */}
          <div style={{
            background: 'rgba(0,0,0,0.3)', borderRadius: 8,
            padding: '10px 12px', marginBottom: 14,
            border: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: sColor }}>
                📊 Hook Quality Score: {score}/100 — {sBadge}
              </span>
            </div>
            <HookScoreBreakdown hq={hq} />
          </div>

          <TagRow label="✓ Competitor Traits Used" items={variant.competitor_traits_used} color="#4ade80" />
          <TagRow label="📊 Evidence" items={variant.evidence} color="#93c5fd" />
          <TagRow label="🔄 Originality Changes" items={variant.originality_changes} color="#fbbf24" />

          {/* Full image prompt */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#a5b4fc' }}>📝 Full Image Prompt</span>
              <button onClick={copyFull} style={btnStyle(isCopiedFull)}>
                {isCopiedFull ? '✓ Copied' : 'Copy Prompt'}
              </button>
            </div>
            <div style={{
              background: 'rgba(0,0,0,0.4)', borderRadius: 6, padding: 10,
              fontSize: 11, color: '#e2e8f0', lineHeight: 1.7,
              whiteSpace: 'pre-wrap', maxHeight: 280, overflowY: 'auto',
              fontFamily: 'monospace',
            }}>
              {variant.full_image_prompt}
            </div>
          </div>

          {/* Negative prompt */}
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#f87171', marginBottom: 4 }}>🚫 Negative Prompt</div>
            <div style={{
              background: 'rgba(239,68,68,0.06)', borderRadius: 6, padding: 8,
              fontSize: 10, color: '#fca5a5', lineHeight: 1.5, fontFamily: 'monospace',
            }}>
              {variant.negative_prompt}
            </div>
          </div>

          {/* Warnings */}
          {variant.warnings.length > 0 && (
            <div style={{ marginTop: 8, padding: '6px 10px', background: 'rgba(251,191,36,0.07)', borderRadius: 6, border: '1px solid rgba(251,191,36,0.2)' }}>
              {variant.warnings.map((w, i) => <div key={i} style={{ fontSize: 10, color: '#fbbf24' }}>⚠ {w}</div>)}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
            <button onClick={copyFull} style={btnStyle(isCopiedFull)}>
              {isCopiedFull ? '✓ Copied' : 'Copy Full Prompt'}
            </button>
            <button onClick={copyOverlay} style={btnStyle(isCopiedOverlay, true)}>
              {isCopiedOverlay ? '✓ Copied' : 'Copy Overlay Text'}
            </button>
            <button onClick={copyAll} style={btnStyle(isCopiedAll, true)}>
              {isCopiedAll ? '✓ Copied' : 'Copy Full Option'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── AI Provider Banner ──────────────────────────────────────────────────────────

function AiProviderBanner({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <div style={{
      background: 'rgba(251,191,36,0.07)',
      border: '1px solid rgba(251,191,36,0.25)',
      borderRadius: 8, padding: '10px 14px',
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 18 }}>⚙️</span>
      <div style={{ flex: 1, fontSize: 11, color: '#fbbf24', lineHeight: 1.5 }}>
        <strong>AI provider is not configured.</strong>{' '}
        The current variants use deterministic semantic fallback based on title signals.
        Configure Gemini or Ollama in Settings for deeper title reasoning and richer prompts.
      </div>
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          style={{
            padding: '6px 14px', fontSize: 11, fontWeight: 700,
            borderRadius: 6, border: '1px solid rgba(251,191,36,0.4)',
            background: 'rgba(251,191,36,0.12)', color: '#fbbf24', cursor: 'pointer',
          }}
        >
          Open AI Settings
        </button>
      )}
    </div>
  )
}

// ── Analysis Summary ───────────────────────────────────────────────────────────

function AnalysisSummaryPanel({ result }: { result: ThumbnailPromptGenerationResponse }) {
  const s = result.analysis_summary
  return (
    <div style={{
      background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.2)',
      borderRadius: 8, padding: '12px 14px', marginBottom: 14,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#a5b4fc', marginBottom: 8 }}>
        🧠 Title Analysis Summary
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: 11 }}>
        <InfoRow label="Subject" value={s.title_subject} />
        <InfoRow label="Viewer Expectation" value={s.viewer_expectation || ''} />
        <InfoRow label="Hidden Variable" value={s.hidden_variable || ''} />
        <InfoRow label="Strongest Proof" value={s.strongest_proof_object || ''} />
        <InfoRow label="Visual Contradiction" value={s.visual_contradiction || ''} />
        <InfoRow label="Recommended Hook" value={s.recommended_hook} />
      </div>
      <div style={{ fontSize: 10, color: '#64748b', marginTop: 6 }}>
        {s.overlay_style_summary}
      </div>
      <div style={{ marginTop: 4, fontSize: 10, color: '#475569' }}>
        Hook source: {s.hook_source || 'unknown'} · Provider: {result.provider} · Model: {result.model}
        {result.used_ai ? ' · ✓ AI-generated' : ' · Deterministic fallback'}
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
      <span style={{ color: '#a5b4fc', fontWeight: 600, flexShrink: 0 }}>{label}:</span>
      <span style={{ color: '#cbd5e1' }}>{value}</span>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ThumbnailPromptStudio({
  channelTitle,
  blueprint,
  thumbnailIntelligence,
  market = 'US',
  onOpenSettings,
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
    const all = result.variants
      .sort((a, b) => a.recommended_test_rank - b.recommended_test_rank)
      .map((v, i) => [
        `=== OPTION ${v.option_label} (Rank #${v.recommended_test_rank}): ${v.concept_name} ===`,
        `Hook: ${HOOK_FAMILY_LABELS[v.hook_family] || v.hook_family} | Quality: ${v.hook_quality.total_score}/100`,
        `Visual Question: ${v.visual_question}`,
        `Overlay: "${v.overlay_text.combined_text}"`,
        ``,
        v.full_image_prompt,
        ``,
        `Negative: ${v.negative_prompt}`,
        i < result.variants.length - 1 ? '\n' + '─'.repeat(80) : '',
      ].join('\n')).join('\n')
    copy('all_prompts', all)
  }

  // Sort variants for display: A/B test first (rank 1-3), then alternatives (4-5)
  const displayVariants = result
    ? [...result.variants].sort((a, b) => a.recommended_test_rank - b.recommended_test_rank)
    : []

  const abVariants = displayVariants.filter(v => v.recommended_for_ab_test)
  const altVariants = displayVariants.filter(v => !v.recommended_for_ab_test)

  const aiNotConfigured = result && !result.used_ai && result.provider === 'disabled'

  return (
    <div style={{
      background: 'rgba(15,18,26,0.95)',
      border: '1px solid rgba(139,92,246,0.3)',
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(109,40,217,0.25), rgba(30,64,175,0.12))',
        borderBottom: '1px solid rgba(139,92,246,0.2)',
        padding: '14px 18px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{ fontSize: 20 }}>✨</span>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: '#c4b5fd' }}>
            AI Thumbnail Prompt Studio
          </h3>
          <p style={{ margin: 0, fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
            Turn your title into 5 hook-intelligent thumbnail concepts. Scored by curiosity, clarity and promise integrity.
          </p>
        </div>
      </div>

      <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Title input */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#a5b4fc', marginBottom: 5 }}>
              Video Title <span style={{ color: '#f87171' }}>*</span>
            </label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={200}
              placeholder="e.g. The Hidden Fee Making Your Restaurant Bill So Much Higher"
              style={{
                width: '100%', background: 'rgba(0,0,0,0.35)',
                border: `1px solid ${title.length > 0 && title.length < 3 ? '#ef4444' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#f1f5f9',
                outline: 'none', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
              {title.length > 0 && title.length < 3 && (
                <span style={{ fontSize: 10, color: '#f87171' }}>Min 3 characters</span>
              )}
              <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>{title.length}/200</span>
            </div>
          </div>

          {/* Context */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#94a3b8', marginBottom: 5 }}>
              Video Context / Script Summary{' '}
              <span style={{ fontWeight: 400, color: '#475569' }}>(optional, helps avoid misinterpretation)</span>
            </label>
            <textarea
              value={context}
              onChange={e => setContext(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Describe what the video is actually about to prevent false urgency or fabricated claims…"
              style={{
                width: '100%', background: 'rgba(0,0,0,0.2)',
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8,
                padding: '9px 12px', fontSize: 12, color: '#cbd5e1',
                outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit',
              }}
            />
            <div style={{ textAlign: 'right', fontSize: 10, color: '#475569', marginTop: 2 }}>
              {context.length}/2000
            </div>
          </div>

          {/* Blueprint info */}
          <div style={{
            background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '9px 12px',
            border: '1px solid rgba(255,255,255,0.06)',
            display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
          }}>
            <span style={{ fontSize: 11, color: '#64748b', flexShrink: 0 }}>📐 Blueprint:</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#c4b5fd' }}>{blueprint.name}</span>
            <span style={{
              fontSize: 10, padding: '1px 7px', borderRadius: 10,
              background: blueprint.is_statistically_validated ? 'rgba(74,222,128,0.12)' : 'rgba(251,191,36,0.12)',
              color: blueprint.is_statistically_validated ? '#4ade80' : '#fbbf24',
              border: `1px solid ${blueprint.is_statistically_validated ? 'rgba(74,222,128,0.25)' : 'rgba(251,191,36,0.25)'}`,
            }}>
              {blueprint.is_statistically_validated ? '✓ Validated' : '⚠ Observed'}
            </span>
            <span style={{ fontSize: 10, color: '#475569' }}>
              hook: {blueprint.target_hook}
            </span>
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            style={{
              padding: '11px 20px', fontSize: 13, fontWeight: 700, borderRadius: 8, border: 'none',
              cursor: canGenerate ? 'pointer' : 'not-allowed',
              background: canGenerate ? 'linear-gradient(135deg, #7c3aed, #4f46e5)' : 'rgba(100,116,139,0.25)',
              color: canGenerate ? '#fff' : '#64748b',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'all 0.2s',
            }}
          >
            {loading ? (
              <>
                <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                Analyzing title & scoring hook candidates…
              </>
            ) : (
              '✨ Generate 5 Hook-Intelligent Thumbnail Prompts'
            )}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: 8, padding: '10px 14px',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#f87171', marginBottom: 4 }}>Generation Failed</div>
            <div style={{ fontSize: 11, color: '#fca5a5' }}>{error}</div>
            <button onClick={handleGenerate} style={{ ...btnStyle(false), marginTop: 8 }}>Retry</button>
          </div>
        )}

        {/* Results */}
        {result && (
          <div>
            {/* AI provider banner */}
            {aiNotConfigured && <div style={{ marginBottom: 12 }}><AiProviderBanner onOpenSettings={onOpenSettings} /></div>}

            {/* Analysis summary */}
            <AnalysisSummaryPanel result={result} />

            {/* Top-level actions */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <button onClick={handleCopyAll} style={btnStyle(copiedKey === 'all_prompts')}>
                {copiedKey === 'all_prompts' ? '✓ All Copied' : 'Copy All 5 Prompts'}
              </button>
              <button onClick={handleGenerate} disabled={loading} style={btnStyle(false, true)}>
                🔄 Regenerate
              </button>
            </div>

            {/* A/B Test group */}
            {abVariants.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  fontSize: 12, fontWeight: 700, color: '#c4b5fd', marginBottom: 8,
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  🏆 Recommended for A/B Test
                  <span style={{
                    fontSize: 10, background: 'rgba(124,58,237,0.15)', color: '#a5b4fc',
                    padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(124,58,237,0.25)',
                  }}>
                    {abVariants.length} variants · different test hypotheses
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {abVariants.map(v => (
                    <VariantCard key={v.id} variant={v} copiedKey={copiedKey} onCopy={copy} />
                  ))}
                </div>
              </div>
            )}

            {/* Alternative concepts */}
            {altVariants.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 8 }}>
                  💡 Alternative Concepts
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {altVariants.map(v => (
                    <VariantCard key={v.id} variant={v} copiedKey={copiedKey} onCopy={copy} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        input:focus, textarea:focus { border-color: rgba(139,92,246,0.5) !important; box-shadow: 0 0 0 2px rgba(139,92,246,0.15); }
      `}</style>
    </div>
  )
}
