import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { logger } from './logger'
import { renderCaptionsOverlay } from './captions/remotion-renderer'
import type { AudioPlan, CaptionPlan, RenderTransitionSettings, VisualGrammarDecision, RenderQaReport } from '../../shared/types'
import {
  concatSceneClipsWithTransitions,
  validateTransitionSettings,
  type RenderSceneEntry
} from './transitions/scene-transition-engine'
import {
  resolveSceneRetention,
  updateRetentionContext,
  createDefaultContext,
  type SceneRetentionInput
} from './retention/retention-engine'
import { cropToZoomFilter } from './retention/visual-beat-engine'
import { runRetentionQA } from './retention/retention-qa'
import type { RetentionSettings, VisualBeat, ProofVisual } from './retention/retention-types'
import { DEFAULT_RETENTION_SETTINGS } from './retention/retention-types'
import { loadProductionSettings } from './production-intelligence/production-settings'
import {
  generateVisualGrammarPlan,
  loadVisualGrammarPlan
} from './production-intelligence/visual-grammar-engine'


import { runRenderPreflight } from './qa/render-preflight'
import { runRenderPostflight } from './qa/render-postflight'
import { buildHealthMotionFilter } from './health/health-motion'
import type { HealthVisualScenePlan, HealthMotionPreset } from './health/health-visual-types'

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
  preflightReport?: RenderQaReport
  qaReport?: RenderQaReport
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

function safeUnlink(filePath: string | undefined): void {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (error) {
    logger.warn(
      `[RENDER] Could not delete temporary file ${filePath}: ${String(error)}`
    )
  }
}

interface VideoStreamInfo {
  hasVideo: boolean
  width: number
  height: number
  duration: number
}

async function probeVideoInfo(filePath: string): Promise<VideoStreamInfo | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffp = require('ffprobe-static')
    if (!ffp?.path || !fs.existsSync(ffp.path)) return null

    return new Promise((resolve) => {
      const proc = spawn(
        ffp.path,
        [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_type,width,height,duration:format=duration',
          '-of', 'json',
          filePath
        ],
        { windowsHide: true }
      )
      let stdout = ''
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const data = JSON.parse(stdout)
            const stream = data.streams?.[0]
            const duration = parseFloat(data.format?.duration) || parseFloat(stream?.duration) || 0
            if (stream && stream.codec_type === 'video') {
              resolve({
                hasVideo: true,
                width: Number(stream.width) || 0,
                height: Number(stream.height) || 0,
                duration
              })
              return
            }
          } catch { /* ignore */ }
        }
        resolve(null)
      })
      proc.on('error', () => resolve(null))
    })
  } catch {
    return null
  }
}

async function concatSceneClipsLegacy(
  sceneClips: string[],
  tmpDir: string,
  rawVideoPath: string
): Promise<void> {
  const concatList = path.join(tmpDir, 'concat.txt')
  fs.writeFileSync(
    concatList,
    // On macOS, paths are already using forward slashes. On Windows, convert backslashes.
    sceneClips.map(f => `file '${process.platform === 'win32' ? f.replace(/\\/g, '/') : f}'`).join('\n'),
    'utf-8'
  )
  await ffmpegRun([
    '-y',
    '-f', 'concat', '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    rawVideoPath
  ])
  safeUnlink(concatList)
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

export type ResolvedMediaKind = 'image' | 'video'

export const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.bmp',
  '.gif'
])

export const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.m4v',
  '.mpeg',
  '.mpg'
])

export function detectMediaKind(
  mediaPath: string,
  declaredType?: 'video' | 'image'
): ResolvedMediaKind {
  const cleanPath = mediaPath
    .split('?')[0]
    .split('#')[0]

  const extension = path.extname(cleanPath).toLowerCase()

  // Extension thật của file luôn có độ ưu tiên cao nhất.
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video'
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image'
  }

  // Chỉ dùng metadata nếu extension không xác định được.
  if (declaredType === 'image') {
    return 'image'
  }

  return 'video'
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

export interface ResolvedSceneMedia {
  sceneIndex: number
  mediaPath: string | null
  source:
    | 'localPath'
    | 'localAsset'
    | 'mediaIndex'
    | 'stockAssignment'
    | 'stockFolder'
    | 'missing'
}

export function resolveSceneMediaWithSource(
  scene: ScenePlan,
  mediaIndex: Array<{ filename: string; path: string }>,
  projectDir: string
): ResolvedSceneMedia {
  // 1. scene.localPath
  if (scene.localPath) {
    const p = normalizePathForFFmpeg(scene.localPath)
    if (fs.existsSync(p)) {
      scene.mediaType = detectMediaKind(p, scene.mediaType)
      return { sceneIndex: scene.sceneIndex, mediaPath: p, source: 'localPath' }
    }
  }

  // 2. scene.localAsset
  if (scene.localAsset) {
    const p = normalizePathForFFmpeg(scene.localAsset)
    if (fs.existsSync(p)) {
      scene.mediaType = detectMediaKind(p, scene.mediaType)
      return { sceneIndex: scene.sceneIndex, mediaPath: p, source: 'localAsset' }
    }
  }

  // 3. scene.mediaFile / localAsset trong media-index.json
  if (scene.mediaFile) {
    const found = resolveMediaPath(scene.mediaFile, mediaIndex)
    if (found && fs.existsSync(found)) {
      scene.mediaType = detectMediaKind(found, scene.mediaType)
      return { sceneIndex: scene.sceneIndex, mediaPath: found, source: 'mediaIndex' }
    }
  }
  if (scene.localAsset) {
    const found = resolveMediaPath(scene.localAsset, mediaIndex)
    if (found && fs.existsSync(found)) {
      scene.mediaType = detectMediaKind(found, scene.mediaType)
      return { sceneIndex: scene.sceneIndex, mediaPath: found, source: 'mediaIndex' }
    }
  }

  // 4. stock-assignments.json
  try {
    const assignmentsPath = path.join(projectDir, 'analysis', 'stock-assignments.json')
    if (fs.existsSync(assignmentsPath)) {
      const assignments = JSON.parse(fs.readFileSync(assignmentsPath, 'utf-8'))
      if (Array.isArray(assignments)) {
        const matched = assignments.find(
          (a: { sceneIndex?: number; sceneId?: string; asset?: { localPath?: string; mediaType?: 'video' | 'image' } }) =>
            (a.sceneIndex === scene.sceneIndex || a.sceneId === `scene_${scene.sceneIndex}`) &&
            a.asset?.localPath
        )
        if (matched?.asset?.localPath) {
          const p = normalizePathForFFmpeg(matched.asset.localPath)
          if (fs.existsSync(p)) {
            scene.mediaType = detectMediaKind(p, matched.asset.mediaType ?? scene.mediaType)
            return { sceneIndex: scene.sceneIndex, mediaPath: p, source: 'stockAssignment' }
          }
        }
      }
    }
  } catch { /* ignore */ }

  // 5. assets/stock folder by scene prefix (e.g. S001_, S010_)
  try {
    const stockDir = path.join(projectDir, 'assets', 'stock')
    if (fs.existsSync(stockDir)) {
      const files = fs.readdirSync(stockDir)
      const prefix3 = `S${String(scene.sceneIndex).padStart(3, '0')}_`
      const prefix4 = `S${String(scene.sceneIndex).padStart(4, '0')}_`
      const match = files.find(
        (f) =>
          (f.startsWith(prefix3) || f.startsWith(prefix4)) &&
          /\.(mp4|mov|webm|mkv|avi|jpg|jpeg|png|webp)$/i.test(f)
      )
      if (match) {
        const p = path.join(stockDir, match)
        if (fs.existsSync(p)) {
          scene.mediaType = detectMediaKind(p, scene.mediaType)
          return { sceneIndex: scene.sceneIndex, mediaPath: p, source: 'stockFolder' }
        }
      }
    }
  } catch { /* ignore */ }

  return { sceneIndex: scene.sceneIndex, mediaPath: null, source: 'missing' }
}

/** Resolve the actual media path for a scene — prefers localPath (stock downloads) over mediaFile lookup */
function resolveSceneMedia(
  scene: ScenePlan,
  mediaIndex: Array<{ filename: string; path: string }>,
  projectDir?: string
): string | null {
  if (!projectDir) {
    if (scene.localPath && fs.existsSync(normalizePathForFFmpeg(scene.localPath))) return normalizePathForFFmpeg(scene.localPath)
    if (scene.localAsset && fs.existsSync(normalizePathForFFmpeg(scene.localAsset))) return normalizePathForFFmpeg(scene.localAsset)
    if (scene.mediaFile) {
      const found = resolveMediaPath(scene.mediaFile, mediaIndex)
      if (found) return found
    }
    return null
  }
  return resolveSceneMediaWithSource(scene, mediaIndex, projectDir).mediaPath
}

// ─── Main render function ─────────────────────────────────────────────────────

/**
 * renderVisualBeatsToClip — render nhiều visual beats thành một scene clip.
 *
 * Mỗi beat là một đoạn trim riêng từ cùng asset, với crop tùy chọn.
 * Sau đó concat tất cả beats thành outClip.
 *
 * FALLBACK: nếu lỗi bất kỳ beat nào → render legacy single clip.
 */
async function renderVisualBeatsToClip(params: {
  beats: VisualBeat[]
  mediaPath: string
  isImage: boolean
  outClip: string
  width: number
  height: number
  fps: number
  scaleFilt: string
  tmpDir: string
  sceneIndex: number
}): Promise<void> {
  const { beats, mediaPath, outClip, width, height, fps, scaleFilt, tmpDir, sceneIndex } = params

  const beatClips: string[] = []
  const cleanExt = path.extname(mediaPath.split('?')[0].split('#')[0]).toLowerCase()

  // Re-derive isImage from the actual file extension — extension always takes priority.
  // This protects against stale/wrong mediaType metadata in the edit plan.
  let isImage: boolean
  if (VIDEO_EXTENSIONS.has(cleanExt)) {
    isImage = false
  } else if (IMAGE_EXTENSIONS.has(cleanExt)) {
    isImage = true
  } else {
    // Unknown extension: trust the caller's value but warn
    isImage = params.isImage
    logger.warn(
      `[RetentionEngine] scene ${sceneIndex}: unknown extension "${cleanExt}" for ${mediaPath}, ` +
      `using caller-provided isImage=${isImage}`
    )
  }

  // Sanity guard: log if caller and extension disagree
  if (params.isImage !== isImage) {
    logger.warn(
      `[RetentionEngine] scene ${sceneIndex}: mediaType mismatch corrected — ` +
      `caller said isImage=${params.isImage} but extension "${cleanExt}" → isImage=${isImage}. ` +
      `path=${mediaPath}`
    )
  }

  try {
    for (let bi = 0; bi < beats.length; bi++) {
      const beat = beats[bi]
      const beatDuration = beat.relativeEnd - beat.relativeStart
      const beatClip = path.join(tmpDir, `beat_${String(sceneIndex).padStart(4, '0')}_${bi}.mp4`)

      // Compute video filter — base scale + optional crop
      let vfFilter = scaleFilt
      if (beat.crop && beat.crop.scale > 1.005) {
        const zf = cropToZoomFilter(beat.crop, width, height, beatDuration, fps)
        if (zf) vfFilter = `${scaleFilt},${zf}`
      }

      if (isImage) {
        await ffmpegRun([
          '-y', '-loop', '1', '-i', mediaPath,
          '-vf', vfFilter,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
          '-t', String(beatDuration),
          '-r', String(fps),
          '-pix_fmt', 'yuv420p',
          beatClip
        ])
      } else {
        // Trim from asset — use ss for beat start offset (approximate)
        const ssOffset = beat.relativeStart
        await ffmpegRun([
          '-y',
          '-ss', String(ssOffset),
          '-i', mediaPath,
          '-vf', `${vfFilter},tpad=stop_mode=clone:stop_duration=${beatDuration},trim=duration=${beatDuration},setpts=PTS-STARTPTS`,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
          '-t', String(beatDuration),
          '-r', String(fps),
          '-an',
          '-pix_fmt', 'yuv420p',
          beatClip
        ])
      }

      beatClips.push(beatClip)
    }

    // Concat beats into scene clip
    if (beatClips.length === 1) {
      // Just rename
      safeUnlink(outClip)
      fs.renameSync(beatClips[0], outClip)
    } else {
      const beatConcatList = path.join(tmpDir, `beat_concat_${sceneIndex}.txt`)
      fs.writeFileSync(
        beatConcatList,
        beatClips.map(f => `file '${process.platform === 'win32' ? f.replace(/\\/g, '/') : f}'`).join('\n'),
        'utf-8'
      )
      await ffmpegRun([
        '-y', '-f', 'concat', '-safe', '0',
        '-i', beatConcatList,
        '-c', 'copy',
        outClip
      ])
      // Cleanup beat clips + concat list
      for (const bc of beatClips) safeUnlink(bc)
      safeUnlink(beatConcatList)
    }

    logger.info(`[RetentionEngine] scene ${sceneIndex}: ${beats.length} beats rendered and concatenated`)

  } catch (err) {
    // If it's a media classification error, re-throw immediately.
    // Do NOT swallow it into the fallback — that would run -loop 1 on a video file.
    const errMsg = String(err)
    if (errMsg.includes('Media classification error') || errMsg.includes('Option loop not found')) {
      throw err
    }

    logger.warn(`[RetentionEngine] scene ${sceneIndex}: beat render failed (${errMsg}), falling back to legacy`)

    // Cleanup partial beat clips
    for (const bc of beatClips) {
      safeUnlink(bc)
    }

    // FALLBACK: legacy single clip (use re-derived isImage, never the stale caller value)
    const baseFilt = scaleFilt
    const fallbackDur = beats.reduce((a, b) => a + (b.relativeEnd - b.relativeStart), 0)
    if (isImage) {
      await ffmpegRun([
        '-y', '-loop', '1', '-i', mediaPath,
        '-vf', baseFilt,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-t', String(fallbackDur),
        '-r', String(fps), '-pix_fmt', 'yuv420p', outClip
      ])
    } else {
      await ffmpegRun([
        '-y', '-i', mediaPath,
        '-vf', `${baseFilt},tpad=stop_mode=clone:stop_duration=${fallbackDur},trim=duration=${fallbackDur},setpts=PTS-STARTPTS`,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-t', String(fallbackDur),
        '-r', String(fps), '-an', '-pix_fmt', 'yuv420p', outClip
      ])
    }
  }
}

export async function renderVideo(params: {
  projectDir: string
  voiceoverPath: string
  outputName?: string
  resolution?: { width: number; height: number }
  fps?: number
  captionPlan?: CaptionPlan   // optional — nếu null/undefined sẽ bỏ qua bước burn caption
  transitionSettings?: RenderTransitionSettings
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

  let tmpDir: string | undefined = undefined
  let workingOutputPath: string | undefined = undefined

  try {
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

    // ── 3. Flatten scenes (preserving chapter and sequence info) ─────────────
    const sceneEntries: RenderSceneEntry[] = []
    plan.chapters.forEach((ch, chIdx) => {
      const seqs = ch.sequences ?? ch.chapters_seq ?? []
      let isFirstInCh = true
      seqs.forEach((seq, seqIdx) => {
        let isFirstInSeq = true
        const scList = seq.scenes ?? []
        scList.forEach((scene) => {
          sceneEntries.push({
            scene,
            chapterIndex: chIdx,
            sequenceIndex: seqIdx,
            isFirstInChapter: isFirstInCh,
            isFirstInSequence: isFirstInSeq
          })
          isFirstInCh = false
          isFirstInSeq = false
        })
      })
    })
    const scenes: ScenePlan[] = sceneEntries.map(entry => entry.scene)
    const totalScenes = scenes.length
    progress(`Processing ${totalScenes} scenes...`, 0.06)

    // Load Health visual plan if available to detect Health AI images and motion presets
    const healthPlanMap = new Map<number, HealthVisualScenePlan>()
    const healthPlanPath = path.join(projectDir, 'analysis', 'health-visual-plan.json')
    if (fs.existsSync(healthPlanPath)) {
      try {
        const hp = JSON.parse(fs.readFileSync(healthPlanPath, 'utf-8'))
        for (const sc of hp.scenes || []) {
          if (sc && typeof sc.sceneIndex === 'number') {
            healthPlanMap.set(sc.sceneIndex, sc)
          }
        }
      } catch { /* ignore */ }
    }

    // ── 3a. Production Intelligence: Preflight QA ────────────────────────────
    progress('Running preflight QA checks...', 0.07)
    const preflightReport = await runRenderPreflight({
      projectDir,
      voiceoverPath,
      captionPlan: params.captionPlan,
      resolution,
      fps
    })

    if (preflightReport.status === 'failed') {
      const fatalIssues = preflightReport.issues.filter((i) => i.severity === 'fatal')
      const msg = fatalIssues.map((i) => i.message).join('; ')
      throw new Error(`Render Preflight QA failed: ${msg}`)
    }

    // ── 3b. Media Preflight ──────────────────────────────────────────────────
    progress('Validating scene media...', 0.08)

    const preflightResults: ResolvedSceneMedia[] = []
    let resolvedMediaCount = 0
    let missingMediaCount = 0

    for (const scene of scenes) {
      const resolved = resolveSceneMediaWithSource(scene, mediaIndex, projectDir)
      preflightResults.push(resolved)
      if (resolved.mediaPath && fs.existsSync(resolved.mediaPath)) {
        resolvedMediaCount++
        scene.localPath = resolved.mediaPath
        if (!scene.mediaFile) {
          scene.mediaFile = path.basename(resolved.mediaPath)
        }
        const detectedKind = detectMediaKind(resolved.mediaPath, scene.mediaType)
        if (scene.mediaType !== detectedKind) {
          logger.warn(
            `[RENDER] Scene ${scene.sceneIndex}: mediaType mismatch. ` +
            `Plan says ${scene.mediaType ?? 'unknown'}, but file extension indicates ${detectedKind}. ` +
            `Syncing memory mediaType to ${detectedKind}.`
          )
          scene.mediaType = detectedKind
        }
        logger.info(
          `[RENDER][Media] scene=${scene.sceneIndex} source=${resolved.source} mediaKind=${detectedKind} exists=true path=${resolved.mediaPath}`
        )
      } else {
        missingMediaCount++
        logger.warn(
          `[RENDER][Media] scene=${scene.sceneIndex} source=${resolved.source} exists=false`
        )
      }
    }

    logger.info(
      `[RENDER][Media] resolved=${resolvedMediaCount} missing=${missingMediaCount} total=${scenes.length}`
    )

    if (scenes.length > 0 && resolvedMediaCount === 0) {
      throw new Error(
        'No scene media could be resolved. Refusing to render an all-black video. Check master-edit-plan.json, media-index.json and stock-assignments.json.'
      )
    }

    // ── 4. Render each scene to a unique temp directory ─────────────────────
    const projectHash = Buffer.from(projectDir).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
    const tmpBaseDir = path.join(os.tmpdir(), `auto-edit-render-${projectHash}-`)
    tmpDir = fs.mkdtempSync(tmpBaseDir)
    logger.info(`[RENDER] Temporary directory: ${tmpDir}`)

    const sceneClips: string[] = []
    const { width, height } = resolution

    // ── Retention Engine setup ─────────────────────────────────────────────────
    const retentionSettings: RetentionSettings = DEFAULT_RETENTION_SETTINGS
    const retCtx = createDefaultContext()

    // Pre-compute retention decisions for all scenes (sequential context tracking)
    const retentionDecisions = new Map<number, import('./retention/retention-types').RetentionDecision>()
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      const sceneInput: SceneRetentionInput = {
        sceneId: String(scene.sceneIndex),
        sceneIndex: i,
        duration: scene.duration,
        energyLevel: (scene as any).energyLevel,
        shotType: (scene as any).shotType,
        narrativeText: (scene as any).narrativeText,
        visualIntent: scene.visualIntent,
        isPatternInterrupt: (scene as any).isPatternInterrupt,
        localPath: scene.localPath,
        isNewChapter: i === 0 || (scene as any).isFirstInChapter,
      }
      const decision = resolveSceneRetention(sceneInput, retCtx, retentionSettings)
      retentionDecisions.set(i, decision)
      updateRetentionContext(retCtx, sceneInput, decision)
    }

    // Run retention QA (flags only — does NOT block render)
    try {
      const qaScenes = scenes.map((s, i) => ({
        sceneIndex: i,
        sceneId: String(s.sceneIndex),
        duration: s.duration,
        energyLevel: (s as any).energyLevel,
        shotType: (s as any).shotType,
        narrativeText: (s as any).narrativeText,
        visualIntent: s.visualIntent,
        isPatternInterrupt: (s as any).isPatternInterrupt,
        visualBeats: retentionDecisions.get(i)?.visualBeats,
      }))
      const qaFlags = runRetentionQA(qaScenes)
      if (qaFlags.length > 0) {
        const qaPath = path.join(projectDir, 'analysis', 'retention-qa.json')
        fs.writeFileSync(qaPath, JSON.stringify(qaFlags, null, 2), 'utf-8')
        logger.info(`[RENDER] Retention QA: ${qaFlags.length} flags saved to retention-qa.json`)
      }
    } catch (err) {
      logger.warn(`[RENDER] Retention QA failed (non-blocking): ${String(err)}`)
    }

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      const mediaName = scene.localPath
        ? path.basename(scene.localPath)
        : (scene.mediaFile || scene.localAsset || scene.visualIntent || `Scene_${scene.sceneIndex}`)

      const pct = 0.08 + (i / totalScenes) * 0.68
      progress(`Scene ${i + 1}/${totalScenes}: ${mediaName}`, pct, {
        sceneIndex: i + 1,
        totalScenes
      })

      const mediaPath = (scene.localPath && fs.existsSync(scene.localPath))
        ? scene.localPath
        : resolveSceneMedia(scene, mediaIndex, projectDir)

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
        const mediaKind = detectMediaKind(mediaPath, scene.mediaType)
        const isImage = mediaKind === 'image'

        const declaredType = scene.mediaType
        const cleanExt = path.extname(mediaPath.split('?')[0].split('#')[0]).toLowerCase()
        const extensionType = VIDEO_EXTENSIONS.has(cleanExt) ? 'video' : IMAGE_EXTENSIONS.has(cleanExt) ? 'image' : undefined

        if (declaredType && extensionType && declaredType !== extensionType) {
          logger.warn(
            `[RENDER] Scene ${scene.sceneIndex}: mediaType mismatch. ` +
            `Plan says ${declaredType}, but file extension indicates ${extensionType}. ` +
            `Using ${extensionType}.`
          )
        }

        if (scene.mediaType !== mediaKind) {
          scene.mediaType = mediaKind
        }

        logger.info(
          `[RENDER] Scene ${scene.sceneIndex}: ` +
          `mediaKind=${mediaKind}, ` +
          `declaredType=${declaredType ?? 'unknown'}, ` +
          `extension=${cleanExt}, ` +
          `path=${mediaPath}`
        )

        // Validate before calling FFmpeg
        if (isImage && VIDEO_EXTENSIONS.has(cleanExt)) {
          throw new Error(
            `Media classification error: video file was about to be rendered as image: ${mediaPath}`
          )
        }
        if (!isImage && IMAGE_EXTENSIONS.has(cleanExt)) {
          throw new Error(
            `Media classification error: image file was about to be rendered as video: ${mediaPath}`
          )
        }

        const decision = retentionDecisions.get(i)
        const beats = decision?.visualBeats ?? []
        const hasMultipleBeats = beats.length > 1

        // Check if this is a Health AI still scene or Health generated image
        const healthScene = healthPlanMap.get(scene.sceneIndex)
        const isHealthAiImage =
          isImage &&
          (healthScene?.strategy === 'ai-still' ||
            mediaPath.includes(path.join('assets', 'generated', 'health')) ||
            mediaPath.includes('/assets/generated/health/'))

        if (isHealthAiImage) {
          // Health Motion Director is the PRIMARY camera motion for Health AI still images
          const motionParam = healthScene?.motion || healthScene?.motionPreset || 'push-in-center'
          const motionFilter = buildHealthMotionFilter(motionParam, width, height, scene.duration, fps)
          const presetName = typeof motionParam === 'object' ? motionParam.preset : motionParam
          logger.info(`[HealthMotion] Scene ${scene.sceneIndex}: applying cinematic motion spec '${presetName}'`)

          await ffmpegRun([
            '-y',
            '-loop', '1',
            '-i', mediaPath,
            '-vf', motionFilter,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
            '-t', String(scene.duration),
            '-r', String(fps),
            '-pix_fmt', 'yuv420p',
            outClip
          ])
        } else if (hasMultipleBeats && retentionSettings.enabled) {
          // ── ENHANCED: render visual beats then concat into scene clip (default non-health behavior)
          await renderVisualBeatsToClip({
            beats,
            mediaPath,
            isImage,
            outClip,
            width,
            height,
            fps,
            scaleFilt,
            tmpDir,
            sceneIndex: i,
          })
        } else {
          // ── LEGACY: single clip render (unchanged behavior) ─────────────────
          const singleBeat = beats[0]
          let vfFilter = scaleFilt
          if (retentionSettings.semanticCropEnabled && singleBeat?.crop && singleBeat.crop.scale > 1.005) {
            const zf = cropToZoomFilter(singleBeat.crop, width, height, scene.duration, fps)
            if (zf) {
              vfFilter = `${scaleFilt},${zf}`
              logger.info(`[RetentionEngine] scene ${i}: single-beat crop scale=${singleBeat.crop.scale.toFixed(2)}`)
            }
          }

          if (isImage) {
            await ffmpegRun([
              '-y',
              '-loop', '1',
              '-i', mediaPath,
              '-vf', vfFilter,
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
              '-t', String(scene.duration),
              '-r', String(fps),
              '-pix_fmt', 'yuv420p',
              outClip
            ])
          } else {
            const durationGuard =
              `tpad=stop_mode=clone:stop_duration=${scene.duration},` +
              `trim=duration=${scene.duration},` +
              `setpts=PTS-STARTPTS`
            const videoFilter = `${vfFilter},${durationGuard}`

            await ffmpegRun([
              '-y',
              '-i', mediaPath,
              '-vf', videoFilter,
              '-c:v', 'libx264',
              '-preset', 'fast',
              '-crf', '20',
              '-t', String(scene.duration),
              '-r', String(fps),
              '-an',
              '-pix_fmt', 'yuv420p',
              outClip
            ])
          }
        }
      }

      // Validate scene clip
      if (!fs.existsSync(outClip) || fs.statSync(outClip).size === 0) {
        throw new Error(`Scene ${scene.sceneIndex} did not produce a valid video clip.`)
      }

      const clipProbe = await probeVideoInfo(outClip)
      if (clipProbe) {
        if (!clipProbe.hasVideo || clipProbe.width <= 0 || clipProbe.height <= 0 || clipProbe.duration <= 0) {
          throw new Error(`Scene ${scene.sceneIndex} did not produce a valid video clip (invalid stream).`)
        }
        const maxAllowedDiff = 1 / fps + 0.05
        const diff = Math.abs(clipProbe.duration - scene.duration)
        if (diff > maxAllowedDiff) {
          logger.warn(
            `[RENDER] Scene ${scene.sceneIndex} duration deviation: expected=${scene.duration.toFixed(3)}s actual=${clipProbe.duration.toFixed(3)}s diff=${diff.toFixed(3)}s (tolerance=${maxAllowedDiff.toFixed(3)}s)`
          )
        }
        logger.info(
          `[RENDER] Scene ${scene.sceneIndex} clip validated: path=${outClip} sizeBytes=${fs.statSync(outClip).size} duration=${clipProbe.duration.toFixed(3)}s resolution=${clipProbe.width}x${clipProbe.height}`
        )
      } else {
        logger.info(
          `[RENDER] Scene ${scene.sceneIndex} clip created: path=${outClip} sizeBytes=${fs.statSync(outClip).size}`
        )
      }

      sceneClips.push(outClip)
    }

    // ── 5. Concatenate all scene clips ────────────────────────────────────────
    progress('Concatenating scenes...', 0.78)
    const rawVideo = path.join(tmpDir, 'raw_video.mp4')

    const validSettings = validateTransitionSettings(params.transitionSettings)
    const shouldAttemptTransitions =
      validSettings &&
      validSettings.enabled &&
      sceneEntries.length > 1

    let rawVideoCreated = false

    if (shouldAttemptTransitions) {
      try {
        progress('Resolving scene transitions...', 0.78)
        rawVideoCreated = await concatSceneClipsWithTransitions({
          sceneEntries,
          sceneClips,
          settings: validSettings,
          fps,
          tmpDir,
          rawVideoPath: rawVideo,
          onProgress: (stage, pct) => progress(stage, pct)
        })
        if (rawVideoCreated) {
          logger.info('[RENDER] Scene assembly method=transitions')
        }
      } catch (err: unknown) {
        logger.warn(
          `[Transitions] Transition render failed, falling back to legacy concat: ${String(err)}`
        )
        progress('Transitions failed — using standard cuts...', 0.79)
        safeUnlink(rawVideo)
        rawVideoCreated = false
      }
    }

    if (!rawVideoCreated) {
      const method = shouldAttemptTransitions ? 'legacy-fallback' : 'legacy-concat'
      logger.info(`[RENDER] Scene assembly method=${method}`)
      await concatSceneClipsLegacy(sceneClips, tmpDir, rawVideo)
      rawVideoCreated = true
    }

    // ── Validate raw_video.mp4 before audio ──
    if (!fs.existsSync(rawVideo) || fs.statSync(rawVideo).size === 0) {
      throw new Error('Raw video was not created or is empty.')
    }

    const rawProbe = await probeVideoInfo(rawVideo)
    if (!rawProbe || !rawProbe.hasVideo || rawProbe.duration <= 0 || rawProbe.width <= 0 || rawProbe.height <= 0) {
      throw new Error(
        'The scene assembly step produced an invalid raw video. Audio and captions were not applied.'
      )
    }

    if (rawProbe.width !== width || rawProbe.height !== height) {
      logger.warn(
        `[RENDER] Raw video resolution ${rawProbe.width}x${rawProbe.height} does not match target ${width}x${height}`
      )
    }

    logger.info(
      `[RENDER] Raw video validated:\npath=${rawVideo}\nduration=${rawProbe.duration.toFixed(3)}s\nresolution=${rawProbe.width}x${rawProbe.height}\nsizeBytes=${fs.statSync(rawVideo).size}`
    )

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
    workingOutputPath = path.join(outputDir, `_${outputName}_working.mp4`)
    safeUnlink(workingOutputPath)

    if (!hasAudio && !hasMusicOrSfx) {
      // No audio at all — just copy raw video
      fs.copyFileSync(rawVideo, workingOutputPath)
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
        workingOutputPath
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

      // Voiceover — normalize loudness to -16 LUFS so it's always clear and consistent
      if (hasAudio) {
        filterParts.push(`[${voiceoverIdx}:a]loudnorm=I=-16:TP=-1.5:LRA=11[vo]`)
      }

      // Music sections — ducked under voiceover
      // Default: -30 dB (3.2% amplitude) — subtle background bed
      const musicLabels: string[] = []
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
        musicLabels.push(`[${label}]`)
      }

      // SFX — placed at scene start time
      const sfxLabels: string[] = []
      for (const { idx, sfx } of sfxInputs) {
        const vol = Math.pow(10, (sfx.volumeDb ?? -24) / 20).toFixed(6)
        const fadeIn = sfx.fadeInSecs ?? 0.05
        const fadeOut = sfx.fadeOutSecs ?? 0.15
        const dur = sfx.endTime - sfx.startTime
        const label = `sfx_${idx}`
        filterParts.push(
          `[${idx}:a]volume=${vol},` +
          `afade=t=in:ss=0:d=${fadeIn},` +
          `afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut},` +
          `adelay=${Math.round(sfx.startTime * 1000)}|${Math.round(sfx.startTime * 1000)},` +
          `apad[${label}]`
        )
        sfxLabels.push(`[${label}]`)
      }

      // Mix all tracks, protecting voiceover loudness
      if (sfxInputs.length === 0) {
        // Legacy Default path (when no SFX are present): unchanged behavior
        const mixLabels: string[] = []
        if (hasAudio) mixLabels.push('[vo]')
        mixLabels.push(...musicLabels)
        const nInputs = mixLabels.length
        filterParts.push(
          `${mixLabels.join('')}amix=inputs=${nInputs}:duration=first:normalize=1,` +
          `alimiter=limit=0.891:attack=5:release=50:level=disabled[amixed]`
        )
      } else {
        // Bus architecture when SFX are present:
        // Isolates SFX and Music buses so that amix normalize=0 does not divide voiceover by N tracks
        const finalBuses: string[] = []
        if (hasAudio) finalBuses.push('[vo]')

        if (musicLabels.length === 1) {
          filterParts.push(`${musicLabels[0]}asplit=1[music_bus]`)
          finalBuses.push('[music_bus]')
        } else if (musicLabels.length > 1) {
          filterParts.push(
            `${musicLabels.join('')}amix=inputs=${musicLabels.length}:duration=longest:normalize=0[music_bus]`
          )
          finalBuses.push('[music_bus]')
        }

        if (sfxLabels.length === 1) {
          filterParts.push(`${sfxLabels[0]}asplit=1[sfx_bus]`)
          finalBuses.push('[sfx_bus]')
        } else if (sfxLabels.length > 1) {
          filterParts.push(
            `${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:duration=longest:normalize=0[sfx_bus]`
          )
          finalBuses.push('[sfx_bus]')
        }

        filterParts.push(
          `${finalBuses.join('')}amix=inputs=${finalBuses.length}:duration=first:normalize=0,` +
          `alimiter=limit=0.891:attack=5:release=50:level=disabled[amixed]`
        )
      }

      const filterComplex = filterParts.join(';')
      logger.info(`[RENDER] filter_complex: ${filterComplex.slice(0, 200)}...`)

      await ffmpegRun([
        ...ffArgs,
        '-filter_complex', filterComplex,
        '-map', '0:v:0',
        '-map', '[amixed]',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        workingOutputPath
      ])
    }

    if (!fs.existsSync(workingOutputPath) || fs.statSync(workingOutputPath).size === 0) {
      throw new Error('Audio mixing step failed to produce a valid video file.')
    }
    const audioProbe = await probeVideoInfo(workingOutputPath)
    if (!audioProbe || !audioProbe.hasVideo || audioProbe.duration <= 0) {
      throw new Error('The audio mixing step produced an invalid video. Video stream is missing.')
    }
    logger.info(
      `[RENDER] Audio mixing output validated: path=${workingOutputPath} sizeBytes=${fs.statSync(workingOutputPath).size} duration=${audioProbe.duration.toFixed(3)}s`
    )

    // ── 7b. Render Overlays (Captions, Proof Visuals, Visual Scene Grammar) ───
    let proofVisuals: ProofVisual[] = []
    if (retentionSettings.proofVisualsEnabled) {
      try {
        proofVisuals = buildProofVisualList(scenes, retentionDecisions, params.captionPlan)
        logger.info(`[RENDER] ProofVisuals: ${proofVisuals.length} overlays built`)
        // Save debug plan (non-blocking)
        try {
          const pvPlanPath = path.join(projectDir, 'analysis', 'proof-visual-plan.json')
          fs.writeFileSync(pvPlanPath, JSON.stringify(proofVisuals.map(pv => ({
            type: pv.type, text: pv.primaryText,
            startTime: pv.absoluteStartTime, endTime: pv.absoluteEndTime,
            position: pv.position
          })), null, 2), 'utf-8')
        } catch { /* non-blocking */ }
      } catch (err) {
        logger.warn(`[RENDER] ProofVisual build failed (non-blocking): ${String(err)}`)
        proofVisuals = []
      }
    }

    const prodSettings = loadProductionSettings(projectDir)
    let visualGrammar: Array<VisualGrammarDecision & { absoluteStartTime?: number; absoluteEndTime?: number }> = []

    if (prodSettings.enabled && prodSettings.visualSceneGrammarEnabled) {
      try {
        let vgPlan = loadVisualGrammarPlan(projectDir)
        if (!vgPlan) {
          vgPlan = generateVisualGrammarPlan({
            projectDir,
            editPlan: plan,
            captionPlan: params.captionPlan,
            proofVisuals,
            settings: prodSettings
          })
        }

        visualGrammar = (vgPlan.decisions ?? [])
          .filter((d) => d.enabled)
          .map((d) => {
            const sc = scenes.find((s) => s.sceneIndex === d.sceneIndex)
            const sceneStart = sc?.startTime ?? 0
            const absStart = sceneStart + d.startOffset
            return {
              ...d,
              absoluteStartTime: absStart,
              absoluteEndTime: absStart + d.duration
            }
          })
        logger.info(`[RENDER] VisualSceneGrammar: ${visualGrammar.length} decisions active for overlay`)
      } catch (vgErr) {
        logger.warn(`[RENDER] VisualGrammar processing failed (non-blocking): ${String(vgErr)}`)
        visualGrammar = []
      }
    }

    const hasCaptions = !!(params.captionPlan?.enabled && (params.captionPlan?.phrases?.length ?? 0) > 0)
    const hasProofVisuals = proofVisuals.length > 0
    const hasVisualGrammar = visualGrammar.length > 0

    if (hasCaptions || hasProofVisuals || hasVisualGrammar) {
      // ── 7b-ii. Render lớp overlay bằng Remotion ─────────────────────────────
      progress('Rendering video overlay (Remotion)...', 0.91)
      const captionsDir = path.join(projectDir, 'assets', 'captions')
      fs.mkdirSync(captionsDir, { recursive: true })
      const overlayPath = path.join(captionsDir, 'overlay.mp4')  // H264 green screen

      const videoDurationSecs = scenes.reduce((a, s) => a + s.duration, 0)

      await renderCaptionsOverlay({
        captionPlan: params.captionPlan ?? { enabled: true, activeRanges: [], phrases: [] },
        proofVisuals,
        visualGrammar,
        videoDurationInSeconds: videoDurationSecs,
        outputPath: overlayPath,
        fps,
        resolution,
        onBundleProgress: (pct) => {
          progress(`Bundling Remotion composition... ${Math.round(pct)}%`, 0.91 + pct * 0.002)
        },
        onRenderProgress: (pct) => {
          progress(`Rendering overlays... ${Math.round(pct * 100)}%`, 0.915 + pct * 0.01)
        },
      })


      // ── 7b-iii. Merge overlay lên video gốc bằng FFmpeg ─────────────────────
      progress('Compositing captions overlay...', 0.93)
      const captionedPath = path.join(outputDir, '_captioned_tmp.mp4')
      safeUnlink(captionedPath)

      logger.info(`[RENDER] Overlay merge: ${overlayPath} -> ${workingOutputPath} (${params.captionPlan.phrases.length} phrases, ${proofVisuals.length} proofs)`)

      await ffmpegRun([
        '-y',
        '-i', workingOutputPath,       // [0] video có audio
        '-i', overlayPath,             // [1] caption MP4 green screen từ Remotion
        '-filter_complex',
        '[1:v]format=rgba,colorkey=0x00ff00:0.12:0.05[ov];[0:v][ov]overlay=0:0:shortest=1:eof_action=pass,format=yuv420p[outv]',
        '-map', '[outv]',
        '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-c:a', 'copy',
        captionedPath
      ])

      if (!fs.existsSync(captionedPath) || fs.statSync(captionedPath).size === 0) {
        safeUnlink(captionedPath)
        throw new Error('Caption overlay compositing failed to produce a valid file.')
      }

      const captionedProbe = await probeVideoInfo(captionedPath)
      if (!captionedProbe || !captionedProbe.hasVideo || captionedProbe.duration <= 0) {
        safeUnlink(captionedPath)
        throw new Error('Caption overlay composited file has no valid video stream.')
      }

      logger.info(
        `[RENDER] Caption overlay composited: path=${captionedPath} sizeBytes=${fs.statSync(captionedPath).size} duration=${captionedProbe.duration.toFixed(3)}s`
      )

      // Thay thế working output bằng bản đã có caption
      safeUnlink(workingOutputPath)
      fs.renameSync(captionedPath, workingOutputPath)

      // Dọn overlay tạm
      safeUnlink(overlayPath)

      logger.info('[RENDER] Caption overlay composited')
    }

    // ── 8. Production Intelligence: Postflight QA ─────────────────────────────
    let qaReport: RenderQaReport | undefined
    if (prodSettings.enabled && prodSettings.renderQaEnabled) {
      progress('Running postflight QA inspection...', 0.95)
      qaReport = await runRenderPostflight({
        projectDir,
        workingOutputPath,
        expectedDuration: scenes.reduce((a, s) => a + s.duration, 0),
        totalScenes: scenes.length,
        hasVoiceover: hasAudio,
        targetResolution: resolution,
        targetFps: fps
      })

      if (qaReport.status === 'failed') {
        const fatalIssues = qaReport.issues.filter((i) => i.severity === 'fatal')
        const msg = fatalIssues.map((i) => i.message).join('; ')
        throw new Error(`Render Postflight QA failed: ${msg}`)
      }
    }

    // ── 8b. Final output validation & publishing ────────────────────────────────
    progress('Finalizing output...', 0.96)
    if (!fs.existsSync(workingOutputPath) || fs.statSync(workingOutputPath).size === 0) {
      throw new Error('Final render working file is missing or empty.')
    }
    const finalProbe = await probeVideoInfo(workingOutputPath)
    if (!finalProbe || !finalProbe.hasVideo || finalProbe.duration <= 0) {
      throw new Error('Final output does not contain a valid video stream.')
    }

    // Atomically promote working output to final outputPath
    safeUnlink(outputPath)
    fs.renameSync(workingOutputPath, outputPath)

    // ── 9. Cleanup temp files ─────────────────────────────────────────────────
    progress('Cleaning up...', 0.98)
    for (const clip of sceneClips) {
      safeUnlink(clip)
    }
    safeUnlink(rawVideo)

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      logger.info(`[RENDER] Removed temporary directory: ${tmpDir}`)
    } catch (error) {
      logger.warn(`[RENDER] Could not remove temporary directory ${tmpDir}: ${String(error)}`)
    }

    const stat = fs.statSync(outputPath)
    const durationSecs = finalProbe.duration || scenes.reduce((a, s) => a + s.duration, 0)

    progress(`Done → ${outputPath}`, 1.0)
    logger.info('[RENDER] Complete', {
      outputPath,
      durationSecs: Math.round(durationSecs * 100) / 100,
      resolution: `${finalProbe.width}x${finalProbe.height}`,
      fileSizeMB: (stat.size / 1024 / 1024).toFixed(2)
    })

    return {
      outputPath,
      durationSecs,
      fileSizeBytes: stat.size,
      preflightReport,
      qaReport
    }


  } catch (err) {
    if (workingOutputPath) safeUnlink(workingOutputPath)
    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch { /* ignore */ }
    }
    throw err
  }
}

// ─── Proof Visual helpers ─────────────────────────────────────────────────────

/**
 * buildProofVisualList — collect RetentionDecision.proofVisual từ tất cả scenes,
 * compute absolute timing, dedup vs captions, resolve smart position.
 *
 * KHÔNG thay đổi scene timing. Chỉ tính absolute timing để Remotion render đúng frame.
 */
function buildProofVisualList(
  scenes: ScenePlan[],
  retentionDecisions: Map<number, import('./retention/retention-types').RetentionDecision>,
  captionPlan: import('../../shared/types').CaptionPlan
): ProofVisual[] {
  const result: ProofVisual[] = []
  let sceneStartCursor = 0
  const seenKeys = new Set<string>()

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    const decision = retentionDecisions.get(i)

    sceneStartCursor += (i === 0 ? 0 : scenes[i - 1].duration)
    if (i > 0) {
      // already added scenes[i-1].duration above; reset to recompute
    }

    if (!decision?.proofVisual) continue

    const pv = decision.proofVisual

    // Compute absolute start using cumulative cursor
    let cumStart = 0
    for (let j = 0; j < i; j++) cumStart += scenes[j].duration
    const absStart = cumStart + pv.relativeTime
    const absEnd = absStart + pv.durationSecs

    if (!pv.primaryText || pv.primaryText.trim().length === 0 || pv.primaryText.length > 48) continue

    // Dedup by normalized text in 15s buckets
    const normText = pv.primaryText.replace(/[\s,.$%]/g, '').toUpperCase()
    const dedupKey = `${normText}_${Math.floor(absStart / 15)}`
    if (seenKeys.has(dedupKey)) {
      logger.debug(`[ProofVisual] scene ${i} skipped -- duplicate: ${pv.primaryText}`)
      continue
    }

    // Dedup vs DataNote captions
    if (isDuplicateOfDataNote(pv.primaryText, captionPlan, absStart, absEnd)) {
      logger.info(`[ProofVisual] scene ${i} skipped -- duplicate DataNote: ${pv.primaryText}`)
      continue
    }

    // Check caption state at this timestamp
    const captionState = getCaptionStateAt(absStart, absEnd, captionPlan)
    if (captionState === 'strong') {
      logger.info(`[ProofVisual] scene ${i} skipped -- overlaps big_statement caption`)
      continue
    }

    // Smart position
    const resolvedPosition = resolveProofPosition(pv, captionState, i)

    seenKeys.add(dedupKey)

    result.push({
      ...pv,
      absoluteStartTime: parseFloat(absStart.toFixed(3)),
      absoluteEndTime:   parseFloat(absEnd.toFixed(3)),
      position: resolvedPosition,
    })

    logger.info(`[ProofVisual] scene ${i} -> ${pv.type}: "${pv.primaryText}" @${absStart.toFixed(1)}s pos=${resolvedPosition}`)
  }

  return result
}

type CaptionStateType = 'none' | 'normal' | 'strong' | 'data_note' | 'news_chyron'

function getCaptionStateAt(
  start: number,
  end: number,
  captionPlan: import('../../shared/types').CaptionPlan
): CaptionStateType {
  const stateOrder: CaptionStateType[] = ['none', 'normal', 'data_note', 'news_chyron', 'strong']
  let maxState: CaptionStateType = 'none'

  for (const phrase of captionPlan.phrases) {
    if (phrase.startTime >= end || phrase.endTime <= start) continue
    let state: CaptionStateType = 'normal'
    if (phrase.presetType === 'big_statement') state = 'strong'
    else if (phrase.presetType === 'data_note') state = 'data_note'
    else if (phrase.presetType === 'news_chyron') state = 'news_chyron'
    if (stateOrder.indexOf(state) > stateOrder.indexOf(maxState)) maxState = state
  }

  return maxState
}

function isDuplicateOfDataNote(
  pvText: string,
  captionPlan: import('../../shared/types').CaptionPlan,
  absStart: number,
  absEnd: number
): boolean {
  const normPv = pvText.replace(/[$,\s.%]/g, '').replace(/million/i, 'M').replace(/billion/i, 'B').toUpperCase()
  for (const phrase of captionPlan.phrases) {
    if (phrase.presetType !== 'data_note' && phrase.emphasisType !== 'shock_stat') continue
    if (phrase.startTime >= absEnd || phrase.endTime <= absStart) continue
    const src = phrase.dataNote?.label ?? phrase.text
    const normSrc = src.replace(/[$,\s.%]/g, '').replace(/million/i, 'M').replace(/billion/i, 'B').toUpperCase()
    if (normSrc.includes(normPv) || normPv.includes(normSrc)) return true
    const pvNums = pvText.match(/\d+/g) ?? []
    const srcNums = src.match(/\d+/g) ?? []
    if (pvNums.length > 0 && pvNums.some(n => srcNums.includes(n))) return true
  }
  return false
}

function resolveProofPosition(
  pv: ProofVisual,
  captionState: CaptionStateType,
  sceneIndex: number
): ProofVisual['position'] {
  if (pv.position) {
    if (captionState === 'strong' || captionState === 'news_chyron') {
      if (pv.position === 'bottom_right') return 'top_right'
      if (pv.position === 'bottom_left') return 'top_left'
    }
    return pv.position
  }
  if (pv.type === 'date_card') return 'top_right'
  if (pv.type === 'location_label') return 'top_left'
  if (pv.type === 'stat_emphasis') return (captionState === 'strong') ? 'top_left' : 'bottom_left'
  const corners: ProofVisual['position'][] = ['bottom_right', 'top_right', 'bottom_right', 'top_right']
  return corners[sceneIndex % corners.length]
}

