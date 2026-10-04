import React, { useState } from 'react'
import type { ProjectState } from '../../../../shared/types'
import { useThumbnailStudio } from '../hooks/useThumbnailStudio'
import { FlowConnectionStatus } from '../components/thumbnail/FlowConnectionStatus'
import { ThumbnailRoundTabs } from '../components/thumbnail/ThumbnailRoundTabs'
import { ThumbnailGenerationProgress } from '../components/thumbnail/ThumbnailGenerationProgress'
import { ThumbnailCandidateCard } from '../components/thumbnail/ThumbnailCandidateCard'
import { ThumbnailTemplateSelector } from '../components/thumbnail/ThumbnailTemplateSelector'

interface ThumbnailStudioPageProps {
  project: ProjectState
  onNavigate?: (page: string) => void
}

export const ThumbnailStudioPage: React.FC<ThumbnailStudioPageProps> = ({
  project,
  onNavigate
}) => {
  const {
    jobState,
    health,
    settings,
    templates,
    isLoading,
    isCheckingHealth,
    activeRound,
    setActiveRound,
    checkHealth,
    startGeneration,
    resumeJob,
    cancelJob,
    generateMore,
    retryCandidate,
    regenerateCandidate,
    export4k,
    selectCandidate,
    openFolder,
    openGoogleFlow
  } = useThumbnailStudio(project.projectDir)

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    settings?.selectedTemplateId || ''
  )

  const handleTemplateChange = async (templateId: string) => {
    setSelectedTemplateId(templateId)
    const t = templates.find((item) => item.id === templateId)
    if (t && settings) {
      await window.api.thumbnail.settings.save(project.projectDir, {
        ...settings,
        selectedTemplateId: t.id,
        templateSnapshot: t.promptText
      })
    }
  }

  const handleStart = async () => {
    await startGeneration(false)
  }

  const handleGenerate5More = async () => {
    const t = templates.find((item) => item.id === selectedTemplateId)
    await generateMore(selectedTemplateId, t?.promptText)
  }

  // Filter candidates for the currently active round
  const currentRoundCandidates = (jobState?.candidates || []).filter(
    (c) => c.round === activeRound
  )

  // In case candidates list is empty or fewer than 5, render placeholders A..E
  const optionLetters = ['A', 'B', 'C', 'D', 'E'] as const

  return (
    <div
      style={{
        padding: '24px 32px',
        maxWidth: '1440px',
        margin: '0 auto',
        height: '100%',
        overflowY: 'auto',
        color: '#f3f4f6'
      }}
    >
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '20px',
          flexWrap: 'wrap',
          gap: '16px'
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0, color: '#ffffff' }}>
              Thumbnail Studio
            </h1>
            <span
              style={{
                background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                color: '#ffffff',
                padding: '2px 10px',
                borderRadius: '12px',
                fontSize: '11px',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
              }}
            >
              Google Flow 4K
            </span>
          </div>
          <p style={{ fontSize: '13px', color: '#9ca3af', margin: '4px 0 0 0' }}>
            AI-grounded companion thumbnail generator with strictly 5 distinct YouTube options
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button
            onClick={() => onNavigate?.('thumbnail-library')}
            style={{
              background: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              color: '#e5e7eb',
              borderRadius: '8px',
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer'
            }}
          >
            📚 Prompt Library
          </button>
        </div>
      </div>

      {/* Google Flow Connection Health */}
      <div style={{ marginBottom: '20px' }}>
        <FlowConnectionStatus
          health={health}
          isChecking={isCheckingHealth}
          onCheck={() => checkHealth()}
          onOpenFlow={openGoogleFlow}
        />
      </div>

      {/* Active Job Progress & Actions */}
      <ThumbnailGenerationProgress
        jobState={jobState}
        onStart={handleStart}
        onResume={resumeJob}
        onCancel={cancelJob}
        onGenerateMore={handleGenerate5More}
        onOpenFolder={() => openFolder()}
        onManageLibrary={() => onNavigate?.('thumbnail-library')}
      />

      {/* Template Selector Card (if no job running or for configuring rounds) */}
      <div
        style={{
          background: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          borderRadius: '10px',
          padding: '16px 20px',
          marginBottom: '20px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px'
        }}
      >
        <div style={{ flex: '1', minWidth: '280px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#9ca3af', marginBottom: '6px' }}>
            Master Prompt Template
          </label>
          <ThumbnailTemplateSelector
            templates={templates}
            selectedTemplateId={selectedTemplateId || settings?.selectedTemplateId || ''}
            onSelect={handleTemplateChange}
          />
        </div>

        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <div style={{ fontSize: '12px', color: '#9ca3af' }}>
            <span style={{ color: '#d1d5db', fontWeight: 600 }}>Target: </span>
            5 Photorealistic 4K Options
          </div>
          <div style={{ fontSize: '12px', color: '#9ca3af' }}>
            <span style={{ color: '#d1d5db', fontWeight: 600 }}>Aspect: </span>
            16:9 Landscape
          </div>
        </div>
      </div>

      {/* Round Tabs */}
      <ThumbnailRoundTabs
        currentRound={jobState?.generationRound || 1}
        totalRounds={jobState?.generationRound || 1}
        activeRound={activeRound}
        onSelectRound={setActiveRound}
      />

      {/* 5 Candidate Grid: A B C D E */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
          gap: '18px',
          marginBottom: '32px'
        }}
      >
        {optionLetters.map((letter) => {
          const candidate = currentRoundCandidates.find((c) => c.optionId === letter)
          const isSelected = Boolean(
            candidate && jobState?.selectedCandidateId === candidate.id
          )

          if (!candidate) {
            // Placeholder card before planning finishes
            return (
              <div
                key={letter}
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px dashed rgba(255, 255, 255, 0.1)',
                  borderRadius: '12px',
                  aspectRatio: '16 / 14',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#6b7280',
                  gap: '8px'
                }}
              >
                <div style={{ fontSize: '18px', fontWeight: 700, color: '#4b5563' }}>
                  Option {letter}
                </div>
                <div style={{ fontSize: '12px' }}>Awaiting Generation</div>
              </div>
            )
          }

          return (
            <ThumbnailCandidateCard
              key={candidate.id}
              candidate={candidate}
              isSelected={isSelected}
              onSelect={selectCandidate}
              onRetry={retryCandidate}
              onRegenerate={regenerateCandidate}
              onExport4k={export4k}
              onOpenFolder={(p) => openFolder(p)}
            />
          )
        })}
      </div>
    </div>
  )
}
