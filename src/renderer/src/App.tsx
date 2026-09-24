import React, { useState, useEffect } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ProgressLog } from './components/ProgressLog'
import { HomePage } from './pages/HomePage'
import { InputPage } from './pages/InputPage'
import { SettingsPage } from './pages/SettingsPage'
import { AnalysisPage } from './pages/AnalysisPage'
import { TranscriptionPage } from './pages/TranscriptionPage'
import { PlanningPage } from './pages/PlanningPage'
import { RenderPage } from './pages/RenderPage'
import { QAPage } from './pages/PlaceholderPages'
import { StockPage } from './pages/StockPage'
import { AudioDirectorPage } from './pages/AudioDirectorPage'
import { useProject } from './hooks/useProject'
import { useTranscribe } from './hooks/useTranscribe'
import { useStock } from './hooks/useStock'
import { useAudioDirector } from './hooks/useAudioDirector'

type Page = 'home' | 'input' | 'transcribe' | 'planning' | 'stock' | 'audio' | 'settings' | 'analysis' | 'render' | 'qa'

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

  const {
    isRunning: isStockRunning,
    progress: stockProgress,
    review: stockReview,
    runStockSearch,
    loadReview: loadStockReview,
    replaceScene: stockReplace,
    lockScene: stockLock,
    uploadOwnMedia: stockUpload
  } = useStock(addLog)

  const audioDirector = useAudioDirector(
    (level, message, category) => addLog({ level: level as 'info' | 'warn' | 'error' | 'success' | 'debug', message, category })
  )

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

  async function handleCreateProject(name: string): Promise<void> {
    const ok = await createProject(name)
    if (ok) navigate('input')
  }

  async function handleOpenProject(): Promise<void> {
    const ok = await openProject()
    if (ok) navigate('input')
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
  const activeProgress = isScanning ? scanProgress
    : isTranscribing ? transcribeProgress
    : isStockRunning ? stockProgress
    : audioDirector.isSearching ? audioDirector.progress
    : audioDirector.isDownloading ? audioDirector.downloadProgress
    : null

  return (
    <div className="app-shell">
      <TitleBar projectName={project?.name ?? null} />

      <div className="app-body">
        <Sidebar
          project={project}
          currentPage={currentPage}
          onNavigate={navigate}
          hasTranscript={transcript !== null}
          stockCoverage={stockReview ? { assigned: stockReview.assignedScenes, total: stockReview.totalScenes } : null}
          audioCoverage={audioDirector.plan ? {
            approved: audioDirector.plan.sections.filter((s) => s.approved).length,
            total: audioDirector.plan.sections.length
          } : null}
        />

        <div className="main-content">
          {currentPage === 'home' && (
            <HomePage
              onCreate={handleCreateProject}
              onOpen={handleOpenProject}
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

          {currentPage === 'planning' && project && (
            <PlanningPage project={project} />
          )}

          {currentPage === 'stock' && project && (
            <StockPage
              project={project}
              review={stockReview}
              isRunning={isStockRunning}
              progress={stockProgress}
              onRun={() => runStockSearch(project.projectDir)}
              onReplace={(idx, q) => stockReplace(project.projectDir, idx, q)}
              onLock={(idx, locked) => stockLock(project.projectDir, idx, locked)}
              onUpload={(idx) => stockUpload(project.projectDir, idx)}
              onLoad={() => loadStockReview(project.projectDir)}
            />
          )}

          {currentPage === 'audio' && project && (
            <AudioDirectorPage
              project={project}
              audioDirector={audioDirector}
            />
          )}

          {currentPage === 'settings' && project && (
            <SettingsPage project={project} onUpdateSettings={updateSettings} />
          )}

          {currentPage === 'analysis' && project && (
            <AnalysisPage project={project} scanResult={scanResult} />
          )}

          {currentPage === 'render' && project && <RenderPage project={project} />}

          {currentPage === 'qa' && <QAPage />}
        </div>
      </div>

      <ProgressLog logs={activeLogs} scanProgress={activeProgress} />
    </div>
  )
}
