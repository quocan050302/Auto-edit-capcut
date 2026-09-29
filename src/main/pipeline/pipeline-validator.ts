import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import { loadConfig } from '../config'
import { normalizeApiKey } from '../utils/api-key'
import { logger } from '../logger'
import type { AutoPipelineOptions } from './pipeline-types'

export interface PipelineValidationResult {
  valid: boolean
  fatalErrors: string[]
  warnings: string[]
  detectedVoiceoverDuration?: number
}

function probeAudioDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ffp = require('ffprobe-static')
      const ffprobePath = ffp?.path || 'ffprobe'
      if (!ffp?.path && !fs.existsSync(ffprobePath)) {
        return resolve(null)
      }

      const proc = spawn(
        ffprobePath,
        [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          filePath
        ],
        { windowsHide: true }
      )

      let stdout = ''
      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      proc.on('close', (code) => {
        if (code === 0) {
          const val = parseFloat(stdout.trim())
          resolve(!isNaN(val) && val > 0 ? val : null)
        } else {
          resolve(null)
        }
      })
      proc.on('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}

/**
 * Lấy Gemini API key từ các nguồn cấu hình đã chuẩn hóa.
 * Tuyệt đối không log API key.
 */
export function resolveGeminiApiKey(): string {
  try {
    const appCfg = loadConfig()
    const key = normalizeApiKey(appCfg.geminiApiKey ?? '')
    if (key) return key
  } catch {
    /* ignore */
  }

  try {
    const configPath = path.join(os.homedir(), '.auto-edit-config.json')
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const key = normalizeApiKey(cfg.geminiApiKey ?? '')
      if (key) return key
    }
  } catch {
    /* ignore */
  }

  const envKey = normalizeApiKey(process.env.GEMINI_API_KEY ?? '')
  return envKey
}

/**
 * Validate toàn bộ điều kiện tiên quyết trước khi chạy pipeline.
 */
export async function validatePipelinePrerequisites(
  options: AutoPipelineOptions
): Promise<PipelineValidationResult> {
  const fatalErrors: string[] = []
  const warnings: string[] = []

  const { projectDir, scriptPath, voiceoverPath } = options

  // 1. Kiểm tra projectDir
  if (!projectDir || !fs.existsSync(projectDir)) {
    fatalErrors.push(`Project directory does not exist: ${projectDir || '(empty)'}`)
    return { valid: false, fatalErrors, warnings }
  }

  try {
    fs.accessSync(projectDir, fs.constants.W_OK)
  } catch {
    fatalErrors.push(`Project directory is not writable: ${projectDir}`)
  }

  // 2. Kiểm tra script file
  if (!scriptPath) {
    fatalErrors.push('Script path is required for Auto Production.')
  } else if (!fs.existsSync(scriptPath)) {
    fatalErrors.push(`Script file not found: ${scriptPath}`)
  } else {
    try {
      const stat = fs.statSync(scriptPath)
      if (stat.size === 0) {
        fatalErrors.push(`Script file is empty: ${scriptPath}`)
      } else {
        const text = fs.readFileSync(scriptPath, 'utf-8')
        if (!text.trim()) {
          fatalErrors.push(`Script file contains only whitespace: ${scriptPath}`)
        }
      }
    } catch (err) {
      fatalErrors.push(`Cannot read script file: ${String(err)}`)
    }
  }

  // 3. Kiểm tra voiceover file
  let duration: number | null = null
  if (!voiceoverPath) {
    fatalErrors.push('Voiceover audio path is required for Auto Production.')
  } else if (!fs.existsSync(voiceoverPath)) {
    fatalErrors.push(`Voiceover audio file not found: ${voiceoverPath}`)
  } else {
    try {
      const stat = fs.statSync(voiceoverPath)
      if (stat.size === 0) {
        fatalErrors.push(`Voiceover audio file is empty: ${voiceoverPath}`)
      } else {
        duration = await probeAudioDuration(voiceoverPath)
        if (duration !== null && duration <= 0) {
          fatalErrors.push(`Voiceover audio has invalid duration: ${duration}s`)
        }
      }
    } catch (err) {
      fatalErrors.push(`Cannot read voiceover audio file: ${String(err)}`)
    }
  }

  // 4. Kiểm tra FFmpeg / FFprobe
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpeg = require('ffmpeg-static')
    if (!ffmpeg || (typeof ffmpeg === 'string' && !fs.existsSync(ffmpeg))) {
      warnings.push('ffmpeg-static binary path not found, relying on system ffmpeg.')
    }
  } catch {
    warnings.push('ffmpeg-static package check threw an error.')
  }

  // 5. Kiểm tra Gemini API key
  const geminiApiKey = resolveGeminiApiKey()
  if (!geminiApiKey) {
    fatalErrors.push(
      'Gemini API key is not configured. Please add it in Settings or set GEMINI_API_KEY env.'
    )
  }

  // 6. Kiểm tra Stock Provider availability
  const appCfg = loadConfig()
  const pexelsKey = normalizeApiKey(appCfg.pexelsApiKey ?? '')
  const pixabayKey = normalizeApiKey(appCfg.pixabayApiKey ?? '')

  // Kiểm tra xem có local media folder nào không
  let hasLocalMedia = false
  try {
    const stateFile = fs.existsSync(path.join(projectDir, 'project-state.json'))
      ? path.join(projectDir, 'project-state.json')
      : path.join(projectDir, 'project.json')
    if (fs.existsSync(stateFile)) {
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      const imgDir = st?.inputs?.imagesFolder
      const vidDir = st?.inputs?.videosFolder
      if ((imgDir && fs.existsSync(imgDir)) || (vidDir && fs.existsSync(vidDir))) {
        hasLocalMedia = true
      }
    }
  } catch {
    /* ignore */
  }

  if (!pexelsKey && !pixabayKey && !hasLocalMedia) {
    fatalErrors.push(
      'No stock API keys configured (Pexels or Pixabay required for auto stock search) and no local media folder provided.'
    )
  } else if (!pexelsKey && !pixabayKey && hasLocalMedia) {
    warnings.push(
      'No stock API keys configured. Pipeline will rely exclusively on local media files.'
    )
  }

  // 7. Output directory writable
  const outputDir = path.join(projectDir, 'output')
  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }
    fs.accessSync(outputDir, fs.constants.W_OK)
  } catch (err) {
    fatalErrors.push(`Output directory is not writable: ${String(err)}`)
  }

  logger.info('[PipelineValidator] Validation completed', {
    valid: fatalErrors.length === 0,
    errorsCount: fatalErrors.length,
    warningsCount: warnings.length
  })

  return {
    valid: fatalErrors.length === 0,
    fatalErrors,
    warnings,
    detectedVoiceoverDuration: duration ?? undefined
  }
}
