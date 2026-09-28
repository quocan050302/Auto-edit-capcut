import { spawn } from 'child_process'
import * as fs from 'fs'
import { logger } from '../logger'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegStatic: string = require('ffmpeg-static')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobeStatic: { path: string } = require('ffprobe-static')

export interface MediaProbeDetails {
  hasVideo: boolean
  hasAudio: boolean
  width: number
  height: number
  durationSecs: number
  fps: number
  codecVideo?: string
  codecAudio?: string
  fileSizeBytes: number
}

export interface VideoQualityAnalysis {
  durationSecs: number
  blackSegments: Array<{ start: number; end: number; duration: number }>
  totalBlackDuration: number
  blackCoveragePct: number
  freezeSegments: Array<{ start: number; end: number; duration: number }>
  silenceSegments: Array<{ start: number; end: number; duration: number }>
}

// In-memory probe cache across the job lifecycle to prevent repeated ffprobes
const probeCache = new Map<string, { probe: MediaProbeDetails; mtimeMs: number }>()

export async function probeMediaDetailed(filePath: string): Promise<MediaProbeDetails | null> {
  if (!filePath || !fs.existsSync(filePath)) return null

  try {
    const stat = fs.statSync(filePath)
    const cached = probeCache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.probe
    }

    if (!ffprobeStatic?.path || !fs.existsSync(ffprobeStatic.path)) {
      logger.warn('[QA-Probe] ffprobe binary not found')
      return null
    }

    return new Promise((resolve) => {
      const proc = spawn(
        ffprobeStatic.path,
        [
          '-v', 'error',
          '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,duration:format=duration,size',
          '-of', 'json',
          filePath
        ],
        { windowsHide: true }
      )

      let stdout = ''
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.on('close', (code) => {
        if (code !== 0) {
          resolve(null)
          return
        }

        try {
          const parsed = JSON.parse(stdout)
          const streams = (parsed.streams ?? []) as Array<{
            codec_type: string
            codec_name?: string
            width?: number
            height?: number
            r_frame_rate?: string
            duration?: string
          }>

          const videoStream = streams.find((s) => s.codec_type === 'video')
          const audioStream = streams.find((s) => s.codec_type === 'audio')

          const formatDuration = parseFloat(parsed.format?.duration ?? '0')
          const videoDuration = parseFloat(videoStream?.duration ?? '0')
          const durationSecs = formatDuration > 0 ? formatDuration : videoDuration

          let fps = 30
          if (videoStream?.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split('/').map(Number)
            if (num && den) fps = Math.round((num / den) * 100) / 100
          }

          const details: MediaProbeDetails = {
            hasVideo: !!videoStream,
            hasAudio: !!audioStream,
            width: Number(videoStream?.width) || 0,
            height: Number(videoStream?.height) || 0,
            durationSecs,
            fps,
            codecVideo: videoStream?.codec_name,
            codecAudio: audioStream?.codec_name,
            fileSizeBytes: stat.size
          }

          probeCache.set(filePath, { probe: details, mtimeMs: stat.mtimeMs })
          resolve(details)
        } catch {
          resolve(null)
        }
      })

      proc.on('error', () => resolve(null))
    })
  } catch (err) {
    logger.warn(`[QA-Probe] Error probing file ${filePath}: ${String(err)}`)
    return null
  }
}

/**
 * Analyzes video quality for black frames, freeze frames, and silence using FFmpeg filters.
 */
export async function analyzeVideoQuality(
  filePath: string,
  totalDuration: number
): Promise<VideoQualityAnalysis> {
  const result: VideoQualityAnalysis = {
    durationSecs: totalDuration,
    blackSegments: [],
    totalBlackDuration: 0,
    blackCoveragePct: 0,
    freezeSegments: [],
    silenceSegments: []
  }

  if (!ffmpegStatic || !fs.existsSync(filePath)) {
    return result
  }

  return new Promise((resolve) => {
    // Run blackdetect and freezedetect with silencedetect
    const proc = spawn(
      ffmpegStatic,
      [
        '-v', 'info',
        '-i', filePath,
        '-vf', 'blackdetect=d=1.5:pix_th=0.10,freezedetect=n=-50dB:d=3.0',
        '-af', 'silencedetect=noise=-50dB:d=3.0',
        '-f', 'null',
        '-'
      ],
      { windowsHide: true }
    )

    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', () => {
      // Parse blackdetect lines: [blackdetect @ ...] black_start:10.5 black_end:13.2 black_duration:2.7
      const blackMatches = stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)
      for (const m of blackMatches) {
        const start = parseFloat(m[1])
        const end = parseFloat(m[2])
        const duration = parseFloat(m[3])
        result.blackSegments.push({ start, end, duration })
        result.totalBlackDuration += duration
      }

      if (totalDuration > 0) {
        result.blackCoveragePct = Math.round((result.totalBlackDuration / totalDuration) * 100)
      }

      // Parse freezedetect lines: [freezedetect @ ...] freeze_start: 5.0 freeze_duration: 3.5 freeze_end: 8.5
      const freezeStartMatches = stderr.matchAll(/freeze_start:\s*([\d.]+)/g)
      const freezeDurMatches = stderr.matchAll(/freeze_duration:\s*([\d.]+)/g)
      const freezeStarts = Array.from(freezeStartMatches).map((m) => parseFloat(m[1]))
      const freezeDurs = Array.from(freezeDurMatches).map((m) => parseFloat(m[1]))

      for (let i = 0; i < Math.min(freezeStarts.length, freezeDurs.length); i++) {
        const start = freezeStarts[i]
        const dur = freezeDurs[i]
        result.freezeSegments.push({ start, end: start + dur, duration: dur })
      }

      // Parse silencedetect lines: [silencedetect @ ...] silence_start: 4.5 silence_duration: 3.2
      const silStarts = Array.from(stderr.matchAll(/silence_start:\s*([\d.]+)/g)).map((m) => parseFloat(m[1]))
      const silDurs = Array.from(stderr.matchAll(/silence_duration:\s*([\d.]+)/g)).map((m) => parseFloat(m[1]))

      for (let i = 0; i < Math.min(silStarts.length, silDurs.length); i++) {
        const start = silStarts[i]
        const dur = silDurs[i]
        result.silenceSegments.push({ start, end: start + dur, duration: dur })
      }

      resolve(result)
    })

    proc.on('error', () => resolve(result))
  })
}

/**
 * Extracts representative frames and builds a contact sheet image using FFmpeg.
 */
export async function generateContactSheet(
  videoPath: string,
  outputPath: string,
  durationSecs: number
): Promise<boolean> {
  if (!ffmpegStatic || !fs.existsSync(videoPath) || durationSecs <= 0) {
    return false
  }

  try {
    const tmpDir = fs.mkdtempSync('contact_sheet_')
    const frameCount = 5
    const timestamps = [
      0.5,
      Math.max(1, durationSecs * 0.25),
      Math.max(2, durationSecs * 0.5),
      Math.max(3, durationSecs * 0.75),
      Math.max(4, durationSecs - 0.8)
    ]

    const extractedFiles: string[] = []

    for (let i = 0; i < timestamps.length; i++) {
      const ts = Math.min(timestamps[i], Math.max(0, durationSecs - 0.2))
      const framePath = `${tmpDir}/frame_${i}.jpg`
      await new Promise<void>((resolve) => {
        const p = spawn(
          ffmpegStatic,
          [
            '-y',
            '-ss', String(ts),
            '-i', videoPath,
            '-vframes', '1',
            '-q:v', '3',
            framePath
          ],
          { windowsHide: true }
        )
        p.on('close', () => resolve())
        p.on('error', () => resolve())
      })

      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 0) {
        extractedFiles.push(framePath)
      }
    }

    if (extractedFiles.length === 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      return false
    }

    // Tile extracted frames into a single contact sheet (e.g. 5x1 or 3x2)
    const tileFilter = extractedFiles.length >= 5 ? 'tile=5x1' : `tile=${extractedFiles.length}x1`
    const concatInputArgs = extractedFiles.flatMap((f) => ['-i', f])

    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        ffmpegStatic,
        [
          '-y',
          ...concatInputArgs,
          '-filter_complex',
          `${extractedFiles.map((_, idx) => `[${idx}:v]scale=384:216[v${idx}]`).join(';')};${extractedFiles.map((_, idx) => `[v${idx}]`).join('')}${tileFilter}`,
          outputPath
        ],
        { windowsHide: true }
      )
      p.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          resolve()
        } else {
          reject(new Error(`FFmpeg contact sheet tile exited with ${code}`))
        }
      })
      p.on('error', reject)
    })

    fs.rmSync(tmpDir, { recursive: true, force: true })
    return true
  } catch (err) {
    logger.warn(`[QA-ContactSheet] Failed to generate contact sheet: ${String(err)}`)
    return false
  }
}
