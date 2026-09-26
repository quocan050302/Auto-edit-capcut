/**
 * visual-beat-engine.ts — Visual Beat Engine
 *
 * Tạo VisualBeat[] cho một scene DỰA TRÊN metadata scene đã có.
 * KHÔNG thay đổi scene timing, narration, hoặc stock assignment.
 *
 * DETERMINISTIC — không dùng Math.random().
 * Seed từ scene.sceneIndex để variation nhất quán giữa renders.
 *
 * LEGACY SAFE:
 * - Nếu scene không đủ điều kiện → trả về 1 beat = full scene
 * - Project cũ vẫn render giống hệt trước
 */

import { logger } from '../logger'
import type { VisualBeat, ProofVisual, RetentionContext, RetentionLevel } from './retention-types'

// ─── Config theo level ────────────────────────────────────────────────────────

interface LevelConfig {
  maxBeatsPerScene: number
  minBeatDuration: number   // giây
  maxBeatDuration: number   // giây
  cropAllowed: boolean
  proofVisualAllowed: boolean
  patternInterruptCooldown: number  // giây
  strongEffectCooldown: number      // giây
}

const LEVEL_CONFIG: Record<RetentionLevel, LevelConfig> = {
  low: {
    maxBeatsPerScene: 2,
    minBeatDuration: 4.0,
    maxBeatDuration: 10.0,
    cropAllowed: true,
    proofVisualAllowed: true,
    patternInterruptCooldown: 45,
    strongEffectCooldown: 30,
  },
  balanced: {
    maxBeatsPerScene: 3,
    minBeatDuration: 2.5,
    maxBeatDuration: 7.0,
    cropAllowed: true,
    proofVisualAllowed: true,
    patternInterruptCooldown: 25,
    strongEffectCooldown: 20,
  },
  high: {
    maxBeatsPerScene: 4,
    minBeatDuration: 1.8,
    maxBeatDuration: 5.0,
    cropAllowed: true,
    proofVisualAllowed: true,
    patternInterruptCooldown: 15,
    strongEffectCooldown: 12,
  },
}

// ─── Number/date/location regex (for proof visual detection) ─────────────────

const PROOF_PATTERNS = [
  { type: 'number_card' as const, regex: /\$[\d,]+(\.\d+)?[kKmMbBtT]?/, label: 'Dollar figure' },
  { type: 'stat_emphasis' as const, regex: /\d+\.?\d*\s*%/, label: 'Percentage' },
  { type: 'number_card' as const, regex: /\d{1,3}(,\d{3})+/, label: 'Large number' },
  { type: 'date_card' as const, regex: /\b(1[0-9]{3}|20[0-9]{2})\b/, label: 'Year' },
  { type: 'stat_emphasis' as const, regex: /\b\d+\s*(million|billion|thousand|hundred)\b/i, label: 'Big stat' },
]

// ─── Deterministic helpers ────────────────────────────────────────────────────

/** Deterministic int from scene index — avoids Math.random() */
function seedInt(sceneIndex: number, variant: number): number {
  return ((sceneIndex * 2654435761 + variant * 40503) >>> 0) % 100
}

/** Adaptive beat durations — variation without random */
function computeBeatDurations(
  sceneDuration: number,
  beatCount: number,
  sceneIndex: number,
  cfg: LevelConfig
): number[] {
  if (beatCount <= 1) return [sceneDuration]

  // Chia không đều dựa vào seed
  const weights: number[] = []
  for (let i = 0; i < beatCount; i++) {
    const seed = seedInt(sceneIndex, i)
    // Weight: 0.7..1.3 → variation nhẹ
    weights.push(0.7 + (seed / 100) * 0.6)
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0)

  const durations = weights.map(w => {
    const raw = (w / totalWeight) * sceneDuration
    return Math.max(cfg.minBeatDuration, Math.min(cfg.maxBeatDuration, raw))
  })

  // Điều chỉnh lại để tổng đúng bằng sceneDuration
  const total = durations.reduce((a, b) => a + b, 0)
  const ratio = sceneDuration / total
  return durations.map(d => Math.round(d * ratio * 100) / 100)
}

// ─── Proof visual detector ────────────────────────────────────────────────────

/**
 * Tìm proof visual opportunity trong narration text.
 * CHỈ dùng data từ narration — không bịa.
 */
export function detectProofVisual(
  narrativeText: string,
  sceneId: string,
  relativeTime: number,
  durationSecs: number
): ProofVisual | null {
  for (const pattern of PROOF_PATTERNS) {
    const match = narrativeText.match(pattern.regex)
    if (match) {
      return {
        type: pattern.type,
        primaryText: match[0].trim(),
        subLabel: undefined,  // không tự bịa sub-label
        sourceField: 'narrativeText',
        relativeTime,
        durationSecs: Math.min(durationSecs, 2.5),
      }
    }
  }
  return null
}

// ─── Semantic crop calculator ─────────────────────────────────────────────────

/**
 * Tính crop parameters dựa trên visualIntent.
 * Crop nhẹ (1.0–1.2) → không gây chóng mặt.
 * Chỉ crop nếu có subject rõ ràng.
 */
export function computeSemanticCrop(
  visualIntent: string | undefined,
  sceneIndex: number,
  beatIndex: number
): VisualBeat['crop'] | undefined {
  if (!visualIntent) return undefined

  const text = visualIntent.toLowerCase()
  const hasClearSubject =
    text.includes('person') || text.includes('face') || text.includes('hand') ||
    text.includes('worker') || text.includes('machine') || text.includes('farm') ||
    text.includes('equipment') || text.includes('animal') || text.includes('detail') ||
    text.includes('close') || text.includes('operator')

  if (!hasClearSubject) return undefined

  // Scale 1.06..1.15 dựa vào seed — không random
  const seed = seedInt(sceneIndex, beatIndex + 10)
  const scale = 1.06 + (seed / 100) * 0.09  // 1.06..1.15
  const roundedScale = Math.round(scale * 100) / 100

  // Slight offset — center subject (0 = absolute center)
  const offsetSeed = seedInt(sceneIndex, beatIndex + 20)
  const x = ((offsetSeed / 100) - 0.5) * 0.08  // -0.04..+0.04

  return { x, y: 0, scale: roundedScale }
}

/**
 * Convert crop params → FFmpeg zoompan filter string.
 * Chỉ dùng nếu scale > 1 (không apply filter nếu crop = 1.0).
 */
export function cropToZoomFilter(
  crop: VisualBeat['crop'],
  width: number,
  height: number,
  duration: number,
  fps: number
): string | undefined {
  if (!crop || crop.scale <= 1.005) return undefined

  const s = crop.scale
  const frames = Math.round(duration * fps)
  // zoompan: static zoom (z='zoom', no ken burns pan)
  // x/y offsets based on crop.x (fraction of extra space)
  const xExtraPixels = Math.round((s - 1) * width * 0.5 + crop.x * width * (s - 1))
  const yExtraPixels = Math.round((s - 1) * height * 0.5 + crop.y * height * (s - 1))
  const xClamp = Math.max(0, Math.min(Math.round((s - 1) * width), xExtraPixels))
  const yClamp = Math.max(0, Math.min(Math.round((s - 1) * height), yExtraPixels))

  // zoompan với static zoom (z cố định = scale, không tăng dần)
  return `zoompan=z='${s.toFixed(3)}':x='${xClamp}':y='${yClamp}':d=${frames}:s=${width}x${height}:fps=${fps}`
}

// ─── Main Visual Beat Engine ──────────────────────────────────────────────────

export interface SceneInput {
  sceneId?: string
  sceneIndex: number
  duration: number
  energyLevel?: string
  shotType?: string
  narrativeText?: string
  visualIntent?: string
  isPatternInterrupt?: boolean
  localPath?: string
}

/**
 * resolveVisualBeats — tính VisualBeat[] cho một scene.
 *
 * Output deterministic từ sceneIndex + metadata.
 * KHÔNG đổi scene timing — chỉ phân bổ visual bên trong.
 *
 * Nếu scene không đủ điều kiện (quá ngắn, dramatic, v.v.):
 * Trả về 1 beat = full scene (legacy behavior).
 */
export function resolveVisualBeats(
  scene: SceneInput,
  ctx: RetentionContext,
  level: RetentionLevel
): { beats: VisualBeat[]; proofVisual: ProofVisual | null } {
  const cfg = LEVEL_CONFIG[level]
  const sceneId = scene.sceneId ?? String(scene.sceneIndex)
  const energy = scene.energyLevel ?? 'medium'
  const duration = scene.duration

  // ── 1. Quyết định số beats ─────────────────────────────────────────────────

  let targetBeats = 1  // default: 1 shot full scene

  // Chỉ chia nhỏ nếu scene đủ dài và không phải dramatic/slow
  const isLongEnough = duration >= cfg.minBeatDuration * 2.5
  const isDramatic = energy === 'low'
  const isFast = energy === 'high'

  if (!isLongEnough) {
    targetBeats = 1
  } else if (isDramatic) {
    // Dramatic: max 1-2 beats, long shots
    targetBeats = duration >= 8 ? 2 : 1
  } else if (isFast) {
    // High energy: có thể có 2-3 beats
    const seed = seedInt(scene.sceneIndex, 1)
    targetBeats = Math.min(cfg.maxBeatsPerScene, seed < 40 ? 2 : 3)
  } else {
    // Medium: 1-2 beats
    const seed = seedInt(scene.sceneIndex, 2)
    targetBeats = seed < 60 ? 1 : 2
  }

  // Không chia quá max config
  targetBeats = Math.min(targetBeats, cfg.maxBeatsPerScene)

  // Cooldown guard: nếu vừa có strong effect → giảm beats
  if (ctx.timeSinceLastStrongEffect < cfg.strongEffectCooldown) {
    targetBeats = Math.min(targetBeats, 1)
  }

  // ── 2. Tính durations ─────────────────────────────────────────────────────

  const beatDurations = computeBeatDurations(duration, targetBeats, scene.sceneIndex, cfg)
  let cursor = 0

  const beats: VisualBeat[] = []
  let proofVisualFound: ProofVisual | null = null

  for (let i = 0; i < targetBeats; i++) {
    const beatDuration = beatDurations[i]
    const relStart = parseFloat(cursor.toFixed(3))
    const relEnd = parseFloat((cursor + beatDuration).toFixed(3))

    // ── 3. Quyết định beat type ──────────────────────────────────────────────

    let beatType: VisualBeat['type'] = 'main_shot'
    let beatPurpose: VisualBeat['purpose'] = 'establish'
    let crop: VisualBeat['crop'] | undefined

    if (i === 0) {
      // Beat đầu: luôn main shot
      beatType = 'main_shot'
      beatPurpose = 'establish'

    } else if (i === 1) {
      // Beat 2: detail crop hoặc proof visual
      const hasNarrative = scene.narrativeText && scene.narrativeText.length > 0

      // Check proof visual opportunity
      if (
        cfg.proofVisualAllowed &&
        hasNarrative &&
        ctx.timeSinceLastProofVisual > 15 &&
        proofVisualFound === null
      ) {
        const pv = detectProofVisual(
          scene.narrativeText!,
          sceneId,
          relStart,
          Math.min(beatDuration, 2.5)
        )
        if (pv) {
          proofVisualFound = pv
          beatType = 'proof_visual'
          beatPurpose = 'emphasize'
        }
      }

      // Nếu không có proof visual, dùng detail crop
      if (beatType === 'main_shot') {
        if (cfg.cropAllowed) {
          const cropParams = computeSemanticCrop(scene.visualIntent, scene.sceneIndex, i)
          if (cropParams) {
            beatType = 'detail_crop'
            beatPurpose = 'explain'
            crop = cropParams
          }
        }
      }

    } else {
      // Beat 3+: secondary hoặc pattern interrupt nếu eligible
      const timeSinceInterrupt = ctx.timeSinceLastStrongEffect
      if (
        scene.isPatternInterrupt &&
        timeSinceInterrupt >= cfg.patternInterruptCooldown
      ) {
        beatType = 'pattern_interrupt'
        beatPurpose = 'reset_attention'
      } else {
        beatType = 'secondary_asset'
        beatPurpose = 'explain'
        // Subtle crop cho beat 3
        if (cfg.cropAllowed) {
          crop = computeSemanticCrop(scene.visualIntent, scene.sceneIndex, i + 5)
        }
      }
    }

    beats.push({
      id: `beat_${sceneId}_${i}`,
      sceneId,
      relativeStart: relStart,
      relativeEnd: relEnd,
      type: beatType,
      purpose: beatPurpose,
      sourceAssetId: scene.localPath,
      crop,
    })

    cursor += beatDuration
  }

  logger.info(
    `[RetentionEngine] scene ${sceneId}: ${targetBeats} beat(s), ` +
    `energy=${energy}, dur=${duration.toFixed(1)}s` +
    (proofVisualFound ? `, proof=${proofVisualFound.primaryText}` : '')
  )

  return { beats, proofVisual: proofVisualFound }
}
