import type {
  HealthMotionPreset,
  HealthMotionSpec,
  HealthVisualCategory,
  HealthScientificAccuracy
} from './health-visual-types'
import { resolvePresetDefaults } from './health-motion'
import { logger } from '../logger'

export interface MotionDirectorInput {
  sceneIndex: number
  category: HealthVisualCategory
  narration?: string
  visualIntent?: string
  duration: number
  scientificAccuracy?: HealthScientificAccuracy
  recentPresets?: HealthMotionPreset[]
}

// ─── Semantic Direction Patterns ─────────────────────────────────────────────

const HEART_PULSE_REGEX =
  /\b(heart|cardiac|pulse|pulsat|beat|rhythm|blood\s*pressure|arterial\s*pulse|systol|diastol)\b/i

const DOWNWARD_REGEX =
  /\b(down|downward|digest|digestive|stomach|gut|intestine|colon|waste|excret|sink|lower|absorb|drop)\b/i

const UPWARD_REGEX =
  /\b(up|upward|brain|cortex|head|neuron|wake|waking|rise|rising|increas|elevat|ascend|signal|energy)\b/i

const FLOW_TRANSPORT_REGEX =
  /\b(flow|blood\s*flow|bloodstream|vessel|artery|vein|circulat|transport|deliver|travel|distribut|flush|glucose\s*move)\b/i

const LEFT_SIDE_REGEX =
  /\b(left|left\s*side|spleen|pancreas|stomach\s*cavity)\b/i

const RIGHT_SIDE_REGEX =
  /\b(right|right\s*side|liver|gallbladder|ascending\s*colon)\b/i

const EVIDENCE_REGEX =
  /\b(study|studies|research|scientist|clinical|trial|evidence|paper|journal|data|statistic|reveal|found)\b/i

export class HealthMotionDirector {
  /**
   * Plans a deterministic, context-aware motion specification for a Health AI still scene.
   */
  public static planSceneMotion(input: MotionDirectorInput): HealthMotionSpec {
    const { sceneIndex, category, duration, recentPresets = [] } = input
    const text = `${input.narration || ''} ${input.visualIntent || ''}`.toLowerCase()

    const isShort = duration < 2.5
    const isLong = duration > 5.0

    // 1. Determine candidate presets in priority order based on semantic content
    const candidates: HealthMotionPreset[] = []

    // A. Heart / Cardiac / Biological Rhythm -> gentle-pulse
    if (HEART_PULSE_REGEX.test(text) && !isShort) {
      candidates.push('gentle-pulse')
    }

    // B. Semantic directional movement
    if (DOWNWARD_REGEX.test(text)) {
      candidates.push('pan-down', 'drift-down-right', 'drift-down-left')
    }

    if (UPWARD_REGEX.test(text)) {
      candidates.push('pan-up', 'drift-up-right', 'drift-up-left')
    }

    if (FLOW_TRANSPORT_REGEX.test(text)) {
      // Alternate left/right flow direction based on sceneIndex
      if (sceneIndex % 2 === 0) {
        candidates.push('pan-right', 'drift-up-right', 'pan-left')
      } else {
        candidates.push('pan-left', 'drift-down-left', 'pan-right')
      }
    }

    // C. Lateral Organ Placement
    if (RIGHT_SIDE_REGEX.test(text)) {
      candidates.push('push-in-right', 'focus-right')
    } else if (LEFT_SIDE_REGEX.test(text)) {
      candidates.push('push-in-left', 'focus-left')
    }

    // D. Category-specific fallbacks
    switch (category) {
      case 'anatomy':
        // Anatomy variety: center push, left/right focus, gentle push out
        if (sceneIndex % 3 === 0) {
          candidates.push('push-in-center', 'push-in-left', 'push-in-right')
        } else if (sceneIndex % 3 === 1) {
          candidates.push('push-in-right', 'focus-right', 'push-in-center')
        } else {
          candidates.push('push-in-left', 'focus-left', 'push-out-center')
        }
        break

      case 'mechanism':
        // Mechanism variety: directional pans and diagonal drifts
        if (sceneIndex % 4 === 0) {
          candidates.push('pan-right', 'drift-up-right', 'push-in-right')
        } else if (sceneIndex % 4 === 1) {
          candidates.push('drift-up-left', 'pan-left', 'push-in-left')
        } else if (sceneIndex % 4 === 2) {
          candidates.push('pan-down', 'drift-down-right', 'push-in-center')
        } else {
          candidates.push('drift-down-left', 'pan-right', 'drift-up-right')
        }
        break

      case 'evidence':
        // Evidence is calmer: slow push out, still hold, or gentle horizontal scan
        if (EVIDENCE_REGEX.test(text) || sceneIndex % 2 === 0) {
          candidates.push('push-out-center', 'still-hold', 'pan-right')
        } else {
          candidates.push('still-hold', 'push-in-center', 'push-out-center')
        }
        break

      case 'conceptual':
        if (sceneIndex % 3 === 0) {
          candidates.push('pan-left', 'drift-up-right', 'push-in-center')
        } else if (sceneIndex % 3 === 1) {
          candidates.push('pan-right', 'drift-down-left', 'push-out-center')
        } else {
          candidates.push('drift-up-left', 'pan-right', 'push-in-right')
        }
        break

      default:
        candidates.push('push-in-center', 'pan-right', 'pan-left', 'push-out-center')
        break
    }

    // Short scenes (< 2.5s) prefer still-hold or very subtle push-in
    if (isShort) {
      candidates.unshift('still-hold', 'push-in-center')
    }

    // 2. Filter candidate using variation memory to avoid repetition
    const selectedPreset = this.selectVariedPreset(candidates, recentPresets, sceneIndex)

    // 3. Resolve motion parameters and intensity
    const spec = resolvePresetDefaults(selectedPreset, duration)

    if (isShort) {
      spec.intensity = 'very-subtle'
      spec.zoomEnd = Math.min(spec.zoomEnd, 1.03)
      spec.reason = `Short scene (${duration.toFixed(1)}s): reduced intensity to avoid abrupt motion`
    } else if (isLong) {
      spec.intensity = 'medium'
      spec.zoomEnd = Math.max(spec.zoomEnd, 1.07)
    }

    logger.info(
      `[HealthMotion] Scene ${sceneIndex} ${category} -> ${spec.preset}, intensity=${spec.intensity} (${spec.reason})`
    )

    return spec
  }

  /**
   * Enforces variation rules:
   *  - No preset used > 2 consecutive scenes (Rule 1)
   *  - Avoid reuse within previous 3 scenes if alternatives exist (Rule 2)
   */
  private static selectVariedPreset(
    candidates: HealthMotionPreset[],
    recentPresets: HealthMotionPreset[],
    sceneIndex: number
  ): HealthMotionPreset {
    const last1 = recentPresets[recentPresets.length - 1]
    const last2 = recentPresets[recentPresets.length - 2]
    const last3 = recentPresets[recentPresets.length - 3]

    // Rule 1: Never allow 3 identical presets in a row
    const forbidden: HealthMotionPreset[] = []
    if (last1 && last2 && last1 === last2) {
      forbidden.push(last1)
    }

    // Filter out strictly forbidden
    const viable = candidates.filter((c) => !forbidden.includes(c))
    const searchPool = viable.length > 0 ? viable : candidates

    // Rule 2: Prefer candidates not in the last 3 scenes
    const preferred = searchPool.filter((c) => c !== last1 && c !== last2 && c !== last3)
    if (preferred.length > 0) {
      return preferred[0]
    }

    // Rule 3: If all candidates appeared in recent history, pick the one least recently used
    const notLast1 = searchPool.filter((c) => c !== last1)
    if (notLast1.length > 0) {
      return notLast1[0]
    }

    // Fallback: deterministic choice from searchPool
    return searchPool[sceneIndex % searchPool.length] || 'push-in-center'
  }
}
