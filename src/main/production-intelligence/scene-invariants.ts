import * as crypto from 'crypto'
import { logger } from '../logger'

export interface MinimalSceneIdentity {
  sceneId?: string
  sceneIndex: number
  startTime: number
  endTime: number
  duration?: number
  narrativeText?: string
  narrationText?: string
  chapterId?: string
  sequenceId?: string
}

export interface SceneIdentityCheckResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

function hashNarration(text?: string): string {
  if (!text) return ''
  return crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

/**
 * Validates that after any operation (such as visual truth reranking or claim extraction),
 * scene identity, count, order, IDs, narration text, and timings are 100% preserved.
 */
export function checkSceneIdentityPreserved<
  TBefore extends MinimalSceneIdentity,
  TAfter extends MinimalSceneIdentity
>(beforeScenes: TBefore[], afterScenes: TAfter[]): SceneIdentityCheckResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!Array.isArray(beforeScenes) || !Array.isArray(afterScenes)) {
    errors.push('Both beforeScenes and afterScenes must be valid arrays.')
    return { valid: false, errors, warnings }
  }

  // 1. Check count
  if (beforeScenes.length !== afterScenes.length) {
    errors.push(
      `Scene count mismatch: expected ${beforeScenes.length} scenes, got ${afterScenes.length} scenes (scene loss or duplication detected).`
    )
    return { valid: false, errors, warnings }
  }

  // 2. Check each scene by index, ID, timing, and narration
  for (let i = 0; i < beforeScenes.length; i++) {
    const before = beforeScenes[i]
    const after = afterScenes[i]

    // Scene index & order
    if (before.sceneIndex !== after.sceneIndex) {
      errors.push(
        `Scene order corrupted at index ${i}: expected sceneIndex ${before.sceneIndex}, got ${after.sceneIndex}.`
      )
    }

    // Scene ID
    if (before.sceneId && after.sceneId && before.sceneId !== after.sceneId) {
      errors.push(
        `Scene ID mutated at index ${i}: before="${before.sceneId}", after="${after.sceneId}".`
      )
    }

    // Narration text preservation
    const beforeNarration = before.narrativeText ?? before.narrationText ?? ''
    const afterNarration = after.narrativeText ?? after.narrationText ?? ''
    if (hashNarration(beforeNarration) !== hashNarration(afterNarration)) {
      errors.push(
        `Narration text altered at scene ${before.sceneId ?? before.sceneIndex}: expected "${beforeNarration.slice(0, 40)}...", got "${afterNarration.slice(0, 40)}...".`
      )
    }

    // Timing preservation (start / end / duration)
    const startDiff = Math.abs(before.startTime - after.startTime)
    const endDiff = Math.abs(before.endTime - after.endTime)
    if (startDiff > 0.001 || endDiff > 0.001) {
      errors.push(
        `Timing shifted at scene ${before.sceneId ?? before.sceneIndex}: expected [${before.startTime.toFixed(2)}-${before.endTime.toFixed(2)}], got [${after.startTime.toFixed(2)}-${after.endTime.toFixed(2)}].`
      )
    }

    // Chapter / Sequence mapping if present
    if (before.chapterId && after.chapterId && before.chapterId !== after.chapterId) {
      warnings.push(
        `Chapter ID mismatch at scene ${before.sceneId ?? before.sceneIndex}: before="${before.chapterId}", after="${after.chapterId}".`
      )
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

/**
 * Asserts that scene identity is preserved. In test mode, throws if violated.
 * In production mode, logs fatal error and returns false so caller can safely fallback.
 */
export function assertSceneIdentityPreserved<
  TBefore extends MinimalSceneIdentity,
  TAfter extends MinimalSceneIdentity
>(
  beforeScenes: TBefore[],
  afterScenes: TAfter[],
  throwOnError = false
): boolean {
  const result = checkSceneIdentityPreserved(beforeScenes, afterScenes)
  if (!result.valid) {
    const errorSummary = `[SceneInvariantViolated] ${result.errors.join(' | ')}`
    logger.error(errorSummary)
    if (throwOnError || process.env.NODE_ENV === 'test') {
      throw new Error(errorSummary)
    }
    return false
  }

  if (result.warnings.length > 0) {
    logger.warn(`[SceneInvariantWarning] ${result.warnings.join(' | ')}`)
  }

  return true
}
