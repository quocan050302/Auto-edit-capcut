import { join } from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { spawn, execSync } from 'child_process'
import { app } from 'electron'
import { logger } from './logger'
import type { TranscriptResult } from '../../../shared/types'

export type { TranscriptResult }

/** Dynamically find path to uv binary across macOS, Linux, and Windows */
export function getUvPath(): string {
  if (process.env.UV_PATH && fs.existsSync(process.env.UV_PATH)) {
    return process.env.UV_PATH
  }

  // Check via which / where
  try {
    const cmd = process.platform === 'win32' ? 'where uv' : 'which uv'
    const out = execSync(cmd, { encoding: 'utf8', env: process.env }).trim().split(/\r?\n/)[0].trim()
    if (out && fs.existsSync(out)) {
      return out
    }
  } catch {
    // not in default PATH
  }

  const homedir = os.homedir()
  const candidates = process.platform === 'win32'
    ? [
        join(homedir, '.local', 'bin', 'uv.exe'),
        join(homedir, '.cargo', 'bin', 'uv.exe'),
        'C:\\Users\\ADMIN\\.local\\bin\\uv.exe'
      ]
    : [
        join(homedir, '.local', 'bin', 'uv'),
        join(homedir, '.cargo', 'bin', 'uv'),
        '/opt/homebrew/bin/uv',
        '/usr/local/bin/uv',
        '/usr/bin/uv'
      ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  return process.platform === 'win32' ? candidates[0] : 'uv'
}

/** Path to our Python transcription script */
function getScriptPath(): string {
  if (!app.isPackaged) {
    return join(process.cwd(), 'scripts', 'transcribe.py')
  }
  // Production: scripts/ bundled next to app resources
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
  const uvPath = getUvPath()

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Transcription script not found: ${scriptPath}`)
  }

  const uvExists = fs.existsSync(uvPath) || (() => {
    try {
      execSync(`${uvPath} --version`, { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  if (!uvExists) {
    throw new Error(
      `uv not found at "${uvPath}". Please install uv (https://docs.astral.sh/uv/) or run "brew install uv" on macOS.`
    )
  }

  logger.info('Starting transcription via uv + faster-whisper', {
    audio: audioPath,
    model: modelName,
    script: scriptPath,
    uv: uvPath
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

    logger.info(`Spawning: ${uvPath} ${args.join(' ')}`)

    const proc = spawn(uvPath, args, {
      env: { ...process.env },
      windowsHide: true
    })

    let resultData: TranscriptResult | null = null
    let stderr = ''
    let stdoutBuffer = ''  // accumulate chunks; result JSON can be very large

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()

      // Process only complete lines (ending with \n)
      const lines = stdoutBuffer.split('\n')
      // Keep the last partial line in the buffer
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed)
          if (msg.type === 'progress') {
            onProgress?.(msg.message, msg.progress)
            logger.info(`[WHISPER] ${msg.message}`)
          } else if (msg.type === 'result') {
            resultData = msg as TranscriptResult
          } else if (msg.type === 'error') {
            logger.error(`[WHISPER] Script error: ${msg.message}`)
          }
        } catch {
          // non-JSON line — log for debugging
          logger.debug(`[WHISPER stdout] ${trimmed.slice(0, 120)}`)
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
