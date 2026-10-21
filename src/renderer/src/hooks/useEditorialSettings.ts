import { useState, useEffect, useCallback, useRef } from 'react'
import type { EditorialGenerationSettings } from '../../../../shared/types'

export const DEFAULT_EDITORIAL_SETTINGS: EditorialGenerationSettings = {
  schemaVersion: 1,
  promptMode: 'classic',
  labelDensity: 'minimal',
  readability: 'standard',
  preferLeaderLines: true,
  renderOverlayMode: 'full'
}

export interface UseEditorialSettingsResult {
  settings: EditorialGenerationSettings
  isLoading: boolean
  isSaving: boolean
  error: string | null
  updateSettings: (patch: Partial<EditorialGenerationSettings>) => Promise<boolean>
  reloadSettings: () => Promise<void>
  waitForPendingSaves: () => Promise<EditorialGenerationSettings>
  hasPendingSaves: boolean
}

/**
 * Hook to manage persistent Editorial Generation Settings for a project.
 * Guaranteed:
 * - Project isolation: Late responses from project A never overwrite project B.
 * - Concurrency control: Fast consecutive checkbox toggles are serialized in a FIFO queue.
 * - Optimistic UI with rollback on error.
 * - No memory leaks or unmounted state updates.
 */
export function useEditorialSettings(projectDir?: string | null): UseEditorialSettingsResult {
  const [settings, setSettings] = useState<EditorialGenerationSettings>(DEFAULT_EDITORIAL_SETTINGS)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  const currentProjectDirRef = useRef<string | null>(projectDir ?? null)
  const confirmedSettingsRef = useRef<EditorialGenerationSettings>(DEFAULT_EDITORIAL_SETTINGS)
  const optimisticSettingsRef = useRef<EditorialGenerationSettings>(DEFAULT_EDITORIAL_SETTINGS)
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true))
  const pendingCountRef = useRef(0)

  useEffect(() => {
    isMountedRef.current = true
    currentProjectDirRef.current = projectDir ?? null
    return () => {
      isMountedRef.current = false
    }
  }, [projectDir])

  const reloadSettings = useCallback(async (): Promise<void> => {
    if (!projectDir) {
      if (isMountedRef.current) {
        setSettings(DEFAULT_EDITORIAL_SETTINGS)
        confirmedSettingsRef.current = DEFAULT_EDITORIAL_SETTINGS
        optimisticSettingsRef.current = DEFAULT_EDITORIAL_SETTINGS
        setError(null)
      }
      return
    }

    if (!window.api?.manualAi?.getEditorialSettings) {
      if (isMountedRef.current) {
        setError('Manual AI bridge unavailable.')
      }
      return
    }

    const requestedDir = projectDir
    if (isMountedRef.current) {
      setIsLoading(true)
      setError(null)
    }

    try {
      const res = await window.api.manualAi.getEditorialSettings(requestedDir)
      if (!isMountedRef.current || currentProjectDirRef.current !== requestedDir) {
        return
      }

      if (res.success && res.settings) {
        setSettings(res.settings)
        confirmedSettingsRef.current = res.settings
        optimisticSettingsRef.current = res.settings
        setError(null)
      } else {
        const errMsg = res.error || 'Failed to load editorial settings.'
        setError(errMsg)
      }
    } catch (err) {
      if (!isMountedRef.current || currentProjectDirRef.current !== requestedDir) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      if (isMountedRef.current && currentProjectDirRef.current === requestedDir) {
        setIsLoading(false)
      }
    }
  }, [projectDir])

  // Load settings whenever projectDir changes
  useEffect(() => {
    void reloadSettings()
  }, [projectDir, reloadSettings])

  const updateSettings = useCallback(
    async (patch: Partial<EditorialGenerationSettings>): Promise<boolean> => {
      const targetDir = currentProjectDirRef.current
      if (!targetDir) {
        setError('No active project directory.')
        return false
      }

      if (!window.api?.manualAi?.updateEditorialSettings) {
        setError('Manual AI settings API unavailable.')
        return false
      }

      // Optimistic merge based on the latest state
      const nextOptimistic: EditorialGenerationSettings = {
        ...optimisticSettingsRef.current,
        ...patch,
        schemaVersion: 1
      }
      optimisticSettingsRef.current = nextOptimistic
      if (isMountedRef.current) {
        setSettings(nextOptimistic)
        setError(null)
      }

      pendingCountRef.current += 1
      if (isMountedRef.current) {
        setIsSaving(true)
      }

      // Chain through serialized queue
      const queuedOperation = saveQueueRef.current.then(async () => {
        try {
          if (currentProjectDirRef.current !== targetDir) {
            return false
          }

          const res = await window.api.manualAi.updateEditorialSettings(targetDir, patch)
          if (!isMountedRef.current || currentProjectDirRef.current !== targetDir) {
            return res.success
          }

          if (res.success && res.settings) {
            confirmedSettingsRef.current = res.settings
            // If no more pending changes, synchronize confirmed state
            if (pendingCountRef.current <= 1) {
              optimisticSettingsRef.current = res.settings
              setSettings(res.settings)
            }
            return true
          } else {
            const msg = res.error || 'Failed to persist editorial settings.'
            setError(msg)
            // Rollback to last confirmed settings
            optimisticSettingsRef.current = confirmedSettingsRef.current
            setSettings(confirmedSettingsRef.current)
            return false
          }
        } catch (err) {
          if (isMountedRef.current && currentProjectDirRef.current === targetDir) {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg)
            optimisticSettingsRef.current = confirmedSettingsRef.current
            setSettings(confirmedSettingsRef.current)
          }
          return false
        } finally {
          pendingCountRef.current = Math.max(0, pendingCountRef.current - 1)
          if (isMountedRef.current && pendingCountRef.current === 0) {
            setIsSaving(false)
          }
        }
      })

      saveQueueRef.current = queuedOperation.catch(() => false)
      return queuedOperation
    },
    []
  )

  const waitForPendingSaves = useCallback(async (): Promise<EditorialGenerationSettings> => {
    await saveQueueRef.current
    return confirmedSettingsRef.current
  }, [])

  return {
    settings,
    isLoading,
    isSaving,
    error,
    updateSettings,
    reloadSettings,
    waitForPendingSaves,
    hasPendingSaves: pendingCountRef.current > 0
  }
}
