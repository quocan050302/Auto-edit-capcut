import { useState, useEffect, useCallback, useRef } from 'react'
import {
  getActiveRunRenderSettings,
  type AutoPipelineState,
  type AutoPipelineOptions,
  type PipelineSnapshot,
  type PipelineStage,
  type PipelineRecoveryResult,
  type VideoAssemblyMode,
  type BackgroundMusicMode,
  type UpdateFinalRenderOptionsResult
} from '../../../../shared/types'

/**
 * Pure monotonic state reducer for AutoPipelineState / PipelineSnapshot updates.
 * Rejects stale snapshots (lower version for the same runId) and preserves
 * full options + effective renderSettings across compact progress broadcasts.
 */
export function mergeIncomingPipelineState(
  prev: AutoPipelineState | null,
  incoming: AutoPipelineState | PipelineSnapshot | null
): AutoPipelineState | null {
  if (!incoming) return null
  const incomingAsState = incoming as AutoPipelineState
  const incomingRenderSettings =
    incoming.renderSettings ??
    (incomingAsState.options ? getActiveRunRenderSettings(incomingAsState.options) : undefined)

  if (!prev) {
    return {
      ...incomingAsState,
      ...(incomingRenderSettings ? { renderSettings: incomingRenderSettings } : {})
    }
  }

  // If the incoming state is for the same run, enforce monotonic version ordering
  if (prev.runId === incoming.runId) {
    const prevVersion = prev.version ?? 0
    const incomingVersion = incoming.version ?? 0
    if (incomingVersion < prevVersion) {
      return prev
    }

    const effectiveRenderSettings = incomingRenderSettings ?? prev.renderSettings
    const mergedOptions: AutoPipelineOptions | undefined = incomingAsState.options
      ? {
          ...incomingAsState.options,
          ...(effectiveRenderSettings
            ? {
                assemblyMode: effectiveRenderSettings.assemblyMode,
                backgroundMusicMode: effectiveRenderSettings.backgroundMusicMode
              }
            : {})
        }
      : prev.options
      ? {
          ...prev.options,
          ...(effectiveRenderSettings
            ? {
                assemblyMode: effectiveRenderSettings.assemblyMode,
                backgroundMusicMode: effectiveRenderSettings.backgroundMusicMode
              }
            : {})
        }
      : undefined

    return {
      ...prev,
      ...incomingAsState,
      ...(mergedOptions ? { options: mergedOptions } : {}),
      ...(effectiveRenderSettings ? { renderSettings: effectiveRenderSettings } : {})
    }
  }

  // New runId replaces previous run state
  return {
    ...incomingAsState,
    ...(incomingRenderSettings ? { renderSettings: incomingRenderSettings } : {})
  }
}

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

  // Cập nhật snapshot theo thứ tự version đơn điệu, bỏ qua late events
  const updateStateIfNewer = useCallback((incoming: AutoPipelineState | PipelineSnapshot | null) => {
    if (!incoming) {
      setPipelineState(null)
      return
    }
    setPipelineState((prev) => mergeIncomingPipelineState(prev, incoming))
  }, [])

  // Tải trạng thái hiện tại từ main process
  const refreshStatus = useCallback(async () => {
    if (!projectDir) {
      setPipelineState(null)
      return
    }
    try {
      const state = await window.api.pipeline.getStatus(projectDir)
      if (isMountedRef.current && state) {
        updateStateIfNewer(state)
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [projectDir, updateStateIfNewer])

  // Lắng nghe progress event qua IPC với snapshot version check và cleanup đúng callback
  useEffect(() => {
    if (!projectDir) {
      setPipelineState(null)
      return
    }

    const unsubscribe = window.api.pipeline.onProgress((state) => {
      if (isMountedRef.current && state.projectDir === projectDir) {
        updateStateIfNewer(state)
      }
    })

    // Lấy snapshot mới nhất khi mount hoặc projectDir thay đổi
    refreshStatus()

    return () => {
      unsubscribe()
    }
  }, [projectDir, refreshStatus, updateStateIfNewer])

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
          updateStateIfNewer(res.state)
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
    [updateStateIfNewer]
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
        updateStateIfNewer(res.state)
      }
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      return false
    } finally {
      if (isMountedRef.current) setIsLoading(false)
    }
  }, [projectDir, updateStateIfNewer])

  const recoverPipeline = useCallback(async (): Promise<PipelineRecoveryResult | null> => {
    if (!projectDir) return null
    setIsLoading(true)
    setError(null)
    try {
      const res = await window.api.pipeline.recover(projectDir)
      if (!res.success) {
        setError(res.error || 'Failed to recover pipeline')
        return null
      }
      if (res.state && isMountedRef.current) {
        updateStateIfNewer(res.state)
      }
      return res.result ?? null
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      return null
    } finally {
      if (isMountedRef.current) setIsLoading(false)
    }
  }, [projectDir, updateStateIfNewer])

  const cancelPipeline = useCallback(async (): Promise<boolean> => {
    const target = pipelineState?.runId || projectDir
    if (!target) return false
    setIsLoading(true)
    try {
      const res = await window.api.pipeline.cancel(target)
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
  }, [pipelineState?.runId, projectDir])

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
          updateStateIfNewer(res.state)
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
    [projectDir, updateStateIfNewer]
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
          updateStateIfNewer(res.state)
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
    [projectDir, updateStateIfNewer]
  )

  const updateFinalRenderOptions = useCallback(
    async (params: {
      assemblyMode: VideoAssemblyMode
      backgroundMusicMode: BackgroundMusicMode
      runId?: string
      expectedStateVersion?: number
    }): Promise<UpdateFinalRenderOptionsResult> => {
      const targetProjectDir = projectDir || pipelineState?.projectDir
      const targetRunId = params.runId || pipelineState?.runId || ''
      if (!targetProjectDir) {
        return {
          success: false,
          appliedToActiveRun: false,
          errorCode: 'RUN_NOT_FOUND',
          error: 'No active project directory.'
        }
      }
      try {
        const res = await window.api.pipeline.updateFinalRenderOptions({
          projectDir: targetProjectDir,
          runId: targetRunId,
          assemblyMode: params.assemblyMode,
          backgroundMusicMode: params.backgroundMusicMode,
          ...(params.expectedStateVersion !== undefined
            ? { expectedStateVersion: params.expectedStateVersion }
            : {})
        })
        if (isMountedRef.current) {
          if (res.snapshot) {
            updateStateIfNewer(res.snapshot)
          } else if (
            res.success &&
            res.effectiveAssemblyMode &&
            res.effectiveBackgroundMusicMode
          ) {
            setPipelineState((prev) => {
              if (!prev || (res.runId && prev.runId !== res.runId)) return prev
              const nextVersion = res.stateVersion ?? prev.version
              if (nextVersion < prev.version) return prev
              return {
                ...prev,
                version: nextVersion,
                renderSettings: {
                  assemblyMode: res.effectiveAssemblyMode!,
                  backgroundMusicMode: res.effectiveBackgroundMusicMode!
                },
                options: prev.options
                  ? {
                      ...prev.options,
                      assemblyMode: res.effectiveAssemblyMode!,
                      backgroundMusicMode: res.effectiveBackgroundMusicMode!
                    }
                  : prev.options
              }
            })
          }
        }
        return res
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          success: false,
          appliedToActiveRun: false,
          errorCode: 'SAVE_FAILED',
          error: msg
        }
      }
    },
    [projectDir, pipelineState?.projectDir, pipelineState?.runId, updateStateIfNewer]
  )

  const isRunning = pipelineState?.overallStatus === 'running'

  return {
    pipelineState,
    isRunning,
    isLoading,
    error,
    startPipeline,
    resumePipeline,
    recoverPipeline,
    cancelPipeline,
    retryStage,
    runFromStage,
    refreshStatus,
    updateFinalRenderOptions
  }
}
