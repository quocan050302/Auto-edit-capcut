import React, { useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ProgressLog } from './components/ProgressLog'
import { HomePage } from './pages/HomePage'
import { InputPage } from './pages/InputPage'
import { SettingsPage } from './pages/SettingsPage'
import { AnalysisPage } from './pages/AnalysisPage'
import { RenderPage, QAPage } from './pages/PlaceholderPages'
import { useProject } from './hooks/useProject'

type Page = 'home' | 'input' | 'settings' | 'analysis' | 'render' | 'qa'

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
    scanMedia
  } = useProject()

  function navigate(page: Page): void {
    if (page !== 'home' && !project) return
    setCurrentPage(page)
  }

  function handleScanComplete(): void {
    // Auto-navigate to analysis after scan
    setCurrentPage('analysis')
  }

  async function handleScanMedia(): Promise<void> {
    await scanMedia()
    handleScanComplete()
  }

  return (
    <div className="app-shell">
      <TitleBar projectName={project?.name ?? null} />

      <div className="app-body">
        <Sidebar project={project} currentPage={currentPage} onNavigate={navigate} />

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

      <ProgressLog logs={logs} scanProgress={isScanning ? scanProgress : null} />
    </div>
  )
}
