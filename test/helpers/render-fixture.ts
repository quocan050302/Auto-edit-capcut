/**
 * Test fixture builder for the Resumable Render Engine V2.
 * Generates a small but structurally complete project with FFmpeg:
 * low-complexity media, a long timeline, voiceover, optional music/SFX and captions.
 */

import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { getFfmpegBinary } from '../../src/main/render-cache/ffmpeg-process'
import type { CaptionPlan, CaptionPhrase, AudioPlan } from '../../shared/types'

export interface RenderFixtureOptions {
  scenes: number
  sceneDuration: number | ((i: number) => number)
  width: number
  height: number
  fps: number
  withMusic?: boolean
  withSfx?: boolean
  withNarrative?: boolean
  captionEverySecs?: number
  productionSettings?: Record<string, unknown>
}

export interface RenderFixture {
  projectDir: string
  voiceoverPath: string
  captionPlan?: CaptionPlan
  totalDuration: number
  mediaDir: string
  planPath: string
}

export function ffmpegSync(args: string[]): void {
  const r = spawnSync(getFfmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}\n${r.stderr}`)
}

export function createRenderFixture(rootDir: string, opts: RenderFixtureOptions): RenderFixture {
  const projectDir = rootDir
  const analysis = path.join(projectDir, 'analysis')
  const mediaDir = path.join(projectDir, 'assets', 'media')
  fs.mkdirSync(analysis, { recursive: true })
  fs.mkdirSync(mediaDir, { recursive: true })
  const { width: w, height: h, fps } = opts

  const durOf = (i: number): number => (typeof opts.sceneDuration === 'function' ? opts.sceneDuration(i) : opts.sceneDuration)
  let maxScene = 1
  for (let i = 0; i < opts.scenes; i++) maxScene = Math.max(maxScene, durOf(i))
  const clipSecs = Math.ceil(maxScene) + 2

  // Low-complexity media sources (as long as the longest scene)
  const clipA = path.join(mediaDir, 'clip-a.mp4')
  const clipB = path.join(mediaDir, 'clip-b.mp4')
  const img = path.join(mediaDir, 'still-1.png')
  ffmpegSync(['-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=${fps}:duration=${clipSecs}`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clipA])
  ffmpegSync(['-f', 'lavfi', '-i', `smptebars=size=${w}x${h}:rate=${fps}:duration=${clipSecs}`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clipB])
  ffmpegSync(['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=1:duration=1`, '-frames:v', '1', img])
  const sources = [
    { file: clipA, type: 'video' },
    { file: clipB, type: 'video' },
    { file: img, type: 'image' }
  ]

  const scenes: Array<Record<string, unknown>> = []
  let t = 0
  for (let i = 0; i < opts.scenes; i++) {
    const d = durOf(i)
    const src = sources[i % sources.length]
    scenes.push({
      sceneIndex: i + 1,
      mediaFile: path.basename(src.file),
      mediaType: src.type,
      localPath: src.file,
      startTime: Number(t.toFixed(3)),
      endTime: Number((t + d).toFixed(3)),
      duration: d,
      transitionIn: i > 0 && i % 4 === 0 ? 'dissolve' : undefined,
      visualIntent: `Scene ${i + 1}`,
      narrativeText: opts.withNarrative && i % 6 === 2 ? `In ${1950 + i} about ${i + 3} million people moved to the city.` : `Scene ${i + 1} narration.`
    })
    t += d
  }
  const totalDuration = Number(t.toFixed(3))

  // 4 chapters × sequences of ~5 scenes
  const perChapter = Math.ceil(scenes.length / 4)
  const chapters: Array<{ sequences: Array<{ scenes: unknown[] }> }> = []
  for (let c = 0; c < 4; c++) {
    const chScenes = scenes.slice(c * perChapter, (c + 1) * perChapter)
    if (chScenes.length === 0) continue
    const sequences: Array<{ scenes: unknown[] }> = []
    for (let s = 0; s < chScenes.length; s += 5) sequences.push({ scenes: chScenes.slice(s, s + 5) })
    chapters.push({ sequences })
  }
  const planPath = path.join(analysis, 'master-edit-plan.json')
  fs.writeFileSync(planPath, JSON.stringify({ chapters }, null, 2))
  fs.writeFileSync(
    path.join(analysis, 'media-index.json'),
    JSON.stringify(sources.map((s) => ({ filename: path.basename(s.file), path: s.file })), null, 2)
  )

  // Voiceover covering the whole timeline (low bitrate tone)
  const voiceoverPath = path.join(projectDir, 'assets', 'voiceover.m4a')
  ffmpegSync(['-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=16000:duration=${totalDuration}`, '-c:a', 'aac', '-b:a', '24k', voiceoverPath])

  // Music + SFX (approved, local)
  if (opts.withMusic || opts.withSfx) {
    const audioDir = path.join(projectDir, 'assets', 'audio')
    fs.mkdirSync(audioDir, { recursive: true })
    const plan: AudioPlan = { generatedAt: new Date().toISOString(), sections: [], sfxAssignments: [] }
    if (opts.withMusic) {
      const music = path.join(audioDir, 'music.m4a')
      ffmpegSync(['-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=16000:duration=${Math.min(totalDuration, 120)}`, '-c:a', 'aac', '-b:a', '24k', music])
      plan.sections.push({
        sectionId: 's1', sectionLabel: 'Intro', mood: 'calm', startTime: 0, endTime: Math.min(totalDuration, 120),
        durationSecs: Math.min(totalDuration, 120), sceneIndexes: [1, 2, 3], musicCandidate: null, approved: true,
        status: 'found', approvedLocalPath: music, approvedFilename: 'music.m4a', volumeDb: -30
      })
    }
    if (opts.withSfx) {
      const sfx = path.join(audioDir, 'whoosh.m4a')
      ffmpegSync(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=1', '-c:a', 'aac', '-b:a', '24k', sfx])
      for (const at of [5, Math.floor(totalDuration / 2)]) {
        plan.sfxAssignments.push({
          sceneIndex: 1, startTime: at, endTime: at + 1, sfxQuery: 'whoosh', sfxCandidate: null, approved: true,
          volumeDb: -18, fadeInSecs: 0.1, fadeOutSecs: 0.2, approvedLocalPath: sfx, approvedFilename: 'whoosh.m4a'
        })
      }
    }
    fs.writeFileSync(path.join(analysis, 'audio-plan.json'), JSON.stringify(plan, null, 2))
  }

  if (opts.productionSettings) {
    fs.writeFileSync(path.join(analysis, 'production-settings.json'), JSON.stringify(opts.productionSettings, null, 2))
  }

  let captionPlan: CaptionPlan | undefined
  if (opts.captionEverySecs && opts.captionEverySecs > 0) {
    const phrases: CaptionPhrase[] = []
    let k = 0
    for (let s = 1; s + 1.6 < totalDuration; s += opts.captionEverySecs) {
      phrases.push({
        id: `p${k}`,
        sceneId: `scene_${k + 1}`,
        text: `CAPTION ${k}`,
        startTime: Number(s.toFixed(3)),
        endTime: Number((s + 1.5).toFixed(3)),
        emphasisType: 'normal',
        style: { fontPreset: 'sans_bold_caps', boxHighlight: false, skew: false, baseColor: 'white' }
      })
      k++
    }
    captionPlan = { enabled: true, activeRanges: [{ startTime: 0, endTime: totalDuration, reason: 'normal' }], phrases }
    fs.writeFileSync(path.join(analysis, 'caption-plan.json'), JSON.stringify(captionPlan, null, 2))
  }

  return { projectDir, voiceoverPath, captionPlan, totalDuration, mediaDir, planPath }
}

/**
 * Fake Remotion overlay renderer for fast tests: renders exactly the requested
 * frameRange as solid green (the chroma key colour) with FFmpeg.
 */
export function makeFakeOverlayRenderer(calls: Array<[number, number]>) {
  return async (opts: {
    outputPath: string
    fps: number
    resolution: { width: number; height: number }
    frameRange?: [number, number] | null
    videoDurationInSeconds: number
    signal?: AbortSignal
  }): Promise<{ hardwareFallback: boolean }> => {
    const [a, b] = opts.frameRange ?? [0, Math.ceil(opts.videoDurationInSeconds * opts.fps) - 1]
    calls.push([a, b])
    if (opts.signal?.aborted) throw new Error('aborted')
    const frames = b - a + 1
    ffmpegSync([
      '-f', 'lavfi', '-i', `color=c=0x00ff00:s=${opts.resolution.width}x${opts.resolution.height}:r=${opts.fps}`,
      '-frames:v', String(frames), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', opts.outputPath
    ])
    return { hardwareFallback: false }
  }
}
