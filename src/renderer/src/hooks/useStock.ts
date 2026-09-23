import { useState, useCallback, useRef } from 'react'
import type { StockRunResult, StockReviewData, StockAsset, LogEntry } from '../../../../shared/types'

interface StockProgress {
  message: string
  progress: number
}

interface StockHook {
  isRunning: boolean
  progress: StockProgress | null
  review: StockReviewData | null
  lastResult: StockRunResult | null
  runStockSearch: (projectDir: string) => Promise<void>
  loadReview: (projectDir: string) => Promise<void>
  replaceScene: (projectDir: string, sceneIndex: number, query: string) => Promise<StockAsset | null>
  lockScene: (projectDir: string, sceneIndex: number, locked: boolean) => Promise<void>
  uploadOwnMedia: (projectDir: string, sceneIndex: number) => Promise<void>
}

type AddLog = (entry: Omit<LogEntry, 'timestamp'>) => void

export function useStock(addLog: AddLog): StockHook {
  const [isRunning, setIsRunning] = useState(false)
  const [progress, setProgress] = useState<StockProgress | null>(null)
  const [review, setReview] = useState<StockReviewData | null>(null)
  const [lastResult, setLastResult] = useState<StockRunResult | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  const loadReview = useCallback(async (projectDir: string): Promise<void> => {
    try {
      const data = await window.api.stock.getReview(projectDir)
      setReview(data)
    } catch { /* project may not have stock data yet */ }
  }, [])

  const runStockSearch = useCallback(async (projectDir: string): Promise<void> => {
    setIsRunning(true)
    setProgress({ message: 'Initializing…', progress: 0 })

    if (unsubRef.current) unsubRef.current()
    unsubRef.current = window.api.stock.onProgress((data) => {
      setProgress(data)
      addLog({ level: 'info', message: data.message, category: 'stock' })
    })

    addLog({ level: 'info', message: 'Starting Stock Media Engine…', category: 'stock' })

    try {
      const result = await window.api.stock.run({ projectDir })
      setLastResult(result)

      if (result.success) {
        addLog({
          level: 'success',
          message: `Stock search done — ${result.assignedScenes}/${result.totalScenes} scenes assigned`,
          category: 'stock'
        })
        await loadReview(projectDir)
      } else {
        addLog({ level: 'error', message: result.error ?? 'Stock search failed', category: 'stock' })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      addLog({ level: 'error', message: `Stock search error: ${msg}`, category: 'stock' })
    } finally {
      setIsRunning(false)
      setProgress(null)
      if (unsubRef.current) {
        unsubRef.current()
        unsubRef.current = null
      }
    }
  }, [addLog, loadReview])

  const replaceScene = useCallback(async (
    projectDir: string,
    sceneIndex: number,
    query: string
  ): Promise<StockAsset | null> => {
    try {
      const res = await window.api.stock.replaceScene({ projectDir, sceneIndex, query })
      if (res.success && res.asset) {
        await loadReview(projectDir)
        addLog({ level: 'success', message: `Scene ${sceneIndex} replaced with "${query}"`, category: 'stock' })
        return res.asset
      } else {
        addLog({ level: 'error', message: res.error ?? 'Replace failed', category: 'stock' })
        return null
      }
    } catch (err: unknown) {
      addLog({ level: 'error', message: String(err), category: 'stock' })
      return null
    }
  }, [addLog, loadReview])

  const lockScene = useCallback(async (
    projectDir: string,
    sceneIndex: number,
    locked: boolean
  ): Promise<void> => {
    await window.api.stock.lockScene({ projectDir, sceneIndex, locked })
    await loadReview(projectDir)
    addLog({
      level: 'info',
      message: `Scene ${sceneIndex} ${locked ? 'locked' : 'unlocked'}`,
      category: 'stock'
    })
  }, [addLog, loadReview])

  const uploadOwnMedia = useCallback(async (
    projectDir: string,
    sceneIndex: number
  ): Promise<void> => {
    const filePath = await window.api.selectFile({
      title: 'Select media for scene',
      filters: [
        { name: 'Video & Images', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'jpg', 'jpeg', 'png', 'webp'] }
      ]
    })
    if (!filePath) return

    const res = await window.api.stock.uploadOwnMedia({ projectDir, sceneIndex, filePath })
    if (res.success) {
      await loadReview(projectDir)
      addLog({ level: 'success', message: `Scene ${sceneIndex}: own media uploaded`, category: 'stock' })
    } else {
      addLog({ level: 'error', message: res.error ?? 'Upload failed', category: 'stock' })
    }
  }, [addLog, loadReview])

  return {
    isRunning,
    progress,
    review,
    lastResult,
    runStockSearch,
    loadReview,
    replaceScene,
    lockScene,
    uploadOwnMedia
  }
}
