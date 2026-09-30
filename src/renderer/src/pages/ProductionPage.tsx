import React from 'react'
import type { ProjectState } from '../../../../shared/types'
import { usePipeline } from '../hooks/usePipeline'
import { ClientPipelineDashboard } from '../components/ClientPipelineDashboard'

export interface ProductionPageProps {
  project: ProjectState
  onNavigate: (page: string) => void
}

export function ProductionPage({ project, onNavigate }: ProductionPageProps): React.ReactElement {
  const {
    pipelineState,
    isRunning,
    cancelPipeline,
    resumePipeline,
    retryStage
  } = usePipeline(project.projectDir)

  return (
    <ClientPipelineDashboard
      project={project}
      pipelineState={pipelineState}
      isRunning={isRunning}
      onCancel={cancelPipeline}
      onResume={resumePipeline}
      onRetryStage={retryStage}
      onNavigate={onNavigate}
    />
  )
}
