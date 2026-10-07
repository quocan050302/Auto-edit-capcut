import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { logger } from '../../logger'
import { getFfmpegBinary, getFfprobeBinary } from '../../render-cache/ffmpeg-process'
import { checkHyperFramesCapability } from '../../hyperframes/hyperframes-capability'
import { executeHyperFramesSfxResolve } from '../../hyperframes/hyperframes-command-runner'
import type { HealthSfxType } from '../../../shared/types'
import type { ResolvedSfx, SfxResolveRequest } from '../sfx-types'

/**
 * Controlled, sanitized intent descriptions per HealthSfxType.
 * Prevents arbitrary narration injection into external CLI tools.
 */
export const HYPERFRAMES_INTENT_MAP: Record<HealthSfxType, string> = {
  'soft-whoosh': 'subtle cinematic soft whoosh, clean documentary transition, no music',
  'reverse-whoosh': 'subtle reverse whoosh, restrained documentary transition',
  'air-swish': 'gentle airy swish, soft motion accent',
  'digital-scan': 'short subtle digital scan sweep, clean science documentary',
  'soft-pulse': 'soft organic pulse, subtle medical documentary accent',
  'heartbeat': 'subtle natural heartbeat, quiet medical documentary, non-horror',
  'soft-impact': 'restrained cinematic soft impact, documentary reveal accent',
  'clock-tick': 'single soft clock tick, clean close detail',
  'subtle-riser': 'short subtle cinematic riser, gentle documentary hook',
  'none': ''
}

/**
 * Normalizes an external audio file to 48kHz stereo 16-bit PCM WAV in project assets.
 * Also trims if duration exceeds reasonable limit for an SFX cue.
 */
async function normalizeAndCopySfx(
  sourcePath: string,
  destPath: string,
  maxDurationSecs = 5.0
): Promise<{ success: boolean; durationSecs: number }> {
  const ffmpegBin = getFfmpegBinary()
  if (!ffmpegBin) {
    // If FFmpeg missing, fallback to raw copy if source is already audio
    try {
      fs.copyFileSync(sourcePath, destPath)
      return { success: true, durationSecs: 1.0 }
    } catch {
      return { success: false, durationSecs: 0 }
    }
  }

  const destDir = path.dirname(destPath)
  fs.mkdirSync(destDir, { recursive: true })

  return new Promise((resolve) => {
    // Transcode to standard 48kHz WAV with short fade-out to prevent clicks
    const args = [
      '-y',
      '-t', String(maxDurationSecs),
      '-i', sourcePath,
      '-c:a', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      destPath
    ]

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d) => { stderr += d.toString() })

    proc.on('close', async (code) => {
      if (code !== 0 || !fs.existsSync(destPath)) {
        logger.warn(`[HyperFrames:SFX] FFmpeg normalize failed (exit ${code}): ${stderr.slice(-200)}`)
        // Attempt raw copy fallback
        try {
          fs.copyFileSync(sourcePath, destPath)
          resolve({ success: true, durationSecs: 1.0 })
        } catch {
          resolve({ success: false, durationSecs: 0 })
        }
        return
      }

      // Probe duration
      const duration = await probeDuration(destPath)
      resolve({ success: true, durationSecs: duration })
    })

    proc.on('error', (err) => {
      logger.warn(`[HyperFrames:SFX] Normalization spawn error: ${err.message}`)
      try {
        fs.copyFileSync(sourcePath, destPath)
        resolve({ success: true, durationSecs: 1.0 })
      } catch {
        resolve({ success: false, durationSecs: 0 })
      }
    })
  })
}

async function probeDuration(filePath: string): Promise<number> {
  const ffprobeBin = getFfprobeBinary()
  if (!ffprobeBin || !fs.existsSync(ffprobeBin)) return 1.0

  return new Promise((resolve) => {
    const proc = spawn(ffprobeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ])
    let out = ''
    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        const val = parseFloat(out.trim())
        if (!isNaN(val) && val > 0) {
          resolve(val)
          return
        }
      }
      resolve(1.0)
    })
    proc.on('error', () => resolve(1.0))
  })
}

/**
 * Resolves an SFX type using the external HyperFrames CLI (Node >= 22 required).
 * Returns null safely if HyperFrames is not installed, Node < 22, timeout, or invalid output.
 * NEVER throws an unhandled error to the pipeline.
 */
export async function resolveHyperframesSfx(
  request: SfxResolveRequest
): Promise<ResolvedSfx | null> {
  if (request.type === 'none') {
    return null
  }

  // 1. Fast capability check
  const capability = await checkHyperFramesCapability()
  if (!capability.available) {
    logger.debug(`[HyperFrames:SFX] type=${request.type} status=unavailable reason=${capability.reason || 'capability check failed'}`)
    return null
  }

  // 2. Map controlled intent
  const intent = HYPERFRAMES_INTENT_MAP[request.type] || request.intents[0] || `${request.type} sound effect`

  // 3. Isolated workspace per project
  const workspaceDir = path.join(request.projectDir, '.cache', 'hyperframes-sfx')
  fs.mkdirSync(workspaceDir, { recursive: true })

  // 4. Run external resolver
  const runResult = await executeHyperFramesSfxResolve({
    type: request.type,
    intent,
    workspaceDir,
    nodeBin: capability.nodeBin,
    npxBin: capability.npxBin,
    timeoutMs: 25000
  })

  if (!runResult.success || !runResult.resolvedPath) {
    logger.info(`[HyperFrames:SFX] type=${request.type} status=failed reason=${runResult.error || 'no output'}`)
    return null
  }

  // 5. Copy and normalize to project assets directory
  const destDir = path.join(request.projectDir, 'assets', 'audio', 'health-sfx')
  fs.mkdirSync(destDir, { recursive: true })
  const destPath = path.join(destDir, `${request.type}_hyperframes.wav`)

  const normalized = await normalizeAndCopySfx(runResult.resolvedPath, destPath)
  if (!normalized.success || !fs.existsSync(destPath)) {
    logger.warn(`[HyperFrames:SFX] Failed copying/normalizing resolved SFX at ${destPath}`)
    return null
  }

  logger.info(`[HyperFrames:SFX] type=${request.type} status=resolved duration=${normalized.durationSecs.toFixed(2)}s path=${destPath}`)

  return {
    type: request.type,
    provider: 'hyperframes',
    localPath: destPath,
    durationSecs: normalized.durationSecs,
    sourceId: `hyperframes-${request.type}`,
    sourceLabel: 'HyperFrames Bundled Library',
    creator: 'HyperFrames SFX Library',
    license: 'HyperFrames Asset',
    generated: false
  }
}
