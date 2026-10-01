import React, { useState, useEffect } from 'react'
import type { ThumbnailCandidate } from '../../../../shared/types'

interface ThumbnailCandidateCardProps {
  candidate: ThumbnailCandidate
  isSelected: boolean
  onSelect: (candidateId: string) => void
  onRetry: (candidateId: string) => void
  onRegenerate: (candidateId: string, customPrompt?: string) => void
  onExport4k: (candidateId: string) => void
  onOpenFolder: (filePath?: string) => void
}

export const ThumbnailCandidateCard: React.FC<ThumbnailCandidateCardProps> = ({
  candidate,
  isSelected,
  onSelect,
  onRetry,
  onRegenerate,
  onExport4k,
  onOpenFolder
}) => {
  const [showPromptModal, setShowPromptModal] = useState(false)
  const [showRegenModal, setShowRegenModal] = useState(false)
  const [customPromptText, setCustomPromptText] = useState(candidate.imagePrompt)
  const [copied, setCopied] = useState(false)
  const [imageSrc, setImageSrc] = useState<string>('')

  const isCompleted = candidate.status === 'completed'
  const isGenerating = candidate.status === 'generating' || candidate.status === 'exporting'
  const isFailed = candidate.status === 'failed'

  // Load image via IPC (main process reads file → base64) to avoid Electron CSP
  // restrictions on file:// protocol in the renderer process.
  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      if (candidate.exportedImagePath) {
        try {
          const result = await window.api.thumbnail.readImage(candidate.exportedImagePath)
          if (!cancelled) {
            if ('dataUrl' in result) {
              setImageSrc(result.dataUrl)
            } else {
              // Fallback to remote URL if IPC read fails
              setImageSrc(candidate.originalImagePath || '')
            }
          }
        } catch {
          if (!cancelled) setImageSrc(candidate.originalImagePath || '')
        }
      } else {
        setImageSrc(candidate.originalImagePath || '')
      }
    }

    load()
    return () => { cancelled = true }
  }, [candidate.exportedImagePath, candidate.originalImagePath])

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(candidate.imagePrompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleConfirmRegenerate = () => {
    onRegenerate(candidate.id, customPromptText)
    setShowRegenModal(false)
  }

  return (
    <div
      style={{
        background: isSelected ? 'rgba(59, 130, 246, 0.08)' : 'rgba(255, 255, 255, 0.03)',
        border: isSelected
          ? '2px solid #3b82f6'
          : isFailed
          ? '1px solid rgba(239, 68, 68, 0.3)'
          : '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '12px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: isSelected ? '0 0 20px rgba(59, 130, 246, 0.25)' : 'none',
        transition: 'all 0.2s ease',
        position: 'relative'
      }}
    >
      {/* Top Banner Option Badge */}
      <div
        style={{
          position: 'absolute',
          top: '12px',
          left: '12px',
          zIndex: 10,
          background: isSelected ? '#3b82f6' : 'rgba(0, 0, 0, 0.75)',
          color: '#ffffff',
          padding: '4px 10px',
          borderRadius: '6px',
          fontWeight: 700,
          fontSize: '13px',
          backdropFilter: 'blur(4px)',
          border: '1px solid rgba(255, 255, 255, 0.2)'
        }}
      >
        Option {candidate.optionId}
        {candidate.revision > 1 && ` (Rev ${candidate.revision})`}
      </div>

      {/* Quality Badge */}
      {candidate.exportQuality && (
        <div
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            zIndex: 10,
            background:
              candidate.exportQuality === 'native-4k'
                ? 'rgba(34, 197, 94, 0.85)'
                : 'rgba(245, 158, 11, 0.85)',
            color: '#ffffff',
            padding: '3px 8px',
            borderRadius: '4px',
            fontWeight: 700,
            fontSize: '11px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }}
        >
          {candidate.exportQuality === 'native-4k' ? 'Native 4K' : candidate.exportQuality}
        </div>
      )}

      {/* Image Preview Box (16:9 ratio) */}
      <div
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          background: '#090a10',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
        }}
      >
        {isCompleted && candidate.exportedImagePath ? (
          <img
            src={imageSrc}
            alt={`Option ${candidate.optionId}`}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={(e) => {
              // Fallback to placeholder if local file protocol isn't loaded yet
              ;(e.target as HTMLElement).style.display = 'none'
            }}
          />
        ) : isGenerating ? (
          <div style={{ textAlign: 'center', padding: '20px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                border: '3px solid rgba(59, 130, 246, 0.2)',
                borderTopColor: '#3b82f6',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
                margin: '0 auto 12px auto'
              }}
            />
            <div style={{ fontSize: '12px', color: '#93c5fd', fontWeight: 500 }}>
              {candidate.status === 'exporting' ? 'Exporting 4K Image...' : 'Generating Image in Flow...'}
            </div>
          </div>
        ) : isFailed ? (
          <div style={{ textAlign: 'center', padding: '20px', color: '#f87171' }}>
            <div style={{ fontSize: '24px', marginBottom: '6px' }}>⚠️</div>
            <div style={{ fontSize: '12px', fontWeight: 500 }}>Generation Failed</div>
            {candidate.error && (
              <div style={{ fontSize: '11px', color: '#fca5a5', marginTop: '4px', maxWidth: '240px' }}>
                {candidate.error}
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: '#6b7280', fontSize: '13px', textAlign: 'center' }}>
            <div>⏳ Queued for Generation</div>
          </div>
        )}
      </div>

      {/* Content Info */}
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#f3f4f6', marginBottom: '6px' }}>
            {candidate.conceptName}
          </div>

          {/* Yellow & White Text Overlays */}
          <div
            style={{
              background: 'rgba(0, 0, 0, 0.4)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '6px',
              padding: '8px 12px',
              fontFamily: 'Impact, Arial Black, sans-serif',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              lineHeight: 1.2
            }}
          >
            <div style={{ color: '#facc15', fontSize: '15px', textShadow: '1px 1px 2px #000' }}>
              {candidate.yellowText}
            </div>
            <div style={{ color: '#ffffff', fontSize: '14px', textShadow: '1px 1px 2px #000' }}>
              {candidate.whiteText}
            </div>
          </div>
        </div>

        {/* Titles */}
        <div style={{ fontSize: '12px', color: '#9ca3af', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div>
            <span style={{ color: '#60a5fa', fontWeight: 600 }}>Clear: </span>
            <span style={{ color: '#d1d5db' }}>{candidate.titleClear}</span>
          </div>
          <div>
            <span style={{ color: '#f59e0b', fontWeight: 600 }}>Curiosity: </span>
            <span style={{ color: '#d1d5db' }}>{candidate.titleCuriosity}</span>
          </div>
        </div>

        {/* Resolution info */}
        {candidate.actualWidth && candidate.actualHeight && (
          <div style={{ fontSize: '11px', color: '#6b7280' }}>
            Resolution: {candidate.actualWidth} × {candidate.actualHeight}
          </div>
        )}

        {/* Actions Bar */}
        <div style={{ marginTop: 'auto', paddingTop: '12px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {isCompleted ? (
            <button
              onClick={() => onSelect(candidate.id)}
              style={{
                flex: 1,
                minWidth: '100px',
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                background: isSelected ? '#10b981' : '#3b82f6',
                color: '#ffffff',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              {isSelected ? '✓ Selected Master' : 'Select Master'}
            </button>
          ) : isFailed ? (
            <button
              onClick={() => onRetry(candidate.id)}
              style={{
                flex: 1,
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                background: '#ef4444',
                color: '#ffffff',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              Retry
            </button>
          ) : null}

          <button
            onClick={() => setShowPromptModal(true)}
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: '#d1d5db',
              cursor: 'pointer'
            }}
            title="View Flow Prompt"
          >
            Prompt
          </button>

          <button
            onClick={() => setShowRegenModal(true)}
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: '#d1d5db',
              cursor: 'pointer'
            }}
            title="Regenerate with Custom Prompt"
          >
            Edit & Regen
          </button>

          {isCompleted && candidate.exportQuality !== 'native-4k' && (
            <button
              onClick={() => onExport4k(candidate.id)}
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                fontSize: '12px',
                background: 'rgba(245, 158, 11, 0.15)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                color: '#fbbf24',
                cursor: 'pointer'
              }}
              title="Attempt 4K Export again"
            >
              Retry 4K
            </button>
          )}

          {isCompleted && candidate.exportedImagePath && (
            <button
              onClick={() => onOpenFolder(candidate.exportedImagePath)}
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                fontSize: '12px',
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#9ca3af',
                cursor: 'pointer'
              }}
              title="Show in Folder"
            >
              📁
            </button>
          )}
        </div>
      </div>

      {/* Modal: View Prompt */}
      {showPromptModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
          }}
          onClick={() => setShowPromptModal(false)}
        >
          <div
            style={{
              background: '#111827',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '12px',
              maxWidth: '650px',
              width: '100%',
              padding: '24px',
              color: '#f3f4f6'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                Option {candidate.optionId} — Image Prompt
              </h3>
              <button
                onClick={() => setShowPromptModal(false)}
                style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div
              style={{
                background: '#030712',
                padding: '16px',
                borderRadius: '8px',
                fontSize: '13px',
                lineHeight: 1.5,
                color: '#e5e7eb',
                maxHeight: '300px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                fontFamily: 'monospace'
              }}
            >
              {candidate.imagePrompt}
            </div>

            <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={handleCopyPrompt}
                style={{
                  background: '#3b82f6',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 16px',
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                {copied ? '✓ Copied' : 'Copy Prompt'}
              </button>
              <button
                onClick={() => setShowPromptModal(false)}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 16px',
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Edit Prompt & Regenerate */}
      {showRegenModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
          }}
          onClick={() => setShowRegenModal(false)}
        >
          <div
            style={{
              background: '#111827',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '12px',
              maxWidth: '650px',
              width: '100%',
              padding: '24px',
              color: '#f3f4f6'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                Regenerate Option {candidate.optionId} (Creates Revision {candidate.revision + 1})
              </h3>
              <button
                onClick={() => setShowRegenModal(false)}
                style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '12px' }}>
              Modify the English image prompt below to regenerate this specific candidate without affecting the other 4 options:
            </p>

            <textarea
              value={customPromptText}
              onChange={(e) => setCustomPromptText(e.target.value)}
              rows={8}
              style={{
                width: '100%',
                background: '#030712',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '8px',
                padding: '12px',
                fontSize: '13px',
                lineHeight: 1.5,
                color: '#e5e7eb',
                fontFamily: 'monospace',
                resize: 'vertical'
              }}
            />

            <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setShowRegenModal(false)}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 16px',
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRegenerate}
                style={{
                  background: '#3b82f6',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Regenerate Candidate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
