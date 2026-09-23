import { join } from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { logger } from '../logger'

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
  duration: number
  segments: TranscriptSegment[]
  fullText: string
  wordCount: number
  generatedAt: string
}

// ─── Whisper model directory (inside app userData) ───────────────────────────
export function getModelsDir(): string {
  const dir = join(app.getPath('userData'), 'whisper-models')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ─── Parse nodejs-whisper output into our TranscriptResult ───────────────────
function parseWhisperOutput(
  raw: Array<{ start: number; end: number; speech: string }>,
  audioDurationSec: number
): TranscriptResult {
  const segments: TranscriptSegment[] = raw.map((seg, i) => ({
    id: `N${String(i + 1).padStart(3, '0')}`,
    text: seg.speech.trim(),
    start: seg.start,
    end: seg.end,
    duration: parseFloat((seg.end - seg.start).toFixed(3)),
    words: [] // word-level timing not always available from nodejs-whisper
  }))

  const fullText = segments.map((s) => s.text).join(' ')
  const wordCount = fullText.split(/\s+/).filter(Boolean).length

  return {
    language: 'auto',
    duration: audioDurationSec,
    segments,
    fullText,
    wordCount,
    generatedAt: new Date().toISOString()
  }
}

// ─── Main transcription function ──────────────────────────────────────────────
export async function transcribeAudio(
  audioPath: string,
  modelName: 'tiny' | 'base' | 'small' | 'medium' = 'base',
  onProgress?: (msg: string) => void
): Promise<TranscriptResult> {
  const { nodewhisper } = await import('nodejs-whisper')

  onProgress?.(`Loading Whisper model: ${modelName}`)
  logger.info(`Starting transcription: ${audioPath}`, { model: modelName })

  const modelsDir = getModelsDir()
  onProgress?.('Running Whisper transcription...')

  const result = await nodewhisper(audioPath, {
    modelName,
    autoDownloadModelName: modelName,
    removeWavFileAfterTranscription: false,
    withCuda: false,
    whisperOptions: {
      outputInJson: true,
      language: 'auto',
      wordTimestamps: true
    }
  })

  logger.info(`Transcription complete: ${result?.length ?? 0} segments`)

  // Get audio duration via ffprobe
  let audioDuration = 0
  try {
    const ffprobeStatic = await import('ffprobe-static')
    const { spawn } = await import('child_process')
    audioDuration = await new Promise<number>((resolve) => {
      const proc = spawn(ffprobeStatic.default.path, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        audioPath
      ])
      let out = ''
      proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
      proc.on('close', () => {
        try {
          const parsed = JSON.parse(out)
          resolve(parseFloat(parsed.format?.duration ?? '0'))
        } catch {
          resolve(0)
        }
      })
    })
  } catch { /* ignore */ }

  return parseWhisperOutput(result || [], audioDuration)
}
