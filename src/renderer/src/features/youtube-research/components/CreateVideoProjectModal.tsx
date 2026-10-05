import React, { useState } from 'react'
import type { ResearchRunResult, ResearchProjectHandoffPayload } from '../types/research.types'

interface Props {
  initialKeyword: string
  initialAngle?: string
  researchResult: ResearchRunResult | null
  onClose: () => void
  onConfirmHandoff: (payload: ResearchProjectHandoffPayload) => Promise<void>
}

export function CreateVideoProjectModal({
  initialKeyword,
  initialAngle,
  researchResult,
  onClose,
  onConfirmHandoff
}: Props): React.ReactElement {
  const [projectName, setProjectName] = useState(
    initialKeyword ? `${initialKeyword.charAt(0).toUpperCase() + initialKeyword.slice(1)} - Documentary` : 'New Video Project'
  )
  const [selectedKeyword, setSelectedKeyword] = useState(initialKeyword)
  const [selectedAngle, setSelectedAngle] = useState(
    initialAngle || (researchResult?.ai_insights?.winning_angles?.[0] ?? 'In-depth market breakdown')
  )

  const [includeMarketFindings, setIncludeMarketFindings] = useState(true)
  const [includeTitlePatterns, setIncludeTitlePatterns] = useState(true)
  const [includeBreakoutReferences, setIncludeBreakoutReferences] = useState(true)
  const [includeContentGaps, setIncludeContentGaps] = useState(true)
  const [includeRelatedKeywords, setIncludeRelatedKeywords] = useState(true)
  const [includeAiIdeas, setIncludeAiIdeas] = useState(true)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!projectName.trim()) return
    setLoading(true)
    setError(null)

    try {
      const payload: ResearchProjectHandoffPayload = {
        projectName: projectName.trim(),
        keyword: selectedKeyword,
        angle: selectedAngle,
        market: researchResult?.market || 'US',
        includeMarketFindings,
        includeTitlePatterns,
        includeBreakoutReferences,
        includeContentGaps,
        includeRelatedKeywords,
        includeAiIdeas,
        researchData: {
          opportunityScore: researchResult?.top_opportunity?.opportunity_score,
          marketFitScore: researchResult?.top_opportunity?.market_fit_score,
          confidence: researchResult?.top_opportunity?.confidence_level,
          topTitles: includeTitlePatterns ? (researchResult?.ai_insights?.title_patterns || []) : [],
          contentGaps: includeContentGaps ? (researchResult?.ai_insights?.content_gaps || []) : [],
          relatedKeywords: includeRelatedKeywords ? (researchResult?.keywords.slice(0, 10).map((k) => k.keyword) || []) : [],
          breakoutVideos: includeBreakoutReferences
            ? (researchResult?.breakout_videos.slice(0, 5).map((b) => ({
                title: b.title,
                url: b.url,
                views: b.views,
                channel: b.channel_title
              })) || [])
            : [],
          aiContentIdeas: includeAiIdeas
            ? (researchResult?.ai_insights?.video_ideas.map((i) => `"${i.title}": ${i.angle}`) || [])
            : [],
          summary: includeMarketFindings ? researchResult?.ai_insights?.summary : undefined
        }
      }

      await onConfirmHandoff(payload)
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.75)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1100,
      backdropFilter: 'blur(4px)'
    }}>
      <div style={{
        background: 'var(--bg-elevated, #13141c)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '12px',
        width: '620px',
        maxWidth: '92vw',
        padding: '28px',
        boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px'
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '14px' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
              Create a Video Project from this Research
            </h2>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
              Transfers market findings and title angles into a new video project draft.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        {/* Form Fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>
              Project Name
            </label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              disabled={loading}
              style={{
                width: '100%',
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                padding: '8px 12px',
                color: 'var(--text-primary)',
                fontSize: '13px'
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>
              Selected Keyword
            </label>
            <input
              type="text"
              value={selectedKeyword}
              onChange={(e) => setSelectedKeyword(e.target.value)}
              disabled={loading}
              style={{
                width: '100%',
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                padding: '8px 12px',
                color: 'var(--text-primary)',
                fontSize: '13px'
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>
              Selected Angle / Hook
            </label>
            <input
              type="text"
              value={selectedAngle}
              onChange={(e) => setSelectedAngle(e.target.value)}
              disabled={loading}
              placeholder="e.g. Why $100 buys less groceries than ten years ago"
              style={{
                width: '100%',
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                padding: '8px 12px',
                color: 'var(--text-primary)',
                fontSize: '13px'
              }}
            />
          </div>

          {/* Include Checkboxes */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px' }}>
              Include Research Context in Draft Brief:
            </label>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '10px',
              background: 'var(--bg-base)',
              padding: '14px',
              borderRadius: '6px',
              border: '1px solid var(--border-subtle)'
            }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={includeMarketFindings} onChange={(e) => setIncludeMarketFindings(e.target.checked)} />
                <span>Market findings & scores</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={includeTitlePatterns} onChange={(e) => setIncludeTitlePatterns(e.target.checked)} />
                <span>Winning title patterns</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={includeBreakoutReferences} onChange={(e) => setIncludeBreakoutReferences(e.target.checked)} />
                <span>Breakout video references</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={includeContentGaps} onChange={(e) => setIncludeContentGaps(e.target.checked)} />
                <span>Content gaps analysis</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={includeRelatedKeywords} onChange={(e) => setIncludeRelatedKeywords(e.target.checked)} />
                <span>Related keywords</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={includeAiIdeas} onChange={(e) => setIncludeAiIdeas(e.target.checked)} />
                <span>AI content ideas</span>
              </label>
            </div>
          </div>
        </div>

        {/* Safety Note */}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
          🛡 Note: Creating a project will safely create a new video project draft. It will <strong>not</strong> automatically start rendering, transcribe audio, or use competitor videos as stock media.
        </div>

        {error && (
          <div style={{ padding: '10px', background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px', fontSize: '11px' }}>
            ⚠ {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading} style={{ padding: '8px 18px' }}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleCreate} disabled={!projectName.trim() || loading} style={{ padding: '8px 24px' }}>
            {loading ? 'Creating Project Draft...' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  )
}
