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

// ─── Proof patterns — ordered by priority ────────────────────────────────────

/** Địa chỉ: số + từ đường phố */
const ADDRESS_REGEX = /\b\d+\s+\w[\w\s]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Highway|Hwy|Way|Place|Pl|Court|Ct)(?:[,.\s]+[\w\s]+)*/i

/** Đơn vị: số + unit như "60,000 people", "500 colonies" */
const UNIT_NUMBER_REGEX = /\b(\d{1,3}(?:,\d{3})+|\d{4,})\s+(people|persons|individuals|colonies|farms|states|acres|miles|kilometers|km|counties|homes|families|workers|companies|factories|ships|aircraft|troops|soldiers|nations|countries|tribes|reserves|parks)\b/i

const PROOF_PATTERNS: Array<{
  type: ProofVisual['type']
  regex: RegExp
  label: string
  icon: ProofVisual['icon']
  position: ProofVisual['position']
  priority: number
}> = [
  // Priority 1 — Dollar amounts (most impactful)
  {
    type: 'number_card', priority: 1,
    regex: /\$[\d,]+(?:\.\d+)?(?:\s*(?:million|billion|thousand|M|B|K))?|\b\d+(?:\.\d+)?\s*(?:million|billion)\s+dollars?\b/i,
    label: 'Dollar figure', icon: 'money', position: 'bottom_right'
  },
  // Priority 2 — Percentage
  {
    type: 'stat_emphasis', priority: 2,
    regex: /\d+(?:\.\d+)?\s*(?:%|percent)\b/i,
    label: 'Percentage', icon: 'stat', position: 'bottom_left'
  },
  // Priority 3 — Million/billion/thousand (no dollar sign)
  {
    type: 'stat_emphasis', priority: 3,
    regex: /\b\d+(?:\.\d+)?\s+(?:million|billion|thousand)\b(?!\s+dollars?)/i,
    label: 'Big stat', icon: 'stat', position: 'bottom_right'
  },
  // Priority 4 — Unit number (60,000 people etc.)
  {
    type: 'number_card', priority: 4,
    regex: UNIT_NUMBER_REGEX,
    label: 'Unit number', icon: 'stat', position: 'bottom_right'
  },
  // Priority 5 — Large bare number
  {
    type: 'number_card', priority: 5,
    regex: /\b\d{1,3}(?:,\d{3}){2,}\b/,
    label: 'Large number', icon: 'none', position: 'bottom_right'
  },
  // Priority 6 — Year (with context word nearby)
  {
    type: 'date_card', priority: 6,
    regex: /\b(?:in|during|by|since|from|after|before|around|until|as of)\s+(1[0-9]{3}|20[0-9]{2})\b|(1[0-9]{3}|20[0-9]{2})\s+(?:to|through|until|–|-)\s+(?:1[0-9]{3}|20[0-9]{2})/i,
    label: 'Year', icon: 'calendar', position: 'top_right'
  },
]

/** Known US/Canada location names used in documentary context */
const KNOWN_LOCATIONS: Array<{ name: string; canonical: string; confidence: number }> = [
  // US States
  { name: 'Montana', canonical: 'MONTANA', confidence: 0.95 },
  { name: 'South Dakota', canonical: 'SOUTH DAKOTA', confidence: 0.95 },
  { name: 'North Dakota', canonical: 'NORTH DAKOTA', confidence: 0.95 },
  { name: 'Wyoming', canonical: 'WYOMING', confidence: 0.95 },
  { name: 'Colorado', canonical: 'COLORADO', confidence: 0.9 },
  { name: 'Minnesota', canonical: 'MINNESOTA', confidence: 0.9 },
  { name: 'Wisconsin', canonical: 'WISCONSIN', confidence: 0.9 },
  { name: 'Iowa', canonical: 'IOWA', confidence: 0.9 },
  { name: 'Kansas', canonical: 'KANSAS', confidence: 0.9 },
  { name: 'Nebraska', canonical: 'NEBRASKA', confidence: 0.9 },
  { name: 'Texas', canonical: 'TEXAS', confidence: 0.9 },
  { name: 'California', canonical: 'CALIFORNIA', confidence: 0.9 },
  { name: 'New York', canonical: 'NEW YORK', confidence: 0.9 },
  { name: 'Pennsylvania', canonical: 'PENNSYLVANIA', confidence: 0.9 },
  { name: 'Ohio', canonical: 'OHIO', confidence: 0.9 },
  { name: 'Illinois', canonical: 'ILLINOIS', confidence: 0.9 },
  { name: 'Michigan', canonical: 'MICHIGAN', confidence: 0.9 },
  { name: 'Indiana', canonical: 'INDIANA', confidence: 0.9 },
  { name: 'Missouri', canonical: 'MISSOURI', confidence: 0.9 },
  { name: 'Washington', canonical: 'WASHINGTON', confidence: 0.85 },
  { name: 'Oregon', canonical: 'OREGON', confidence: 0.9 },
  { name: 'Idaho', canonical: 'IDAHO', confidence: 0.9 },
  { name: 'Utah', canonical: 'UTAH', confidence: 0.9 },
  { name: 'Nevada', canonical: 'NEVADA', confidence: 0.9 },
  { name: 'Arizona', canonical: 'ARIZONA', confidence: 0.9 },
  { name: 'New Mexico', canonical: 'NEW MEXICO', confidence: 0.9 },
  { name: 'Oklahoma', canonical: 'OKLAHOMA', confidence: 0.9 },
  { name: 'Arkansas', canonical: 'ARKANSAS', confidence: 0.9 },
  { name: 'Louisiana', canonical: 'LOUISIANA', confidence: 0.9 },
  { name: 'Mississippi', canonical: 'MISSISSIPPI', confidence: 0.9 },
  { name: 'Alabama', canonical: 'ALABAMA', confidence: 0.9 },
  { name: 'Georgia', canonical: 'GEORGIA', confidence: 0.85 },
  { name: 'Florida', canonical: 'FLORIDA', confidence: 0.9 },
  { name: 'Tennessee', canonical: 'TENNESSEE', confidence: 0.9 },
  { name: 'Kentucky', canonical: 'KENTUCKY', confidence: 0.9 },
  { name: 'Virginia', canonical: 'VIRGINIA', confidence: 0.85 },
  { name: 'West Virginia', canonical: 'WEST VIRGINIA', confidence: 0.9 },
  { name: 'North Carolina', canonical: 'NORTH CAROLINA', confidence: 0.9 },
  { name: 'South Carolina', canonical: 'SOUTH CAROLINA', confidence: 0.9 },
  { name: 'Maryland', canonical: 'MARYLAND', confidence: 0.85 },
  { name: 'Delaware', canonical: 'DELAWARE', confidence: 0.85 },
  { name: 'Connecticut', canonical: 'CONNECTICUT', confidence: 0.85 },
  { name: 'Massachusetts', canonical: 'MASSACHUSETTS', confidence: 0.9 },
  { name: 'Vermont', canonical: 'VERMONT', confidence: 0.85 },
  { name: 'New Hampshire', canonical: 'NEW HAMPSHIRE', confidence: 0.85 },
  { name: 'Maine', canonical: 'MAINE', confidence: 0.85 },
  { name: 'Rhode Island', canonical: 'RHODE ISLAND', confidence: 0.85 },
  { name: 'New Jersey', canonical: 'NEW JERSEY', confidence: 0.85 },
  { name: 'Alaska', canonical: 'ALASKA', confidence: 0.9 },
  { name: 'Hawaii', canonical: 'HAWAII', confidence: 0.9 },
  // Canadian Provinces
  { name: 'Manitoba', canonical: 'MANITOBA, CANADA', confidence: 0.95 },
  { name: 'Saskatchewan', canonical: 'SASKATCHEWAN, CANADA', confidence: 0.95 },
  { name: 'Alberta', canonical: 'ALBERTA, CANADA', confidence: 0.95 },
  { name: 'British Columbia', canonical: 'BRITISH COLUMBIA, CANADA', confidence: 0.9 },
  { name: 'Ontario', canonical: 'ONTARIO, CANADA', confidence: 0.85 },
  { name: 'Quebec', canonical: 'QUEBEC, CANADA', confidence: 0.9 },
  // Major cities (high confidence)
  { name: 'Chicago', canonical: 'CHICAGO', confidence: 0.9 },
  { name: 'Los Angeles', canonical: 'LOS ANGELES', confidence: 0.9 },
  { name: 'Houston', canonical: 'HOUSTON', confidence: 0.9 },
  { name: 'Phoenix', canonical: 'PHOENIX', confidence: 0.9 },
  { name: 'Philadelphia', canonical: 'PHILADELPHIA', confidence: 0.9 },
  { name: 'San Antonio', canonical: 'SAN ANTONIO', confidence: 0.9 },
  { name: 'San Diego', canonical: 'SAN DIEGO', confidence: 0.9 },
  { name: 'Dallas', canonical: 'DALLAS', confidence: 0.9 },
  { name: 'San Francisco', canonical: 'SAN FRANCISCO', confidence: 0.9 },
  { name: 'Seattle', canonical: 'SEATTLE', confidence: 0.9 },
  { name: 'Denver', canonical: 'DENVER', confidence: 0.9 },
  { name: 'Boston', canonical: 'BOSTON', confidence: 0.9 },
  { name: 'Detroit', canonical: 'DETROIT', confidence: 0.9 },
  { name: 'Minneapolis', canonical: 'MINNEAPOLIS', confidence: 0.9 },
  { name: 'Winnipeg', canonical: 'WINNIPEG, CANADA', confidence: 0.9 },
  // Countries
  { name: 'Canada', canonical: 'CANADA', confidence: 0.9 },
  { name: 'United States', canonical: 'UNITED STATES', confidence: 0.85 },
  { name: 'Mexico', canonical: 'MEXICO', confidence: 0.85 },
]

/**
 * detectLocationInText — tìm location name trong narration text.
 * Context-aware: khớp từ danh sách known locations.
 * Không dùng NER model — pure string matching.
 *
 * @param text - narration text
 * @param contextLocations - optional list of locations from GlobalScriptContext
 */
function detectLocationInText(
  text: string,
  contextLocations?: string[]
): { canonical: string; confidence: number } | null {
  // Ưu tiên context-provided locations trước
  const prioritized = contextLocations
    ? [
        ...contextLocations.map(loc => ({
          name: loc,
          canonical: loc.toUpperCase(),
          confidence: 0.98  // high confidence if from script context
        })),
        ...KNOWN_LOCATIONS,
      ]
    : KNOWN_LOCATIONS

  // Sort by length descending — match longer first (South Dakota trước Dakota)
  const sorted = [...prioritized].sort((a, b) => b.name.length - a.name.length)

  for (const loc of sorted) {
    // Word-boundary aware match
    const escaped = loc.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`\\b${escaped}\\b`, 'i')
    if (regex.test(text)) {
      // Check if exact "Manitoba, Canada" appears — prefer full form
      if (contextLocations === undefined || !loc.name.includes(',')) {
        const withCountryMatch = text.match(
          new RegExp(`\\b${escaped}\\s*,\\s*(Canada|USA|US|United States|Mexico)\\b`, 'i')
        )
        if (withCountryMatch) {
          return {
            canonical: `${loc.name.toUpperCase()}, ${withCountryMatch[1].toUpperCase()}`,
            confidence: 0.99
          }
        }
      }
      return { canonical: loc.canonical, confidence: loc.confidence }
    }
  }
  return null
}

/**
 * Tìm proof visual opportunity trong narration text.
 * CHỈ dùng data từ narration — không bịa.
 *
 * @param narrativeText - narration/script text
 * @param sceneId       - for ID generation
 * @param relativeTime  - relative start within scene
 * @param durationSecs  - max display time
 * @param contextLocations - optional known locations from script context
 */
export function detectProofVisual(
  narrativeText: string,
  sceneId: string,
  relativeTime: number,
  durationSecs: number,
  contextLocations?: string[]
): ProofVisual | null {
  if (!narrativeText || narrativeText.trim().length === 0) return null

  // 1. Address detection (highest specificity)
  const addressMatch = narrativeText.match(ADDRESS_REGEX)
  if (addressMatch) {
    const text = addressMatch[0].trim().slice(0, 48)  // cap length
    return {
      type: 'location_label',
      primaryText: text.toUpperCase(),
      sourceField: 'narrativeText',
      relativeTime,
      durationSecs: Math.min(durationSecs, 2.5),
      position: 'top_right',
      stylePreset: 'location_tag',
      icon: 'location',
      confidence: 0.85,
    }
  }

  // 2. Numeric patterns (priority-sorted)
  for (const pattern of PROOF_PATTERNS) {
    const match = narrativeText.match(pattern.regex)
    if (match) {
      // For year patterns — extract the year number only
      let primaryText = match[0].trim()
      if (pattern.type === 'date_card') {
        const yearMatch = primaryText.match(/\b(1[0-9]{3}|20[0-9]{2})\b/)
        if (yearMatch) primaryText = yearMatch[1]
      }
      // Cap text length
      if (primaryText.length > 32) primaryText = primaryText.slice(0, 32)

      return {
        type: pattern.type,
        primaryText,
        sourceField: 'narrativeText',
        relativeTime,
        durationSecs: Math.min(durationSecs, 2.5),
        position: pattern.position,
        icon: pattern.icon,
        confidence: 0.9,
      }
    }
  }

  // 3. Location detection (lower priority than numeric data)
  const locationResult = detectLocationInText(narrativeText, contextLocations)
  if (locationResult && locationResult.confidence >= 0.8) {
    return {
      type: 'location_label',
      primaryText: locationResult.canonical.slice(0, 48),
      sourceField: 'narrativeText',
      relativeTime,
      durationSecs: Math.min(durationSecs, 2.0),
      position: 'top_left',
      stylePreset: 'location_tag',
      icon: 'location',
      confidence: locationResult.confidence,
    }
  }

  return null
}


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
