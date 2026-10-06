import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
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
import { runRetentionQA, generateRetentionSummary, saveRetentionSummary } from './retention/retention-qa'
import { ensureRetentionPlan } from './retention/retention-director'
import { applyRetentionMotionHint } from './retention/retention-motion'
import type { RetentionSettings, VisualBeat, ProofVisual, RetentionDecision, RetentionPlan, RetentionScenePlan } from './retention/retention-types'
import { DEFAULT_RETENTION_SETTINGS } from './retention/retention-types'
import { loadProductionSettings } from './production-intelligence/production-settings'
import {
  generateVisualGrammarPlan,
  loadVisualGrammarPlan
} from './production-intelligence/visual-grammar-engine'


import { runRenderPostflight } from './qa/render-postflight'
import { buildHealthMotionFilter } from './health/health-motion'
import type { HealthVisualScenePlan, HealthMotionPreset } from './health/health-visual-types'
import { findMissingManualAiScenes } from './visual-mix/manual-ai/manual-ai-validator'

// ── Resumable Render Engine V2 ───────────────────────────────────────────────
import {
  ffmpegRun as sharedFfmpegRun,
  probeMedia,
  throwIfAborted,
  isRenderCancelledError,
  RenderCancelledError,
  type FfmpegRunOptions
} from './render-cache/ffmpeg-process'
import {
  computeSceneFingerprint,
  computeAssemblyFingerprint,
  computeAudioFingerprint,
  computeOverlayBlockFingerprint,
  computeCompositeFingerprint,
  computeRenderFingerprint,
  computeDirectorySignature,
  fileSignature,
  fingerprintOf,
  hashFileContent,
  hashJsonValue,
  type VisualBaseSettings
} from './render-cache/render-fingerprint'
import {
  createManifest,
  emptyCheckpoint,
  type RenderManifestV2,
  type RenderSceneCheckpoint,
  type OverlayBlockCheckpoint,
  type RenderArtifactCheckpoint,
  type InterruptionReason
} from './render-cache/render-manifest'
import {
  RenderWorkspace,
  readActiveRender,
  writeActiveRender,
  listRenderDescendantPids,
  pruneRenderCache,
  type ActiveRenderRecord,
  type ArtifactExpectation
} from './render-cache/render-cache-manager'
import {
  computeResourceLimits,
  AdaptiveThrottle,
  type RenderResourceProfile,
  type RenderResourceLimits
} from './render-cache/render-resource-manager'
import { loadRenderPreferences, type VideoEncoderMode } from './render-cache/render-preferences'
import {
  resolveEncoder,
  softwareEncoder,
  videoToolboxEncoder,
  asHardwareError,
  HardwareEncoderError,
  type EncoderProfile
} from './render-cache/video-encoder'
import { planOverlayBlocks, collectProtectedIntervals } from './render-cache/overlay-blocks'
import { runRenderPreflightCached } from './render-cache/preflight-cache'
import { APP_INSTANCE_ID } from './pipeline/pipeline-state'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RenderProgress {
  stage: string
  sceneIndex?: number
  totalScenes?: number
  progress: number   // 0..1
  timeMs?: number    // elapsed ms
}

export interface RenderCacheStats {
  renderFingerprint: string
  totalScenes: number
  reusedScenes: number
  renderedScenes: number
  reusedAssembly: boolean
  reusedAudioMix: boolean
  totalOverlayBlocks: number
  reusedOverlayBlocks: number
  reusedComposite: boolean
  resourceProfile: RenderResourceProfile
  encoder: string
  warnings: string[]
}

export interface RenderResult {
  outputPath: string
  durationSecs: number
  fileSizeBytes: number
  preflightReport?: RenderQaReport
  qaReport?: RenderQaReport
  cache?: RenderCacheStats
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

type OverlayRendererFn = typeof renderCaptionsOverlay
let overlayRenderer: OverlayRendererFn = renderCaptionsOverlay

/** Test-only: substitute the Remotion overlay renderer (null restores the real one). */
export function setOverlayRendererForTests(fn: OverlayRendererFn | null): void {
  overlayRenderer = fn ?? renderCaptionsOverlay
}

type TransitionAssemblerFn = typeof concatSceneClipsWithTransitions
let transitionAssembler: TransitionAssemblerFn = concatSceneClipsWithTransitions

/** Test-only: substitute the transition assembler (null restores the real one). */
export function setTransitionAssemblerForTests(fn: TransitionAssemblerFn | null): void {
  transitionAssembler = fn ?? concatSceneClipsWithTransitions
}

interface EncodeContext {
  ffmpeg: FfmpegRunOptions
  encoder: EncoderProfile
}

/** Plain FFmpeg run (stream copy / audio) with resource limits + cancellation. */
function ffmpegRun(args: string[], ctx?: EncodeContext): Promise<void> {
  return sharedFfmpegRun(args, ctx?.ffmpeg ?? {})
}

/** Video encode run — a failure with a hardware encoder is surfaced as HardwareEncoderError. */
async function encodeRun(args: string[], ctx: EncodeContext): Promise<void> {
  try {
    await sharedFfmpegRun(args, ctx.ffmpeg)
  } catch (err) {
    if (isRenderCancelledError(err)) throw err
    throw asHardwareError(err, ctx.encoder)
  }
}

/** Codec args for an encode — identical to the legacy `-c:v libx264 -preset fast -crf N` in software mode. */
function vcodec(ctx: EncodeContext, crf: number): string[] {
  return ctx.encoder.videoArgs(crf, 'fast')
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

/** rename() that also works across volumes (os.tmpdir → project cache). */
function moveFile(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    fs.copyFileSync(src, dst)
    safeUnlink(src)
  }
}

function concatListLine(f: string): string {
  return `file '${process.platform === 'win32' ? f.replace(/\\/g, '/') : f}'`
}

async function concatSceneClipsLegacy(
  sceneClips: string[],
  tmpDir: string,
  rawVideoPath: string,
  ctx?: EncodeContext
): Promise<void> {
  const concatList = path.join(tmpDir, 'concat.txt')
  fs.writeFileSync(
    concatList,
    // On macOS, paths are already using forward slashes. On Windows, convert backslashes.
    sceneClips.map(concatListLine).join('\n'),
    'utf-8'
  )
  await ffmpegRun([
    '-y',
    '-f', 'concat', '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    rawVideoPath
  ], ctx)
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

// ─── Scene clip rendering ─────────────────────────────────────────────────────

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
  ctx: EncodeContext
}): Promise<void> {
  const { beats, mediaPath, outClip, width, height, fps, scaleFilt, tmpDir, sceneIndex, ctx } = params

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
      throwIfAborted(ctx.ffmpeg.signal)
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
        await encodeRun([
          '-y', '-loop', '1', '-i', mediaPath,
          '-vf', vfFilter,
          ...vcodec(ctx, 20),
          '-t', String(beatDuration),
          '-r', String(fps),
          '-pix_fmt', 'yuv420p',
          beatClip
        ], ctx)
      } else {
        // Trim from asset — use ss for beat start offset (approximate)
        const ssOffset = beat.relativeStart
        await encodeRun([
          '-y',
          '-ss', String(ssOffset),
          '-i', mediaPath,
          '-vf', `${vfFilter},tpad=stop_mode=clone:stop_duration=${beatDuration},trim=duration=${beatDuration},setpts=PTS-STARTPTS`,
          ...vcodec(ctx, 20),
          '-t', String(beatDuration),
          '-r', String(fps),
          '-an',
          '-pix_fmt', 'yuv420p',
          beatClip
        ], ctx)
      }

      beatClips.push(beatClip)
    }

    // Concat beats into scene clip
    if (beatClips.length === 1) {
      // Just rename
      safeUnlink(outClip)
      moveFile(beatClips[0], outClip)
    } else {
      const beatConcatList = path.join(tmpDir, `beat_concat_${sceneIndex}.txt`)
      fs.writeFileSync(
        beatConcatList,
        beatClips.map(concatListLine).join('\n'),
        'utf-8'
      )
      await ffmpegRun([
        '-y', '-f', 'concat', '-safe', '0',
        '-i', beatConcatList,
        '-c', 'copy',
        outClip
      ], ctx)
      // Cleanup beat clips + concat list
      for (const bc of beatClips) safeUnlink(bc)
      safeUnlink(beatConcatList)
    }

    logger.info(`[RetentionEngine] scene ${sceneIndex}: ${beats.length} beats rendered and concatenated`)

  } catch (err) {
    // Cancellation and hardware-encoder failures must propagate (no silent fallback).
    if (isRenderCancelledError(err) || err instanceof HardwareEncoderError) {
      for (const bc of beatClips) safeUnlink(bc)
      throw err
    }
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
      await encodeRun([
        '-y', '-loop', '1', '-i', mediaPath,
        '-vf', baseFilt,
        ...vcodec(ctx, 20),
        '-t', String(fallbackDur),
        '-r', String(fps), '-pix_fmt', 'yuv420p', outClip
      ], ctx)
    } else {
      await encodeRun([
        '-y', '-i', mediaPath,
        '-vf', `${baseFilt},tpad=stop_mode=clone:stop_duration=${fallbackDur},trim=duration=${fallbackDur},setpts=PTS-STARTPTS`,
        ...vcodec(ctx, 20),
        '-t', String(fallbackDur),
        '-r', String(fps), '-an', '-pix_fmt', 'yuv420p', outClip
      ], ctx)
    }
  }
}

// ─── Render plan preparation (pure — no FFmpeg) ───────────────────────────────

export interface SceneRenderJob {
  ordinal: number                 // 1-based render position
  scene: ScenePlan
  mediaPath: string | null
  mediaName: string
  mediaKind: ResolvedMediaKind | 'placeholder'
  beats: VisualBeat[]
  useBeats: boolean
  scaleFilt: string
  fingerprint: string
}

export interface PreparedRenderPlan {
  projectDir: string
  voiceoverPath: string
  outputName: string
  resolution: { width: number; height: number }
  fps: number
  transitionSettings: RenderTransitionSettings | undefined
  validTransitionSettings: RenderTransitionSettings | undefined
  plan: EditPlan
  mediaIndex: Array<{ filename: string; path: string }>
  sceneEntries: RenderSceneEntry[]
  scenes: ScenePlan[]
  resolvedMediaCount: number
  missingMediaCount: number
  retentionSettings: RetentionSettings
  retentionDecisions: Map<number, RetentionDecision>
  retentionPlan: RetentionPlan | null
  retentionPlanMap: Map<number, RetentionScenePlan>
  visualPlanMap: Map<number, { strategy?: string; motion?: any; motionPreset?: any; category?: string }>
  sceneJobs: SceneRenderJob[]
  base: VisualBaseSettings
  hashes: {
    plan: string
    mediaIndex: string
    stockAssignments: string
    captionPlan: string
    audioPlan: string
    productionSettings: string
    visualGrammarPlan: string
  }
  renderFingerprint: string
  assemblyFingerprint: string
  totalDurationSecs: number
}

export function encoderKeyFor(mode: VideoEncoderMode | string | undefined, resolution: { width: number; height: number }, fps: number): string {
  return mode === 'videotoolbox-h264'
    ? videoToolboxEncoder(resolution.width, resolution.height, fps).key
    : softwareEncoder().key
}

/**
 * Loads the edit plan, resolves scene media, computes retention decisions and every
 * fingerprint. Has no FFmpeg side effects, so it is also used for crash-recovery inspection.
 */
export function prepareRenderPlan(params: {
  projectDir: string
  voiceoverPath: string
  outputName?: string
  resolution?: { width: number; height: number }
  fps?: number
  captionPlan?: CaptionPlan
  transitionSettings?: RenderTransitionSettings
  encoderKey: string
}): PreparedRenderPlan {
  const outputName = params.outputName ?? 'final_output'
  const resolution = params.resolution ?? { width: 1920, height: 1080 }
  const fps = params.fps ?? 30
  const projectDir = normalizePathForFFmpeg(params.projectDir)
  const voiceoverPath = normalizePathForFFmpeg(params.voiceoverPath)

  // ── 1. Load edit plan ─────────────────────────────────────────────────────
  const planPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
  if (!fs.existsSync(planPath)) throw new Error('No edit plan found. Run AI Planning first.')
  const plan: EditPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))

  // ── 2. Load media index ───────────────────────────────────────────────────
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
          scene: scene as unknown as RenderSceneEntry['scene'],
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
  const scenes: ScenePlan[] = sceneEntries.map(entry => entry.scene as unknown as ScenePlan)

  // ── 3b. Media Preflight ──────────────────────────────────────────────────
  let resolvedMediaCount = 0
  let missingMediaCount = 0
  for (const scene of scenes) {
    const resolved = resolveSceneMediaWithSource(scene, mediaIndex, projectDir)
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
      logger.debug(
        `[RENDER][Media] scene=${scene.sceneIndex} source=${resolved.source} mediaKind=${detectedKind} exists=true path=${resolved.mediaPath}`
      )
    } else {
      missingMediaCount++
      logger.warn(
        `[RENDER][Media] scene=${scene.sceneIndex} source=${resolved.source} exists=false`
      )
    }
  }

  // Load visual mix plan or Health visual plan if available to detect AI images and motion presets
  const visualPlanMap = new Map<number, { strategy?: string; motion?: any; motionPreset?: any; category?: string }>()
  const visualMixPlanPath = path.join(projectDir, 'analysis', 'visual-mix-plan.json')
  if (fs.existsSync(visualMixPlanPath)) {
    try {
      const vp = JSON.parse(fs.readFileSync(visualMixPlanPath, 'utf-8'))
      for (const sc of vp.scenes || []) {
        if (sc && typeof sc.sceneIndex === 'number') {
          visualPlanMap.set(sc.sceneIndex, sc)
        }
      }
    } catch { /* ignore */ }
  }
  const healthPlanPath = path.join(projectDir, 'analysis', 'health-visual-plan.json')
  if (fs.existsSync(healthPlanPath)) {
    try {
      const hp = JSON.parse(fs.readFileSync(healthPlanPath, 'utf-8'))
      for (const sc of hp.scenes || []) {
        if (sc && typeof sc.sceneIndex === 'number' && !visualPlanMap.has(sc.sceneIndex)) {
          visualPlanMap.set(sc.sceneIndex, sc)
        }
      }
    } catch { /* ignore */ }
  }

  // ── Retention Engine & Retention Director setup ───────────────────────────
  const retentionSettings: RetentionSettings = DEFAULT_RETENTION_SETTINGS
  const retCtx = createDefaultContext()

  // Ensure or load Retention Plan (deterministic, whole-narrative analysis)
  const retentionPlanMap = new Map<number, RetentionScenePlan>()
  let retentionPlan: RetentionPlan | null = null
  try {
    const rawScenes = scenes.map((s, idx) => ({
      sceneIndex: s.sceneIndex ?? idx,
      sceneId: String(s.sceneIndex ?? idx),
      duration: s.duration,
      narrativeText: (s as any).narrativeText,
      visualIntent: s.visualIntent,
      energyLevel: (s as any).energyLevel,
      shotType: (s as any).shotType,
      isPatternInterrupt: (s as any).isPatternInterrupt,
      isFirstInChapter: idx === 0 || (s as any).isFirstInChapter,
      visualStrategy: visualPlanMap.get(s.sceneIndex)?.strategy,
      category: visualPlanMap.get(s.sceneIndex)?.category,
      motionPreset: visualPlanMap.get(s.sceneIndex)?.motionPreset,
      localPath: s.localPath
    }))

    retentionPlan = ensureRetentionPlan(projectDir, {
      scenes: rawScenes,
      level: retentionSettings.level
    })

    if (retentionPlan) {
      for (const sp of retentionPlan.scenes) {
        retentionPlanMap.set(sp.sceneIndex, sp)
      }
    }
  } catch (err) {
    logger.warn(`[RENDER] Failed to ensure retention plan (falling open to legacy): ${String(err)}`)
    retentionPlan = null
  }

  // Pre-compute retention decisions for all scenes (sequential context tracking)
  const retentionDecisions = new Map<number, RetentionDecision>()
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    const retentionHint = retentionPlanMap.get(scene.sceneIndex) ?? retentionPlanMap.get(i)
    const sceneInput: SceneRetentionInput = {
      sceneId: String(scene.sceneIndex),
      sceneIndex: i,
      duration: scene.duration,
      energyLevel: (scene as any).energyLevel,
      shotType: (scene as any).shotType,
      narrativeText: (scene as any).narrativeText,
      visualIntent: scene.visualIntent,
      isPatternInterrupt: (scene as any).isPatternInterrupt || retentionHint?.patternInterrupt,
      localPath: scene.localPath,
      isNewChapter: i === 0 || (scene as any).isFirstInChapter,
      retentionHint
    }
    const decision = resolveSceneRetention(sceneInput, retCtx, retentionSettings)
    retentionDecisions.set(i, decision)
    updateRetentionContext(retCtx, sceneInput, decision)
  }

  // ── Scene jobs + fingerprints ─────────────────────────────────────────────
  const { width, height } = resolution
  const base: VisualBaseSettings = { width, height, fps, encoderProfile: params.encoderKey }
  const scaleFilt = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`

  const sceneJobs: SceneRenderJob[] = scenes.map((scene, i) => {
    const mediaPath = (scene.localPath && fs.existsSync(scene.localPath))
      ? scene.localPath
      : resolveSceneMedia(scene, mediaIndex, projectDir)
    const hasMedia = !!mediaPath && fs.existsSync(mediaPath)
    const mediaName = scene.localPath
      ? path.basename(scene.localPath)
      : (scene.mediaFile || scene.localAsset || scene.visualIntent || `Scene_${scene.sceneIndex}`)
    const mediaKind: SceneRenderJob['mediaKind'] = hasMedia ? detectMediaKind(mediaPath!, scene.mediaType) : 'placeholder'
    const beats = retentionDecisions.get(i)?.visualBeats ?? []
    const useBeats = hasMedia && beats.length > 1 && retentionSettings.enabled
    const visualScene = visualPlanMap.get(scene.sceneIndex)
    const isAiStill =
      mediaKind === 'image' &&
      (visualScene?.strategy === 'ai-still' ||
        (mediaPath && (
          mediaPath.includes(path.join('assets', 'generated', 'health')) ||
          mediaPath.includes('/assets/generated/health/') ||
          mediaPath.includes(path.join('assets', 'generated', 'general')) ||
          mediaPath.includes('/assets/generated/general/')
        )))
    const motionPreset = isAiStill ? (visualScene?.motionPreset || visualScene?.motion || 'push-in-center') : ''
    const effectiveFilter = isAiStill ? `${scaleFilt}:motion=${typeof motionPreset === 'object' ? motionPreset.preset : motionPreset}` : scaleFilt
    const fingerprint = computeSceneFingerprint({
      sceneOrdinal: i + 1,
      sceneIndex: scene.sceneIndex,
      duration: scene.duration,
      startTime: scene.startTime,
      mediaType: mediaKind,
      mediaSignature: hasMedia ? fileSignature(mediaPath) : null,
      visualBeats: hasMedia ? beats.map((b) => ({ s: b.relativeStart, e: b.relativeEnd, crop: b.crop ?? null })) : null,
      filterChain: effectiveFilter,
      multiBeat: useBeats,
      semanticCrop: !!retentionSettings.semanticCropEnabled,
      base
    })
    return {
      ordinal: i + 1,
      scene,
      mediaPath: hasMedia ? mediaPath : null,
      mediaName,
      mediaKind,
      beats,
      useBeats,
      scaleFilt,
      fingerprint
    }
  })

  const validTransitionSettings = validateTransitionSettings(params.transitionSettings)
  const analysis = path.join(projectDir, 'analysis')
  const cp = params.captionPlan
  const hashes = {
    plan: hashFileContent(planPath),
    mediaIndex: hashFileContent(mediaIndexPath),
    stockAssignments: hashFileContent(path.join(analysis, 'stock-assignments.json')),
    captionPlan: cp ? hashJsonValue(cp) : 'none',
    audioPlan: hashFileContent(path.join(analysis, 'audio-plan.json')),
    productionSettings: hashFileContent(path.join(analysis, 'production-settings.json')),
    visualGrammarPlan: hashFileContent(path.join(analysis, 'visual-grammar-plan.json'))
  }

  const assemblyFingerprint = computeAssemblyFingerprint({
    sceneFingerprints: sceneJobs.map((j) => j.fingerprint),
    sceneBoundaryMeta: sceneEntries.map((e) => ({
      c: e.chapterIndex,
      s: e.sequenceIndex,
      fc: e.isFirstInChapter,
      fs: e.isFirstInSequence,
      t: e.scene.transitionIn,
      d: e.scene.duration
    })),
    transitionSettings: validTransitionSettings ?? null,
    base
  })

  const renderFingerprint = computeRenderFingerprint({
    masterEditPlanHash: hashes.plan,
    mediaIndexHash: hashes.mediaIndex,
    stockAssignmentsHash: hashes.stockAssignments,
    captionPlanHash: hashes.captionPlan,
    audioPlanHash: hashes.audioPlan,
    voiceover: fileSignature(voiceoverPath),
    base,
    transitionSettings: validTransitionSettings ?? null,
    retentionSettings,
    proofVisualSettings: { enabled: retentionSettings.proofVisualsEnabled, prod: hashes.productionSettings },
    // visual-grammar-plan.json may be auto-generated BY the render itself, so it is not
    // part of the workspace key; the resolved decisions are hashed into every overlay
    // block fingerprint (overlayPropsHash) instead, which invalidates overlays correctly.
    visualGrammarSettings: { prod: hashes.productionSettings },
    sceneFingerprints: sceneJobs.map((j) => j.fingerprint)
  })

  return {
    projectDir,
    voiceoverPath,
    outputName,
    resolution,
    fps,
    transitionSettings: params.transitionSettings,
    validTransitionSettings,
    plan,
    mediaIndex,
    sceneEntries,
    scenes,
    resolvedMediaCount,
    missingMediaCount,
    retentionSettings,
    retentionDecisions,
    retentionPlan,
    retentionPlanMap,
    visualPlanMap,
    sceneJobs,
    base,
    hashes,
    renderFingerprint,
    assemblyFingerprint,
    totalDurationSecs: scenes.reduce((a, s) => a + s.duration, 0)
  }
}

/** Key used by the RenderJobCoordinator to detect "same render requested twice". */
export function computeRenderRequestKey(params: {
  projectDir: string
  voiceoverPath: string
  outputName?: string
  resolution?: { width: number; height: number }
  fps?: number
  transitionSettings?: RenderTransitionSettings
  captionPlan?: CaptionPlan
}): string {
  const projectDir = normalizePathForFFmpeg(params.projectDir)
  const analysis = path.join(projectDir, 'analysis')
  return fingerprintOf({
    projectDir,
    voiceover: fileSignature(params.voiceoverPath ? normalizePathForFFmpeg(params.voiceoverPath) : null),
    outputName: params.outputName ?? 'final_output',
    resolution: params.resolution ?? { width: 1920, height: 1080 },
    fps: params.fps ?? 30,
    transitions: validateTransitionSettings(params.transitionSettings) ?? null,
    captions: params.captionPlan ? hashJsonValue(params.captionPlan) : 'none',
    plan: hashFileContent(path.join(analysis, 'master-edit-plan.json')),
    audio: hashFileContent(path.join(analysis, 'audio-plan.json')),
    stock: hashFileContent(path.join(analysis, 'stock-assignments.json'))
  })
}

// ─── Main render function ─────────────────────────────────────────────────────

export interface RenderVideoParams {
  projectDir: string
  voiceoverPath: string
  outputName?: string
  resolution?: { width: number; height: number }
  fps?: number
  captionPlan?: CaptionPlan   // optional — nếu null/undefined sẽ bỏ qua bước burn caption
  transitionSettings?: RenderTransitionSettings
  onProgress?: (p: RenderProgress) => void
  // ── Resumable Render Engine V2 (all optional — defaults keep legacy behaviour) ──
  signal?: AbortSignal
  resourceProfile?: RenderResourceProfile
  encoderMode?: VideoEncoderMode
  remotionHardwareAcceleration?: boolean
  source?: 'manual' | 'pipeline'
  /** true when started by crash auto-resume (counts towards the one-time limit) */
  isAutoResume?: boolean
  pipelineRunId?: string
  getCancelReason?: () => 'user-cancelled' | 'app-closed' | undefined
}

export async function renderVideo(params: RenderVideoParams): Promise<RenderResult> {
  try {
    return await renderVideoV2(params, undefined)
  } catch (err) {
    if (err instanceof HardwareEncoderError && !params.signal?.aborted) {
      logger.warn(`[RENDER] ${err.message} — falling back to Software H.264`)
      params.onProgress?.({ stage: 'Hardware encoder failed — retrying with Software H.264...', progress: 0.05 })
      return renderVideoV2(params, 'software-h264', [`Hardware encoder failed and was replaced by Software H.264: ${err.message}`])
    }
    throw err
  }
}

async function renderVideoV2(
  params: RenderVideoParams,
  encoderOverride: VideoEncoderMode | undefined,
  carriedWarnings: string[] = []
): Promise<RenderResult> {
  const prefs = loadRenderPreferences()
  const signal = params.signal
  const resourceProfile = params.resourceProfile ?? prefs.resourceProfile
  const requestedEncoder: VideoEncoderMode = encoderOverride ?? params.encoderMode ?? prefs.videoEncoder
  const remotionHw = params.remotionHardwareAcceleration ?? prefs.remotionHardwareAcceleration
  const limits: RenderResourceLimits = computeResourceLimits(resourceProfile)
  const warnings: string[] = [...carriedWarnings]

  const {
    outputName = 'final_output',
    resolution = { width: 1920, height: 1080 },
    fps = 30,
    onProgress
  } = params

  const progress = (stage: string, pct: number, extra: Partial<RenderProgress> = {}): void => {
    logger.info(`[RENDER] ${stage} (${Math.round(pct * 100)}%)`)
    onProgress?.({ stage, progress: pct, ...extra })
  }

  let tmpDir: string | undefined = undefined
  let publishPartial: string | undefined = undefined
  let workspace: RenderWorkspace | undefined
  let manifest: RenderManifestV2 | undefined
  let activeRecord: ActiveRenderRecord | undefined
  let heartbeat: NodeJS.Timeout | undefined
  const throttle = new AdaptiveThrottle(limits, (msg) => progress(msg, lastPct))
  let lastPct = 0.02

  const setPct = (stage: string, pct: number, extra: Partial<RenderProgress> = {}): void => {
    lastPct = pct
    progress(stage, pct, extra)
  }

  try {
    // ── 0. Encoder + resource profile ─────────────────────────────────────────
    const encoder = await resolveEncoder(requestedEncoder, { ...resolution, fps }, warnings)
    const ffmpegOpts: FfmpegRunOptions = {
      signal,
      threads: limits.ffmpegThreads,
      filterThreads: limits.ffmpegFilterThreads,
      niceLevel: limits.niceLevel
    }
    const ctx: EncodeContext = { ffmpeg: ffmpegOpts, encoder }
    logger.info(
      `[RENDER] Resource profile=${limits.profile} ffmpegThreads=${limits.ffmpegThreads} ` +
      `filterThreads=${limits.ffmpegFilterThreads} remotionConcurrency=${limits.remotionConcurrency} encoder=${encoder.key}`
    )

    // ── 1–3. Load edit plan, media index, flatten scenes, resolve media ──────
    setPct('Loading edit plan...', 0.02)
    setPct('Loading media index...', 0.04)
    const prepared = prepareRenderPlan({
      projectDir: params.projectDir,
      voiceoverPath: params.voiceoverPath,
      outputName,
      resolution,
      fps,
      captionPlan: params.captionPlan,
      transitionSettings: params.transitionSettings,
      encoderKey: encoder.key
    })
    const { projectDir, voiceoverPath, scenes, sceneEntries, sceneJobs, retentionSettings, retentionDecisions, retentionPlan, retentionPlanMap, visualPlanMap } = prepared
    const totalScenes = scenes.length
    setPct(`Processing ${totalScenes} scenes...`, 0.06)

    // ── 3a. Production Intelligence: Preflight QA (reused if inputs unchanged) ─
    setPct('Running preflight QA checks...', 0.07)
    const { report: preflightReport } = await runRenderPreflightCached({
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
    throwIfAborted(signal)

    // ── 3a-2. Manual AI (Prompt mode) guard ──────────────────────────────────
    // The user chose to supply the AI images themselves. A missing image must STOP the render
    // instead of silently becoming a black placeholder or Stock footage.
    const missingManualAiScenes = findMissingManualAiScenes(projectDir)
    if (missingManualAiScenes.length > 0) {
      throw new Error(
        `Manual AI images missing for scenes: ${missingManualAiScenes.join(', ')}. ` +
          'Import the missing images (Production → Find Visuals → Import AI Images) before rendering.'
      )
    }

    // ── 3b. Media Preflight ──────────────────────────────────────────────────
    setPct('Validating scene media...', 0.08)
    logger.info(
      `[RENDER][Media] resolved=${prepared.resolvedMediaCount} missing=${prepared.missingMediaCount} total=${scenes.length}`
    )

    if (scenes.length > 0 && prepared.resolvedMediaCount === 0) {
      throw new Error(
        'No scene media could be resolved. Refusing to render an all-black video. Check master-edit-plan.json, media-index.json and stock-assignments.json.'
      )
    }

    // Run retention QA & generate retention summary (flags only — does NOT block render)
    try {
      const qaScenes = scenes.map((s, i) => ({
        sceneIndex: i,
        sceneId: String(s.sceneIndex),
        duration: s.duration,
        energyLevel: (s as any).energyLevel,
        shotType: (s as any).shotType,
        narrativeText: (s as any).narrativeText,
        visualIntent: s.visualIntent,
        isPatternInterrupt: (s as any).isPatternInterrupt || retentionPlanMap.get(i)?.patternInterrupt,
        visualBeats: retentionDecisions.get(i)?.visualBeats,
        motionPreset: visualPlanMap.get(s.sceneIndex)?.motionPreset,
        category: visualPlanMap.get(s.sceneIndex)?.category
      }))
      const qaFlags = runRetentionQA(qaScenes, retentionPlan)
      if (qaFlags.length > 0) {
        const qaPath = path.join(projectDir, 'analysis', 'retention-qa.json')
        fs.writeFileSync(qaPath, JSON.stringify(qaFlags, null, 2), 'utf-8')
        logger.info(`[RENDER] Retention QA: ${qaFlags.length} flags saved to retention-qa.json`)
      }
      const summary = generateRetentionSummary(qaScenes, retentionPlan, qaFlags)
      saveRetentionSummary(projectDir, summary)
    } catch (err) {
      logger.warn(`[RENDER] Retention QA failed (non-blocking): ${String(err)}`)
    }

    // ── 4. Persistent render workspace (resumable) ───────────────────────────
    workspace = new RenderWorkspace(projectDir, prepared.renderFingerprint)
    workspace.ensure()
    const stale = workspace.cleanupStalePartials()
    const previousActive = readActiveRender(projectDir)
    const existing = workspace.loadManifest()
    const resuming = !!existing && existing.status !== 'completed'
    manifest = existing ?? createManifest({
      renderFingerprint: prepared.renderFingerprint,
      projectDir,
      outputName,
      settings: {
        resolution,
        fps,
        transitionSettings: prepared.validTransitionSettings ?? null,
        resourceProfile: limits.profile,
        encoderMode: encoder.mode
      }
    })
    manifest.outputName = outputName
    manifest.settings.resourceProfile = limits.profile
    manifest.settings.encoderMode = encoder.mode
    manifest.status = 'rendering-scenes'
    manifest.interruptedAt = undefined
    manifest.interruptionReason = undefined
    manifest.warnings = [...warnings]
    if (stale.length) manifest.warnings.push(`Discarded ${stale.length} incomplete partial file(s) from an interrupted run`)
    workspace.saveManifest(manifest)
    workspace.touch()
    workspace.logEvent({ event: resuming ? 'render-resume' : 'render-start', fingerprint: prepared.renderFingerprint, profile: limits.profile, encoder: encoder.key })

    activeRecord = {
      schemaVersion: 1,
      renderFingerprint: prepared.renderFingerprint,
      workspace: workspace.name,
      status: 'running',
      source: params.source ?? 'manual',
      pid: process.pid,
      appInstanceId: APP_INSTANCE_ID,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      params: {
        voiceoverPath,
        outputName,
        resolution,
        fps,
        transitionSettings: params.transitionSettings
      },
      autoResumeAfterCrash: prefs.autoResumeAfterCrash,
      autoResumeCount: params.isAutoResume
        ? (previousActive?.autoResumeCount ?? 0) + 1
        : (params.source === 'pipeline' &&
            previousActive?.renderFingerprint === prepared.renderFingerprint &&
            previousActive.status !== 'completed'
            ? previousActive.autoResumeCount ?? 0
            : 0),
      pipelineRunId: params.pipelineRunId
    }
    writeActiveRender(projectDir, activeRecord)
    heartbeat = setInterval(() => {
      void (async () => {
        if (!activeRecord || activeRecord.status !== 'running') return
        activeRecord.heartbeatAt = new Date().toISOString()
        activeRecord.childPids = await listRenderDescendantPids()
        try { writeActiveRender(projectDir, activeRecord) } catch { /* ignore */ }
      })()
    }, 5000)
    heartbeat.unref?.()
    throttle.start()

    // Truly temporary scratch (beat clips, concat lists) — never needed for resume
    const projectHash = Buffer.from(projectDir).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `auto-edit-render-${projectHash}-`))
    logger.info(`[RENDER] Render workspace: ${workspace.dir} (resuming=${resuming})`)

    const { width, height } = resolution
    const sceneClips: string[] = []
    let reusedScenes = 0

    // Carry over checkpoints whose fingerprint still matches
    const prevScenes = new Map((existing?.scenes ?? []).map((s) => [s.ordinal, s]))
    manifest.scenes = sceneJobs.map((job): RenderSceneCheckpoint => {
      const prev = prevScenes.get(job.ordinal)
      if (prev && prev.fingerprint === job.fingerprint && prev.status === 'completed') return { ...prev, reused: false }
      return {
        ordinal: job.ordinal,
        sceneIndex: job.scene.sceneIndex,
        expectedDuration: job.scene.duration,
        status: 'pending',
        fingerprint: job.fingerprint,
        artifactPath: workspace!.scenePath(job.ordinal)
      }
    })
    workspace.saveManifest(manifest)

    // ── 5. Scene clips (persistent, resumable) ───────────────────────────────
    const recentAiMotionPresets: string[] = []
    for (let i = 0; i < sceneJobs.length; i++) {
      throwIfAborted(signal)
      const job = sceneJobs[i]
      const scene = job.scene
      const cp = manifest.scenes[i]
      const outClip = workspace.scenePath(job.ordinal)
      const pct = 0.08 + (i / totalScenes) * 0.68
      const expect: ArtifactExpectation = {
        fingerprint: job.fingerprint,
        kind: 'scene',
        width,
        height,
        fps,
        durationSecs: scene.duration,
        // Clips are frame-quantized per beat; the legacy renderer only warned on drift
        durationTolerance: Math.max(0.5, (job.beats.length + 2) / fps),
        lenient: true
      }

      const reuse = await workspace.tryReuse(outClip, expect, signal)
      if (reuse.ok) {
        reusedScenes++
        cp.status = 'completed'
        cp.reused = true
        cp.artifactPath = outClip
        cp.sizeBytes = reuse.meta?.sizeBytes
        cp.durationSecs = reuse.probe?.duration
        cp.width = reuse.probe?.width
        cp.height = reuse.probe?.height
        cp.fps = reuse.probe?.fps
        sceneClips.push(outClip)
        setPct(`Reusing cached scene ${i + 1}/${totalScenes}`, pct, { sceneIndex: i + 1, totalScenes })
        // Persist progress periodically while fast-forwarding through cached scenes
        if (i % 10 === 0) workspace.saveManifest(manifest)
        continue
      }

      await throttle.beforeNextJob(signal)
      setPct(`Rendering scene ${i + 1}/${totalScenes}: ${job.mediaName}`, pct, { sceneIndex: i + 1, totalScenes })
      cp.status = 'running'
      cp.startedAt = new Date().toISOString()
      workspace.saveManifest(manifest)

      const partial = outClip.replace(/\.mp4$/, '.partial.mp4')
      safeUnlink(partial)
      await renderSceneClip({
        job,
        outClip: partial,
        width,
        height,
        fps,
        tmpDir,
        ctx,
        retentionSettings,
        sceneOrdinalIndex: i,
        visualPlanMap,
        retentionPlanMap,
        recentAiMotionPresets
      })

      let probe
      try {
        probe = await workspace.commitPartial(partial, outClip, expect, { encoder: encoder.key, signal })
      } catch (err) {
        if (isRenderCancelledError(err)) throw err
        throw new Error(`Scene ${scene.sceneIndex} did not produce a valid video clip. ${String((err as Error).message ?? err)}`)
      }
      const maxAllowedDiff = 1 / fps + 0.05
      const diff = Math.abs(probe.duration - scene.duration)
      if (diff > maxAllowedDiff) {
        logger.warn(
          `[RENDER] Scene ${scene.sceneIndex} duration deviation: expected=${scene.duration.toFixed(3)}s actual=${probe.duration.toFixed(3)}s diff=${diff.toFixed(3)}s (tolerance=${maxAllowedDiff.toFixed(3)}s)`
        )
      }
      logger.info(
        `[RENDER] Scene ${scene.sceneIndex} clip validated: path=${outClip} duration=${probe.duration.toFixed(3)}s resolution=${probe.width}x${probe.height}`
      )
      cp.status = 'completed'
      cp.reused = false
      cp.completedAt = new Date().toISOString()
      cp.sizeBytes = fs.statSync(outClip).size
      cp.durationSecs = probe.duration
      cp.width = probe.width
      cp.height = probe.height
      cp.fps = probe.fps
      // Persist after every completed scene so a crash loses at most one scene
      workspace.saveManifest(manifest)
      workspace.logEvent({ event: 'scene-completed', ordinal: job.ordinal, sceneIndex: scene.sceneIndex })
      sceneClips.push(outClip)
    }
    workspace.saveManifest(manifest)

    // ── 6. Scene assembly (checkpoint) ───────────────────────────────────────
    throwIfAborted(signal)
    manifest.status = 'assembling-scenes'
    manifest.progress.currentPhase = 'assembling-scenes'
    const rawVideo = workspace.rawVideoPath
    const assemblyExpect: ArtifactExpectation = {
      fingerprint: prepared.assemblyFingerprint,
      kind: 'assembly',
      width,
      height,
      fps,
      durationSecs: prepared.totalDurationSecs,
      durationTolerance: Math.max(1.0, sceneJobs.length * 1.5 / fps),
      lenient: true
    }
    let reusedAssembly = false
    const assemblyReuse = await workspace.tryReuse(rawVideo, assemblyExpect, signal)
    let rawProbe = assemblyReuse.probe
    if (assemblyReuse.ok) {
      reusedAssembly = true
      setPct(reusedScenes === totalScenes ? 'Reusing assembled scene video' : 'Reusing cached scene assembly', 0.78)
    } else {
      setPct('Assembling cached scene clips', 0.78)
      manifest.assembly = { status: 'running', fingerprint: prepared.assemblyFingerprint, startedAt: new Date().toISOString(), artifactPath: rawVideo }
      workspace.saveManifest(manifest)
      const rawPartial = rawVideo.replace(/\.mp4$/, '.partial.mp4')
      safeUnlink(rawPartial)

      const validSettings = prepared.validTransitionSettings
      const shouldAttemptTransitions =
        validSettings &&
        validSettings.enabled &&
        sceneEntries.length > 1

      let rawVideoCreated = false

      if (shouldAttemptTransitions) {
        try {
          setPct('Resolving scene transitions...', 0.78)
          rawVideoCreated = await transitionAssembler({
            sceneEntries,
            sceneClips,
            settings: validSettings!,
            fps,
            tmpDir,
            rawVideoPath: rawPartial,
            onProgress: (stage, pct) => setPct(stage, pct),
            ffmpegOptions: ffmpegOpts,
            videoCodecArgs: vcodec(ctx, 20),
            maxScenesPerSegment: limits.assemblyMaxScenesPerSegment,
            segmentRunner: async (seg, render) => {
              const segPath = workspace!.assemblySegmentPath(seg.segmentIndex)
              const segExpect: ArtifactExpectation = {
                fingerprint: fingerprintOf({ assembly: prepared.assemblyFingerprint, seg }),
                kind: 'assembly-segment',
                width,
                height,
                fps,
                frames: seg.endFrameExclusive - seg.startFrame,
                durationSecs: seg.endSec - seg.startSec,
                durationTolerance: 2 / fps + 0.05,
                lenient: true
              }
              const segReuse = await workspace!.tryReuse(segPath, segExpect, signal)
              if (segReuse.ok) {
                setPct(`Reusing assembled segment ${seg.segmentIndex}`, lastPct)
                return segPath
              }
              await throttle.beforeNextJob(signal)
              const segPartial = segPath.replace(/\.mp4$/, '.partial.mp4')
              safeUnlink(segPartial)
              try {
                await render(segPartial)
              } catch (err) {
                if (isRenderCancelledError(err)) throw err
                throw asHardwareError(err, encoder)
              }
              await workspace!.commitPartial(segPartial, segPath, segExpect, { encoder: encoder.key, signal })
              workspace!.logEvent({ event: 'assembly-segment-completed', segment: seg.segmentIndex })
              return segPath
            }
          })
          if (rawVideoCreated) {
            logger.info('[RENDER] Scene assembly method=transitions')
          }
        } catch (err: unknown) {
          if (isRenderCancelledError(err) || err instanceof HardwareEncoderError) throw err
          logger.warn(
            `[Transitions] Transition render failed, falling back to legacy concat: ${String(err)}`
          )
          setPct('Transitions failed — using standard cuts...', 0.79)
          safeUnlink(rawPartial)
          rawVideoCreated = false
        }
      }

      if (!rawVideoCreated) {
        const method = shouldAttemptTransitions ? 'legacy-fallback' : 'legacy-concat'
        logger.info(`[RENDER] Scene assembly method=${method}`)
        await concatSceneClipsLegacy(sceneClips, tmpDir, rawPartial, ctx)
        rawVideoCreated = true
      }

      // ── Validate raw_video.mp4 before audio ──
      try {
        rawProbe = await workspace.commitPartial(rawPartial, rawVideo, assemblyExpect, { encoder: encoder.key, signal })
      } catch (err) {
        if (isRenderCancelledError(err)) throw err
        throw new Error(
          `The scene assembly step produced an invalid raw video. Audio and captions were not applied. (${String((err as Error).message ?? err)})`
        )
      }
      workspace.logEvent({ event: 'assembly-completed' })
    }
    manifest.assembly = {
      status: 'completed',
      fingerprint: prepared.assemblyFingerprint,
      artifactPath: rawVideo,
      reused: reusedAssembly,
      durationSecs: rawProbe?.duration,
      width: rawProbe?.width,
      height: rawProbe?.height,
      fps: rawProbe?.fps,
      sizeBytes: fs.statSync(rawVideo).size,
      completedAt: new Date().toISOString()
    }
    workspace.saveManifest(manifest)

    if (rawProbe && (rawProbe.width !== width || rawProbe.height !== height)) {
      logger.warn(
        `[RENDER] Raw video resolution ${rawProbe.width}x${rawProbe.height} does not match target ${width}x${height}`
      )
    }

    logger.info(
      `[RENDER] Raw video validated:\npath=${rawVideo}\nduration=${rawProbe?.duration.toFixed(3)}s\nresolution=${rawProbe?.width}x${rawProbe?.height}\nsizeBytes=${fs.statSync(rawVideo).size}`
    )

    // ── 7. Load audio plan (Smart Audio Director) ─────────────────────────────
    throwIfAborted(signal)
    setPct('Loading audio plan…', 0.86)
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

    // ── 8. Mix voiceover + music + SFX (checkpoint) ───────────────────────────
    manifest.status = 'mixing-audio'
    manifest.progress.currentPhase = 'mixing-audio'
    const audioFingerprint = computeAudioFingerprint({
      assemblyFingerprint: prepared.assemblyFingerprint,
      voiceover: hasAudio ? fileSignature(voiceoverPath) : null,
      audioPlanHash: hasMusicOrSfx ? prepared.hashes.audioPlan : 'none',
      musicSignatures: approvedMusic.map((s) => fileSignature(normalizePathForFFmpeg(s.approvedLocalPath!))),
      sfxSignatures: approvedSfx.map((s) => fileSignature(normalizePathForFFmpeg(s.approvedLocalPath!)))
    })
    const mixedVideo = workspace.mixedVideoPath
    const mixExpect: ArtifactExpectation = {
      fingerprint: audioFingerprint,
      kind: 'audio-mix',
      width,
      height,
      requireAudio: hasAudio || hasMusicOrSfx,
      lenient: true
    }
    let reusedAudioMix = false
    const mixReuse = await workspace.tryReuse(mixedVideo, mixExpect, signal)
    let audioProbe = mixReuse.probe
    if (mixReuse.ok) {
      reusedAudioMix = true
      setPct('Reusing completed audio mix', 0.90)
    } else {
      setPct('Mixing audio tracks…', 0.90)
      manifest.audioMix = { status: 'running', fingerprint: audioFingerprint, startedAt: new Date().toISOString(), artifactPath: mixedVideo }
      workspace.saveManifest(manifest)
      const workingOutputPath = mixedVideo.replace(/\.mp4$/, '.partial.mp4')
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
        ], ctx)
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
        ], ctx)
      }

      try {
        audioProbe = await workspace.commitPartial(workingOutputPath, mixedVideo, mixExpect, { signal })
      } catch (err) {
        if (isRenderCancelledError(err)) throw err
        throw new Error(`The audio mixing step produced an invalid video. (${String((err as Error).message ?? err)})`)
      }
      workspace.logEvent({ event: 'audio-mix-completed' })
    }
    manifest.audioMix = {
      status: 'completed',
      fingerprint: audioFingerprint,
      artifactPath: mixedVideo,
      reused: reusedAudioMix,
      durationSecs: audioProbe?.duration,
      sizeBytes: fs.statSync(mixedVideo).size,
      completedAt: new Date().toISOString()
    }
    workspace.saveManifest(manifest)
    logger.info(
      `[RENDER] Audio mixing output validated: path=${mixedVideo} sizeBytes=${fs.statSync(mixedVideo).size} duration=${audioProbe?.duration.toFixed(3)}s`
    )

    // ── 9. Render Overlays (Captions, Proof Visuals, Visual Scene Grammar) ───
    throwIfAborted(signal)
    let proofVisuals: ProofVisual[] = []
    if (retentionSettings.proofVisualsEnabled) {
      try {
        proofVisuals = buildProofVisualList(scenes, retentionDecisions, params.captionPlan ?? { enabled: false, activeRanges: [], phrases: [] })
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
            editPlan: prepared.plan,
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
    const hasOverlay = hasCaptions || hasProofVisuals || hasVisualGrammar

    let finalWorkingPath = mixedVideo
    let reusedOverlayBlocks = 0
    let reusedComposite = false
    let overlayBlockFps: string[] | null = null

    if (hasOverlay) {
      manifest.status = 'rendering-overlays'
      manifest.progress.currentPhase = 'rendering-overlays'
      const captionPlanForOverlay = params.captionPlan ?? { enabled: true, activeRanges: [], phrases: [] }
      const videoDurationSecs = scenes.reduce((a, s) => a + s.duration, 0)
      const totalFrames = Math.ceil(videoDurationSecs * fps)
      const overlayPropsHash = fingerprintOf({ captionPlan: captionPlanForOverlay, proofVisuals, visualGrammar })
      const remotionSourceHash = computeDirectorySignature(path.join(__dirname, '../../src/remotion'))
      const hwMode = remotionHw && process.platform === 'darwin' ? 'if-possible' : 'disable'

      const sceneBoundaries: number[] = []
      let cum = 0
      for (const s of scenes) { cum += s.duration; sceneBoundaries.push(cum) }
      const blocks = planOverlayBlocks({
        totalFrames,
        fps,
        sceneBoundariesSecs: sceneBoundaries,
        protectedIntervals: collectProtectedIntervals({
          captionPhrases: hasCaptions ? captionPlanForOverlay.phrases : [],
          proofVisuals,
          visualGrammar
        })
      })

      const prevBlocks = new Map((existing?.overlayBlocks ?? []).map((b) => [b.blockIndex, b]))
      manifest.overlayBlocks = blocks.map((b): OverlayBlockCheckpoint => {
        const fp = computeOverlayBlockFingerprint({
          overlayPropsHash,
          startFrame: b.startFrame,
          endFrameExclusive: b.endFrameExclusive,
          totalFrames,
          base: prepared.base,
          remotionSourceHash,
          hardwareAcceleration: hwMode
        })
        const prev = prevBlocks.get(b.blockIndex)
        if (prev && prev.fingerprint === fp && prev.status === 'completed') return { ...prev, reused: false }
        return {
          blockIndex: b.blockIndex,
          startFrame: b.startFrame,
          endFrameExclusive: b.endFrameExclusive,
          status: 'pending',
          fingerprint: fp,
          artifactPath: workspace!.overlayBlockPath(b.blockIndex)
        }
      })
      overlayBlockFps = manifest.overlayBlocks.map((b) => b.fingerprint)
      workspace.saveManifest(manifest)
      logger.info(`[RENDER] Overlay split into ${blocks.length} block(s) over ${totalFrames} frames`)

      const blockFiles: string[] = []
      for (let bi = 0; bi < manifest.overlayBlocks.length; bi++) {
        throwIfAborted(signal)
        const blk = manifest.overlayBlocks[bi]
        const blockPath = workspace.overlayBlockPath(blk.blockIndex)
        const frames = blk.endFrameExclusive - blk.startFrame
        const blockExpect: ArtifactExpectation = {
          fingerprint: blk.fingerprint,
          kind: 'overlay-block',
          width,
          height,
          fps,
          frames,
          durationSecs: frames / fps,
          durationTolerance: 2 / fps + 0.05
        }
        const basePct = 0.905 + (bi / manifest.overlayBlocks.length) * 0.02
        const blockReuse = await workspace.tryReuse(blockPath, blockExpect, signal)
        if (blockReuse.ok) {
          reusedOverlayBlocks++
          blk.status = 'completed'
          blk.reused = true
          blockFiles.push(blockPath)
          setPct(`Reusing overlay block ${bi + 1}/${manifest.overlayBlocks.length}`, basePct)
          continue
        }

        await throttle.beforeNextJob(signal)
        const concurrency = throttle.currentRemotionConcurrency()
        setPct(`Rendering overlay block ${bi + 1}/${manifest.overlayBlocks.length}`, basePct)
        blk.status = 'running'
        blk.startedAt = new Date().toISOString()
        workspace.saveManifest(manifest)
        const blockPartial = blockPath.replace(/\.mp4$/, '.partial.mp4')
        safeUnlink(blockPartial)
        const t0 = Date.now()
        const { hardwareFallback } = await overlayRenderer({
          captionPlan: captionPlanForOverlay,
          proofVisuals,
          visualGrammar,
          videoDurationInSeconds: videoDurationSecs,
          outputPath: blockPartial,
          fps,
          resolution,
          frameRange: [blk.startFrame, blk.endFrameExclusive - 1],
          concurrency,
          offthreadVideoThreads: limits.offthreadVideoThreads,
          mediaCacheSizeInBytes: limits.mediaCacheSizeInBytes,
          offthreadVideoCacheSizeInBytes: limits.offthreadVideoCacheSizeInBytes,
          hardwareAcceleration: hwMode,
          signal,
          onBundleProgress: (pct) => {
            progress(`Bundling Remotion composition... ${Math.round(pct)}%`, basePct)
          },
          onRenderProgress: (pct) => {
            progress(`Rendering overlay block ${bi + 1}/${manifest!.overlayBlocks.length}... ${Math.round(pct * 100)}%`, basePct + (pct * 0.02) / manifest!.overlayBlocks.length)
          },
        })
        if (hardwareFallback && !manifest.warnings.includes('Remotion hardware acceleration failed; overlay rendered in software.')) {
          manifest.warnings.push('Remotion hardware acceleration failed; overlay rendered in software.')
        }
        try {
          await workspace.commitPartial(blockPartial, blockPath, blockExpect, { encoder: `remotion:${hwMode}`, signal })
        } catch (err) {
          if (isRenderCancelledError(err)) throw err
          throw new Error(`Overlay block ${bi + 1} failed validation: ${String((err as Error).message ?? err)}`)
        }
        blk.status = 'completed'
        blk.reused = false
        blk.completedAt = new Date().toISOString()
        workspace.saveManifest(manifest)
        workspace.logEvent({ event: 'overlay-block-completed', block: blk.blockIndex, ms: Date.now() - t0, concurrency })
        blockFiles.push(blockPath)
      }

      // Concat overlay blocks (stream copy, exact order)
      const overlayFull = workspace.overlayFullPath
      const overlayFullExpect: ArtifactExpectation = {
        fingerprint: fingerprintOf({ blocks: overlayBlockFps }),
        kind: 'overlay-full',
        width,
        height,
        fps,
        frames: totalFrames,
        durationSecs: totalFrames / fps,
        durationTolerance: 2 / fps + 0.05
      }
      const fullReuse = await workspace.tryReuse(overlayFull, overlayFullExpect, signal)
      if (!fullReuse.ok) {
        const fullPartial = overlayFull.replace(/\.mp4$/, '.partial.mp4')
        safeUnlink(fullPartial)
        if (blockFiles.length === 1) {
          fs.copyFileSync(blockFiles[0], fullPartial, fs.constants.COPYFILE_FICLONE)
        } else {
          const listPath = path.join(tmpDir, 'overlay-concat.txt')
          fs.writeFileSync(listPath, blockFiles.map(concatListLine).join('\n'), 'utf-8')
          await ffmpegRun(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', fullPartial], ctx)
          safeUnlink(listPath)
        }
        await workspace.commitPartial(fullPartial, overlayFull, overlayFullExpect, { signal })
      }
      manifest.overlayFull = { status: 'completed', fingerprint: overlayFullExpect.fingerprint, artifactPath: overlayFull }

      // ── 9b. Merge overlay lên video gốc bằng FFmpeg (checkpoint) ─────────────
      throwIfAborted(signal)
      manifest.status = 'compositing'
      manifest.progress.currentPhase = 'compositing'
      const compositeFingerprint = computeCompositeFingerprint({
        audioFingerprint,
        overlayBlockFingerprints: overlayBlockFps,
        base: prepared.base
      })
      const compositePath = workspace.compositePath
      const compositeExpect: ArtifactExpectation = {
        fingerprint: compositeFingerprint,
        kind: 'composite',
        width,
        height,
        requireAudio: !!audioProbe?.hasAudio,
        lenient: true
      }
      const compReuse = await workspace.tryReuse(compositePath, compositeExpect, signal)
      if (compReuse.ok) {
        reusedComposite = true
        setPct('Reusing composited video', 0.93)
      } else {
        setPct('Compositing final video', 0.93)
        manifest.composite = { status: 'running', fingerprint: compositeFingerprint, startedAt: new Date().toISOString(), artifactPath: compositePath }
        workspace.saveManifest(manifest)
        const captionedPath = compositePath.replace(/\.mp4$/, '.partial.mp4')
        safeUnlink(captionedPath)

        logger.info(`[RENDER] Overlay merge: ${overlayFull} -> ${mixedVideo} (${params.captionPlan?.phrases?.length ?? 0} phrases, ${proofVisuals.length} proofs)`)

        await encodeRun([
          '-y',
          '-i', mixedVideo,              // [0] video có audio
          '-i', overlayFull,             // [1] caption MP4 green screen từ Remotion
          '-filter_complex',
          '[1:v]format=rgba,colorkey=0x00ff00:0.12:0.05[ov];[0:v][ov]overlay=0:0:shortest=1:eof_action=pass,format=yuv420p[outv]',
          '-map', '[outv]',
          '-map', '0:a?',
          ...vcodec(ctx, 20),
          '-c:a', 'copy',
          captionedPath
        ], ctx)

        let captionedProbe
        try {
          captionedProbe = await workspace.commitPartial(captionedPath, compositePath, compositeExpect, { encoder: encoder.key, signal })
        } catch (err) {
          if (isRenderCancelledError(err)) throw err
          throw new Error(`Caption overlay compositing failed to produce a valid file. (${String((err as Error).message ?? err)})`)
        }
        logger.info(
          `[RENDER] Caption overlay composited: path=${compositePath} sizeBytes=${fs.statSync(compositePath).size} duration=${captionedProbe.duration.toFixed(3)}s`
        )
        workspace.logEvent({ event: 'composite-completed' })
      }
      manifest.composite = {
        status: 'completed',
        fingerprint: compositeFingerprint,
        artifactPath: compositePath,
        reused: reusedComposite,
        sizeBytes: fs.statSync(compositePath).size,
        completedAt: new Date().toISOString()
      }
      workspace.saveManifest(manifest)
      finalWorkingPath = compositePath
    } else {
      // No overlay → the audio-mixed artifact is the composite
      manifest.overlayBlocks = []
      manifest.composite = {
        status: 'completed',
        fingerprint: computeCompositeFingerprint({ audioFingerprint, overlayBlockFingerprints: null, base: prepared.base }),
        artifactPath: mixedVideo,
        reused: reusedAudioMix,
        completedAt: new Date().toISOString()
      }
      workspace.saveManifest(manifest)
    }

    // ── 10. Production Intelligence: Postflight QA on the final working output ─
    throwIfAborted(signal)
    const outputDir = path.join(projectDir, 'output')
    fs.mkdirSync(outputDir, { recursive: true })
    const outputPath = path.join(outputDir, `${outputName}.mp4`)
    publishPartial = path.join(outputDir, `${outputName}.partial.mp4`)
    safeUnlink(publishPartial)
    // APFS clone (copy-on-write): instant and keeps the cached artifact intact
    fs.copyFileSync(finalWorkingPath, publishPartial, fs.constants.COPYFILE_FICLONE)

    manifest.status = 'postflight'
    manifest.progress.currentPhase = 'postflight'
    workspace.saveManifest(manifest)

    let qaReport: RenderQaReport | undefined
    if (prodSettings.enabled && prodSettings.renderQaEnabled) {
      setPct('Running postflight QA inspection...', 0.95)
      qaReport = await runRenderPostflight({
        projectDir,
        workingOutputPath: publishPartial,
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

    // ── 11. Final output validation & atomic publish ──────────────────────────
    throwIfAborted(signal)
    setPct('Finalizing output...', 0.96)
    if (!fs.existsSync(publishPartial) || fs.statSync(publishPartial).size === 0) {
      throw new Error('Final render working file is missing or empty.')
    }
    const finalProbe = await probeMedia(publishPartial, { signal })
    if (!finalProbe || !finalProbe.hasVideo || finalProbe.duration <= 0) {
      throw new Error('Final output does not contain a valid video stream.')
    }

    // Atomically promote working output to final outputPath (last point a cancel is honoured)
    throwIfAborted(signal)
    safeUnlink(outputPath)
    fs.renameSync(publishPartial, outputPath)
    publishPartial = undefined

    // ── 12. Cleanup temp files (cache is kept for resume / fast re-render) ────
    setPct('Cleaning up...', 0.98)

    const stat = fs.statSync(outputPath)
    const durationSecs = finalProbe.duration || scenes.reduce((a, s) => a + s.duration, 0)

    manifest.status = 'completed'
    manifest.progress.currentPhase = 'completed'
    manifest.completedAt = new Date().toISOString()
    manifest.finalOutput = {
      status: 'completed',
      fingerprint: manifest.composite.fingerprint,
      artifactPath: outputPath,
      sizeBytes: stat.size,
      durationSecs,
      width: finalProbe.width,
      height: finalProbe.height,
      fps: finalProbe.fps,
      completedAt: manifest.completedAt
    }
    workspace.saveManifest(manifest)
    workspace.touch({ completedAt: manifest.completedAt, outputPath })
    workspace.logEvent({ event: 'render-completed', outputPath, reusedScenes, totalScenes })
    if (activeRecord) {
      activeRecord.status = 'completed'
      activeRecord.endedAt = manifest.completedAt
      writeActiveRender(projectDir, activeRecord)
    }

    // Prune old workspaces only now that the final output is confirmed
    try {
      pruneRenderCache(projectDir, { keepWorkspaces: [workspace.name], maxBytes: prefs.maxCacheBytes })
    } catch (err) {
      logger.warn(`[RENDER] Cache prune skipped: ${String(err)}`)
    }

    const cache: RenderCacheStats = {
      renderFingerprint: prepared.renderFingerprint,
      totalScenes,
      reusedScenes,
      renderedScenes: totalScenes - reusedScenes,
      reusedAssembly,
      reusedAudioMix,
      totalOverlayBlocks: manifest.overlayBlocks.length,
      reusedOverlayBlocks,
      reusedComposite,
      resourceProfile: limits.profile,
      encoder: encoder.key,
      warnings: manifest.warnings
    }

    progress(`Done → ${outputPath}`, 1.0)
    logger.info('[RENDER] Complete', {
      outputPath,
      durationSecs: Math.round(durationSecs * 100) / 100,
      resolution: `${finalProbe.width}x${finalProbe.height}`,
      fileSizeMB: (stat.size / 1024 / 1024).toFixed(2),
      reusedScenes,
      totalScenes,
      reusedOverlayBlocks
    })

    return {
      outputPath,
      durationSecs,
      fileSizeBytes: stat.size,
      preflightReport,
      qaReport,
      cache
    }


  } catch (err) {
    const cancelled = isRenderCancelledError(err) || !!signal?.aborted
    const reason: InterruptionReason = cancelled
      ? (params.getCancelReason?.() ?? 'user-cancelled')
      : 'error'
    if (workspace && manifest) {
      try {
        markInterruptedCheckpoints(manifest)
        manifest.status = cancelled ? (reason === 'user-cancelled' ? 'cancelled' : 'interrupted') : 'failed'
        manifest.interruptionReason = reason
        manifest.interruptedAt = new Date().toISOString()
        if (!cancelled) manifest.warnings.push(`Render failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`)
        workspace.saveManifest(manifest)
        workspace.logEvent({ event: cancelled ? 'render-interrupted' : 'render-failed', reason })
      } catch { /* ignore */ }
    }
    if (activeRecord && workspace) {
      try {
        activeRecord.status = cancelled ? (reason === 'user-cancelled' ? 'cancelled' : 'interrupted') : 'failed'
        activeRecord.interruptionReason = reason
        activeRecord.endedAt = new Date().toISOString()
        activeRecord.lastError = cancelled ? undefined : String((err as Error)?.message ?? err).slice(0, 500)
        writeActiveRender(workspace.projectDir, activeRecord)
      } catch { /* ignore */ }
    }
    if (cancelled && !(err instanceof RenderCancelledError)) {
      throw new RenderCancelledError(reason === 'app-closed' ? 'Render interrupted: application closed' : 'Render cancelled by user')
    }
    throw err
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    throttle.stop()
    if (publishPartial) safeUnlink(publishPartial)
    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch { /* ignore */ }
    }
  }
}

function markInterruptedCheckpoints(m: RenderManifestV2): void {
  const reset = (c: RenderArtifactCheckpoint): void => {
    if (c.status === 'running') c.status = 'pending'
  }
  m.scenes.forEach(reset)
  m.overlayBlocks.forEach(reset)
  reset(m.assembly)
  reset(m.audioMix)
  reset(m.composite)
  if (!m.finalOutput) m.finalOutput = emptyCheckpoint()
}

/**
 * Renders one scene clip with exactly the legacy encode parameters.
 */
async function renderSceneClip(p: {
  job: SceneRenderJob
  outClip: string
  width: number
  height: number
  fps: number
  tmpDir: string
  ctx: EncodeContext
  retentionSettings: RetentionSettings
  sceneOrdinalIndex: number
  visualPlanMap?: Map<number, { strategy?: string; motion?: any; motionPreset?: any; category?: string }>
  retentionPlanMap?: Map<number, RetentionScenePlan>
  recentAiMotionPresets?: string[]
}): Promise<void> {
  const { job, outClip, width, height, fps, tmpDir, ctx, retentionSettings, visualPlanMap, retentionPlanMap, recentAiMotionPresets } = p
  const scene = job.scene
  const i = p.sceneOrdinalIndex
  const mediaPath = job.mediaPath
  const scaleFilt = job.scaleFilt

  if (!mediaPath || !fs.existsSync(mediaPath)) {
    // Missing media: generate a black placeholder
    logger.warn(`[RENDER] Missing media for scene ${scene.sceneIndex}: ${job.mediaName}, using black placeholder`)
    await encodeRun([
      '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${scene.duration}:r=${fps}`,
      ...vcodec(ctx, 23),
      '-t', String(scene.duration),
      '-pix_fmt', 'yuv420p',
      outClip
    ], ctx)
    return
  }

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

  const beats = job.beats
  const hasMultipleBeats = beats.length > 1

  // Check if this is an AI still scene or generated image (Health or General)
  const visualScene = visualPlanMap?.get(scene.sceneIndex)
  const isAiStillImage =
    isImage &&
    (visualScene?.strategy === 'ai-still' ||
      mediaPath.includes(path.join('assets', 'generated', 'health')) ||
      mediaPath.includes('/assets/generated/health/') ||
      mediaPath.includes(path.join('assets', 'generated', 'general')) ||
      mediaPath.includes('/assets/generated/general/'))

  if (isAiStillImage) {
    // Camera motion spec for AI still images (Health or General)
    const baseMotion = visualScene?.motion || visualScene?.motionPreset || 'push-in-center'
    const retentionHint = retentionPlanMap?.get(scene.sceneIndex) ?? retentionPlanMap?.get(i)
    const motionParam = applyRetentionMotionHint(baseMotion, retentionHint, recentAiMotionPresets ?? [])
    const presetName = typeof motionParam === 'object' ? motionParam.preset : motionParam
    if (recentAiMotionPresets) {
      recentAiMotionPresets.push(presetName)
    }

    const motionFilter = buildHealthMotionFilter(motionParam as any, width, height, scene.duration, fps)
    logger.info(`[VisualMotion] Scene ${scene.sceneIndex}: applying cinematic motion spec '${presetName}'`)

    await encodeRun([
      '-y',
      '-loop', '1',
      '-i', mediaPath,
      '-vf', motionFilter,
      ...vcodec(ctx, 20),
      '-t', String(scene.duration),
      '-r', String(fps),
      '-pix_fmt', 'yuv420p',
      outClip
    ], ctx)
  } else if (hasMultipleBeats && retentionSettings.enabled) {
    // ── ENHANCED: render visual beats then concat into scene clip ──────────
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
      ctx
    })
  } else {
    // ── LEGACY: single clip render (unchanged behavior) ─────────────────
    // Apply crop if single beat has semantic crop
    const singleBeat = beats[0]
    let vfFilter = scaleFilt
    if (retentionSettings.semanticCropEnabled && singleBeat?.crop && singleBeat.crop.scale > 1.005) {
      const zf = cropToZoomFilter(singleBeat.crop, width, height, scene.duration, fps)
      if (zf) {
        // Apply scale first then zoompan
        vfFilter = `${scaleFilt},${zf}`
        logger.info(`[RetentionEngine] scene ${i}: single-beat crop scale=${singleBeat.crop.scale.toFixed(2)}`)
      }
    }

    if (isImage) {
      await encodeRun([
        '-y',
        '-loop', '1',
        '-i', mediaPath,
        '-vf', vfFilter,
        ...vcodec(ctx, 20),
        '-t', String(scene.duration),
        '-r', String(fps),
        '-pix_fmt', 'yuv420p',
        outClip
      ], ctx)
    } else {
      const durationGuard =
        `tpad=stop_mode=clone:stop_duration=${scene.duration},` +
        `trim=duration=${scene.duration},` +
        `setpts=PTS-STARTPTS`
      const videoFilter = `${vfFilter},${durationGuard}`

      await encodeRun([
        '-y',
        '-i', mediaPath,
        '-vf', videoFilter,
        ...vcodec(ctx, 20),
        '-t', String(scene.duration),
        '-r', String(fps),
        '-an',
        '-pix_fmt', 'yuv420p',
        outClip
      ], ctx)
    }
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
  retentionDecisions: Map<number, RetentionDecision>,
  captionPlan: import('../../shared/types').CaptionPlan
): ProofVisual[] {
  const result: ProofVisual[] = []
  const seenKeys = new Set<string>()

  for (let i = 0; i < scenes.length; i++) {
    const decision = retentionDecisions.get(i)

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
    const pvNums: string[] = pvText.match(/\d+/g) ?? []
    const srcNums: string[] = src.match(/\d+/g) ?? []
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

