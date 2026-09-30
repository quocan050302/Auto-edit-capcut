import React, { useState } from 'react'
import { ClientPipelineDashboard } from './components/ClientPipelineDashboard'
import type { AutoPipelineState, ProjectState } from '../../shared/types'

const mockProject: ProjectState = {
  id: 'mock-proj-1',
  name: 'History of Artificial Intelligence',
  projectDir: '/Users/macbook/Documents/Projects/AI-History',
  status: 'idle',
  settings: {
    resolution: '1080p',
    aspectRatio: '16:9',
    language: 'vi'
  },
  inputs: {
    scriptPath: '/mock/script.txt',
    voiceoverPath: '/mock/voice.mp3',
    imagesFolder: '/mock/images',
    videosFolder: '/mock/videos',
    musicFolder: '/mock/music',
    sfxFolder: '/mock/sfx'
  },
  stats: {
    totalImages: 12,
    totalVideos: 28,
    totalMusic: 4,
    totalSfx: 16,
    voiceDurationSeconds: 480,
    estimatedScenes: 95,
    estimatedChapters: 6
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastOperation: null,
  error: null
}

function getMockState(mode: 'stock-search' | 'rendering' | 'recovery'): AutoPipelineState {
  if (mode === 'stock-search') {
    return {
      schemaVersion: 1,
      version: 18,
      runId: 'run-stock-search-demo',
      projectDir: mockProject.projectDir,
      currentStage: 'stock-search',
      overallStatus: 'running',
      startedAt: new Date(Date.now() - 48000).toISOString(),
      updatedAt: new Date().toISOString(),
      inputFingerprint: { scriptPath: '/mock/script.txt', voiceoverPath: '/mock/voice.mp3' },
      options: { videoDimensions: { width: 1920, height: 1080 } },
      stages: {
        validating: { status: 'completed', progress: 1, durationMs: 2400 },
        transcribing: { status: 'completed', progress: 1, durationMs: 14200 },
        planning: { status: 'completed', progress: 1, durationMs: 18500 },
        captions: { status: 'completed', progress: 1, durationMs: 8200 },
        'global-context': { status: 'completed', progress: 1, durationMs: 11800, artifactPath: '/mock/artifacts/global-context.json' },
        'stock-search': {
          status: 'running',
          progress: 0.83,
          message: 'Searching Pexels/Pixabay [79/95 scenes matched]',
          startedAt: new Date(Date.now() - 15000).toISOString(),
          stats: { totalScenes: 95, processedScenes: 79, assignedScenes: 79, downloadedScenes: 65 }
        },
        'audio-search': { status: 'pending', progress: 0 },
        preflight: { status: 'pending', progress: 0 },
        rendering: { status: 'pending', progress: 0 },
        postflight: { status: 'pending', progress: 0 }
      },
      warnings: [],
      fatalErrors: []
    }
  }

  if (mode === 'rendering') {
    return {
      schemaVersion: 1,
      version: 42,
      runId: 'run-rendering-demo',
      projectDir: mockProject.projectDir,
      currentStage: 'rendering',
      overallStatus: 'running',
      startedAt: new Date(Date.now() - 145000).toISOString(),
      updatedAt: new Date().toISOString(),
      inputFingerprint: { scriptPath: '/mock/script.txt', voiceoverPath: '/mock/voice.mp3' },
      options: { videoDimensions: { width: 1920, height: 1080 } },
      stages: {
        validating: { status: 'completed', progress: 1, durationMs: 2400 },
        transcribing: { status: 'completed', progress: 1, durationMs: 14200 },
        planning: { status: 'completed', progress: 1, durationMs: 18500 },
        captions: { status: 'completed', progress: 1, durationMs: 8200 },
        'global-context': { status: 'completed', progress: 1, durationMs: 11800 },
        'stock-search': { status: 'completed', progress: 1, durationMs: 52000, stats: { totalScenes: 95, assignedScenes: 95 } },
        'audio-search': { status: 'completed', progress: 1, durationMs: 16000 },
        preflight: { status: 'completed', progress: 1, durationMs: 4100, artifactPath: '/mock/artifacts/preflight-report.json' },
        rendering: {
          status: 'running',
          progress: 0.62,
          message: 'Compositing frame 1302/2100 (Captions + Audio Ducking)',
          startedAt: new Date(Date.now() - 18000).toISOString(),
          stats: { currentFrame: 1302, totalFrames: 2100, fps: 30 }
        },
        postflight: { status: 'pending', progress: 0 }
      },
      warnings: [],
      fatalErrors: []
    }
  }

  // Recovery State
  return {
    schemaVersion: 1,
    version: 35,
    runId: 'run-recovery-demo',
    projectDir: mockProject.projectDir,
    currentStage: 'rendering',
    overallStatus: 'interrupted',
    startedAt: new Date(Date.now() - 165000).toISOString(),
    updatedAt: new Date().toISOString(),
    inputFingerprint: { scriptPath: '/mock/script.txt', voiceoverPath: '/mock/voice.mp3' },
    options: { videoDimensions: { width: 1920, height: 1080 } },
    stages: {
      validating: { status: 'completed', progress: 1, durationMs: 2400 },
      transcribing: { status: 'completed', progress: 1, durationMs: 14200 },
      planning: { status: 'completed', progress: 1, durationMs: 18500 },
      captions: { status: 'completed', progress: 1, durationMs: 8200 },
      'global-context': { status: 'completed', progress: 1, durationMs: 11800 },
      'stock-search': { status: 'completed', progress: 1, durationMs: 52000 },
      'audio-search': { status: 'completed', progress: 1, durationMs: 16000 },
      preflight: { status: 'completed', progress: 1, durationMs: 4100 },
      rendering: {
        status: 'interrupted',
        progress: 0.45,
        message: 'Application closed — ready to resume',
        durationMs: 9500
      },
      postflight: { status: 'pending', progress: 0 }
    },
    warnings: [],
    fatalErrors: []
  }
}

export function PreviewApp(): React.ReactElement {
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
  const initialMode = (urlParams?.get('preview') as any) || 'stock-search'
  const [activeScenario, setActiveScenario] = useState<'stock-search' | 'rendering' | 'recovery'>(
    initialMode === 'rendering' || initialMode === 'recovery' ? initialMode : 'stock-search'
  )

  const currentState = getMockState(activeScenario)

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-void, #12121c)', color: '#fff' }}>
      {/* Scenario Switcher Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 24px',
          background: 'rgba(0,0,0,0.6)',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          position: 'sticky',
          top: 0,
          zIndex: 100
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--brand-accent, #a78bfa)' }}>
            QA Preview Scenarios:
          </span>
          <button
            type="button"
            className={`btn btn-sm ${activeScenario === 'stock-search' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveScenario('stock-search')}
            id="scenario-stock"
          >
            1. Stock Search (Running)
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeScenario === 'rendering' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveScenario('rendering')}
            id="scenario-render"
          >
            2. Rendering Video (Running)
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeScenario === 'recovery' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveScenario('recovery')}
            id="scenario-recovery"
          >
            3. Recovery State (Paused Safely)
          </button>
        </div>

        <span style={{ fontSize: '11px', color: 'var(--text-muted, #9ca3af)' }}>
          Mode: {activeScenario} · Elapsed: {activeScenario === 'recovery' ? '02:07' : '00:48+'}
        </span>
      </div>

      <div style={{ padding: '24px 20px 80px' }}>
        <ClientPipelineDashboard
          project={mockProject}
          pipelineState={currentState}
          isRunning={activeScenario !== 'recovery'}
          onCancel={async () => {
            alert('Cancel clicked')
            return true
          }}
          onResume={async () => {
            alert('Resume Production clicked')
            return true
          }}
          onRetryStage={async (stg) => {
            alert(`Retry stage: ${stg}`)
            return true
          }}
          onNavigate={(page) => {
            alert(`Navigate called with target page: "${page}"`)
          }}
        />
      </div>
    </div>
  )
}
