import { join } from 'path'
import * as fs from 'fs'
import { spawn } from 'child_process'
import { app } from 'electron'
import { logger } from './logger'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TranscriptWord {
  word: string
  start: number
  end: number
}

export interface TranscriptSegment {
  id: string
  text: string
  start: number
  end: number
  duration: number
  words: TranscriptWord[]
}

export interface TranscriptResult {
  language: string
  languageProbability?: number
  duration: number
  segments: TranscriptSegment[]
  fullText: string
  wordCount: number
  generatedAt: string
}

// ─── Paths ───────────────────────────────────────────────────────────────────

/** Path to uv binary */
const UV_PATH = 'C:\\Users\\ADMIN\\.local\\bin\\uv.exe'

/** Path to our Python transcription script */
function getScriptPath(): string {
  // In dev: relative to project root
  const devPath = join(app.getAppPath(), '..', 'scripts', 'transcribe.py')
  if (fs.existsSync(devPath)) return devPath
  // In prod: next to app executable
  return join(process.resourcesPath, 'scripts', 'transcribe.py')
}

/** Directory to cache Whisper models */
export function getModelsDir(): string {
  const dir = join(app.getPath('userData'), 'whisper-models')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ─── Main transcription function ─────────────────────────────────────────────

export async function transcribeAudio(
  audioPath: string,
  modelName: 'tiny' | 'base' | 'small' | 'medium' = 'base',
  onProgress?: (msg: string, progress: number) => void
): Promise<TranscriptResult> {
  const scriptPath = getScriptPath()
  const modelsDir = getModelsDir()

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Transcription script not found: ${scriptPath}`)
  }

  if (!fs.existsSync(UV_PATH)) {
    throw new Error(`uv not found at ${UV_PATH}. Please install uv: https://docs.astral.sh/uv/`)
  }

  logger.info('Starting transcription via uv + faster-whisper', {
    audio: audioPath,
    model: modelName,
    script: scriptPath
  })

  onProgress?.('Starting uv + faster-whisper...', 0.02)

  return new Promise<TranscriptResult>((resolve, reject) => {
    const args = [
      'run',
      scriptPath,
      audioPath,
      '--model', modelName,
      '--cache-dir', modelsDir
    ]

    logger.info(`Spawning: ${UV_PATH} ${args.join(' ')}`)

    const proc = spawn(UV_PATH, args, {
      env: { ...process.env },
      windowsHide: true
    })

    let resultData: TranscriptResult | null = null
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim())
      for (const line of lines) {
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'progress') {
            onProgress?.(msg.message, msg.progress)
            logger.info(`[WHISPER] ${msg.message}`)
          } else if (msg.type === 'result') {
            resultData = msg as TranscriptResult
          }
        } catch {
          // non-JSON line, ignore
          logger.debug(`[WHISPER stdout] ${line}`)
        }
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      // faster-whisper logs progress to stderr — relay useful lines
      const lines = chunk.toString().split('\n')
      for (const line of lines) {
        if (line.includes('Transcribing') || line.includes('Detected') || line.includes('%')) {
          onProgress?.(line.trim(), 0.5)
        }
      }
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        logger.error(`Transcription process exited ${code}`, { stderr: stderr.slice(0, 500) })
        reject(new Error(`Transcription failed (exit ${code}): ${stderr.slice(0, 300)}`))
        return
      }
      if (!resultData) {
        reject(new Error('Transcription produced no result'))
        return
      }
      logger.info('Transcription complete', {
        segments: resultData.segments.length,
        words: resultData.wordCount,
        duration: resultData.duration
      })
      resolve(resultData)
    })

    proc.on('error', (err) => {
      logger.error(`Failed to spawn transcription process: ${err.message}`)
      reject(new Error(`Failed to start transcription: ${err.message}`))
    })
  })
}
