import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { logger } from '../logger'
import type {
  VideoTransitionType,
  TransitionRenderMode,
  RenderTransitionSettings
} from '../../../shared/types'
import {
  ffmpegRun as sharedFfmpegRun,
  type FfmpegRunOptions
} from '../render-cache/ffmpeg-process'

export interface RenderSceneEntry {
  scene: {
    sceneIndex: number
    duration: number
    transitionIn?: string
    [key: string]: unknown
  }
  chapterIndex: number
  sequenceIndex: number
  isFirstInChapter: boolean
  isFirstInSequence: boolean
}

export interface ResolvedSceneTransition {
  fromSceneIndex: number
  toSceneIndex: number
  type: VideoTransitionType
  duration: number
  reason: string
}

export const VALID_TRANSITIONS: readonly VideoTransitionType[] = [
  'cut',
  'fade',
  'dissolve',
  'wipeleft',
  'wiperight',
  'slideleft',
  'slideright',
  'smoothleft',
  'smoothright',
  'circleopen',
  'circleclose',
  'pixelize',
  'zoomin'
] as const

/**
 * Normalizes user/plan transition string to a valid VideoTransitionType.
 * Fallback is always 'dissolve'.
 */
export function normalizeTransitionType(raw?: string): VideoTransitionType {
  if (!raw || typeof raw !== 'string') return 'dissolve'
  const clean = raw.trim().toLowerCase().replace(/[_\s]+/g, '-')

  switch (clean) {
    case 'none':
    case 'hard-cut':
    case 'hardcut':
    case 'cut':
      return 'cut'

    case 'crossfade':
    case 'cross-fade':
    case 'fade':
      return 'fade'

    case 'dissolve':
      return 'dissolve'

    case 'wipe-left':
    case 'wipeleft':
      return 'wipeleft'

    case 'wipe-right':
    case 'wiperight':
      return 'wiperight'

    case 'slide-left':
    case 'slideleft':
      return 'slideleft'

    case 'slide-right':
    case 'slideright':
      return 'slideright'

    case 'smooth-left':
    case 'smoothleft':
      return 'smoothleft'

    case 'smooth-right':
    case 'smoothright':
      return 'smoothright'

    case 'circle-open':
    case 'circleopen':
      return 'circleopen'

    case 'circle-close':
    case 'circleclose':
      return 'circleclose'

    case 'pixelize':
    case 'pixelate':
      return 'pixelize'

    case 'zoom':
    case 'zoom-in':
    case 'zoomin':
      return 'zoomin'

    default:
      return 'dissolve'
  }
}

/**
 * Validates and clamps transition settings passed from renderer process.
 */
export function validateTransitionSettings(
  raw?: RenderTransitionSettings
): RenderTransitionSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined

  if (!raw.enabled) {
    return {
      enabled: false,
      mode: 'smart',
      defaultDuration: 0.35,
      chapterDuration: 0.65
    }
  }

  const mode: TransitionRenderMode = raw.mode === 'single' ? 'single' : 'smart'
  let singleType: VideoTransitionType | undefined = undefined

  if (mode === 'single') {
    singleType = normalizeTransitionType(raw.singleType)
  }

  const defaultDuration =
    typeof raw.defaultDuration === 'number' && Number.isFinite(raw.defaultDuration)
      ? Math.max(0.15, Math.min(1.0, raw.defaultDuration))
      : 0.35

  const chapterDuration =
    typeof raw.chapterDuration === 'number' && Number.isFinite(raw.chapterDuration)
      ? Math.max(0.25, Math.min(1.2, raw.chapterDuration))
      : 0.65

  return {
    enabled: true,
    mode,
    singleType,
    defaultDuration: Math.round(defaultDuration * 1000) / 1000,
    chapterDuration: Math.round(chapterDuration * 1000) / 1000
  }
}

/**
 * Resolves transitions for all boundaries between consecutive scenes.
 * Boundary i is between sceneEntries[i] and sceneEntries[i+1].
 */
export function resolveAllTransitions(
  sceneEntries: RenderSceneEntry[],
  settings: RenderTransitionSettings,
  openingHints?: { fromSceneIndex: number; toSceneIndex: number; type: VideoTransitionType; duration?: number; reason: string }[]
): ResolvedSceneTransition[] {
  const count = sceneEntries.length
  if (count <= 1) return []

  const result: ResolvedSceneTransition[] = []

  for (let i = 0; i < count - 1; i++) {
    const fromEntry = sceneEntries[i]
    const toEntry = sceneEntries[i + 1]
    const fromScene = fromEntry.scene
    const toScene = toEntry.scene

    let type: VideoTransitionType = 'dissolve'
    let duration = settings.defaultDuration
    let reason = ''

    if (settings.mode === 'single') {
      type = settings.singleType ?? 'dissolve'
      if (type === 'cut') {
        duration = 0
        reason = 'single mode cut'
      } else if (toEntry.isFirstInChapter) {
        duration = settings.chapterDuration
        reason = 'single mode chapter boundary'
      } else {
        duration = settings.defaultDuration
        reason = 'single mode normal boundary'
      }
    } else {
      // Smart mode
      const openingHint = openingHints?.find(
        (h) => h.fromSceneIndex === fromScene.sceneIndex && h.toSceneIndex === toScene.sceneIndex
      )

      if (openingHint) {
        type = openingHint.type
        duration = openingHint.duration ?? (type === 'cut' ? 0 : settings.defaultDuration)
        reason = `opening composer hint: ${openingHint.reason}`
      } else if (toScene.transitionIn) {
        type = normalizeTransitionType(toScene.transitionIn)
        if (type === 'cut') {
          duration = 0
          reason = 'smart mode plan requested cut'
        } else if (toEntry.isFirstInChapter) {
          duration = settings.chapterDuration
          reason = 'smart mode plan requested transition at chapter start'
        } else if (toEntry.isFirstInSequence) {
          duration = Math.min(settings.defaultDuration + 0.1, 0.6)
          reason = 'smart mode plan requested transition at sequence start'
        } else {
          duration = settings.defaultDuration
          reason = 'smart mode plan requested transition'
        }
      } else {
        // No explicit transitionIn
        if (toEntry.isFirstInChapter) {
          type = 'fade'
          duration = settings.chapterDuration
          reason = 'smart mode default new chapter fade'
        } else if (toEntry.isFirstInSequence) {
          type = 'dissolve'
          duration = Math.min(settings.defaultDuration + 0.1, 0.6)
          reason = 'smart mode default new sequence dissolve'
        } else {
          type = 'dissolve'
          duration = settings.defaultDuration
          reason = 'smart mode default scene dissolve'
        }
      }
    }

    // Protect short scenes: clamp duration
    if (type !== 'cut' && duration > 0) {
      const fromDur = fromScene.duration
      const toDur = toScene.duration

      if (
        typeof fromDur !== 'number' ||
        !Number.isFinite(fromDur) ||
        fromDur <= 0 ||
        typeof toDur !== 'number' ||
        !Number.isFinite(toDur) ||
        toDur <= 0
      ) {
        type = 'cut'
        duration = 0
        reason += ' (invalid scene duration -> fallback cut)'
      } else {
        const maxSafe = Math.min(fromDur * 0.35, toDur * 0.35)
        const safeDuration = Math.min(duration, maxSafe)

        if (safeDuration < 0.12 || !Number.isFinite(safeDuration)) {
          type = 'cut'
          duration = 0
          reason += ` (safe duration ${safeDuration.toFixed(3)}s < 0.12s threshold -> fallback cut)`
        } else {
          duration = Math.round(safeDuration * 10000) / 10000
        }
      }
    } else {
      duration = 0
    }

    result.push({
      fromSceneIndex: fromScene.sceneIndex,
      toSceneIndex: toScene.sceneIndex,
      type,
      duration,
      reason
    })
  }

  return result
}

/**
 * Builds the FFmpeg filter_complex graph for concatenating scene clips with xfade.
 * Uses tpad clone padding on outgoing scenes to preserve exact video duration.
 */
export function buildTransitionFilterGraph(
  scenes: Array<{ duration: number }>,
  transitions: ResolvedSceneTransition[],
  fps: number
): {
  filterComplex: string
  expectedDuration: number
  inputDurations: number[]
} {
  const count = scenes.length
  if (count <= 1) {
    throw new Error('At least 2 scenes required to build transition filter graph')
  }

  const expectedDuration = scenes.reduce((sum, s) => sum + s.duration, 0)
  const inputDurations: number[] = []
  const filterParts: string[] = []

  // 1. Prepare normalized inputs with outgoing tpad padding if needed
  for (let i = 0; i < count; i++) {
    const origDuration = scenes[i].duration
    const outgoingTrans = i < count - 1 ? transitions[i] : undefined
    const outgoingPadding =
      outgoingTrans && outgoingTrans.type !== 'cut' && outgoingTrans.duration > 0
        ? outgoingTrans.duration
        : 0

    const totalInputDuration = Math.round((origDuration + outgoingPadding) * 10000) / 10000
    inputDurations.push(totalInputDuration)

    if (outgoingPadding > 0) {
      filterParts.push(
        `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=${outgoingPadding.toFixed(4)}[v${i}]`
      )
    } else {
      filterParts.push(
        `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[v${i}]`
      )
    }
  }

  // 2. Chain boundaries
  let currentStream = '[v0]'
  let currentEncodedDuration = inputDurations[0]

  for (let i = 0; i < count - 1; i++) {
    const trans = transitions[i]
    const nextStream = `[v${i + 1}]`
    const nextInputDuration = inputDurations[i + 1]

    if (trans.type !== 'cut' && trans.duration > 0) {
      const xfadeOffset = Math.round((currentEncodedDuration - trans.duration) * 10000) / 10000
      const outLabel = `[x${i}]`
      filterParts.push(
        `${currentStream}${nextStream}xfade=transition=${trans.type}:duration=${trans.duration.toFixed(4)}:offset=${xfadeOffset.toFixed(4)}${outLabel}`
      )
      currentEncodedDuration =
        Math.round((currentEncodedDuration + nextInputDuration - trans.duration) * 10000) / 10000
      currentStream = outLabel
    } else {
      // Hard cut between accumulated stream and next input
      const outLabel = `[c${i}]`
      filterParts.push(
        `${currentStream}${nextStream}concat=n=2:v=1:a=0,settb=AVTB,setpts=PTS-STARTPTS,fps=${fps}${outLabel}`
      )
      currentEncodedDuration =
        Math.round((currentEncodedDuration + nextInputDuration) * 10000) / 10000
      currentStream = outLabel
    }
  }

  // 3. Final trim to guarantee exact expected video duration
  const finalTrimDur = Math.round(expectedDuration * 10000) / 10000
  filterParts.push(
    `${currentStream}trim=duration=${finalTrimDur.toFixed(4)},setpts=PTS-STARTPTS[vout]`
  )

  return {
    filterComplex: filterParts.join(';\n'),
    expectedDuration: finalTrimDur,
    inputDurations
  }
}

/**
 * Uses ffprobe-static to probe the actual duration of a video file.
 * Returns duration in seconds or null if probe fails.
 */
export async function probeVideoDuration(filePath: string): Promise<number | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffp = require('ffprobe-static')
    if (!ffp?.path || !fs.existsSync(ffp.path)) return null

    return new Promise((resolve) => {
      const proc = spawn(
        ffp.path,
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
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
          resolve(Number.isFinite(val) ? val : null)
        } else {
          resolve(null)
        }
      })
      proc.on('error', () => resolve(null))
    })
  } catch {
    return null
  }
}

function ffmpegRun(args: string[], options?: FfmpegRunOptions): Promise<void> {
  return sharedFfmpegRun(args, options ?? {})
}

// ─── Segmented assembly (bounded memory for long timelines) ──────────────────

export interface TransitionSegmentPlan {
  segmentIndex: number       // 1-based
  firstScene: number         // 0-based index into sceneEntries (inclusive)
  lastScene: number          // 0-based index (inclusive) — needed to render up to endSec
  /** absolute timeline start of firstScene */
  shiftSec: number
  /** absolute output window [startSec, endSec) — frame aligned */
  startSec: number
  endSec: number
  startFrame: number
  endFrameExclusive: number
}

/**
 * Splits a transition timeline into independent segments.
 *
 * A split point T is placed inside scene k's "pure" region — after the incoming
 * transition into k has finished and before the outgoing transition into k+1 starts.
 * Frames at t ≥ T depend only on scenes ≥ k, so a segment can start its filter graph
 * at scene k and shift its timestamps back to absolute time. This keeps every
 * segment's filter graph small (≤ maxScenesPerSegment + 1 inputs).
 */
export function planTransitionSegments(
  scenes: Array<{ duration: number }>,
  transitions: ResolvedSceneTransition[],
  fps: number,
  maxScenesPerSegment: number
): TransitionSegmentPlan[] {
  const count = scenes.length
  const starts: number[] = []
  let acc = 0
  for (const s of scenes) {
    starts.push(acc)
    acc += s.duration
  }
  const total = Math.round(acc * 10000) / 10000
  const totalFrames = Math.ceil(total * fps - 1e-6)

  const splitScenes: Array<{ scene: number; frame: number }> = []
  const maxPer = Math.max(2, Math.floor(maxScenesPerSegment))
  let lastSplitScene = 0
  for (let k = 1; k < count; k++) {
    if (k - lastSplitScene < maxPer) continue
    const incoming = transitions[k - 1]
    const dIn = incoming && incoming.type !== 'cut' ? incoming.duration : 0
    const pureStart = starts[k] + dIn
    const pureEnd = k + 1 < count ? starts[k + 1] : total
    // one frame of safety margin on both sides
    const frame = Math.ceil(pureStart * fps - 1e-6) + 1
    if (frame / fps >= pureEnd - 1 / fps || frame >= totalFrames) continue
    splitScenes.push({ scene: k, frame })
    lastSplitScene = k
  }

  const segments: TransitionSegmentPlan[] = []
  let curScene = 0
  let curFrame = 0
  for (let i = 0; i <= splitScenes.length; i++) {
    const next = splitScenes[i]
    const endFrame = next ? next.frame : totalFrames
    const lastScene = next ? next.scene : count - 1
    segments.push({
      segmentIndex: segments.length + 1,
      firstScene: curScene,
      lastScene,
      shiftSec: starts[curScene],
      startSec: curFrame / fps,
      endSec: next ? endFrame / fps : total,
      startFrame: curFrame,
      endFrameExclusive: endFrame
    })
    if (next) {
      curScene = next.scene
      curFrame = next.frame
    }
  }
  return segments
}

/** Filter graph for one segment: sub-graph of its scenes + absolute-time window trim. */
export function buildSegmentFilterGraph(
  allScenes: Array<{ duration: number }>,
  allTransitions: ResolvedSceneTransition[],
  seg: TransitionSegmentPlan,
  fps: number
): string {
  const subScenes = allScenes.slice(seg.firstScene, seg.lastScene + 1)
  const subTransitions = allTransitions.slice(seg.firstScene, seg.lastScene)
  let body: string
  if (subScenes.length === 1) {
    body = `[0:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[seg0]`
  } else {
    const { filterComplex } = buildTransitionFilterGraph(subScenes, subTransitions, fps)
    // Replace the final full-length trim with our absolute window
    const lines = filterComplex.split(';\n')
    lines.pop()
    const lastLabelMatch = /(\[[a-z]\d+\])$/.exec(lines[lines.length - 1])
    const lastLabel = lastLabelMatch ? lastLabelMatch[1] : '[v0]'
    lines.push(`${lastLabel}null[seg0]`)
    body = lines.join(';\n')
  }
  return (
    `${body};\n` +
    `[seg0]setpts=PTS+${seg.shiftSec.toFixed(6)}/TB,` +
    `trim=start=${seg.startSec.toFixed(6)}:end=${seg.endSec.toFixed(6)},setpts=PTS-STARTPTS[vout]`
  )
}

export type SegmentRunner = (
  seg: TransitionSegmentPlan,
  render: (outputPath: string) => Promise<void>
) => Promise<string>

/**
 * Concatenates scene clips with transitions using FFmpeg filter_complex xfade.
 * Returns true if transitions were applied, or false if no xfade was needed (all cuts).
 *
 * When `segmentRunner` is provided and the timeline is longer than
 * `maxScenesPerSegment`, the timeline is rendered in independent segments
 * (each resumable via the runner) and joined with a stream-copy concat.
 */
export async function concatSceneClipsWithTransitions(params: {
  sceneEntries: RenderSceneEntry[]
  sceneClips: string[]
  settings: RenderTransitionSettings
  fps: number
  tmpDir: string
  rawVideoPath: string
  onProgress?: (stage: string, pct: number) => void
  ffmpegOptions?: FfmpegRunOptions
  /** x264 args for the encode (defaults to the legacy libx264 fast/CRF20). */
  videoCodecArgs?: string[]
  maxScenesPerSegment?: number
  segmentRunner?: SegmentRunner
  openingHints?: { fromSceneIndex: number; toSceneIndex: number; type: VideoTransitionType; duration?: number; reason: string }[]
}): Promise<boolean> {
  const {
    sceneEntries,
    sceneClips,
    settings,
    fps,
    rawVideoPath,
    onProgress,
    openingHints
  } = params

  if (sceneEntries.length <= 1 || sceneClips.length <= 1) {
    return false
  }

  // 1. Resolve transitions
  const transitions = resolveAllTransitions(sceneEntries, settings, openingHints)
  const cutCount = transitions.filter((t) => t.type === 'cut').length
  const fadeCount = transitions.filter((t) => t.type === 'fade').length
  const dissolveCount = transitions.filter((t) => t.type === 'dissolve').length
  const otherCount = transitions.length - cutCount - fadeCount - dissolveCount

  const scenes = sceneEntries.map((e) => e.scene)
  const expectedDuration = scenes.reduce((sum, s) => sum + s.duration, 0)

  logger.info(
    `[Transitions] enabled=true mode=${settings.mode} boundaries=${transitions.length}`
  )
  logger.info(
    `[Transitions] cut=${cutCount} fade=${fadeCount} dissolve=${dissolveCount} other=${otherCount}`
  )
  logger.info(`[Transitions] expectedDuration=${expectedDuration.toFixed(3)}s`)

  // If all boundaries are hard cuts, skip xfade re-encode and let legacy concat handle it
  if (cutCount === transitions.length) {
    logger.info('[Transitions] All boundaries are hard cuts -- skipping xfade filter_complex')
    return false
  }

  onProgress?.('Applying scene transitions...', 0.78)

  const codecArgs = params.videoCodecArgs ?? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20']
  const maxPer = params.maxScenesPerSegment ?? 0
  const useSegments = !!params.segmentRunner && maxPer >= 2 && sceneClips.length > maxPer + 1

  if (!useSegments) {
    // 2. Build filter graph (original single-graph path)
    const { filterComplex } = buildTransitionFilterGraph(scenes, transitions, fps)
    logger.debug(`[Transitions] FFmpeg filter_complex:\n${filterComplex}`)

    // 3. Assemble FFmpeg args
    const inputArgs: string[] = []
    for (const clip of sceneClips) {
      inputArgs.push('-i', clip)
    }

    const args = [
      '-y',
      ...inputArgs,
      '-filter_complex',
      filterComplex,
      '-map',
      '[vout]',
      ...codecArgs,
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
      '-movflags',
      '+faststart',
      rawVideoPath
    ]

    // 4. Run FFmpeg
    await ffmpegRun(args, params.ffmpegOptions)
  } else {
    const segments = planTransitionSegments(scenes, transitions, fps, maxPer)
    logger.info(`[Transitions] Segmented assembly: ${segments.length} segments (≤${maxPer + 1} inputs each)`)
    const segmentFiles: string[] = []
    for (const seg of segments) {
      onProgress?.(
        `Assembling scene segment ${seg.segmentIndex}/${segments.length}...`,
        0.78 + (seg.segmentIndex / segments.length) * 0.05
      )
      const file = await params.segmentRunner!(seg, async (outputPath) => {
        const inputArgs: string[] = []
        for (let i = seg.firstScene; i <= seg.lastScene; i++) inputArgs.push('-i', sceneClips[i])
        const filterComplex = buildSegmentFilterGraph(scenes, transitions, seg, fps)
        await ffmpegRun([
          '-y',
          ...inputArgs,
          '-filter_complex', filterComplex,
          '-map', '[vout]',
          ...codecArgs,
          '-pix_fmt', 'yuv420p',
          '-r', String(fps),
          outputPath
        ], params.ffmpegOptions)
      })
      segmentFiles.push(file)
    }
    const listPath = path.join(params.tmpDir, `assembly-concat-${Date.now()}.txt`)
    fs.writeFileSync(
      listPath,
      segmentFiles.map((f) => `file '${process.platform === 'win32' ? f.replace(/\\/g, '/') : f.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf-8'
    )
    try {
      await ffmpegRun(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', rawVideoPath], params.ffmpegOptions)
    } finally {
      try { fs.unlinkSync(listPath) } catch { /* ignore */ }
    }
  }

  // 5. Verify duration with probe
  const outputDuration = await probeVideoDuration(rawVideoPath)
  if (outputDuration !== null) {
    const diff = Math.abs(outputDuration - expectedDuration)
    logger.info(
      `[Transitions] expectedDuration=${expectedDuration.toFixed(3)}s, outputDuration=${outputDuration.toFixed(3)}s, diff=${diff.toFixed(3)}s`
    )
    const maxAllowedDiff = 1 / fps + 0.03
    if (diff > maxAllowedDiff) {
      logger.warn(
        `[Transitions] Duration deviation ${diff.toFixed(3)}s exceeds tolerance ${maxAllowedDiff.toFixed(3)}s`
      )
    }
  } else {
    logger.warn(
      `[Transitions] Could not probe output duration, expectedDuration=${expectedDuration.toFixed(3)}s`
    )
  }

  return true
}

