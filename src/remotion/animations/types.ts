/**
 * types.ts — Animation system types
 *
 * Tất cả types liên quan animation engine.
 * Backward compatible: tất cả field trong CaptionPhrase extension đều optional.
 */

/** 6 animation combo presets */
export type AnimationPreset =
  | 'smooth_kinetic'   // fade + slideUp + subtleScale — default
  | 'punch'            // fade + impactScale + rotateSettle — keyword/punchline
  | 'swipe_reveal'     // clip reveal + translateX — transition/headline
  | 'blur_focus'       // blur + fade + scale — dramatic/suspense
  | 'impact_keyword'   // normal: fade+slide; keyword: impactScale+highlight
  | 'type_pop'         // word stagger, keyword spring pop

/** Animation intensity level */
export type AnimationIntensity = 'subtle' | 'medium' | 'strong'

/** Keyword animation style */
export type KeywordAnimation = 'none' | 'spring' | 'impact' | 'highlight'

/**
 * Resolved animation config cho một phrase.
 * Được tính deterministically từ phrase.id + emphasisType + index.
 */
export interface ResolvedAnimation {
  preset: AnimationPreset
  intensity: AnimationIntensity
  keywordAnimation: KeywordAnimation
  wordStaggerFrames: number   // 0 = không stagger
}

/**
 * CSS transform string được tính từ primitives.
 * Bao gồm opacity vì không thể mixed vào transform.
 */
export interface AnimatedStyle {
  opacity: number
  transform: string
  filter?: string
  clipPath?: string
}
