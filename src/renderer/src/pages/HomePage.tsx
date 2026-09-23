import React, { useState } from 'react'
import { NewProjectModal } from '../components/NewProjectModal'

interface HomePageProps {
  onCreate: (name: string) => Promise<void>
  onOpen: () => Promise<void>
  onNavigate: (page: 'input') => void
}

export function HomePage({ onCreate, onOpen, onNavigate }: HomePageProps): React.ReactElement {
  const [showModal, setShowModal] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  async function handleCreate(name: string): Promise<void> {
    setIsCreating(true)
    const ok = await onCreate(name)
    setIsCreating(false)
    if (ok) {
      setShowModal(false)
      onNavigate('input')
    }
  }

  async function handleOpen(): Promise<void> {
    const ok = await onOpen()
    if (ok) onNavigate('input')
  }

  return (
    <>
      <div className="page-container">
        <div className="home-hero">
          <div className="home-hero-logo">
            <svg viewBox="0 0 24 24">
              <path d="M4 6.47L5.76 10H20v8H4V6.47M22 4h-4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4z" />
            </svg>
          </div>

          <div>
            <div className="home-hero-headline">Long-Form AI Video Factory</div>
            <div className="home-hero-sub" style={{ marginTop: '12px' }}>
              Transform narration scripts, voice-overs, and media into polished documentary-style
              videos — automatically.
            </div>
          </div>

          <div className="home-actions">
            <button
              className="btn btn-primary btn-lg"
              onClick={() => setShowModal(true)}
              id="btn-new-project"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
              </svg>
              New Project
            </button>
            <button
              className="btn btn-secondary btn-lg"
              onClick={handleOpen}
              id="btn-open-project"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
                <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              </svg>
              Open Project
            </button>
          </div>
        </div>

        {/* Feature highlights */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </div>

      {showModal && (
        <NewProjectModal
          onConfirm={handleCreate}
          onCancel={() => setShowModal(false)}
          isCreating={isCreating}
        />
      )}
    </>
  )
}

const FEATURES = [
  {
    title: 'Audio-First Timeline',
    desc: 'Voice-over is the master. Visuals are placed precisely against transcribed narration timestamps.',
    icon: '🎙️'
  },
  {
    title: 'Hierarchical Editing',
    desc: 'Projects → Chapters → Sequences → Scenes. Each layer carries full editorial context.',
    icon: '🏗️'
  },
  {
    title: 'Long-Form Ready',
    desc: 'Designed for 10–60 minute documentaries. Rendered in 1–3 minute segments for reliability.',
    icon: '🎬'
  },
  {
    title: 'AI Media Matching',
    desc: 'Semantic matching pairs narration scenes with the most relevant images and footage.',
    icon: '🤖'
  },
  {
    title: 'Automated QA',
    desc: 'Black frame detection, sync checks, aspect ratio validation, and auto-repair.',
    icon: '✅'
  },
  {
    title: 'Manual Override',
    desc: 'Inspect every scene, swap media, change motion presets, split or merge shots.',
    icon: '🎛️'
  }
]

function FeatureCard({
  title,
  desc,
  icon
}: {
  title: string
  desc: string
  icon: string
}): React.ReactElement {
  return (
    <div className="panel" style={{ padding: '20px' }}>
      <div style={{ fontSize: '28px', marginBottom: '10px' }}>{icon}</div>
      <div
        style={{
          fontSize: '13px',
          fontWeight: 700,
          color: 'var(--text-primary)',
          marginBottom: '6px'
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        {desc}
      </div>
    </div>
  )
}
