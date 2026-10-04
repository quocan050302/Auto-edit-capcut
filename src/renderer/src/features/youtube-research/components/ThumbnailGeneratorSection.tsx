import React, { useState } from 'react'
import type { ThumbnailBlueprint, ThumbnailGenerationResponse } from '../types/research.types'
import { researchApi } from '../api/researchApi'

interface Props {
  blueprints: ThumbnailBlueprint[]
}

export function ThumbnailGeneratorSection({ blueprints }: Props) {
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string>(blueprints[0]?.id || '')
  const [title, setTitle] = useState('')
  const [scriptSummary, setScriptSummary] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [result, setResult] = useState<ThumbnailGenerationResponse | null>(null)
  const [error, setError] = useState('')

  const handleGenerate = async () => {
    if (!title.trim()) {
      setError('Please enter a video title')
      return
    }
    const blueprint = blueprints.find(b => b.id === selectedBlueprintId)
    if (!blueprint) {
      setError('Please select a blueprint')
      return
    }

    setError('')
    setIsGenerating(true)
    setResult(null)

    try {
      const res = await researchApi.generateThumbnail({
        title: title.trim(),
        script_summary: scriptSummary.trim(),
        blueprint
      })
      setResult(res)
    } catch (err: any) {
      setError(err.message || 'Generation failed')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleDownload = () => {
    if (!result?.image_base64) return
    const link = document.createElement('a')
    link.href = `data:image/jpeg;base64,${result.image_base64}`
    link.download = `thumbnail-${Date.now()}.jpg`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  if (blueprints.length === 0) return null

  return (
    <div style={{ background: 'var(--bg-base)', padding: '20px', borderRadius: '12px', border: '1px solid var(--border-subtle)', marginTop: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <span style={{ fontSize: '20px' }}>🖼️</span>
        <h4 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          Title-to-Thumbnail Generator
        </h4>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        {/* Left Col: Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
              Video Title *
            </label>
            <input 
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. I Investigated the Dark Web"
              style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
              Script Summary / Context (Optional)
            </label>
            <textarea
              value={scriptSummary}
              onChange={(e) => setScriptSummary(e.target.value)}
              placeholder="Briefly describe the video content to guide the AI..."
              rows={3}
              style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)', color: 'var(--text-primary)', resize: 'vertical' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
              Target Blueprint
            </label>
            <select
              value={selectedBlueprintId}
              onChange={(e) => setSelectedBlueprintId(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                fontSize: '13px'
              }}
            >
              {blueprints.map(bp => (
                <option key={bp.id} value={bp.id}>{bp.name}</option>
              ))}
            </select>
          </div>

          {error && (
            <div style={{ color: '#ef4444', fontSize: '12px' }}>{error}</div>
          )}

          <button 
            onClick={handleGenerate}
            disabled={isGenerating || !title.trim()}
            style={{ 
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', 
              color: 'white',
              cursor: isGenerating ? 'wait' : 'pointer',
              border: 'none',
              padding: '10px 16px',
              borderRadius: '6px',
              fontWeight: 600
            }}
          >
            {isGenerating ? 'Generating...' : 'Generate Thumbnail'}
          </button>
        </div>

        {/* Right Col: Result */}
        <div style={{ 
          background: 'var(--bg-surface)', 
          borderRadius: '8px', 
          border: '1px dashed var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '220px',
          overflow: 'hidden',
          position: 'relative'
        }}>
          {result ? (
            <>
              <img 
                src={`data:image/jpeg;base64,${result.image_base64}`} 
                alt="Generated Thumbnail" 
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <div style={{ position: 'absolute', top: 8, right: 8 }}>
                <button onClick={handleDownload} style={{ background: 'rgba(0,0,0,0.6)', color: 'white', border: 'none', borderRadius: '4px', padding: '6px', cursor: 'pointer' }}>
                  Download
                </button>
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '20px' }}>
              {isGenerating ? 'Generating image via AI... (may take 10-30s)' : '16:9 Thumbnail will appear here'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
