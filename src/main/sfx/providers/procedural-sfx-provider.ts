import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { logger } from '../../logger'
import { getFfmpegBinary, getFfprobeBinary } from '../../render-cache/ffmpeg-process'
import type { HealthSfxType } from '../../../shared/types'
import type { ResolvedSfx, SfxResolveRequest } from '../sfx-types'

interface ProceduralRecipe {
  args: string[]
  expectedDuration: number
}

/**
 * Deterministic FFmpeg lavfi synthesis recipes for each HealthSfxType.
 * Pure mathematical generation — zero external API, zero network, zero random noise seeds.
 * Generates subtle, documentary-grade audio cues in 48kHz 16-bit PCM WAV.
 */
function getRecipeForType(type: HealthSfxType): ProceduralRecipe | null {
  switch (type) {
    case 'soft-whoosh':
      // Gentle filtered pink noise whoosh with smooth bell-like envelope (~0.65s)
      return {
        args: [
          '-f', 'lavfi',
          '-i', 'anoisesrc=d=0.65:c=pink:r=48000,lowpass=f=900,afade=t=in:ss=0:d=0.25,afade=t=out:st=0.25:d=0.4,volume=0.8'
        ],
        expectedDuration: 0.65
      }

    case 'reverse-whoosh':
      // Reverse-style swell with long gradual rise and quick release (~0.80s)
      return {
        args: [
          '-f', 'lavfi',
          '-i', 'anoisesrc=d=0.80:c=pink:r=48000,lowpass=f=1100,afade=t=in:ss=0:d=0.65,afade=t=out:st=0.65:d=0.15,volume=0.8'
        ],
        expectedDuration: 0.80
      }

    case 'air-swish':
      // High-frequency filtered airy swish with quick attack (~0.55s)
      return {
        args: [
          '-f', 'lavfi',
          '-i', 'anoisesrc=d=0.55:c=white:r=48000,bandpass=f=2600:w=1400,afade=t=in:ss=0:d=0.15,afade=t=out:st=0.15:d=0.4,volume=0.5'
        ],
        expectedDuration: 0.55
      }

    case 'digital-scan':
      // Sleek electronic sweep / chirp (750Hz -> 1350Hz) for science documentary (~0.55s)
      return {
        args: [
          '-f', 'lavfi',
          '-i', 'aevalsrc=0.18*sin(2*PI*(750+600*t)*t):d=0.55:s=48000,afade=t=in:ss=0:d=0.08,afade=t=out:st=0.25:d=0.3,volume=0.6'
        ],
        expectedDuration: 0.55
      }

    case 'soft-pulse':
      // Low subtle sine pulse for medical documentary (~0.80s)
      return {
        args: [
          '-f', 'lavfi',
          '-i', 'sine=f=85:d=0.80:r=48000,afade=t=in:ss=0:d=0.15,afade=t=out:st=0.20:d=0.6,volume=0.7'
        ],
        expectedDuration: 0.80
      }

    case 'heartbeat':
      // Subtle double low-frequency thump (58Hz & 54Hz spaced 240ms), non-horror (~0.46s)
      return {
        args: [
          '-filter_complex',
          'sine=f=58:d=0.18:r=48000,afade=t=in:ss=0:d=0.03,afade=t=out:st=0.04:d=0.14[p1];sine=f=54:d=0.22:r=48000,afade=t=in:ss=0:d=0.03,afade=t=out:st=0.04:d=0.18,adelay=240|240[p2];[p1][p2]amix=inputs=2:dropout_transition=0,volume=0.85'
        ],
        expectedDuration: 0.46
      }

    case 'soft-impact':
      // Low frequency tone mixed with short filtered noise transient (~0.50s)
      return {
        args: [
          '-filter_complex',
          'sine=f=60:d=0.50:r=48000,afade=t=in:ss=0:d=0.02,afade=t=out:st=0.06:d=0.44[sub];anoisesrc=d=0.15:c=pink:r=48000,lowpass=f=1200,afade=t=in:ss=0:d=0.01,afade=t=out:st=0.02:d=0.13[trans];[sub][trans]amix=inputs=2:dropout_transition=0,volume=0.8'
        ],
        expectedDuration: 0.50
      }

    case 'clock-tick':
      // Short clean click/tick transient (~0.10s)
      return {
        args: [
          '-f', 'lavfi',
          '-i', 'sine=f=1750:d=0.10:r=48000,afade=t=in:ss=0:d=0.005,afade=t=out:st=0.01:d=0.09,volume=0.4'
        ],
        expectedDuration: 0.10
      }

    case 'subtle-riser':
      // Gentle documentary riser sweep (~1.20s)
      return {
        args: [
          '-f', 'lavfi',
          '-i', 'aevalsrc=0.15*sin(2*PI*(180+220*t*t)*t):d=1.20:s=48000,afade=t=in:ss=0:d=0.9,afade=t=out:st=0.9:d=0.3,volume=0.6'
        ],
        expectedDuration: 1.20
      }

    default:
      return null
  }
}

/**
 * Probes audio duration via ffprobe. Falls back to stat-based estimate if ffprobe fails.
 */
async function probeAudioDuration(filePath: string, fallbackSecs: number): Promise<number> {
  const ffprobeBin = getFfprobeBinary()
  if (!ffprobeBin || !fs.existsSync(ffprobeBin)) {
    return fallbackSecs
  }

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
      resolve(fallbackSecs)
    })
    proc.on('error', () => resolve(fallbackSecs))
  })
}

/**
 * Generates a deterministic procedural SFX file using local FFmpeg lavfi filters.
 * Returns ResolvedSfx or null if generation fails.
 */
export async function generateProceduralSfx(request: SfxResolveRequest): Promise<ResolvedSfx | null> {
  if (request.type === 'none') {
    return null
  }

  const recipe = getRecipeForType(request.type)
  if (!recipe) {
    logger.warn(`[ProceduralSFX] No procedural recipe for type=${request.type}`)
    return null
  }

  const ffmpegBin = getFfmpegBinary()
  if (!ffmpegBin) {
    logger.warn('[ProceduralSFX] FFmpeg binary not available')
    return null
  }

  const outDir = path.join(request.projectDir, 'assets', 'audio', 'health-sfx')
  fs.mkdirSync(outDir, { recursive: true })

  const outPath = path.join(outDir, `${request.type}_procedural.wav`)

  return new Promise<ResolvedSfx | null>((resolve) => {
    const fullArgs = [
      '-y',
      ...recipe.args,
      '-c:a', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      outPath
    ]

    const proc = spawn(ffmpegBin, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''

    proc.stderr?.on('data', (d) => {
      stderr += d.toString()
    })

    proc.on('close', async (code) => {
      if (code !== 0) {
        logger.warn(`[ProceduralSFX] Failed generating ${request.type} (exit ${code}): ${stderr.slice(-200)}`)
        resolve(null)
        return
      }

      if (!fs.existsSync(outPath)) {
        logger.warn(`[ProceduralSFX] Generated file missing at ${outPath}`)
        resolve(null)
        return
      }

      const stat = fs.statSync(outPath)
      if (stat.size < 512) {
        logger.warn(`[ProceduralSFX] Generated file too small (${stat.size} bytes) at ${outPath}`)
        resolve(null)
        return
      }

      const durationSecs = await probeAudioDuration(outPath, recipe.expectedDuration)

      logger.info(`[ProceduralSFX] Generated type=${request.type} path=${outPath} duration=${durationSecs.toFixed(2)}s`)

      resolve({
        type: request.type,
        provider: 'procedural',
        localPath: outPath,
        durationSecs,
        sourceId: `procedural-${request.type}`,
        sourceLabel: 'Local Procedural SFX',
        license: 'Procedural Synthesis',
        creator: 'Local Procedural SFX',
        generated: true
      })
    })

    proc.on('error', (err) => {
      logger.warn(`[ProceduralSFX] Error spawning ffmpeg: ${err.message}`)
      resolve(null)
    })
  })
}
