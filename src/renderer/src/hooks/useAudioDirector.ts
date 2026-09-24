import { useState, useCallback, useRef } from 'react'
import type { AudioPlan, AudioRunResult } from '../../../../shared/types'

interface AudioProgress {
  message: string
  progress: number
}

export interface UseAudioDirectorReturn {
  plan: AudioPlan | null
  isSearching: boolean
  isDownloading: boolean
  progress: AudioProgress | null
  downloadProgress: AudioProgress | null
  lastResult: AudioRunResult | null
  lastError: string | null
  runSearch: (projectDir: string) => Promise<void>
  loadPlan: (projectDir: string) => Promise<void>
  approveSection: (projectDir: string, sectionId: string, approved: boolean, opts?: { volumeDb?: number; fadeInSecs?: number; fadeOutSecs?: number }) => Promise<void>
  approveSfx: (projectDir: string, sceneIndex: number, approved: boolean, volumeDb?: number) => Promise<void>
  approveAll: (projectDir: string) => Promise<void>
  downloadApproved: (projectDir: string) => Promise<void>
}

export function useAudioDirector(
  addLog: (level: string, message: string, category?: string) => void
): UseAudioDirectorReturn {
  const [plan, setPlan] = useState<AudioPlan | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [progress, setProgress] = useState<AudioProgress | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<AudioProgress | null>(null)
  const [lastResult, setLastResult] = useState<AudioRunResult | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  const unsubSearch = useRef<(() => void) | null>(null)
  const unsubDownload = useRef<(() => void) | null>(null)

  const runSearch = useCallback(async (projectDir: string) => {
    setIsSearching(true)
    setLastError(null)
    setProgress({ message: 'Initialising…', progress: 0 })
    addLog('info', 'Smart Audio Director: starting search…', 'audio')

    unsubSearch.current?.()
    unsubSearch.current = window.api.audio.onProgress((data) => {
      setProgress(data)
    })

    try {
      const result = await window.api.audio.search({ projectDir })
      setLastResult(result)

      if (result.success) {
        const updatedPlan: AudioPlan = { generatedAt: new Date().toISOString(), sections: result.sections, sfxAssignments: result.sfxAssignments }
        setPlan(updatedPlan)
        const found = result.sections.filter((s) => s.status === 'found').length
        const downloaded = result.sections.filter((s) => s.approvedLocalPath).length
        addLog('success', `Audio complete: ${found}/${result.sections.length} music found, ${downloaded} downloaded, ${result.sfxAssignments.length} SFX`, 'audio')
        if (downloaded > 0) {
          addLog('info', `✅ Music ready — go to Render page and click Re-render to include background music`, 'audio')
        }
      } else {
        const errMsg = result.error ?? 'Search returned no results'
        setLastError(errMsg)
        addLog('error', `Audio search failed: ${errMsg}`, 'audio')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setLastError(msg)
      addLog('error', `Audio search error: ${msg}`, 'audio')
    } finally {
      setIsSearching(false)
      setProgress(null)
      unsubSearch.current?.()
    }
  }, [addLog])

  const loadPlan = useCallback(async (projectDir: string) => {
    try {
      const loaded = await window.api.audio.getPlan(projectDir)
      setPlan(loaded)
    } catch {
      // No plan yet — that's fine
    }
  }, [])

  const approveSection = useCallback(async (
    projectDir: string,
    sectionId: string,
    approved: boolean,
    opts: { volumeDb?: number; fadeInSecs?: number; fadeOutSecs?: number } = {}
  ) => {
    const result = await window.api.audio.approveSection({ projectDir, sectionId, approved, ...opts })
    if (result.success && result.plan) {
      setPlan(result.plan)
    }
  }, [])

  const approveSfx = useCallback(async (
    projectDir: string,
    sceneIndex: number,
    approved: boolean,
    volumeDb?: number
  ) => {
    const result = await window.api.audio.approveSfx({ projectDir, sceneIndex, approved, volumeDb })
    if (result.success && result.plan) {
      setPlan(result.plan)
    }
  }, [])

  const approveAll = useCallback(async (projectDir: string) => {
    if (!plan) return
    // Approve all found sections + all sfx candidates
    const updatedPlan = { ...plan }
    updatedPlan.sections = plan.sections.map((s) => ({
      ...s,
      approved: s.status === 'found'
    }))
    updatedPlan.sfxAssignments = plan.sfxAssignments.map((sfx) => ({
      ...sfx,
      approved: !!sfx.sfxCandidate
    }))
    await window.api.audio.savePlan({ projectDir, plan: updatedPlan })
    setPlan(updatedPlan)
    addLog('info', 'All available audio approved', 'audio')
  }, [plan, addLog])

  const downloadApproved = useCallback(async (projectDir: string) => {
    setIsDownloading(true)
    setDownloadProgress({ message: 'Starting downloads…', progress: 0 })
    addLog('info', 'Downloading approved audio tracks…', 'audio')

    unsubDownload.current?.()
    unsubDownload.current = window.api.audio.onDownloadProgress((data) => {
      setDownloadProgress(data)
    })

    try {
      const result = await window.api.audio.downloadApproved({ projectDir })
      if (result.success && result.plan) {
        setPlan(result.plan)
        const musicDone = result.plan.sections.filter((s) => s.approvedLocalPath).length
        const sfxDone = result.plan.sfxAssignments.filter((s) => s.approvedLocalPath).length
        addLog('success', `Downloads complete: ${musicDone} music tracks, ${sfxDone} SFX`, 'audio')
      } else {
        addLog('error', `Download failed: ${result.error}`, 'audio')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      addLog('error', `Download error: ${msg}`, 'audio')
    } finally {
      setIsDownloading(false)
      setDownloadProgress(null)
      unsubDownload.current?.()
    }
  }, [addLog])

  return {
    plan,
    isSearching,
    isDownloading,
    progress,
    downloadProgress,
    lastResult,
    lastError,
    runSearch,
    loadPlan,
    approveSection,
    approveSfx,
    approveAll,
    downloadApproved
  }
}
