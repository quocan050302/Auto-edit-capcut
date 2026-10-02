import React, { useState, useCallback, useRef, useEffect } from 'react'
import type {
  CompetitorAnalysisResult,
  MarketCode,
  ThumbnailIntelligenceResult,
  ThumbnailAnalysis,
  ThumbnailPattern,
  ThumbnailBlueprint,
  VideoForThumbnail,
  ThumbnailGroupStats,
} from '../types/research.types'
import { ThumbnailGeneratorSection } from './ThumbnailGeneratorSection'
import ThumbnailPromptStudio from './ThumbnailPromptStudio'
import { SimilarChannelsPanel } from './SimilarChannelsPanel'

interface Props {
  onAnalyzeCompetitor: (url: string, market: MarketCode) => Promise<CompetitorAnalysisResult>
  onAnalyzeThumbnails: (payload: {
    channel_id: string
    channel_title: string
    videos: Array<Record<string, unknown>>
    channel_median_views: number
    p75_views: number
    max_videos?: number
  }) => Promise<ThumbnailIntelligenceResult>
  onCreateProjectFromVideo: (title: string) => void
  isAdvancedView?: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function pctBar(value: number, total: number, color: string) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
      <div style={{ flex: 1, height: '4px', background: 'var(--bg-base)', borderRadius: '2px' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '2px' }} />
      </div>
      <span style={{ color: 'var(--text-muted)', minWidth: '36px' }}>{value}/{total}</span>
    </div>
  )
}

function ConfidenceBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    high: '#34d399',
    medium: '#60a5fa',
    low: '#f59e0b',
    insufficient: '#ef4444',
  }
  return (
    <span style={{
      fontSize: '9px', fontWeight: 700, padding: '2px 6px',
      borderRadius: '3px', background: colors[level] + '22',
      color: colors[level], textTransform: 'uppercase', letterSpacing: '0.5px'
    }}>
      {level}
    </span>
  )
}

function PerformanceBadge({ group }: { group: string }) {
  const cfg: Record<string, { color: string; label: string }> = {
    outlier: { color: '#34d399', label: '⚡ Outlier' },
    baseline: { color: '#60a5fa', label: '〰 Baseline' },
    low: { color: '#6b7280', label: '↓ Low' },
  }
  const c = cfg[group] || cfg.baseline
  return (
    <span style={{
      fontSize: '9px', fontWeight: 700, padding: '2px 7px',
      borderRadius: '3px', background: c.color + '22', color: c.color
    }}>
      {c.label}
    </span>
  )
}

// ── Thumbnail Inspector Modal ────────────────────────────────────────────────

function ThumbnailInspector({
  analysis,
  onClose,
}: {
  analysis: ThumbnailAnalysis
  onClose: () => void
}) {
  const [showOverlays, setShowOverlays] = useState(true)

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.75)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '20px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-elevated)', borderRadius: '12px',
          border: '1px solid var(--border-subtle)', width: '100%', maxWidth: '860px',
          maxHeight: '90vh', overflowY: 'auto', padding: '24px'
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Thumbnail Inspector
            </h3>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {analysis.video_title}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              onClick={() => setShowOverlays(v => !v)}
              className="btn btn-secondary"
              style={{ fontSize: '11px', padding: '4px 10px' }}
            >
              {showOverlays ? 'Hide' : 'Show'} Overlays
            </button>
            <button onClick={onClose} className="btn btn-secondary" style={{ fontSize: '11px', padding: '4px 10px' }}>
              ✕ Close
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          {/* Left: Thumbnail Image */}
          <div>
            <div style={{ position: 'relative', borderRadius: '8px', overflow: 'hidden', background: '#000' }}>
              <img
                src={analysis.thumbnail_url}
                alt={analysis.video_title}
                style={{ width: '100%', display: 'block' }}
                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
              {showOverlays && analysis.composition?.main_subject_box && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${analysis.composition.main_subject_box.x * 100}%`,
                    top: `${analysis.composition.main_subject_box.y * 100}%`,
                    width: `${analysis.composition.main_subject_box.width * 100}%`,
                    height: `${analysis.composition.main_subject_box.height * 100}%`,
                    border: '2px solid #34d399',
                    boxSizing: 'border-box',
                    pointerEvents: 'none'
                  }}
                />
              )}
              {showOverlays && analysis.composition?.text_region_box && analysis.composition.text_region_box.width > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${analysis.composition.text_region_box.x * 100}%`,
                    top: `${analysis.composition.text_region_box.y * 100}%`,
                    width: `${analysis.composition.text_region_box.width * 100}%`,
                    height: `${analysis.composition.text_region_box.height * 100}%`,
                    border: '2px solid #f59e0b',
                    boxSizing: 'border-box',
                    pointerEvents: 'none'
                  }}
                />
              )}
              {showOverlays && (
                <div
                  style={{
                    position: 'absolute', bottom: 0, right: 0,
                    width: '15%', height: '15%',
                    border: '2px dashed rgba(239,68,68,0.6)',
                    background: 'rgba(239,68,68,0.1)',
                    pointerEvents: 'none'
                  }}
                  title="Duration badge zone — avoid placing text here"
                />
              )}
            </div>
            {/* Color Palette */}
            {analysis.colors?.dominant_colors?.length > 0 && (
              <div style={{ marginTop: '10px' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>Dominant Colors</div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {analysis.colors.dominant_colors.map((c, i) => (
                    <div
                      key={i}
                      title={`${c.hex} (${c.label}) — ${(c.fraction * 100).toFixed(0)}%`}
                      style={{
                        width: `${Math.max(24, c.fraction * 120)}px`, height: '20px',
                        background: c.hex, borderRadius: '3px', border: '1px solid rgba(255,255,255,0.1)'
                      }}
                    />
                  ))}
                </div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '3px' }}>
                  {analysis.colors.warm_cool_balance} · brightness {(analysis.colors.brightness * 100).toFixed(0)}% · contrast {(analysis.colors.contrast * 100).toFixed(0)}%
                </div>
              </div>
            )}
            {/* Mobile Preview Score */}
            <div style={{
              marginTop: '10px', padding: '10px',
              background: 'var(--bg-base)', borderRadius: '6px'
            }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>Mobile Readability</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  fontSize: '22px', fontWeight: 700,
                  color: analysis.mobile_readability.score >= 60 ? '#34d399' : analysis.mobile_readability.score >= 40 ? '#f59e0b' : '#ef4444'
                }}>
                  {analysis.mobile_readability.score}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>/ 100</div>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                {[
                  ['Text Readable', analysis.mobile_readability.text_readable],
                  ['Face Visible', analysis.mobile_readability.face_recognizable],
                  ['Object Clear', analysis.mobile_readability.main_object_clear],
                ].map(([label, val]) => (
                  <span key={label as string} style={{
                    fontSize: '9px', padding: '1px 5px', borderRadius: '3px',
                    background: val ? '#34d39922' : '#6b728022',
                    color: val ? '#34d399' : '#6b7280'
                  }}>
                    {val ? '✓' : '✗'} {label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Right: Analysis Details */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Performance */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <PerformanceBadge group={analysis.performance_group} />
              <ConfidenceBadge level={analysis.confidence > 0.6 ? 'high' : analysis.confidence > 0.35 ? 'medium' : 'low'} />
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                {fmtNum(analysis.views)} views · {analysis.views_per_day.toFixed(1)}/day · {analysis.outlier_ratio.toFixed(2)}x
              </span>
            </div>

            {/* OCR */}
            <div style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase' }}>
                Text Overlay (OCR)
              </div>
              {analysis.ocr.is_uncertain ? (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  OCR uncertain — {analysis.ocr.text || 'No text detected'}
                </div>
              ) : analysis.ocr.text ? (
                <div style={{
                  fontSize: '12px', color: '#fbbf24', fontFamily: 'monospace',
                  background: '#111', padding: '6px 8px', borderRadius: '4px', marginBottom: '6px'
                }}>
                  "{analysis.ocr.text}"
                </div>
              ) : (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No text overlay detected</div>
              )}
              {analysis.ocr.word_count > 0 && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '10px', color: 'var(--text-muted)' }}>
                  <span>{analysis.ocr.word_count} words</span>
                  {analysis.ocr.has_numbers && <span>• Has numbers</span>}
                  {analysis.ocr.has_question && <span>• Has ?</span>}
                  {analysis.ocr.has_exclamation && <span>• Has !</span>}
                  {analysis.ocr.has_uppercase && <span>• Uppercase</span>}
                </div>
              )}
            </div>

            {/* Composition */}
            <div style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase' }}>
                Composition
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                <div>Layout: <strong>{analysis.composition.layout_type.replace(/_/g, ' ')}</strong></div>
                <div>Focal point: <strong>{analysis.composition.main_focal_point}</strong></div>
                <div>Background: <strong>{analysis.composition.background_complexity}</strong></div>
                {analysis.composition.subject_size_pct > 0 && (
                  <div>Subject area: <strong>{(analysis.composition.subject_size_pct * 100).toFixed(0)}%</strong> of frame</div>
                )}
                {analysis.composition.duration_badge_risk && (
                  <div style={{ color: '#f87171' }}>⚠ Duration badge may overlap bottom-right</div>
                )}
              </div>
            </div>

            {/* Subjects */}
            <div style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase' }}>
                Subject Analysis
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                <div>Person: <strong>{analysis.subjects.has_person ? `Yes (${analysis.subjects.face_count} face${analysis.subjects.face_count !== 1 ? 's' : ''})` : 'No'}</strong></div>
                {analysis.subjects.has_person && (
                  <>
                    <div>Shot: <strong>{analysis.subjects.shot_type.replace(/_/g, ' ')}</strong></div>
                    <div>Expression: <strong>{analysis.subjects.facial_expression}</strong></div>
                    <div>Gaze: <strong>{analysis.subjects.gaze_direction.replace(/_/g, ' ')}</strong></div>
                  </>
                )}
                {[
                  ['Proof object', analysis.subjects.has_proof_object],
                  ['Arrow/circle', analysis.subjects.has_arrow_circle],
                  ['Comparison', analysis.subjects.has_comparison],
                  ['Contradiction', analysis.subjects.has_contradiction],
                ].filter(([, v]) => v).map(([label]) => (
                  <div key={label as string} style={{ color: '#34d399' }}>✓ {label}</div>
                ))}
              </div>
            </div>

            {/* Hooks */}
            {analysis.hooks.length > 0 && (
              <div style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase' }}>
                  Visual Hooks
                </div>
                {analysis.hooks.map((h, i) => (
                  <div key={i} style={{ marginBottom: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '11px', color: '#c084fc', fontWeight: 600 }}>
                        {h.hook_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{(h.confidence * 100).toFixed(0)}%</span>
                    </div>
                    {h.title_evidence && (
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{h.title_evidence}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Title–Thumbnail Pairing */}
            <div style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase' }}>
                Title–Thumbnail Relationship
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div>Type: <strong>{analysis.title_pairing.relationship.replace(/_/g, ' ')}</strong></div>
                {analysis.title_pairing.redundancy_pct > 0 && (
                  <div>Redundancy: <strong>{(analysis.title_pairing.redundancy_pct * 100).toFixed(0)}%</strong></div>
                )}
                {analysis.title_pairing.has_curiosity_gap && (
                  <div style={{ color: '#34d399' }}>✓ Creates curiosity gap</div>
                )}
              </div>
            </div>

            {/* Warnings */}
            {analysis.warnings.length > 0 && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', paddingTop: '8px' }}>
                {analysis.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Thumbnail Gallery Card ───────────────────────────────────────────────────

function ThumbnailCard({
  analysis,
  onInspect,
}: {
  analysis: ThumbnailAnalysis
  onInspect: () => void
}) {
  const [imgError, setImgError] = useState(false)
  const topHook = analysis.hooks[0]?.hook_type?.replace(/_/g, ' ') || '—'

  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: `1px solid ${analysis.performance_group === 'outlier' ? '#34d39944' : 'var(--border-subtle)'}`,
      borderRadius: '8px', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Thumbnail Image */}
      <div style={{ position: 'relative', aspectRatio: '16/9', background: '#111' }}>
        {!imgError ? (
          <img
            src={analysis.thumbnail_url}
            alt={analysis.video_title}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div style={{
            width: '100%', height: '100%', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)', fontSize: '11px'
          }}>
            No preview
          </div>
        )}
        <div style={{ position: 'absolute', top: '6px', left: '6px' }}>
          <PerformanceBadge group={analysis.performance_group} />
        </div>
        {analysis.mobile_readability.score > 0 && (
          <div style={{
            position: 'absolute', top: '6px', right: '6px',
            background: 'rgba(0,0,0,0.7)', borderRadius: '3px',
            padding: '1px 5px', fontSize: '9px', color: 'var(--text-muted)'
          }}>
            📱 {analysis.mobile_readability.score}
          </div>
        )}
      </div>

      {/* Card Body */}
      <div style={{ padding: '10px', flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>
          {analysis.video_title}
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '10px', color: 'var(--text-muted)' }}>
          <span>{fmtNum(analysis.views)}</span>
          <span>·</span>
          <span>{analysis.views_per_day.toFixed(1)}/day</span>
          <span>·</span>
          <span>{analysis.outlier_ratio.toFixed(2)}x</span>
        </div>

        {/* Color swatches */}
        {analysis.colors?.dominant_colors?.length > 0 && (
          <div style={{ display: 'flex', gap: '3px', marginTop: '2px' }}>
            {analysis.colors.dominant_colors.slice(0, 5).map((c, i) => (
              <div key={i} style={{
                width: '14px', height: '14px', borderRadius: '2px',
                background: c.hex, border: '1px solid rgba(255,255,255,0.1)'
              }} title={c.hex} />
            ))}
            <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '2px', alignSelf: 'center' }}>
              {analysis.colors.warm_cool_balance}
            </span>
          </div>
        )}

        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '2px' }}>
          {analysis.subjects.has_person && (
            <span style={{ fontSize: '9px', padding: '1px 4px', background: '#818cf822', color: '#818cf8', borderRadius: '2px' }}>
              👤 Person
            </span>
          )}
          {analysis.ocr.word_count > 0 && (
            <span style={{ fontSize: '9px', padding: '1px 4px', background: '#fbbf2422', color: '#fbbf24', borderRadius: '2px' }}>
              T {analysis.ocr.word_count}w
            </span>
          )}
          {analysis.colors.has_yellow && (
            <span style={{ fontSize: '9px', padding: '1px 4px', background: '#fde04722', color: '#fde047', borderRadius: '2px' }}>🟡</span>
          )}
          {analysis.colors.has_red && (
            <span style={{ fontSize: '9px', padding: '1px 4px', background: '#ef444422', color: '#ef4444', borderRadius: '2px' }}>🔴</span>
          )}
        </div>

        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>
          Hook: {topHook}
        </div>

        <button
          onClick={onInspect}
          className="btn btn-secondary"
          style={{ marginTop: '8px', fontSize: '10px', padding: '4px 8px' }}
        >
          🔍 Inspect Thumbnail
        </button>
      </div>
    </div>
  )
}

// ── Pattern Card ─────────────────────────────────────────────────────────────

function PatternCard({ pattern, type }: { pattern: ThumbnailPattern; type: 'winning' | 'avoid' }) {
  const color = type === 'winning' ? '#34d399' : '#f87171'
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: `1px solid ${color}44`,
      borderRadius: '8px', padding: '14px'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', alignItems: 'flex-start' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color }}>
          {type === 'winning' ? '✓' : '✗'} {pattern.name}
        </div>
        <ConfidenceBadge level={pattern.confidence} />
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
        {pattern.description}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {[
          { label: 'Outliers', count: pattern.outlier_count, total: pattern.outlier_total, color: '#34d399' },
          { label: 'Baseline', count: pattern.baseline_count, total: pattern.baseline_total, color: '#60a5fa' },
          { label: 'Low', count: pattern.low_count, total: pattern.low_total, color: '#6b7280' },
        ].map(({ label, count, total, color: c }) => (
          <div key={label}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>{label}</div>
            {pctBar(count, total, c)}
          </div>
        ))}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px' }}>
        Sample: {pattern.sample_size} thumbnails
      </div>
    </div>
  )
}

// ── Blueprint Card ────────────────────────────────────────────────────────────

function BlueprintCard({ blueprint, onCopyPrompt, onCopyBlueprint }: {
  blueprint: ThumbnailBlueprint
  onCopyPrompt: () => void
  onCopyBlueprint: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)',
      borderRadius: '10px', padding: '18px'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
        <div>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>
            📐 {blueprint.name}
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <ConfidenceBadge level={blueprint.confidence} />
            <span style={{ 
              fontSize: '9px', padding: '2px 6px', borderRadius: '4px',
              background: blueprint.is_statistically_validated ? 'rgba(52,211,153,0.1)' : 'rgba(245,158,11,0.1)',
              color: blueprint.is_statistically_validated ? '#34d399' : '#f59e0b',
              border: `1px solid ${blueprint.is_statistically_validated ? 'rgba(52,211,153,0.2)' : 'rgba(245,158,11,0.2)'}`
            }}>
              {blueprint.is_statistically_validated ? 'Validated' : 'Not Validated'}
            </span>
            <span style={{
              fontSize: '9px', padding: '2px 6px', borderRadius: '4px',
              background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)'
            }}>
              Mode: {blueprint.blueprint_mode.replace(/_/g, ' ')}
            </span>
          </div>
        </div>
        <button
          onClick={() => setExpanded(v => !v)}
          className="btn btn-secondary"
          style={{ fontSize: '11px', padding: '4px 10px' }}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      <div style={{ fontSize: '11px', color: '#60a5fa', marginBottom: '8px' }}>
        <strong>Use when:</strong> {blueprint.use_when}
      </div>
      <div style={{ fontSize: '11px', color: '#c084fc', marginBottom: '8px' }}>
        <strong>Target hook:</strong> {blueprint.target_hook.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
      </div>

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px' }}>
          
          {/* Sample & Fallback Info */}
          {!blueprint.is_statistically_validated && (
            <div style={{ background: 'rgba(245,158,11,0.08)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(245,158,11,0.2)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#f59e0b', marginBottom: '4px' }}>⚠ Not Statistically Validated</div>
              <div style={{ fontSize: '11px', color: '#d97706', marginBottom: '4px' }}>{blueprint.fallback_reason}</div>
              {blueprint.evidence.length > 0 && (
                <div style={{ fontSize: '11px', color: '#d97706', fontStyle: 'italic' }}>Evidence: {blueprint.evidence.join(' ')}</div>
              )}
            </div>
          )}

          {[
            { label: '📐 Layout', content: blueprint.layout_description },
            { label: '👤 Subject Recipe', content: blueprint.subject_recipe },
            { label: '🖼 Background', content: blueprint.background_recipe },
            { label: '✍ Text Recipe', content: blueprint.text_recipe },
            { label: '🎨 Colors', content: blueprint.color_recipe },
            { label: '💡 Lighting', content: blueprint.lighting_recipe },
            { label: '👁 Visual Hierarchy', content: blueprint.hierarchy_recipe },
            { label: '🔗 Title Pairing', content: blueprint.title_pairing_recipe },
          ].filter(({ content }) => content).map(({ label, content }) => (
            <div key={label} style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{content}</div>
            </div>
          ))}

          {blueprint.overlay_text_formula.length > 0 && (
            <div style={{ background: 'var(--bg-base)', padding: '10px', borderRadius: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' }}>📝 Text Formula</div>
              {blueprint.overlay_text_formula.map((f, i) => (
                <div key={i} style={{ fontSize: '11px', color: '#fbbf24', fontFamily: 'monospace' }}>{f}</div>
              ))}
            </div>
          )}

          {blueprint.originality_rules.length > 0 && (
            <div style={{ background: '#111827', border: '1px solid #1f2937', padding: '10px', borderRadius: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#f59e0b', marginBottom: '4px' }}>
                🛡 Originality Guard
              </div>
              {blueprint.originality_rules.map((r, i) => (
                <div key={i} style={{ fontSize: '11px', color: 'var(--text-muted)' }}>• {r}</div>
              ))}
            </div>
          )}

          {blueprint.evidence.length > 0 && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
              <strong>Evidence:</strong>
              {blueprint.evidence.map((e, i) => <div key={i}>• {e}</div>)}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
        <button onClick={onCopyPrompt} className="btn btn-primary" style={{ fontSize: '11px', padding: '6px 12px' }}>
          📋 Copy Image Prompt
        </button>
        <button onClick={onCopyBlueprint} className="btn btn-secondary" style={{ fontSize: '11px', padding: '6px 12px' }}>
          📄 Copy Blueprint
        </button>
      </div>
    </div>
  )
}

// ── Group Stats Table ─────────────────────────────────────────────────────────

function GroupStatsSection({ stats }: { stats: { outlier?: ThumbnailGroupStats; baseline?: ThumbnailGroupStats; low?: ThumbnailGroupStats } }) {
  const rows: Array<{ label: string; key: keyof ThumbnailGroupStats; fmt?: (v: number) => string }> = [
    { label: 'Count', key: 'n' },
    { label: 'Has Text Overlay', key: 'has_text_pct', fmt: v => `${(v * 100).toFixed(0)}%` },
    { label: 'Has Face / Person', key: 'has_face_pct', fmt: v => `${(v * 100).toFixed(0)}%` },
    { label: 'Has Proof Object', key: 'has_proof_pct', fmt: v => `${(v * 100).toFixed(0)}%` },
    { label: 'Has Yellow', key: 'has_yellow_pct', fmt: v => `${(v * 100).toFixed(0)}%` },
    { label: 'Has Red', key: 'has_red_pct', fmt: v => `${(v * 100).toFixed(0)}%` },
    { label: 'Median Word Count', key: 'median_word_count', fmt: v => v.toFixed(1) },
    { label: 'Median Brightness', key: 'median_brightness', fmt: v => `${(v * 100).toFixed(0)}%` },
    { label: 'Median Contrast', key: 'median_contrast', fmt: v => `${(v * 100).toFixed(0)}%` },
    { label: 'Median Mobile Score', key: 'median_mobile_score', fmt: v => v.toFixed(0) },
    { label: 'Top Hook', key: 'top_hook' as keyof ThumbnailGroupStats },
    { label: 'Top Layout', key: 'top_layout' as keyof ThumbnailGroupStats },
  ]

  const out = stats.outlier
  const base = stats.baseline
  const low = stats.low

  function val(s: ThumbnailGroupStats | undefined, key: keyof ThumbnailGroupStats, fmt?: (v: number) => string) {
    if (!s) return '—'
    const v = s[key]
    if (v === undefined || v === null) return '—'
    if (typeof v === 'number' && fmt) return fmt(v)
    return String(v).replace(/_/g, ' ')
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)', fontWeight: 600 }}>Metric</th>
            <th style={{ textAlign: 'right', padding: '6px 10px', color: '#34d399', borderBottom: '1px solid var(--border-subtle)', fontWeight: 600 }}>Outlier ({out?.n || 0})</th>
            <th style={{ textAlign: 'right', padding: '6px 10px', color: '#60a5fa', borderBottom: '1px solid var(--border-subtle)', fontWeight: 600 }}>Baseline ({base?.n || 0})</th>
            <th style={{ textAlign: 'right', padding: '6px 10px', color: '#6b7280', borderBottom: '1px solid var(--border-subtle)', fontWeight: 600 }}>Low ({low?.n || 0})</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map(({ label, key, fmt }) => (
            <tr key={label} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <td style={{ padding: '5px 10px', color: 'var(--text-muted)' }}>{label}</td>
              <td style={{ padding: '5px 10px', textAlign: 'right', color: '#34d399', fontWeight: 600 }}>{val(out, key, fmt)}</td>
              <td style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--text-secondary)' }}>{val(base, key, fmt)}</td>
              <td style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{val(low, key, fmt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px', fontStyle: 'italic' }}>
        ⚠ Associations only. These metrics do not prove causation. Sample sizes may be small.
        Do not claim thumbnails cause higher views.
      </div>
    </div>
  )
}

// ── Client Fallback ─────────────────────────────────────────────────────────────

function createClientSafeFallbackBlueprint(data: ThumbnailIntelligenceResult): ThumbnailBlueprint {
  return {
    id: `client_fallback_${Date.now()}`,
    name: 'Mobile-First Safe Blueprint (Client Fallback)',
    use_when: 'Fallback when no competitor data is available.',
    target_hook: 'curiosity_gap',
    blueprint_mode: 'safe_default',
    is_statistically_validated: false,
    fallback_reason: 'Legacy data or missing server blueprints. A safe mobile-first default blueprint is provided.',
    source_group: 'default',
    sample_summary: {
      total_analyzed: data.analyzed_count,
      outlier_count: data.outlier_count,
      baseline_count: data.baseline_count,
      low_count: data.low_count,
      has_valid_control_group: false
    },
    limitations: ['Not based on specific competitor data.'],
    based_on_pattern_ids: [],
    layout_description: 'Single dominant subject filling 45–60% of frame. Leave clear space for text.',
    subject_recipe: 'One primary subject.',
    background_recipe: 'Simple, uncluttered background with depth.',
    text_recipe: 'Maximum 2 lines, 3-6 words. High contrast.',
    color_recipe: 'High contrast palette.',
    lighting_recipe: 'Bright and clear.',
    hierarchy_recipe: 'Subject -> Text -> Background',
    title_pairing_recipe: 'Curiosity gap',
    overlay_text_formula: ['Short hook'],
    image_prompt_template: 'YouTube thumbnail 16:9. Simple background with depth. Single dominant subject (45-60% of frame). High contrast. Concept relates to: {title}.',
    negative_prompt: 'unreadable text, distorted face, malformed hands, excessive objects',
    evidence: [],
    confidence: 'insufficient',
    originality_rules: ['Keep: abstract composition', 'Do NOT use competitor logos or branding.']
  }
}

// ── Main CompetitorTab Component ──────────────────────────────────────────────

export function CompetitorTab({
  onAnalyzeCompetitor,
  onAnalyzeThumbnails,
  onCreateProjectFromVideo,
  isAdvancedView = false,
}: Props): React.ReactElement {
  const [channelUrl, setChannelUrl] = useState('')
  const [market, setMarket] = useState<MarketCode>('US')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<CompetitorAnalysisResult | null>(null)

  // Thumbnail Intelligence state
  const [thumbLoading, setThumbLoading] = useState(false)
  const [thumbError, setThumbError] = useState<string | null>(null)
  const [thumbData, setThumbData] = useState<ThumbnailIntelligenceResult | null>(null)
  const [thumbProgress, setThumbProgress] = useState<string>('')
  const [thumbFilter, setThumbFilter] = useState<'all' | 'outlier' | 'baseline' | 'low'>('all')
  const [thumbSort, setThumbSort] = useState<'outlier_ratio' | 'views' | 'views_per_day' | 'newest' | 'mobile'>('outlier_ratio')
  const [inspectedThumb, setInspectedThumb] = useState<ThumbnailAnalysis | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const thumbAbort = useRef<AbortController | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }, [])

  // ── Channel Analysis ─────────────────────────────────────────────────────
  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!channelUrl.trim() || loading) return

    setLoading(true)
    setError(null)
    setThumbData(null)
    setThumbError(null)
    try {
      const res = await onAnalyzeCompetitor(channelUrl.trim(), market)
      setData(res)
      // Auto-start thumbnail intelligence
      if (res.videos_for_thumbnail && res.videos_for_thumbnail.length > 0) {
        runThumbnailIntelligence(res)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // ── Thumbnail Intelligence ────────────────────────────────────────────────
  const runThumbnailIntelligence = useCallback(async (channelData: CompetitorAnalysisResult) => {
    if (!channelData.videos_for_thumbnail?.length) {
      setThumbError('No videos with thumbnails available for analysis.')
      return
    }
    setThumbLoading(true)
    setThumbError(null)
    setThumbProgress('Preparing thumbnail analysis...')

    try {
      const result = await onAnalyzeThumbnails({
        channel_id: channelData.channel_id,
        channel_title: channelData.channel_title,
        videos: channelData.videos_for_thumbnail as unknown as Array<Record<string, unknown>>,
        channel_median_views: channelData.median_recent_views,
        p75_views: channelData.p75_views,
        max_videos: 30,
      })
      setThumbData(result)
      setThumbProgress('')
    } catch (err: unknown) {
      setThumbError(err instanceof Error ? err.message : String(err))
      setThumbProgress('')
    } finally {
      setThumbLoading(false)
    }
  }, [onAnalyzeThumbnails])

  // ── Copy Helpers ─────────────────────────────────────────────────────────
  const copyText = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => showToast(`✓ ${label} copied!`),
      () => showToast(`✗ Copy failed`)
    )
  }, [showToast])

  const copyBlueprint = useCallback((bp: ThumbnailBlueprint) => {
    const md = `# ${bp.name}

**Use when:** ${bp.use_when}
**Target hook:** ${bp.target_hook.replace(/_/g, ' ')}
**Confidence:** ${bp.confidence}

## Layout
${bp.layout_description}

## Subject
${bp.subject_recipe}

## Background
${bp.background_recipe}

## Text
${bp.text_recipe}

## Colors
${bp.color_recipe}

## Lighting
${bp.lighting_recipe}

## Visual Hierarchy
${bp.hierarchy_recipe}

## Title–Thumbnail Pairing
${bp.title_pairing_recipe}

## Text Formula
${bp.overlay_text_formula.join('\n')}

## Originality Guard
${bp.originality_rules.join('\n')}

## Evidence
${bp.evidence.join('\n')}

---
*Generated by Competitor Thumbnail Intelligence V1. Patterns are correlational, not causal.*`
    copyText(md, 'Blueprint')
  }, [copyText])

  // ── Sorted/Filtered analyses ─────────────────────────────────────────────
  const filteredAnalyses = thumbData
    ? thumbData.analyses
        .filter(a => thumbFilter === 'all' || a.performance_group === thumbFilter)
        .filter(a => !a.is_error)
        .sort((a, b) => {
          if (thumbSort === 'outlier_ratio') return b.outlier_ratio - a.outlier_ratio
          if (thumbSort === 'views') return b.views - a.views
          if (thumbSort === 'views_per_day') return b.views_per_day - a.views_per_day
          if (thumbSort === 'mobile') return b.mobile_readability.score - a.mobile_readability.score
          if (thumbSort === 'newest') return a.video_age_days - b.video_age_days
          return 0
        })
    : []

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: '16px', right: '16px', zIndex: 2000,
          background: '#1e293b', border: '1px solid #334155',
          borderRadius: '8px', padding: '10px 16px',
          fontSize: '12px', color: '#e2e8f0', boxShadow: '0 4px 12px rgba(0,0,0,0.4)'
        }}>
          {toast}
        </div>
      )}

      {/* Inspector Modal */}
      {inspectedThumb && (
        <ThumbnailInspector
          analysis={inspectedThumb}
          onClose={() => setInspectedThumb(null)}
        />
      )}

      {/* ── Input Card ──────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '10px',
        padding: '24px'
      }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, margin: '0 0 6px 0', color: 'var(--text-primary)' }}>
          Public Channel Baseline Intelligence
        </h3>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 16px 0' }}>
          Analyze public baseline views, upload cadence, repeat topics, breakout outliers, and thumbnail visual patterns from any creator channel.
        </p>

        <form onSubmit={handleAnalyze} style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text"
            placeholder="Enter YouTube Channel URL or handle (e.g. @EconomicsExplained or https://www.youtube.com/@Wendover)"
            value={channelUrl}
            onChange={(e) => setChannelUrl(e.target.value)}
            disabled={loading}
            style={{
              flex: 1,
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '6px',
              padding: '10px 14px',
              color: 'var(--text-primary)',
              fontSize: '13px'
            }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!channelUrl.trim() || loading}
            style={{ padding: '0 20px', minWidth: '130px' }}
          >
            {loading ? 'Analyzing...' : 'Analyze Channel'}
          </button>
        </form>

        {error && (
          <div style={{ marginTop: '12px', padding: '10px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px', color: '#f87171', fontSize: '12px' }}>
            ⚠ {error}
          </div>
        )}
      </div>

      {/* ── Analysis Results ─────────────────────────────────────────────── */}
      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Channel Header Banner */}
          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}>
            <div>
              <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Analyzed Creator</div>
              <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', margin: '4px 0 0 0' }}>
                {data.channel_title}
              </h2>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                {data.subscriber_count ? `${data.subscriber_count.toLocaleString()} subscribers` : 'Subscribers hidden'} • Country: {data.country || 'Unknown'} • Cadence: every ~{data.upload_cadence_days} days
              </div>
            </div>
            <a
              href={data.channel_url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => { e.preventDefault(); window.open(data.channel_url) }}
              className="btn btn-secondary"
              style={{ fontSize: '11px', padding: '6px 14px' }}
            >
              Open YouTube Channel ↗
            </a>
          </div>

          {/* Baseline Metrics Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
            <div style={{ background: 'var(--bg-elevated)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Median Recent Views</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#34d399', marginTop: '4px' }}>
                {data.median_recent_views.toLocaleString()}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Primary baseline</div>
            </div>
            <div style={{ background: 'var(--bg-elevated)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Mean Recent Views</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>
                {Math.round(data.mean_recent_views).toLocaleString()}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Average volume</div>
            </div>
            <div style={{ background: 'var(--bg-elevated)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>P75 High Watermark</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#60a5fa', marginTop: '4px' }}>
                {Math.round(data.p75_views).toLocaleString()}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Top quartile</div>
            </div>
            <div style={{ background: 'var(--bg-elevated)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Topic Consistency</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#c084fc', marginTop: '4px' }}>
                {data.topic_consistency}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Content discipline</div>
            </div>
          </div>

          {/* Repeated Topics & Title Patterns */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div style={{ background: 'var(--bg-elevated)', padding: '18px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <h4 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 10px 0' }}>
                Best Repeated Topic Themes
              </h4>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {data.best_repeated_topics.map((t, idx) => (
                  <span key={idx} style={{
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border-subtle)',
                    padding: '4px 10px', borderRadius: '4px',
                    fontSize: '11px', color: '#818cf8', fontWeight: 600
                  }}>
                    {t}
                  </span>
                ))}
              </div>
            </div>

            <div style={{ background: 'var(--bg-elevated)', padding: '18px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <h4 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 10px 0' }}>
                Winning Title Patterns Used
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {data.winning_title_patterns.map((p, idx) => (
                  <div key={idx} style={{
                    fontSize: '11px', fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-base)', padding: '6px 10px',
                    borderRadius: '4px', color: '#fbbf24'
                  }}>
                    {p}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Outlier Videos Section */}
          {data.outlier_videos.length > 0 && (
            <div>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 12px 0' }}>
                Outlier Videos Above Baseline ({data.outlier_videos.length})
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '14px' }}>
                {data.outlier_videos.map((v) => (
                  <div key={v.video_id} style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '8px', padding: '12px',
                    display: 'flex', flexDirection: 'column', justifyContent: 'space-between'
                  }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <span style={{ fontSize: '10px', color: '#34d399', fontWeight: 700 }}>
                          {v.outlier_ratio}x Outlier
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                          {v.views.toLocaleString()} views
                        </span>
                      </div>
                      <h5 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px 0', lineHeight: 1.4 }}>
                        {v.title}
                      </h5>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
                      <a
                        href={v.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => { e.preventDefault(); window.open(v.url) }}
                        style={{ fontSize: '10px', color: 'var(--text-brand)', textDecoration: 'none' }}
                      >
                        Watch ↗
                      </a>
                      <button
                        className="btn btn-secondary"
                        onClick={() => onCreateProjectFromVideo(v.title)}
                        style={{ fontSize: '10px', padding: '2px 8px' }}
                      >
                        + Project Draft
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════
              THUMBNAIL INTELLIGENCE SECTION (NEW V2)
              ══════════════════════════════════════════════════════════════ */}
          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            overflow: 'hidden'
          }}>
            {/* Section Header */}
            <div style={{
              padding: '18px 20px',
              background: 'linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%)',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between'
            }}>
              <div>
                <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#a5b4fc' }}>
                  🖼 Thumbnail Intelligence
                </h3>
                <p style={{ fontSize: '11px', color: '#6366f1', margin: '4px 0 0 0' }}>
                  Visual pattern analysis across outlier, baseline, and low-performing videos
                </p>
              </div>
              {data.videos_for_thumbnail && data.videos_for_thumbnail.length > 0 && (
                <button
                  onClick={() => runThumbnailIntelligence(data)}
                  disabled={thumbLoading}
                  className="btn btn-secondary"
                  style={{ fontSize: '11px', padding: '6px 12px' }}
                >
                  {thumbLoading ? '⏳ Analyzing...' : '🔄 Re-analyze Thumbnails'}
                </button>
              )}
            </div>

            <div style={{ padding: '20px' }}>
              {/* Loading State */}
              {thumbLoading && (
                <div style={{
                  padding: '20px', textAlign: 'center',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px'
                }}>
                  <div style={{
                    width: '36px', height: '36px', borderRadius: '50%',
                    border: '3px solid var(--border-subtle)', borderTopColor: '#6366f1',
                    animation: 'spin 1s linear infinite'
                  }} />
                  <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                    {thumbProgress || 'Analyzing thumbnails...'}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    Downloading and analyzing up to 30 thumbnails concurrently...
                  </div>
                </div>
              )}

              {/* Error State */}
              {thumbError && !thumbLoading && (
                <div style={{
                  padding: '12px', background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px',
                  fontSize: '12px', color: '#f87171'
                }}>
                  ⚠ Thumbnail analysis failed: {thumbError}
                  <br />
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    Channel baseline data above is still valid.
                  </span>
                </div>
              )}

              {/* No videos */}
              {!thumbLoading && !thumbError && !thumbData && data.videos_for_thumbnail?.length === 0 && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '20px' }}>
                  No videos with thumbnail URLs available for analysis.
                </div>
              )}

              {/* Results */}
              {thumbData && !thumbLoading && (() => {
                const safeBlueprints = thumbData.blueprints.length > 0 ? thumbData.blueprints : [createClientSafeFallbackBlueprint(thumbData)];
                const primaryBlueprint = safeBlueprints[0];
                return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                  {/* Summary Header */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
                    {[
                      { label: 'Analyzed', value: thumbData.analyzed_count, color: '#34d399' },
                      { label: 'Outliers', value: thumbData.outlier_count, color: '#f59e0b' },
                      { label: 'Baseline', value: thumbData.baseline_count, color: '#60a5fa' },
                      { label: 'Low Performers', value: thumbData.low_count, color: '#6b7280' },
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{
                        background: 'var(--bg-base)', padding: '12px',
                        borderRadius: '8px', border: '1px solid var(--border-subtle)', textAlign: 'center'
                      }}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color }}>{value}</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Confidence + limitations */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Analysis confidence:</span>
                    <ConfidenceBadge level={thumbData.overall_confidence} />
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      Provider: {thumbData.provider}
                    </span>
                    {thumbData.cached_count > 0 && (
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        • {thumbData.cached_count} cached
                      </span>
                    )}
                    {thumbData.failed_count > 0 && (
                      <span style={{ fontSize: '11px', color: '#f87171' }}>
                        • {thumbData.failed_count} failed
                      </span>
                    )}
                  </div>

                  {thumbData.limitations.length > 0 && (
                    <div style={{ padding: '10px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '6px' }}>
                      {thumbData.limitations.map((l, i) => (
                        <div key={i} style={{ fontSize: '11px', color: '#f59e0b' }}>⚠ {l}</div>
                      ))}
                    </div>
                  )}

                  {/* Simple View: Top patterns + blueprint */}
                  {!isAdvancedView ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      {/* Gallery — limited */}
                      {filteredAnalyses.slice(0, 6).length > 0 && (
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '10px' }}>
                            Thumbnail Sample ({filteredAnalyses.slice(0, 6).length})
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
                            {filteredAnalyses.slice(0, 6).map(a => (
                              <ThumbnailCard key={a.video_id} analysis={a} onInspect={() => setInspectedThumb(a)} />
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Top 3 winning patterns */}
                      {thumbData.winning_patterns.length > 0 && (
                        <div>
                          <h4 style={{ fontSize: '13px', fontWeight: 700, color: '#34d399', margin: '0 0 10px 0' }}>
                            ✓ Top Observed Patterns (Outliers)
                          </h4>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '10px' }}>
                            {thumbData.winning_patterns.slice(0, 3).map(p => (
                              <PatternCard key={p.pattern_id} pattern={p} type="winning" />
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Top 3 avoid patterns */}
                      {thumbData.avoid_patterns.length > 0 && (
                        <div>
                          <h4 style={{ fontSize: '13px', fontWeight: 700, color: '#f87171', margin: '0 0 10px 0' }}>
                            ✗ Patterns to Consider Avoiding
                          </h4>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '10px' }}>
                            {thumbData.avoid_patterns.slice(0, 3).map(p => (
                              <PatternCard key={p.pattern_id} pattern={p} type="avoid" />
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Primary blueprint (ALWAYS RENDERED) */}
                      <div>
                        <h4 style={{ fontSize: '13px', fontWeight: 700, color: '#a5b4fc', margin: '0 0 10px 0' }}>
                          📐 Recommended Blueprint
                        </h4>
                        <BlueprintCard
                          blueprint={primaryBlueprint}
                          onCopyPrompt={() => copyText(primaryBlueprint.image_prompt_template, 'Image Prompt')}
                          onCopyBlueprint={() => copyBlueprint(primaryBlueprint)}
                        />
                      </div>

                      {/* Prompt Studio — Basic View */}
                      <ThumbnailPromptStudio
                        channelTitle={data.channel_title}
                        blueprint={primaryBlueprint}
                        thumbnailIntelligence={thumbData}
                        market={market}
                      />
                    </div>
                  ) : (
                    /* Advanced View */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                      {/* Gallery — full with filters */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                          <h4 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                            Thumbnail Gallery ({filteredAnalyses.length}/{thumbData.analyses.length})
                          </h4>
                          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            <select
                              value={thumbFilter}
                              onChange={e => setThumbFilter(e.target.value as typeof thumbFilter)}
                              style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: '4px', padding: '4px 8px', color: 'var(--text-primary)', fontSize: '11px' }}
                            >
                              <option value="all">All Groups</option>
                              <option value="outlier">Outliers</option>
                              <option value="baseline">Baseline</option>
                              <option value="low">Low Performers</option>
                            </select>
                            <select
                              value={thumbSort}
                              onChange={e => setThumbSort(e.target.value as typeof thumbSort)}
                              style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: '4px', padding: '4px 8px', color: 'var(--text-primary)', fontSize: '11px' }}
                            >
                              <option value="outlier_ratio">Sort: Outlier Ratio</option>
                              <option value="views">Sort: Views</option>
                              <option value="views_per_day">Sort: Views/Day</option>
                              <option value="mobile">Sort: Mobile Score</option>
                              <option value="newest">Sort: Newest</option>
                            </select>
                          </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
                          {filteredAnalyses.map(a => (
                            <ThumbnailCard key={a.video_id} analysis={a} onInspect={() => setInspectedThumb(a)} />
                          ))}
                        </div>
                      </div>

                      {/* All winning patterns */}
                      {thumbData.winning_patterns.length > 0 && (
                        <div>
                          <h4 style={{ fontSize: '13px', fontWeight: 700, color: '#34d399', margin: '0 0 10px 0' }}>
                            ✓ Winning Visual Patterns ({thumbData.winning_patterns.length})
                          </h4>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
                            {thumbData.winning_patterns.map(p => (
                              <PatternCard key={p.pattern_id} pattern={p} type="winning" />
                            ))}
                          </div>
                        </div>
                      )}

                      {/* All avoid patterns */}
                      {thumbData.avoid_patterns.length > 0 && (
                        <div>
                          <h4 style={{ fontSize: '13px', fontWeight: 700, color: '#f87171', margin: '0 0 10px 0' }}>
                            ✗ Patterns to Consider Avoiding ({thumbData.avoid_patterns.length})
                          </h4>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
                            {thumbData.avoid_patterns.map(p => (
                              <PatternCard key={p.pattern_id} pattern={p} type="avoid" />
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Group stats comparison */}
                      <div style={{ background: 'var(--bg-base)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                        <h4 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 12px 0' }}>
                          Outlier vs Baseline vs Low — Statistical Comparison
                        </h4>
                        <GroupStatsSection stats={thumbData.group_stats} />
                      </div>

                      {/* All blueprints (ALWAYS RENDERED) */}
                      <div>
                        <h4 style={{ fontSize: '13px', fontWeight: 700, color: '#a5b4fc', margin: '0 0 10px 0' }}>
                          📐 Reusable Thumbnail Blueprints ({safeBlueprints.length})
                        </h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          {safeBlueprints.map(bp => (
                            <BlueprintCard
                              key={bp.id}
                              blueprint={bp}
                              onCopyPrompt={() => copyText(bp.image_prompt_template, 'Image Prompt')}
                              onCopyBlueprint={() => copyBlueprint(bp)}
                            />
                          ))}
                        </div>
                      </div>

                      {/* Title-to-Thumbnail Generator Section (ALWAYS RENDERED) */}
                      <ThumbnailGeneratorSection blueprints={safeBlueprints} />

                      {/* Prompt Studio — Advanced View */}
                      <ThumbnailPromptStudio
                        channelTitle={data.channel_title}
                        blueprint={primaryBlueprint}
                        thumbnailIntelligence={thumbData}
                        market={market}
                      />

                      {/* Similar Channel Discovery */}
                      <SimilarChannelsPanel
                        competitor={data}
                        market={market}
                        language="en"
                      />

                      {/* Failure details */}
                      {thumbData.failure_details.length > 0 && (
                        <div style={{ background: 'var(--bg-base)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
                          <h5 style={{ fontSize: '12px', fontWeight: 700, color: '#f87171', margin: '0 0 8px 0' }}>
                            Failed Thumbnails ({thumbData.failure_details.length})
                          </h5>
                          {thumbData.failure_details.map((f, i) => (
                            <div key={i} style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>
                              {f.video_id}: {f.reason}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                )
              })()}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
