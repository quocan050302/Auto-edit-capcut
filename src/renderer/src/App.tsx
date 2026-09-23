import React, { useState, useEffect } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ProgressLog } from './components/ProgressLog'
import { HomePage } from './pages/HomePage'
import { InputPage } from './pages/InputPage'
import { SettingsPage } from './pages/SettingsPage'
import { AnalysisPage } from './pages/AnalysisPage'
import { TranscriptionPage } from './pages/TranscriptionPage'
import { RenderPage, QAPage } from './pages/PlaceholderPages'
import { useProject } from './hooks/useProject'
import { useTranscribe } from './hooks/useTranscribe'

type Page = 'home' | 'input' | 'transcribe' | 'settings' | 'analysis' | 'render' | 'qa'

export default function App(): React.ReactElement {
  const [currentPage, setCurrentPage] = useState<Page>('home')

  const {
    project,
    logs,
    scanResult,
    scanProgress,
    isScanning,
    createProject,
    openProject,
    updateInputs,
    updateSettings,
    scanMedia,
    addLog
  } = useProject()

  const {
    transcript,
    isTranscribing,
    transcribeProgress,
    startTranscription,
    loadCachedTranscript
  } = useTranscribe(addLog)

  // Load cached transcript when project opens
  useEffect(() => {
    if (project?.projectDir) {
      loadCachedTranscript(project.projectDir)
    }
  }, [project?.projectDir])

  function navigate(page: Page): void {
    if (page !== 'home' && !project) return
    setCurrentPage(page)
  }

  async function handleScanMedia(): Promise<void> {
    await scanMedia()
    setCurrentPage('analysis')
  }

  async function handleTranscribe(modelName: 'tiny' | 'base' | 'small' | 'medium'): Promise<void> {
    if (!project) return
    await startTranscription({
      projectDir: project.projectDir,
      voiceoverPath: project.inputs.voiceoverPath!,
      modelName,
      scriptPath: project.inputs.scriptPath
    })
  }

  const activeLogs = logs
  const activeProgress = isScanning ? scanProgress : isTranscribing ? transcribeProgress : null

  return (
    <div className="app-shell">
      <TitleBar projectName={project?.name ?? null} />

      <div className="app-body">
        <Sidebar
          project={project}
          currentPage={currentPage}
          onNavigate={navigate}
          hasTranscript={transcript !== null}
        />

        <div className="main-content">
          {currentPage === 'home' && (
            <HomePage
              onCreate={createProject}
              onOpen={openProject}
              onNavigate={(p) => navigate(p)}
            />
          )}

          {currentPage === 'input' && project && (
            <InputPage
              project={project}
              onUpdateInputs={updateInputs}
              onScanMedia={handleScanMedia}
              isScanning={isScanning}
            />
          )}

          {currentPage === 'transcribe' && project && (
            <TranscriptionPage
              project={project}
              transcript={transcript}
              isTranscribing={isTranscribing}
              transcribeProgress={transcribeProgress}
              onStartTranscription={handleTranscribe}
            />
          )}

          {currentPage === 'settings' && project && (
            <SettingsPage project={project} onUpdateSettings={updateSettings} />
          )}

          {currentPage === 'analysis' && project && (
            <AnalysisPage project={project} scanResult={scanResult} />
          )}

          {currentPage === 'render' && <RenderPage />}

          {currentPage === 'qa' && <QAPage />}
        </div>
      </div>

      <ProgressLog logs={activeLogs} scanProgress={activeProgress} />
    </div>
  )
}
