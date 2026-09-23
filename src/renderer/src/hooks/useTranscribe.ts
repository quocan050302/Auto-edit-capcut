import { useState, useCallback, useRef } from 'react'
import type { LogEntry, TranscriptResult } from '../../../../shared/types'

// Re-export for consumers
export type { TranscriptResult }
// Alias for convenience
export type TranscriptData = TranscriptResult

interface TranscribeHook {
  transcript: TranscriptData | null
  isTranscribing: boolean
  transcribeProgress: { message: string; progress: number } | null
  startTranscription: (params: {
    projectDir: string
    voiceoverPath: string
    modelName: 'tiny' | 'base' | 'small' | 'medium'
    scriptPath: string | null
  }) => Promise<boolean>
  loadCachedTranscript: (projectDir: string) => Promise<void>
}

export function useTranscribe(
  addLog: (entry: Omit<LogEntry, 'timestamp'>) => void
): TranscribeHook {
  const [transcript, setTranscript] = useState<TranscriptData | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [transcribeProgress, setTranscribeProgress] = useState<{
    message: string
    progress: number
  } | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  const loadCachedTranscript = useCallback(async (projectDir: string): Promise<void> => {
    const cached = await window.api.transcribe.getTranscript(projectDir)
    if (cached) {
      setTranscript(cached as TranscriptData)
      addLog({ level: 'info', message: 'Loaded cached transcript', category: 'transcribe' })
    }
  }, [addLog])

  const startTranscription = useCallback(
    async (params: {
      projectDir: string
      voiceoverPath: string
      modelName: 'tiny' | 'base' | 'small' | 'medium'
      scriptPath: string | null
    }): Promise<boolean> => {
      setIsTranscribing(true)
      setTranscribeProgress({ message: 'Starting...', progress: 0 })

      // Subscribe to progress
      if (unsubRef.current) unsubRef.current()
      unsubRef.current = window.api.transcribe.onProgress((data) => {
        setTranscribeProgress(data)
        if (data.progress >= 0) {
          addLog({ level: 'info', message: data.message, category: 'transcribe' })
        }
      })

      addLog({
        level: 'info',
        message: `Starting Whisper transcription (model: ${params.modelName})...`,
        category: 'transcribe'
      })

      try {
        const result = await window.api.transcribe.start(params)

        if (result.success && result.transcript) {
          setTranscript(result.transcript as TranscriptData)
          addLog({
            level: 'success',
            message: `Transcription complete${result.cached ? ' (cached)' : ''} — ${result.transcript.segments.length} segments, ${result.transcript.wordCount} words`,
            category: 'transcribe'
          })
          return true
        } else {
          addLog({
            level: 'error',
            message: `Transcription failed: ${result.error ?? 'Unknown error'}`,
            category: 'transcribe'
          })
          return false
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        addLog({ level: 'error', message: `Transcription error: ${msg}`, category: 'transcribe' })
        return false
      } finally {
        setIsTranscribing(false)
        setTranscribeProgress(null)
        if (unsubRef.current) {
          unsubRef.current()
          unsubRef.current = null
        }
      }
    },
    [addLog]
  )

  return { transcript, isTranscribing, transcribeProgress, startTranscription, loadCachedTranscript }
}
