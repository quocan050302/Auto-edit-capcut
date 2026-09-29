import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  AutoPipelineState,
  AutoPipelineOptions,
  PipelineStage
} from '../../../../shared/types'

export function usePipeline(projectDir?: string | null) {
  const [pipelineState, setPipelineState] = useState<AutoPipelineState | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Tải trạng thái hiện tại khi mở project
  const refreshStatus = useCallback(async () => {
    if (!projectDir) {
      setPipelineState(null)
      return
    }
    try {
      const state = await window.api.pipeline.getStatus(projectDir)
      if (isMountedRef.current) {
        setPipelineState(state)
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [projectDir])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  // Lắng nghe progress event qua IPC với unsubscribe cleanup
  useEffect(() => {
    if (!projectDir) return

    const unsubscribe = window.api.pipeline.onProgress((state) => {
      if (isMountedRef.current && state.projectDir === projectDir) {
        setPipelineState(state)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [projectDir])

  const startPipeline = useCallback(
    async (options: AutoPipelineOptions): Promise<boolean> => {
      setIsLoading(true)
      setError(null)
      try {
        const res = await window.api.pipeline.start(options)
        if (!res.success) {
          setError(res.error || 'Failed to start pipeline')
          return false
        }
        if (res.state && isMountedRef.current) {
          setPipelineState(res.state)
        }
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        return false
      } finally {
        if (isMountedRef.current) setIsLoading(false)
      }
    },
    []
  )

  const resumePipeline = useCallback(async (): Promise<boolean> => {
    if (!projectDir) return false
    setIsLoading(true)
    setError(null)
    try {
      const res = await window.api.pipeline.resume(projectDir)
      if (!res.success) {
        setError(res.error || 'Failed to resume pipeline')
        return false
      }
      if (res.state && isMountedRef.current) {
        setPipelineState(res.state)
      }
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      return false
    } finally {
      if (isMountedRef.current) setIsLoading(false)
    }
  }, [projectDir])

  const cancelPipeline = useCallback(async (): Promise<boolean> => {
    if (!pipelineState?.runId) return false
    setIsLoading(true)
    try {
      const res = await window.api.pipeline.cancel(pipelineState.runId)
      if (res.success && isMountedRef.current) {
        setPipelineState((prev) =>
          prev ? { ...prev, overallStatus: 'cancelled' } : null
        )
      }
      return res.success
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      return false
    } finally {
      if (isMountedRef.current) setIsLoading(false)
    }
  }, [pipelineState?.runId])

  const retryStage = useCallback(
    async (stage: PipelineStage): Promise<boolean> => {
      if (!projectDir) return false
      setIsLoading(true)
      setError(null)
      try {
        const res = await window.api.pipeline.retryStage(projectDir, stage)
        if (!res.success) {
          setError(res.error || `Failed to retry stage: ${stage}`)
          return false
        }
        if (res.state && isMountedRef.current) {
          setPipelineState(res.state)
        }
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        return false
      } finally {
        if (isMountedRef.current) setIsLoading(false)
      }
    },
    [projectDir]
  )

  const runFromStage = useCallback(
    async (stage: PipelineStage, options?: Partial<AutoPipelineOptions>): Promise<boolean> => {
      if (!projectDir) return false
      setIsLoading(true)
      setError(null)
      try {
        const res = await window.api.pipeline.runFromStage(projectDir, stage, options)
        if (!res.success) {
          setError(res.error || `Failed to run from stage: ${stage}`)
          return false
        }
        if (res.state && isMountedRef.current) {
          setPipelineState(res.state)
        }
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        return false
      } finally {
        if (isMountedRef.current) setIsLoading(false)
      }
    },
    [projectDir]
  )

  const isRunning = pipelineState?.overallStatus === 'running'

  return {
    pipelineState,
    isRunning,
    isLoading,
    error,
    startPipeline,
    resumePipeline,
    cancelPipeline,
    retryStage,
    runFromStage,
    refreshStatus
  }
}
