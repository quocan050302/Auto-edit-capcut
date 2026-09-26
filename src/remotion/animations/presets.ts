/**
 * presets.ts — Animation combo preset definitions + resolver
 *
 * Mỗi preset kết hợp tối đa 3 animation primitive chính.
 * Resolver chọn preset DETERMINISTICALLY từ phrase.id + emphasisType + index.
 *
 * KHÔNG dùng Math.random().
 * KHÔNG thay đổi timing hoặc content của phrase.
 */

import type { AnimationPreset, AnimationIntensity, KeywordAnimation, ResolvedAnimation } from './types'
import type { CaptionPhrase } from '../../../shared/types'
import { hashStr } from './helpers'

// ─── Preset definitions ───────────────────────────────────────────────────────

export interface PresetDef {
  enter: string[]          // tên primitives sử dụng khi enter
  keyword: KeywordAnimation
  exit: string[]
  defaultIntensity: AnimationIntensity
  wordStagger: boolean     // có stagger words không
}

export const ANIMATION_PRESETS: Record<AnimationPreset, PresetDef> = {
  /**
   * A. SMOOTH_KINETIC — caption bình thường
   * fade + slideUp + subtleScale
   * Clean, premium, modern. Không overshoot mạnh.
   */
  smooth_kinetic: {
    enter: ['fade', 'slideUp', 'springScale'],
    keyword: 'spring',
    exit: ['fade', 'slideUp'],
    defaultIntensity: 'medium',
    wordStagger: false,
  },

  /**
   * B. PUNCH — keyword mạnh / reaction / punchline
   * fade + impactScale + rotateSettle
   * Snap nhanh, không rung liên tục.
   */
  punch: {
    enter: ['fade', 'impactScale', 'rotateSettle'],
    keyword: 'impact',
    exit: ['fade'],
    defaultIntensity: 'strong',
    wordStagger: false,
  },

  /**
   * C. SWIPE_REVEAL — transition / headline
   * clip reveal + translateX + fade
   * Text xuất hiện từ trái sang phải.
   */
  swipe_reveal: {
    enter: ['reveal', 'slideX', 'fade'],
    keyword: 'none',
    exit: ['fade'],
    defaultIntensity: 'medium',
    wordStagger: false,
  },

  /**
   * D. BLUR_FOCUS — dramatic / suspense
   * blur + fade + scale
   * Mềm, không bounce. Blur chỉ ở entrance.
   */
  blur_focus: {
    enter: ['fade', 'blurFocus', 'springScale'],
    keyword: 'highlight',
    exit: ['fade'],
    defaultIntensity: 'subtle',
    wordStagger: false,
  },

  /**
   * E. IMPACT_KEYWORD — normal words: fade+slide; keyword: impactScale+highlight
   * Hierarchy rõ ràng giữa normal và keyword.
   */
  impact_keyword: {
    enter: ['fade', 'slideUp'],
    keyword: 'impact',
    exit: ['fade'],
    defaultIntensity: 'medium',
    wordStagger: false,
  },

  /**
   * F. TYPE_POP — narration nhanh, word stagger
   * Words xuất hiện lệch 2 frames. Keyword cuối: spring pop.
   */
  type_pop: {
    enter: ['fade', 'slideUp'],
    keyword: 'spring',
    exit: ['fade'],
    defaultIntensity: 'medium',
    wordStagger: true,
  },
}

// ─── Variation tables ─────────────────────────────────────────────────────────

/**
 * Rotation tables cho từng emphasisType.
 * Không dùng strong preset quá 2 caption liên tiếp.
 * Index được tính từ phrase index (deterministic).
 */
const HOOK_ROTATION: AnimationPreset[] = [
  'impact_keyword',
  'smooth_kinetic',
  'type_pop',
  'smooth_kinetic',
  'blur_focus',
  'impact_keyword',
  'smooth_kinetic',
  'type_pop',
]

const PUNCHLINE_ROTATION: AnimationPreset[] = [
  'punch',
  'smooth_kinetic',
  'blur_focus',
  'punch',
]

const NORMAL_ROTATION: AnimationPreset[] = [
  'smooth_kinetic',
  'type_pop',
  'smooth_kinetic',
]

// ─── Main resolver ────────────────────────────────────────────────────────────

/**
 * resolveCaptionAnimation — chọn preset + intensity DETERMINISTICALLY.
 *
 * Logic:
 * 1. Nếu phrase đã có animationPreset (từ Gemini hoặc user) → dùng trực tiếp.
 * 2. Nếu không → infer từ emphasisType + phrase index.
 *
 * Không thay đổi text, timing, hay bất kỳ thứ gì ngoài visual config.
 */
export function resolveCaptionAnimation(
  phrase: CaptionPhrase,
  phraseIndex: number
): ResolvedAnimation {
  // Cast để check optional fields (backward compatible — old plans won't have these)
  const phraseAny = phrase as CaptionPhrase & {
    animationPreset?: AnimationPreset
    animationIntensity?: AnimationIntensity
    keywordAnimation?: KeywordAnimation
    wordStaggerFrames?: number
  }

  // 1. Nếu có explicit animationPreset từ plan → dùng
  let preset: AnimationPreset
  if (phraseAny.animationPreset && phraseAny.animationPreset in ANIMATION_PRESETS) {
    preset = phraseAny.animationPreset
  } else {
    // 2. Infer từ emphasisType + index
    preset = inferAnimationPreset(phrase.emphasisType, phraseIndex, phrase.id)
  }

  const presetDef = ANIMATION_PRESETS[preset]

  // Intensity: explicit → fallback presetDef.defaultIntensity
  const intensity: AnimationIntensity =
    phraseAny.animationIntensity ?? deriveIntensity(phrase.emphasisType)

  // Keyword animation: explicit → fallback từ preset
  const keywordAnimation: KeywordAnimation =
    phraseAny.keywordAnimation ?? presetDef.keyword

  // Word stagger: explicit → fallback từ preset
  const wordStaggerFrames: number =
    phraseAny.wordStaggerFrames ??
    (presetDef.wordStagger ? 2 : 0)

  return { preset, intensity, keywordAnimation, wordStaggerFrames }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function inferAnimationPreset(
  emphasisType: string,
  phraseIndex: number,
  phraseId: string
): AnimationPreset {
  switch (emphasisType) {
    case 'hook':
      return HOOK_ROTATION[phraseIndex % HOOK_ROTATION.length]

    case 'punchline':
      return PUNCHLINE_ROTATION[phraseIndex % PUNCHLINE_ROTATION.length]

    case 'list_transition':
      return 'swipe_reveal'

    case 'shock_stat':
      // Dùng hash của id để vary giữa impact và smooth
      return hashStr(phraseId, 2) === 0 ? 'impact_keyword' : 'smooth_kinetic'

    default:
      return NORMAL_ROTATION[phraseIndex % NORMAL_ROTATION.length]
  }
}

function deriveIntensity(emphasisType: string): AnimationIntensity {
  switch (emphasisType) {
    case 'hook':      return 'medium'
    case 'punchline': return 'strong'
    case 'shock_stat': return 'medium'
    default:          return 'subtle'
  }
}
