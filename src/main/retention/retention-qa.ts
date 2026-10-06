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
export function runRetentionQA(
  scenes: QaScene[],
  retentionPlan?: RetentionPlan | null
): RetentionQaFlag[] {
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

  // ── 5. Upgraded Retention Director checks (if retentionPlan is present) ───
  if (retentionPlan) {
    const plans = retentionPlan.scenes || []

    // 5.1 Low novelty streak
    for (let i = 2; i < plans.length; i++) {
      const p0 = plans[i - 2]
      const p1 = plans[i - 1]
      const p2 = plans[i]
      if (p0.noveltyScore < 0.40 && p1.noveltyScore < 0.40 && p2.noveltyScore < 0.40) {
        flags.push(makeFlag(
          p2.sceneId,
          'LOW_NOVELTY_STREAK',
          'warning',
          `Low novelty streak across 3 consecutive scenes (${p0.noveltyScore.toFixed(2)}, ${p1.noveltyScore.toFixed(2)}, ${p2.noveltyScore.toFixed(2)})`,
          'Vary camera motion, apply detail crop, or introduce a proof visual'
        ))
      }
    }

    // 5.2 Repeated motion detection
    const motionHistory: Array<{ sceneId: string; motion?: string }> = []
    for (const sc of scenes) {
      const motion = (sc as any).motionPreset || (sc as any).motion?.preset
      if (motion) {
        motionHistory.push({ sceneId: sc.sceneId ?? String(sc.sceneIndex), motion })
      }
    }
    for (let i = 2; i < motionHistory.length; i++) {
      const m0 = motionHistory[i - 2].motion
      const m1 = motionHistory[i - 1].motion
      const m2 = motionHistory[i].motion
      if (m0 && m1 === m0 && m2 === m0) {
        flags.push(makeFlag(
          motionHistory[i].sceneId,
          'REPEATED_MOTION',
          'warning',
          `3 consecutive AI still scenes use identical motion preset "${m0}"`,
          'Use alternate motion preset or subtle pan to increase visual variety'
        ))
      }
    }

    // 5.3 Repeated visual category
    for (let i = 2; i < scenes.length; i++) {
      const c0 = (scenes[i - 2] as any).category
      const c1 = (scenes[i - 1] as any).category
      const c2 = (scenes[i] as any).category
      if (c0 && c1 === c0 && c2 === c0 && c0 !== 'conceptual') {
        flags.push(makeFlag(
          scenes[i].sceneId ?? String(scenes[i].sceneIndex),
          'REPEATED_VISUAL_CATEGORY',
          'info',
          `3 consecutive scenes share the same visual category "${c0}"`,
          'Ensure camera angles or framing vary between scenes'
        ))
      }
    }

    // 5.4 Unresolved high-confidence open loops
    for (const loop of retentionPlan.openLoops || []) {
      if (loop.status === 'open' && loop.confidence >= 0.85) {
        flags.push(makeFlag(
          String(loop.openedAtSceneIndex),
          'OPEN_LOOP_UNRESOLVED',
          'info',
          `Open loop "${loop.question}" has no identified payoff scene`,
          'Consider addressing or answering the open question in a later scene'
        ))
      }
    }

    // 5.5 Rehook gap too long
    const targetGap = retentionPlan.strategy?.targetRehookGapSecs || 35
    let timeSinceLastRehook = 0
    for (const p of plans) {
      const sc = scenes.find((s) => s.sceneIndex === p.sceneIndex)
      const dur = sc?.duration || 4.0
      if (p.role === 'hook' || p.role === 're-hook' || p.role === 'surprise' || p.patternInterrupt) {
        if (timeSinceLastRehook > targetGap * 1.5) {
          flags.push(makeFlag(
            p.sceneId,
            'REHOOK_GAP_TOO_LONG',
            'warning',
            `Re-hook gap of ${Math.round(timeSinceLastRehook)}s exceeded recommended target (${targetGap}s)`,
            'Add an engaging narrative question or pattern interrupt earlier'
          ))
        }
        timeSinceLastRehook = 0
      } else {
        timeSinceLastRehook += dur
      }
    }
  }

  // ── 6. Summary log ────────────────────────────────────────────────────────
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

// ─── Retention Summary Artifact Generator ─────────────────────────────────────

import type { RetentionPlan, RetentionSummary } from './retention-types'
import * as fs from 'fs'
import * as path from 'path'

export function generateRetentionSummary(
  scenes: QaScene[],
  retentionPlan?: RetentionPlan | null,
  flags: RetentionQaFlag[] = []
): RetentionSummary {
  let totalDuration = 0
  for (const s of scenes) {
    totalDuration += s.duration || 0
  }

  const lowNoveltyFlags = flags.filter((f) => f.flagType === 'LOW_NOVELTY_STREAK').length
  const longRehookFlags = flags.filter((f) => f.flagType === 'REHOOK_GAP_TOO_LONG').length
  const repeatedMotionFlags = flags.filter((f) => f.flagType === 'REPEATED_MOTION').length
  const overeditedFlags = flags.filter((f) => f.flagType === 'OVEREDITED' || f.flagType === 'EFFECT_OVERLOAD').length

  const detectedLoops = retentionPlan?.openLoops?.length || 0
  const resolvedLoops = retentionPlan?.openLoops?.filter((l) => l.status === 'resolved').length || 0
  const unresolvedLoops = detectedLoops - resolvedLoops

  const patternInterrupts = retentionPlan?.summary?.patternInterrupts ??
    scenes.filter((s) => s.isPatternInterrupt).length

  // Calculate average novelty score
  let avgNovelty = 0.70
  if (retentionPlan?.scenes && retentionPlan.scenes.length > 0) {
    const sum = retentionPlan.scenes.reduce((acc, sp) => acc + (sp.noveltyScore || 0), 0)
    avgNovelty = Math.round((sum / retentionPlan.scenes.length) * 100) / 100
  }

  // Calculate internal retention health score (100 base)
  let healthScore = 100
  healthScore -= lowNoveltyFlags * 5
  healthScore -= longRehookFlags * 5
  healthScore -= repeatedMotionFlags * 3
  healthScore -= unresolvedLoops * 4
  healthScore -= overeditedFlags * 4
  healthScore = Math.max(40, Math.min(100, healthScore))

  return {
    schemaVersion: 1,
    sceneCount: scenes.length,
    durationSecs: Math.round(totalDuration * 10) / 10,
    retentionHealthScore: healthScore,
    riskCounts: {
      lowNovelty: lowNoveltyFlags,
      longRehookGap: longRehookFlags,
      repeatedMotion: repeatedMotionFlags,
      overedited: overeditedFlags
    },
    openLoops: {
      detected: detectedLoops,
      resolved: resolvedLoops,
      unresolved: unresolvedLoops
    },
    patternInterrupts,
    averageNoveltyScore: avgNovelty
  }
}

export function saveRetentionSummary(projectDir: string, summary: RetentionSummary): void {
  try {
    const summaryPath = path.join(projectDir, 'analysis', 'retention-summary.json')
    const dir = path.dirname(summaryPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')
    logger.info(`[RetentionQA] Retention summary saved to retention-summary.json (score=${summary.retentionHealthScore})`)
  } catch (err) {
    logger.warn(`[RetentionQA] Failed to save retention summary: ${String(err)}`)
  }
}

