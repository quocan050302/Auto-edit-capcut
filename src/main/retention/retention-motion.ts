/**
 * retention-motion.ts — Retention-Aware AI Motion Decorator
 *
 * Small additive helper for AI still image rendering.
 * Does NOT rewrite FFmpeg filters or change rendering architecture.
 * Safely adapts the motion preset based on the scene's retention role,
 * intensity, and recent motion history to prevent motion monotony.
 */

import { logger } from '../logger'
import type { HealthMotionPreset, HealthMotionSpec } from '../../../shared/types'
import type { RetentionScenePlan } from './retention-types'

const SAFE_PRESET_VARIATIONS: Record<string, HealthMotionPreset[]> = {
  'push-in-center': ['slow-push-in', 'push-in-left', 'pan-left', 'micro-drift'],
  'slow-push-in': ['push-in-center', 'micro-drift', 'pan-right', 'still-hold'],
  'pan-left': ['pan-right', 'push-in-center', 'slow-push-in', 'micro-drift'],
  'pan-right': ['pan-left', 'push-in-center', 'slow-push-out', 'micro-drift'],
  'micro-drift': ['slow-push-in', 'pan-left', 'still-hold', 'push-in-center'],
  'slow-push-out': ['micro-drift', 'pan-right', 'still-hold', 'slow-push-in'],
  'push-out-center': ['slow-push-out', 'micro-drift', 'pan-left', 'still-hold'],
  'pan-up': ['pan-down', 'push-in-center', 'micro-drift', 'slow-push-in'],
  'pan-down': ['pan-up', 'slow-push-in', 'pan-right', 'micro-drift'],
  'still-hold': ['micro-drift', 'slow-push-in', 'pan-left']
}

export function pickAlternativePreset(
  repeatedPreset: HealthMotionPreset,
  role?: string
): HealthMotionPreset {
  const alternatives = SAFE_PRESET_VARIATIONS[repeatedPreset] || ['slow-push-in', 'pan-left', 'micro-drift']

  if (role === 'proof' || role === 'payoff') {
    if (alternatives.includes('slow-push-in')) return 'slow-push-in'
    if (alternatives.includes('still-hold')) return 'still-hold'
    if (alternatives.includes('micro-drift')) return 'micro-drift'
  }

  if (role === 'hook' || role === 're-hook' || role === 'surprise') {
    if (alternatives.includes('push-in-center')) return 'push-in-center'
    if (alternatives.includes('push-in-left')) return 'push-in-left'
    if (alternatives.includes('pan-right')) return 'pan-right'
  }

  return alternatives[0] || 'micro-drift'
}

/**
 * Decorates base motion spec/preset with retention guidance.
 * Fallback guarantee: returns baseMotion unchanged if anything fails or hint is missing.
 */
export function applyRetentionMotionHint(
  baseMotion: HealthMotionSpec | HealthMotionPreset | string,
  retentionHint?: RetentionScenePlan,
  recentMotionHistory: string[] = []
): HealthMotionSpec | HealthMotionPreset {
  if (!retentionHint) {
    return baseMotion as HealthMotionPreset
  }

  try {
    const isSpecObject = typeof baseMotion === 'object' && baseMotion !== null && 'preset' in baseMotion
    let currentPreset: HealthMotionPreset = isSpecObject
      ? (baseMotion as HealthMotionSpec).preset
      : (baseMotion as HealthMotionPreset)

    // 1. Role-specific preset recommendation if base motion is generic default
    const isGenericDefault = currentPreset === 'push-in-center' || currentPreset === 'slow-push-in'

    if (isGenericDefault) {
      switch (retentionHint.role) {
        case 'hook':
        case 'surprise':
          currentPreset = 'push-in-center'
          break
        case 'mechanism':
          currentPreset = 'pan-left'
          break
        case 'proof':
          currentPreset = 'still-hold'
          break
        case 'payoff':
          currentPreset = 'slow-push-in'
          break
        case 'bridge':
        case 'recap':
        case 'conclusion':
          currentPreset = 'micro-drift'
          break
        case 're-hook':
          currentPreset = 'pan-right'
          break
      }
    }

    // 2. Motion novelty check: prevent >2 identical strong presets consecutively
    if (recentMotionHistory.length >= 2) {
      const lastTwo = recentMotionHistory.slice(-2)
      if (lastTwo[0] === currentPreset && lastTwo[1] === currentPreset) {
        const alt = pickAlternativePreset(currentPreset, retentionHint.role)
        logger.info(
          `[RetentionMotion] Scene ${retentionHint.sceneIndex}: repeated motion '${currentPreset}' detected, switching to '${alt}' for novelty`
        )
        currentPreset = alt
      }
    }

    // 3. Return adjusted motion
    if (isSpecObject) {
      const spec = baseMotion as HealthMotionSpec
      let intensity = spec.intensity
      if (retentionHint.motionEnergy === 'elevated' && intensity === 'subtle') {
        intensity = 'medium'
      } else if (retentionHint.motionEnergy === 'calm' && intensity === 'medium') {
        intensity = 'subtle'
      }
      return {
        ...spec,
        preset: currentPreset,
        intensity
      }
    }

    return currentPreset
  } catch (err) {
    logger.warn(`[RetentionMotion] Failed to apply hint: ${String(err)}, using base motion`)
    return baseMotion as HealthMotionPreset
  }
}
