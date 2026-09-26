/**
 * retention-qa.ts — Advanced Retention QA
 *
 * Extends pacing-guard.ts với thêm retention-specific flags.
 * Không thay pacing-guard, chỉ bổ sung.
 *
 * Output: RetentionQaFlag[] — chỉ là warnings/suggestions.
 * KHÔNG block render.
 * KHÔNG thay scene timing.
 *
 * Gọi sau pacing-guard.analyzePacing() hoặc sau render prep.
 */

import { logger } from '../logger'
import type { RetentionQaFlag, RetentionQaFlagType, VisualBeat } from './retention-types'

interface QaScene {
  sceneIndex: number
  sceneId?: string
  duration: number
  energyLevel?: string
  shotType?: string
  narrativeText?: string
  visualIntent?: string
  isPatternInterrupt?: boolean
  localPath?: string
  visualBeats?: VisualBeat[]
  [key: string]: unknown
}

// ─── Config ───────────────────────────────────────────────────────────────────

const QA_CONFIG = {
  longStaticThresholdHigh: 7,    // giây — high energy scene không nên tĩnh lâu hơn
  longStaticThresholdMedium: 12, // giây — medium energy
  longStaticThresholdLow: 20,    // giây — low energy OK để dài hơn
  repeatedShotTypeWindow: 4,     // số scenes liên tiếp cùng shotType → flag
  proofOpportunityMinStats: 1,   // cần ít nhất 1 stat để flag proof opportunity
  overloadVisualScore: 6,        // điểm visual load tối đa trước khi flag
} as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROOF_REGEX = /\$[\d,]+|\d+\.?\d*\s*%|\b(1[0-9]{3}|20[0-9]{2})\b|\d{1,3}(,\d{3})+|\b\d+\s*(million|billion|thousand)\b/i

function makeFlag(
  sceneId: string,
  flagType: RetentionQaFlagType,
  severity: RetentionQaFlag['severity'],
  description: string,
  suggestion?: string
): RetentionQaFlag {
  return { sceneId, flagType, severity, description, suggestion }
}

// ─── Main QA function ─────────────────────────────────────────────────────────

/**
 * runRetentionQA — phân tích scenes và trả về flags.
 *
 * Flags chỉ là informational — không thay đổi render.
 * Có thể save vào analysis/retention-qa.json để review.
 */
export function runRetentionQA(scenes: QaScene[]): RetentionQaFlag[] {
  const flags: RetentionQaFlag[] = []

  // ── 1. Long static visual ─────────────────────────────────────────────────
  for (const scene of scenes) {
    const sceneId = scene.sceneId ?? String(scene.sceneIndex)
    const energy = scene.energyLevel ?? 'medium'
    const beats = scene.visualBeats

    // Tính longest single beat duration
    let longestBeat = scene.duration
    if (beats && beats.length > 0) {
      longestBeat = Math.max(...beats.map(b => b.relativeEnd - b.relativeStart))
    }

    const threshold =
      energy === 'high' ? QA_CONFIG.longStaticThresholdHigh :
      energy === 'low'  ? QA_CONFIG.longStaticThresholdLow :
      QA_CONFIG.longStaticThresholdMedium

    if (longestBeat > threshold) {
      flags.push(makeFlag(
        sceneId,
        'LONG_STATIC_VISUAL',
        energy === 'high' ? 'warning' : 'info',
        `Longest beat ${longestBeat.toFixed(1)}s exceeds threshold ${threshold}s for ${energy} energy`,
        energy === 'high' ? 'Add detail crop or secondary visual' : 'Consider subtle crop for variety'
      ))
    }
  }

  // ── 2. Repeated shot type window ─────────────────────────────────────────
  if (scenes.length >= QA_CONFIG.repeatedShotTypeWindow) {
    for (let i = 0; i <= scenes.length - QA_CONFIG.repeatedShotTypeWindow; i++) {
      const window = scenes.slice(i, i + QA_CONFIG.repeatedShotTypeWindow)
      const firstShot = window[0].shotType
      if (firstShot && window.every(s => s.shotType === firstShot)) {
        const sceneId = window[QA_CONFIG.repeatedShotTypeWindow - 1].sceneId ?? String(window[QA_CONFIG.repeatedShotTypeWindow - 1].sceneIndex)
        // Chỉ flag scene cuối của chuỗi
        flags.push(makeFlag(
          sceneId,
          'REPEATED_SHOT_TYPE',
          'warning',
          `${QA_CONFIG.repeatedShotTypeWindow} consecutive "${firstShot}" shot type scenes`,
          'Try detail crop or secondary asset with different framing'
        ))
        // Skip window để tránh spam (jump qua)
        i += QA_CONFIG.repeatedShotTypeWindow - 1
      }
    }
  }

  // ── 3. Missing proof visual opportunity ───────────────────────────────────
  let windowStart = 0
  let windowProofCount = 0
  let windowHasStatCount = 0

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    const sceneId = scene.sceneId ?? String(scene.sceneIndex)
    const hasStatInNarration = scene.narrativeText
      ? PROOF_REGEX.test(scene.narrativeText)
      : false

    if (hasStatInNarration) windowHasStatCount++

    const hasPvBeat = scene.visualBeats?.some(b => b.type === 'proof_visual') ?? false
    if (hasPvBeat) windowProofCount++

    // Check every 5 scenes
    if ((i + 1) % 5 === 0) {
      if (windowHasStatCount >= 2 && windowProofCount === 0) {
        flags.push(makeFlag(
          sceneId,
          'MISSING_PROOF_OPPORTUNITY',
          'info',
          `${windowHasStatCount} stat references in last 5 scenes with no proof visuals`,
          'Enable proofVisualsEnabled in retention settings'
        ))
      }
      windowProofCount = 0
      windowHasStatCount = 0
      windowStart = i + 1
    }
  }

  // ── 4. No visual reset in long stretch ───────────────────────────────────
  let noResetSeconds = 0
  const NO_RESET_THRESHOLD = 30  // giây

  for (const scene of scenes) {
    const sceneId = scene.sceneId ?? String(scene.sceneIndex)
    const hasReset =
      scene.isPatternInterrupt ||
      (scene.visualBeats ?? []).some(b =>
        b.type === 'pattern_interrupt' || b.type === 'proof_visual'
      )

    if (!hasReset) {
      noResetSeconds += scene.duration
      if (noResetSeconds > NO_RESET_THRESHOLD) {
        flags.push(makeFlag(
          sceneId,
          'NO_VISUAL_RESET',
          'warning',
          `${Math.round(noResetSeconds)}s without visual reset or pattern interrupt`,
          'Add proof visual or detail crop in this stretch'
        ))
        noResetSeconds = 0  // reset sau khi flag để tránh spam
      }
    } else {
      noResetSeconds = 0
    }
  }

  // ── 5. Summary log ────────────────────────────────────────────────────────
  const bySeverity = {
    error: flags.filter(f => f.severity === 'error').length,
    warning: flags.filter(f => f.severity === 'warning').length,
    info: flags.filter(f => f.severity === 'info').length,
  }
  logger.info(
    `[RetentionQA] ${flags.length} flags: ` +
    `${bySeverity.error} errors, ${bySeverity.warning} warnings, ${bySeverity.info} info`
  )

  return flags
}
