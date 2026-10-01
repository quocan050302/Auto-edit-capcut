import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  ThumbnailJobState,
  ThumbnailCandidate,
  ThumbnailProviderHealth,
  ProjectThumbnailSettings,
  ThumbnailPromptTemplate,
  ThumbnailProgressPayload
} from '../../../../shared/types'

export interface UseThumbnailStudioResult {
  jobState: ThumbnailJobState | null
  health: ThumbnailProviderHealth | null
  settings: ProjectThumbnailSettings | null
  templates: ThumbnailPromptTemplate[]
  isLoading: boolean
  isCheckingHealth: boolean
  activeRound: number
  setActiveRound: (round: number) => void
  checkHealth: (bridgeUrl?: string) => Promise<ThumbnailProviderHealth>
  startGeneration: (forceRestart?: boolean) => Promise<boolean>
  resumeJob: () => Promise<boolean>
  cancelJob: () => Promise<boolean>
  generateMore: (templateId?: string, templateSnapshot?: string) => Promise<boolean>
  retryCandidate: (candidateId: string) => Promise<boolean>
  regenerateCandidate: (candidateId: string, customPrompt?: string) => Promise<boolean>
  export4k: (candidateId: string) => Promise<boolean>
  selectCandidate: (candidateId: string) => Promise<boolean>
  openFolder: (folderPath?: string) => Promise<void>
  openGoogleFlow: () => Promise<void>
  refresh: () => Promise<void>
}

export function useThumbnailStudio(projectDir?: string): UseThumbnailStudioResult {
  const [jobState, setJobState] = useState<ThumbnailJobState | null>(null)
  const [health, setHealth] = useState<ThumbnailProviderHealth | null>(null)
  const [settings, setSettings] = useState<ProjectThumbnailSettings | null>(null)
  const [templates, setTemplates] = useState<ThumbnailPromptTemplate[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [isCheckingHealth, setIsCheckingHealth] = useState<boolean>(false)
  const [activeRound, setActiveRound] = useState<number>(1)

  const activeRoundRef = useRef<number>(1)
  activeRoundRef.current = activeRound

  const refresh = useCallback(async () => {
    if (!projectDir) {
      setIsLoading(false)
      return
    }

    try {
      const [jobRes, settingsRes, templatesRes] = await Promise.all([
        window.api.thumbnail.jobs.get(projectDir),
        window.api.thumbnail.settings.get(projectDir),
        window.api.thumbnail.templates.list()
      ])

      if (jobRes.success && jobRes.state) {
        setJobState(jobRes.state)
        if (jobRes.state.generationRound && jobRes.state.generationRound !== activeRoundRef.current) {
          setActiveRound(jobRes.state.generationRound)
        }
      }

      if (settingsRes.success && settingsRes.settings) {
        setSettings(settingsRes.settings)
      }

      if (templatesRes.success && templatesRes.templates) {
        setTemplates(templatesRes.templates)
      }
    } catch (err) {
      console.error('[useThumbnailStudio] Failed to refresh state:', err)
    } finally {
      setIsLoading(false)
    }
  }, [projectDir])

  const checkHealth = useCallback(async (bridgeUrl?: string): Promise<ThumbnailProviderHealth> => {
    setIsCheckingHealth(true)
    try {
      const res = await window.api.thumbnail.flow.checkHealth(bridgeUrl)
      setHealth(res)
      return res
    } finally {
      setIsCheckingHealth(false)
    }
  }, [])

  // Initial load & health check
  useEffect(() => {
    refresh()
    checkHealth()
  }, [refresh, checkHealth])

  // Listen to realtime progress updates
  useEffect(() => {
    const unsubscribe = window.api.thumbnail.onProgress((payload: ThumbnailProgressPayload) => {
      if (projectDir && payload.projectDir === projectDir) {
        if (payload.jobState) {
          setJobState(payload.jobState)
          if (payload.jobState.generationRound) {
            setActiveRound(payload.jobState.generationRound)
          }
        } else if (payload.candidate) {
          setJobState((prev) => {
            if (!prev) return null
            const updatedCandidates = prev.candidates.map((c) =>
              c.id === payload.candidate!.id ? payload.candidate! : c
            )
            return {
              ...prev,
              status: payload.status,
              candidates: updatedCandidates
            }
          })
        }
      }
    })

    return () => {
      unsubscribe()
    }
  }, [projectDir])

  const startGeneration = useCallback(
    async (forceRestart = false): Promise<boolean> => {
      if (!projectDir) return false
      try {
        const res = await window.api.thumbnail.jobs.start({
          projectDir,
          templateId: settings?.selectedTemplateId,
          templateSnapshot: settings?.templateSnapshot,
          generationRound: activeRound,
          forceRestart
        })
        if (res.success && res.state) {
          setJobState(res.state)
          return true
        }
        return false
      } catch (err) {
        console.error('[useThumbnailStudio] Start generation failed:', err)
        return false
      }
    },
    [projectDir, settings, activeRound]
  )

  const resumeJob = useCallback(async (): Promise<boolean> => {
    if (!projectDir) return false
    try {
      const res = await window.api.thumbnail.jobs.resume(projectDir)
      if (res.success && res.state) {
        setJobState(res.state)
        return true
      }
      return false
    } catch (err) {
      console.error('[useThumbnailStudio] Resume failed:', err)
      return false
    }
  }, [projectDir])

  const cancelJob = useCallback(async (): Promise<boolean> => {
    if (!projectDir) return false
    try {
      const res = await window.api.thumbnail.jobs.cancel(projectDir)
      if (res.success) {
        await refresh()
        return true
      }
      return false
    } catch (err) {
      console.error('[useThumbnailStudio] Cancel failed:', err)
      return false
    }
  }, [projectDir, refresh])

  const generateMore = useCallback(
    async (templateId?: string, templateSnapshot?: string): Promise<boolean> => {
      if (!projectDir) return false
      try {
        const res = await window.api.thumbnail.jobs.generateMore({
          projectDir,
          templateId: templateId || settings?.selectedTemplateId,
          templateSnapshot: templateSnapshot || settings?.templateSnapshot
        })
        if (res.success && res.state) {
          setJobState(res.state)
          setActiveRound(res.state.generationRound)
          return true
        }
        return false
      } catch (err) {
        console.error('[useThumbnailStudio] Generate more failed:', err)
        return false
      }
    },
    [projectDir, settings]
  )

  const retryCandidate = useCallback(
    async (candidateId: string): Promise<boolean> => {
      if (!projectDir) return false
      try {
        const res = await window.api.thumbnail.candidates.retry({ projectDir, candidateId })
        if (res.success && res.candidate) {
          setJobState((prev) => {
            if (!prev) return null
            return {
              ...prev,
              candidates: prev.candidates.map((c) => (c.id === candidateId ? res.candidate! : c))
            }
          })
          return true
        }
        return false
      } catch (err) {
        console.error('[useThumbnailStudio] Retry candidate failed:', err)
        return false
      }
    },
    [projectDir]
  )

  const regenerateCandidate = useCallback(
    async (candidateId: string, customPrompt?: string): Promise<boolean> => {
      if (!projectDir) return false
      try {
        const res = await window.api.thumbnail.candidates.regenerate({
          projectDir,
          candidateId,
          customPrompt
        })
        if (res.success && res.candidate) {
          setJobState((prev) => {
            if (!prev) return null
            return {
              ...prev,
              candidates: prev.candidates.map((c) => (c.id === candidateId ? res.candidate! : c))
            }
          })
          return true
        }
        return false
      } catch (err) {
        console.error('[useThumbnailStudio] Regenerate candidate failed:', err)
        return false
      }
    },
    [projectDir]
  )

  const export4k = useCallback(
    async (candidateId: string): Promise<boolean> => {
      if (!projectDir) return false
      try {
        const res = await window.api.thumbnail.candidates.export4k({ projectDir, candidateId })
        if (res.success && res.candidate) {
          setJobState((prev) => {
            if (!prev) return null
            return {
              ...prev,
              candidates: prev.candidates.map((c) => (c.id === candidateId ? res.candidate! : c))
            }
          })
          return true
        }
        return false
      } catch (err) {
        console.error('[useThumbnailStudio] Export 4k failed:', err)
        return false
      }
    },
    [projectDir]
  )

  const selectCandidate = useCallback(
    async (candidateId: string): Promise<boolean> => {
      if (!projectDir) return false
      try {
        const res = await window.api.thumbnail.candidates.select({ projectDir, candidateId })
        if (res.success) {
          setJobState((prev) => (prev ? { ...prev, selectedCandidateId: candidateId } : null))
          return true
        }
        return false
      } catch (err) {
        console.error('[useThumbnailStudio] Select candidate failed:', err)
        return false
      }
    },
    [projectDir]
  )

  const openFolder = useCallback(
    async (folderPath?: string): Promise<void> => {
      if (!projectDir) return
      await window.api.thumbnail.openFolder({ projectDir, folderPath })
    },
    [projectDir]
  )

  const openGoogleFlow = useCallback(async (): Promise<void> => {
    await window.api.thumbnail.flow.openFlow()
  }, [])

  return {
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
    openGoogleFlow,
    refresh
  }
}
