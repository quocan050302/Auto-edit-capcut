/**
 * retention-engine.ts — Main Retention Engine
 *
 * Entry point: resolveSceneRetention()
 *
 * Orchestrates:
 * - Visual Beat Engine
 * - Semantic Crop
 * - Proof Visual detection
 * - Visual load guard (overload prevention)
 * - Context tracking (variation memory)
 *
 * KHÔNG thay đổi:
 * - scene timing
 * - narration
 * - stock primary assignment
 * - audio plan
 * - caption timing
 *
 * Fallback: nếu lỗi → log warning và trả về single-beat (legacy behavior).
 */

import { logger } from '../logger'
import { resolveVisualBeats, cropToZoomFilter } from './visual-beat-engine'
import type {
  RetentionDecision,
  RetentionContext,
  RetentionLevel,
  RetentionSettings,
  VisualBeat,
} from './retention-types'

// ─── Visual load scorer ───────────────────────────────────────────────────────

/**
 * Tính visual load score của scene để tránh overload.
 * Caption plan + audio plan phải được phối hợp.
 */
function computeVisualLoad(params: {
  hasActiveCaption: boolean
  hasStrongCaption: boolean
  beatCount: number
  hasProofVisual: boolean
  hasSfx: boolean
  hasPatternInterrupt: boolean
}): number {
  let score = 0
  if (params.hasActiveCaption) score += 1
  if (params.hasStrongCaption) score += 1      // big_statement = extra
  if (params.beatCount > 2) score += 1
  if (params.hasProofVisual) score += 2
  if (params.hasSfx) score += 1
  if (params.hasPatternInterrupt) score += 2
  return score
}

const MAX_VISUAL_LOAD = 6

// ─── Transition resolver ──────────────────────────────────────────────────────

/**
 * Chọn transition type dựa trên context — không random.
 * Hard cut mặc định.
 */
function resolveTransition(
  currentEnergy: string,
  previousEnergy: string,
  isNewChapter: boolean,
  isPatternInterrupt: boolean,
  prevTransition: string
): 'cut' | 'dissolve' | 'fade' {
  if (isNewChapter) return 'fade'
  if (isPatternInterrupt) return 'cut'  // hard cut cho pattern interrupt
  if (currentEnergy === 'low' && previousEnergy !== 'low') return 'dissolve'
  // Tránh repeat fancy transition
  if (prevTransition === 'dissolve') return 'cut'
  return 'cut'  // default: hard cut
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface SceneRetentionInput {
  sceneId?: string
  sceneIndex: number
  duration: number
  energyLevel?: string
  shotType?: string
  narrativeText?: string
  visualIntent?: string
  isPatternInterrupt?: boolean
  localPath?: string
  isNewChapter?: boolean
  // Caption coordination
  hasCaptionInRange?: boolean
  hasStrongCaption?: boolean
  // Audio coordination
  hasSfxInRange?: boolean
}

export function createDefaultContext(): RetentionContext {
  return {
    previousShotType: 'wide',
    previousTransitionType: 'cut',
    previousPatternInterruptType: null,
    previousCropScale: 1.0,
    timeSinceLastHumanShot: 999,
    timeSinceLastProofVisual: 999,
    timeSinceLastStrongEffect: 999,
    consecutiveSameShot: 0,
    consecutiveStrongEffect: 0,
    accumulatedVisualLoad: 0,
    sceneIndex: 0,
  }
}

/**
 * resolveSceneRetention — tính RetentionDecision cho một scene.
 *
 * Luôn có fallback: nếu exception → single-beat legacy output.
 * Gọi sequentially, update ctx sau mỗi scene.
 */
export function resolveSceneRetention(
  scene: SceneRetentionInput,
  ctx: RetentionContext,
  settings: RetentionSettings
): RetentionDecision {
  const sceneId = scene.sceneId ?? String(scene.sceneIndex)

  // Fallback behavior nếu không bật retention
  if (!settings.enabled) {
    return makeSingleBeatDecision(sceneId, scene)
  }

  try {
    return _resolveRetention(scene, ctx, settings)
  } catch (err) {
    logger.warn(`[RetentionEngine] scene ${sceneId} fallback: ${String(err)}`)
    return makeSingleBeatDecision(sceneId, scene)
  }
}

function _resolveRetention(
  scene: SceneRetentionInput,
  ctx: RetentionContext,
  settings: RetentionSettings
): RetentionDecision {
  const sceneId = scene.sceneId ?? String(scene.sceneIndex)
  const level = settings.level
  const notes: string[] = []

  // ── 1. Visual beats ────────────────────────────────────────────────────────
  const { beats, proofVisual } = resolveVisualBeats(scene, ctx, level)

  // ── 2. Overload guard ─────────────────────────────────────────────────────
  const rawVisualLoad = computeVisualLoad({
    hasActiveCaption: scene.hasCaptionInRange ?? false,
    hasStrongCaption: scene.hasStrongCaption ?? false,
    beatCount: beats.length,
    hasProofVisual: proofVisual !== null && settings.proofVisualsEnabled,
    hasSfx: scene.hasSfxInRange ?? false,
    hasPatternInterrupt: scene.isPatternInterrupt ?? false,
  })

  // Nếu overload → giảm beats về 1 và bỏ proof visual
  let finalBeats = beats
  let finalProof = proofVisual && settings.proofVisualsEnabled ? proofVisual : null

  if (rawVisualLoad > MAX_VISUAL_LOAD) {
    notes.push(`Visual load ${rawVisualLoad} > ${MAX_VISUAL_LOAD} — reducing to single beat`)
    logger.info(`[RetentionEngine] scene ${sceneId}: overload guard triggered (load=${rawVisualLoad})`)
    finalBeats = [beats[0]]  // giữ lại beat đầu
    finalProof = null
  }

  // ── 3. Zoom filter computation ────────────────────────────────────────────
  // TODO: width/height sẽ được inject từ render params — dùng placeholder
  // Renderer sẽ override zoomFilter với đúng resolution khi render
  for (const beat of finalBeats) {
    if (beat.crop && beat.crop.scale > 1.005) {
      // Placeholder — sẽ được computed với đúng dimensions tại render time
      beat.zoomFilter = `__crop_${beat.crop.scale}_${beat.crop.x}_${beat.crop.y}__`
    }
  }

  // ── 4. Transition ─────────────────────────────────────────────────────────
  const transitionType = resolveTransition(
    scene.energyLevel ?? 'medium',
    ctx.previousShotType === 'wide' ? 'medium' : 'medium',
    scene.isNewChapter ?? false,
    scene.isPatternInterrupt ?? false,
    ctx.previousTransitionType
  )

  // ── 5. Visual / audio load ────────────────────────────────────────────────
  const finalVisualLoad = computeVisualLoad({
    hasActiveCaption: scene.hasCaptionInRange ?? false,
    hasStrongCaption: scene.hasStrongCaption ?? false,
    beatCount: finalBeats.length,
    hasProofVisual: finalProof !== null,
    hasSfx: scene.hasSfxInRange ?? false,
    hasPatternInterrupt: scene.isPatternInterrupt ?? false,
  })

  return {
    sceneId,
    visualBeats: finalBeats,
    proofVisual: finalProof ?? undefined,
    transitionType,
    visualLoadScore: finalVisualLoad,
    audioLoadScore: (scene.hasSfxInRange ? 1 : 0) + (scene.hasCaptionInRange ? 0.5 : 0),
    notes,
  }
}

/** Single-beat fallback = legacy behavior: full scene, no crop, no extras */
function makeSingleBeatDecision(sceneId: string, scene: SceneRetentionInput): RetentionDecision {
  return {
    sceneId,
    visualBeats: [{
      id: `beat_${sceneId}_0`,
      sceneId,
      relativeStart: 0,
      relativeEnd: scene.duration,
      type: 'main_shot',
      purpose: 'establish',
      sourceAssetId: scene.localPath,
    }],
    visualLoadScore: 0,
    audioLoadScore: 0,
    transitionType: 'cut',
    notes: ['legacy single-beat'],
  }
}

// ─── Context updater ──────────────────────────────────────────────────────────

/**
 * Gọi sau mỗi scene để update context cho scene tiếp theo.
 * Tracking variation memory — không cần database.
 */
export function updateRetentionContext(
  ctx: RetentionContext,
  scene: SceneRetentionInput,
  decision: RetentionDecision
): void {
  ctx.sceneIndex++
  ctx.previousShotType = scene.shotType ?? 'medium'
  ctx.previousTransitionType = decision.transitionType ?? 'cut'
  ctx.timeSinceLastStrongEffect += scene.duration
  ctx.timeSinceLastProofVisual += scene.duration
  ctx.timeSinceLastHumanShot += scene.duration

  if (decision.proofVisual) {
    ctx.timeSinceLastProofVisual = 0
  }
  if (scene.isPatternInterrupt) {
    ctx.timeSinceLastStrongEffect = 0
    ctx.previousPatternInterruptType = 'pattern_interrupt'
  }
  if (decision.visualBeats.length > 2) {
    ctx.timeSinceLastStrongEffect = 0
  }
}
