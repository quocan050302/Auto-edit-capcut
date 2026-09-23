import { IpcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { transcribeAudio, getModelsDir } from '../transcriber'
import type { TranscriptResult } from '../transcriber'
import { logger } from '../logger'

// IPC channel names for transcription
export const TRANSCRIBE_CHANNELS = {
  START: 'transcribe:start',
  PROGRESS: 'transcribe:progress',
  RESULT: 'transcribe:result',
  GET_TRANSCRIPT: 'transcribe:get',
  CHECK_MODEL: 'transcribe:check-model'
} as const

export function registerTranscribeHandlers(ipcMain: IpcMain): void {
  // Check if a model is already downloaded
  ipcMain.handle(TRANSCRIBE_CHANNELS.CHECK_MODEL, (_event, modelName: string) => {
    const modelsDir = getModelsDir()
    const modelFile = join(modelsDir, `ggml-${modelName}.bin`)
    return {
      exists: fs.existsSync(modelFile),
      path: modelFile,
      modelsDir
    }
  })

  // Get existing transcript
  ipcMain.handle(TRANSCRIBE_CHANNELS.GET_TRANSCRIPT, (_event, projectDir: string) => {
    const transcriptPath = join(projectDir, 'analysis', 'transcript.json')
    if (!fs.existsSync(transcriptPath)) return null
    try {
      return JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')) as TranscriptResult
    } catch {
      return null
    }
  })

  // Start transcription
  ipcMain.handle(
    TRANSCRIBE_CHANNELS.START,
    async (
      event,
      params: {
        projectDir: string
        voiceoverPath: string
        modelName: 'tiny' | 'base' | 'small' | 'medium'
        scriptPath: string | null
      }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)

      const sendProgress = (message: string, progress: number): void => {
        win?.webContents.send(TRANSCRIBE_CHANNELS.PROGRESS, { message, progress })
        logger.info(`[TRANSCRIBE] ${message} (${Math.round(progress * 100)}%)`)
      }

      try {
        sendProgress('Initializing Whisper...', 0.02)

        // Check if cached transcript exists and voiceover hasn't changed
        const transcriptPath = join(params.projectDir, 'analysis', 'transcript.json')
        const cacheMetaPath = join(params.projectDir, 'analysis', 'transcript-meta.json')

        if (fs.existsSync(cacheMetaPath) && fs.existsSync(transcriptPath)) {
          const meta = JSON.parse(fs.readFileSync(cacheMetaPath, 'utf-8'))
          const stat = fs.statSync(params.voiceoverPath)
          const currentHash = `${params.voiceoverPath}:${stat.size}:${stat.mtimeMs}`
          if (meta.hash === currentHash && meta.model === params.modelName) {
            sendProgress('Using cached transcript', 1.0)
            const cached = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'))
            return { success: true, transcript: cached, cached: true }
          }
        }

        sendProgress(`Downloading/loading model "${params.modelName}"...`, 0.05)

        const transcript = await transcribeAudio(
          params.voiceoverPath,
          params.modelName,
          (msg) => sendProgress(msg, 0.3)
        )

        sendProgress('Saving transcript...', 0.95)

        // Save transcript
        fs.mkdirSync(join(params.projectDir, 'analysis'), { recursive: true })
        fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2), 'utf-8')

        // Save cache metadata
        const stat = fs.statSync(params.voiceoverPath)
        fs.writeFileSync(
          cacheMetaPath,
          JSON.stringify({
            hash: `${params.voiceoverPath}:${stat.size}:${stat.mtimeMs}`,
            model: params.modelName,
            generatedAt: new Date().toISOString()
          }),
          'utf-8'
        )

        sendProgress(`Transcription complete — ${transcript.segments.length} segments`, 1.0)

        logger.info('Transcript saved', {
          segments: transcript.segments.length,
          words: transcript.wordCount,
          duration: transcript.duration
        })

        return { success: true, transcript, cached: false }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`Transcription failed: ${msg}`)
        sendProgress(`Error: ${msg}`, -1)
        return { success: false, error: msg }
      }
    }
  )
}
