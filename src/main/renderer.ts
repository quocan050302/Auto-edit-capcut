import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { logger } from './logger'

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
}

interface EditPlan {
  chapters: Array<{
    sequences: Array<{
      scenes: ScenePlan[]
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

/** Find actual file path for a media filename by searching source folders */
function resolveMediaPath(
  filename: string,
  mediaIndex: Array<{ filename: string; path: string }>
): string | null {
  const item = mediaIndex.find(m => m.filename === filename || path.basename(m.path) === filename)
  return item ? item.path : null
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
    projectDir,
    voiceoverPath,
    outputName = 'final_output',
    resolution = { width: 1920, height: 1080 },
    fps = 30,
    onProgress
  } = params

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
    ch.sequences.flatMap(seq => seq.scenes)
  )
  const totalScenes = scenes.length
  progress(`Processing ${totalScenes} scenes...`, 0.06)

  // ── 4. Render each scene to a temp clip ───────────────────────────────────
  const tmpDir = path.join(projectDir, 'renders', '_tmp')
  fs.mkdirSync(tmpDir, { recursive: true })

  const sceneClips: string[] = []
  const { width, height } = resolution

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    const pct = 0.06 + (i / totalScenes) * 0.70
    progress(`Scene ${i + 1}/${totalScenes}: ${scene.mediaFile}`, pct, {
      sceneIndex: i + 1,
      totalScenes
    })

    const mediaPath = resolveMediaPath(scene.mediaFile, mediaIndex)
    const outClip = path.join(tmpDir, `scene_${String(i + 1).padStart(4, '0')}.mp4`)

    const scaleFilt = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`

    if (!mediaPath || !fs.existsSync(mediaPath)) {
      // Missing media: generate a black placeholder
      logger.warn(`[RENDER] Missing media: ${scene.mediaFile}, using black placeholder`)
      await ffmpegRun([
        '-y',
        '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${scene.duration}:r=${fps}`,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-t', String(scene.duration),
        '-pix_fmt', 'yuv420p',
        outClip
      ])
    } else if (scene.mediaType === 'image') {
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

    sceneClips.push(outClip)
  }

  // ── 5. Concatenate all scene clips ────────────────────────────────────────
  progress('Concatenating scenes...', 0.78)
  const concatList = path.join(tmpDir, 'concat.txt')
  fs.writeFileSync(
    concatList,
    sceneClips.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'),
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

  // ── 6. Mix voiceover audio ────────────────────────────────────────────────
  progress('Mixing voiceover audio...', 0.88)
  const outputDir = path.join(projectDir, 'output')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${outputName}.mp4`)

  if (fs.existsSync(voiceoverPath)) {
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
    // No audio — just copy raw video
    fs.copyFileSync(rawVideo, outputPath)
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
