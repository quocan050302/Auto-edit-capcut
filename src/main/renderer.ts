import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { logger } from './logger'
import type { AudioPlan } from '../../shared/types'

// ffmpeg-static ships a pre-built ffmpeg binary
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RenderProgress {
  stage: string
  sceneIndex?: number
  totalScenes?: number
  progress: number   // 0..1
  timeMs?: number    // elapsed ms
}

export interface RenderResult {
  outputPath: string
  durationSecs: number
  fileSizeBytes: number
}

interface ScenePlan {
  sceneIndex: number
  mediaFile: string
  mediaType: 'video' | 'image'
  startTime: number
  endTime: number
  duration: number
  transitionIn?: string
  localPath?: string
  localAsset?: string
  visualIntent?: string
}

interface EditPlan {
  chapters: Array<{
    sequences?: Array<{
      scenes?: ScenePlan[]
    }>
    chapters_seq?: Array<{
      scenes?: ScenePlan[]
    }>
  }>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ffmpegRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    const stderr: string[] = []
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-5).join('')}`))
    })
    proc.on('error', reject)
  })
}

/**
 * On macOS, paths stored as Windows-style (e.g. "D:\\Video_factory..." relative to CWD) must
 * be resolved to a valid absolute path. FFmpeg interprets "D:" as a protocol and fails.
 * Also strips any remaining Windows backslashes used as path separators.
 */
function normalizePathForFFmpeg(p: string): string {
  if (!p) return p
  // Already absolute Unix path
  if (p.startsWith('/')) return p
  // path.resolve() from CWD gives an absolute path
  // then we replace any backslash PATH SEPARATORs (Windows), but NOT backslashes in dir names
  // Since path.resolve on macOS treats backslash as literal char, the resolved path is correct.
  return path.resolve(p)
}

/** Find actual file path for a media filename by searching source folders */
function resolveMediaPath(
  filename: string,
  mediaIndex: Array<{ filename: string; path: string }>
): string | null {
  if (!filename) return null
  const item = mediaIndex.find(m => m.filename === filename || path.basename(m.path) === filename)
  return item ? normalizePathForFFmpeg(item.path) : null
}

/** Resolve the actual media path for a scene — prefers localPath (stock downloads) over mediaFile lookup */
function resolveSceneMedia(
  scene: ScenePlan,
  mediaIndex: Array<{ filename: string; path: string }>
): string | null {
  // 1. Direct local path (set by stock engine or user upload)
  if (scene.localPath) {
    const p = normalizePathForFFmpeg(scene.localPath)
    if (fs.existsSync(p)) return p
  }
  if (scene.localAsset) {
    const p = normalizePathForFFmpeg(scene.localAsset)
    if (fs.existsSync(p)) return p
  }
  // 2. Look up by filename in media index
  if (scene.mediaFile) {
    const found = resolveMediaPath(scene.mediaFile, mediaIndex)
    if (found) return found
  }
  if (scene.localAsset) {
    const found = resolveMediaPath(scene.localAsset, mediaIndex)
    if (found) return found
  }
  return null
}

// ─── Main render function ─────────────────────────────────────────────────────

export async function renderVideo(params: {
  projectDir: string
  voiceoverPath: string
  outputName?: string
  resolution?: { width: number; height: number }
  fps?: number
  onProgress?: (p: RenderProgress) => void
}): Promise<RenderResult> {
  const {
    outputName = 'final_output',
    resolution = { width: 1920, height: 1080 },
    fps = 30,
    onProgress
  } = params

  // Normalize paths that may be Windows-style (D:\...) on macOS
  const projectDir = normalizePathForFFmpeg(params.projectDir)
  const voiceoverPath = normalizePathForFFmpeg(params.voiceoverPath)

  const progress = (stage: string, pct: number, extra: Partial<RenderProgress> = {}): void => {
    logger.info(`[RENDER] ${stage} (${Math.round(pct * 100)}%)`)
    onProgress?.({ stage, progress: pct, ...extra })
  }

  // ── 1. Load edit plan ─────────────────────────────────────────────────────
  progress('Loading edit plan...', 0.02)
  const planPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
  if (!fs.existsSync(planPath)) throw new Error('No edit plan found. Run AI Planning first.')
  const plan: EditPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))

  // ── 2. Load media index ───────────────────────────────────────────────────
  progress('Loading media index...', 0.04)
  const mediaIndexPath = path.join(projectDir, 'analysis', 'media-index.json')
  const mediaIndex: Array<{ filename: string; path: string }> =
    fs.existsSync(mediaIndexPath)
      ? JSON.parse(fs.readFileSync(mediaIndexPath, 'utf-8'))
      : []

  // ── 3. Flatten scenes ─────────────────────────────────────────────────────
  const scenes: ScenePlan[] = plan.chapters.flatMap(ch =>
    (ch.sequences ?? ch.chapters_seq ?? []).flatMap(seq => seq.scenes ?? [])
  )
  const totalScenes = scenes.length
  progress(`Processing ${totalScenes} scenes...`, 0.06)

  // ── 4. Render each scene to a temp clip ───────────────────────────────────
  // Use OS temp dir to avoid issues with special characters (colons, backslashes)
  // in the project directory path (which may be stored as a Windows-style path on macOS)
  const projectHash = Buffer.from(projectDir).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
  const tmpDir = path.join(os.tmpdir(), `auto-edit-render-${projectHash}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const sceneClips: string[] = []
  const { width, height } = resolution

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    const mediaName = scene.localPath
      ? path.basename(scene.localPath)
      : (scene.mediaFile || scene.localAsset || scene.visualIntent || `Scene_${scene.sceneIndex}`)

    const pct = 0.06 + (i / totalScenes) * 0.70
    progress(`Scene ${i + 1}/${totalScenes}: ${mediaName}`, pct, {
      sceneIndex: i + 1,
      totalScenes
    })

    const mediaPath = resolveSceneMedia(scene, mediaIndex)
    const outClip = path.join(tmpDir, `scene_${String(i + 1).padStart(4, '0')}.mp4`)

    const scaleFilt = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`

    if (!mediaPath || !fs.existsSync(mediaPath)) {
      // Missing media: generate a black placeholder
      logger.warn(`[RENDER] Missing media for scene ${scene.sceneIndex}: ${mediaName}, using black placeholder`)
      await ffmpegRun([
        '-y',
        '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${scene.duration}:r=${fps}`,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-t', String(scene.duration),
        '-pix_fmt', 'yuv420p',
        outClip
      ])
    } else {
      const isImage = /\.(jpe?g|png|webp|bmp|gif)$/i.test(mediaPath) || scene.mediaType === 'image'
      if (isImage) {
        // Image → loop for duration
        await ffmpegRun([
          '-y',
          '-loop', '1',
          '-i', mediaPath,
          '-vf', scaleFilt,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
          '-t', String(scene.duration),
          '-r', String(fps),
          '-pix_fmt', 'yuv420p',
          outClip
        ])
      } else {
        // Video → trim + scale
        await ffmpegRun([
          '-y',
          '-i', mediaPath,
          '-vf', scaleFilt,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
          '-t', String(scene.duration),
          '-r', String(fps),
          '-an',                // strip audio from source video (voiceover added later)
          '-pix_fmt', 'yuv420p',
          outClip
        ])
      }
    }

    sceneClips.push(outClip)
  }

  // ── 5. Concatenate all scene clips ────────────────────────────────────────
  progress('Concatenating scenes...', 0.78)
  const concatList = path.join(tmpDir, 'concat.txt')
  fs.writeFileSync(
    concatList,
    // On macOS, paths are already using forward slashes. On Windows, convert backslashes.
    sceneClips.map(f => `file '${process.platform === 'win32' ? f.replace(/\\/g, '/') : f}'`).join('\n'),
    'utf-8'
  )

  const rawVideo = path.join(tmpDir, 'raw_video.mp4')
  await ffmpegRun([
    '-y',
    '-f', 'concat', '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    rawVideo
  ])

  // ── 6. Load audio plan (Smart Audio Director) ─────────────────────────────
  progress('Loading audio plan…', 0.86)
  const audioPlanPath = path.join(projectDir, 'analysis', 'audio-plan.json')
  const audioPlan: AudioPlan | null = fs.existsSync(audioPlanPath)
    ? (JSON.parse(fs.readFileSync(audioPlanPath, 'utf-8')) as AudioPlan)
    : null

  const approvedMusic = audioPlan?.sections.filter(
    (s) => s.approved && s.approvedLocalPath && fs.existsSync(normalizePathForFFmpeg(s.approvedLocalPath))
  ) ?? []

  const approvedSfx = audioPlan?.sfxAssignments.filter(
    (s) => s.approved && s.approvedLocalPath && fs.existsSync(normalizePathForFFmpeg(s.approvedLocalPath))
  ) ?? []

  const hasAudio = fs.existsSync(voiceoverPath)
  const hasMusicOrSfx = approvedMusic.length > 0 || approvedSfx.length > 0

  logger.info(`[RENDER] Audio: voiceover=${hasAudio}, music=${approvedMusic.length}, sfx=${approvedSfx.length}`)

  // ── 7. Mix voiceover + music + SFX ────────────────────────────────────────
  progress('Mixing audio tracks…', 0.90)
  const outputDir = path.join(projectDir, 'output')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${outputName}.mp4`)

  if (!hasAudio && !hasMusicOrSfx) {
    // No audio at all — just copy raw video
    fs.copyFileSync(rawVideo, outputPath)
  } else if (!hasMusicOrSfx && hasAudio) {
    // Simple case: voiceover only
    await ffmpegRun([
      '-y',
      '-i', rawVideo,
      '-i', voiceoverPath,
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-map', '0:v:0', '-map', '1:a:0',
      '-shortest',
      outputPath
    ])
  } else {
    // Complex case: voiceover + background music + SFX
    // Build ffmpeg inputs and filter_complex
    const ffArgs: string[] = ['-y', '-i', rawVideo]

    let inputIdx = 1

    // Input: voiceover
    const voiceoverIdx = hasAudio ? inputIdx++ : -1
    if (hasAudio) ffArgs.push('-i', voiceoverPath)

    // Inputs: background music sections
    const musicInputs: Array<{ idx: number; section: typeof approvedMusic[0] }> = []
    for (const sec of approvedMusic) {
      ffArgs.push('-i', normalizePathForFFmpeg(sec.approvedLocalPath!))
      musicInputs.push({ idx: inputIdx++, section: sec })
    }

    // Inputs: SFX
    const sfxInputs: Array<{ idx: number; sfx: typeof approvedSfx[0] }> = []
    for (const sfx of approvedSfx) {
      ffArgs.push('-i', normalizePathForFFmpeg(sfx.approvedLocalPath!))
      sfxInputs.push({ idx: inputIdx++, sfx })
    }

    // Build filter_complex
    const filterParts: string[] = []
    const mixLabels: string[] = []

    // Voiceover — normalize loudness to -16 LUFS so it's always clear and consistent
    if (hasAudio) {
      filterParts.push(`[${voiceoverIdx}:a]loudnorm=I=-16:TP=-1.5:LRA=11[vo]`)
      mixLabels.push('[vo]')
    }

    // Music sections — ducked under voiceover
    // Default: -30 dB (3.2% amplitude) — subtle background bed
    for (const { idx, section } of musicInputs) {
      const vol = Math.pow(10, (section.volumeDb ?? -30) / 20).toFixed(6)
      const fadeIn = section.fadeInSecs ?? 2
      const fadeOut = section.fadeOutSecs ?? 3
      const dur = section.durationSecs
      const label = `music_${idx}`
      filterParts.push(
        `[${idx}:a]volume=${vol},` +
        `afade=t=in:ss=0:d=${fadeIn},` +
        `afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut},` +
        `adelay=${Math.round(section.startTime * 1000)}|${Math.round(section.startTime * 1000)},` +
        `apad[${label}]`
      )
      mixLabels.push(`[${label}]`)
    }

    // SFX — placed at scene start time
    for (const { idx, sfx } of sfxInputs) {
      const vol = Math.pow(10, (sfx.volumeDb ?? -18) / 20).toFixed(6)
      const fadeIn = sfx.fadeInSecs ?? 0.5
      const fadeOut = sfx.fadeOutSecs ?? 0.5
      const dur = sfx.endTime - sfx.startTime
      const label = `sfx_${idx}`
      filterParts.push(
        `[${idx}:a]volume=${vol},` +
        `afade=t=in:ss=0:d=${fadeIn},` +
        `afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut},` +
        `adelay=${Math.round(sfx.startTime * 1000)}|${Math.round(sfx.startTime * 1000)},` +
        `apad[${label}]`
      )
      mixLabels.push(`[${label}]`)
    }

    // Mix all tracks, then limit output to prevent clipping
    const nInputs = mixLabels.length
    filterParts.push(
      // normalize=1 scales by 1/nInputs to prevent summing clips
      `${mixLabels.join('')}amix=inputs=${nInputs}:duration=first:normalize=1,` +
      // Final brick-wall limiter: ensure no sample exceeds -1 dBTP
      `alimiter=limit=0.891:attack=5:release=50:level=disabled[amixed]`
    )

    const filterComplex = filterParts.join(';')
    logger.info(`[RENDER] filter_complex: ${filterComplex.slice(0, 200)}…`)

    await ffmpegRun([
      ...ffArgs,
      '-filter_complex', filterComplex,
      '-map', '0:v:0',
      '-map', '[amixed]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
      outputPath
    ])
  }

  // ── 7. Cleanup temp files ─────────────────────────────────────────────────
  progress('Cleaning up...', 0.97)
  try {
    for (const clip of sceneClips) fs.unlinkSync(clip)
    fs.unlinkSync(concatList)
    fs.unlinkSync(rawVideo)
  } catch { /* ignore cleanup errors */ }

  const stat = fs.statSync(outputPath)
  const durationSecs = scenes.reduce((a, s) => a + s.duration, 0)

  progress(`Done → ${outputPath}`, 1.0)
  logger.info('[RENDER] Complete', {
    outputPath,
    durationSecs: Math.round(durationSecs),
    fileSizeMB: (stat.size / 1024 / 1024).toFixed(1)
  })

  return { outputPath, durationSecs, fileSizeBytes: stat.size }
}
