/**
 * Pacing Guard — Pattern Interrupt Engine
 *
 * A pure algorithmic module (no AI calls, no async) that:
 *  1. Scans scenes sequentially by time order.
 *  2. Detects "monotone stretches": consecutive segments with the same energyLevel
 *     OR the same shotType exceeding maxMonotoneSeconds.
 *  3. Returns PacingIssue[] with actionable suggestions:
 *       - 'insert_broll'         → set scene.isPatternInterrupt=true so ranker
 *                                   boosts high-motion stock for that scene
 *       - 'insert_text_overlay'  → renderer will drawtext an exactTopicAnchor
 *                                   keyword over that scene
 *       - 'vary_shot_type'       → annotate scene with the *desired* next shotType
 *                                   so context-query-gen can bias Tier A queries
 *  4. Mutates scene fields (energyLevel, shotType, isPatternInterrupt) IN-PLACE
 *     before the plan is written to disk, so downstream modules see clean data.
 *
 * Called from planner.ts immediately after the Gemini plan is parsed,
 * before saving master-edit-plan.json.
 */

import { logger } from './logger'
import type { PacingIssue, SceneEnergyLevel, SceneShotType } from '../../shared/types'

// ─── Scene duck-type (matches both planner.ts ScenePlan and renderer.ts ScenePlan)

export interface PacingScene {
  sceneIndex: number
  startTime: number
  endTime: number
  duration: number
  energyLevel?: SceneEnergyLevel
  shotType?: SceneShotType
  isPatternInterrupt?: boolean
  narrativeText?: string
  visualIntent?: string
  searchQueries?: string[]
  [key: string]: unknown
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface PacingGuardConfig {
  /** Max consecutive seconds with the same energyLevel before issuing an issue */
  maxMonotoneEnergySeconds: number
  /** Max consecutive seconds with the same shotType before issuing an issue */
  maxMonotoneShotSeconds: number
  /** Whether to require shot-type variety (default true) */
  requireShotTypeVariety: boolean
}

const DEFAULT_CONFIG: PacingGuardConfig = {
  maxMonotoneEnergySeconds: 150,  // 2.5 minutes — documentary standard
  maxMonotoneShotSeconds: 90,     // 1.5 minutes — for shot variation
  requireShotTypeVariety: true
}

// ─── Inference helpers ───────────────────────────────────────────────────────

/**
 * Infer a scene's energyLevel from its narrative text and visualIntent.
 * Applied only if Gemini did not already set the field.
 */
function inferEnergyLevel(scene: PacingScene): SceneEnergyLevel {
  const text = `${scene.narrativeText ?? ''} ${scene.visualIntent ?? ''}`.toLowerCase()

  // High energy cues
  const highCues = [
    'conflict', 'battle', 'crisis', 'explosion', 'urgent', 'reveal', 'shocking',
    'protest', 'riot', 'disaster', 'fire', 'attack', 'death', 'murder', 'crash',
    'breakthrough', 'victory', 'defeat', 'climax', 'confrontation'
  ]
  if (highCues.some((c) => text.includes(c))) return 'high'

  // Low energy cues
  const lowCues = [
    'peaceful', 'quiet', 'meditation', 'reflection', 'landscape', 'sunrise',
    'slow', 'history', 'archive', 'document', 'explain', 'background', 'context',
    'meanwhile', 'tradition', 'ceremony', 'ritual', 'daily life', 'routine'
  ]
  if (lowCues.some((c) => text.includes(c))) return 'low'

  return 'medium'
}

/**
 * Infer a scene's shotType from its visualIntent and searchQueries.
 * Applied only if Gemini did not already set the field.
 */
function inferShotType(scene: PacingScene): SceneShotType {
  const text = `${scene.visualIntent ?? ''} ${(scene.searchQueries ?? []).join(' ')}`.toLowerCase()

  if (text.includes('close') || text.includes('portrait') || text.includes('face') ||
      text.includes('detail') || text.includes('hand') || text.includes('eye')) {
    return 'close-up'
  }
  if (text.includes('aerial') || text.includes('wide') || text.includes('landscape') ||
      text.includes('establishing') || text.includes('panorama') || text.includes('horizon')) {
    return 'wide'
  }
  if (text.includes('abstract') || text.includes('concept') || text.includes('metaphor') ||
      text.includes('symbol') || text.includes('silhouette') || text.includes('blur')) {
    return 'abstract'
  }
  return 'medium'
}

/** Cycle to the "next" shotType to suggest as a variety break */
function nextShotType(current: SceneShotType): SceneShotType {
  const cycle: SceneShotType[] = ['wide', 'medium', 'close-up', 'abstract']
  const idx = cycle.indexOf(current)
  return cycle[(idx + 1) % cycle.length]
}

// ─── Main analysis function ──────────────────────────────────────────────────

/**
 * Analyze all scenes for monotone pacing and annotate them in-place.
 *
 * @param scenes  Flat list of ALL scenes (order by startTime, cross-chapter).
 * @param config  Optional overrides; defaults to { 150s energy, 90s shot }.
 * @returns       List of PacingIssue[] for the Retention QA Gemini pass.
 */
export function analyzePacing(
  scenes: PacingScene[],
  config: Partial<PacingGuardConfig> = {}
): PacingIssue[] {
  const cfg: PacingGuardConfig = { ...DEFAULT_CONFIG, ...config }
  const issues: PacingIssue[] = []

  // ── Step 1: Fill missing energyLevel / shotType via inference ─────────────
  for (const scene of scenes) {
    if (!scene.energyLevel) {
      scene.energyLevel = inferEnergyLevel(scene)
    }
    if (!scene.shotType) {
      scene.shotType = inferShotType(scene)
    }
  }

  logger.info(`[PacingGuard] Analyzing ${scenes.length} scenes for monotone stretches...`)

  // ── Step 2: Sliding window — detect monotone energy stretches ─────────────
  let energyRunStart = 0
  let energyRunSeconds = 0
  let currentEnergy: SceneEnergyLevel = scenes[0]?.energyLevel ?? 'medium'

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    const sceneEnergy = scene.energyLevel as SceneEnergyLevel

    if (sceneEnergy === currentEnergy) {
      // Accumulate seconds in this energy run
      energyRunSeconds += scene.duration

      if (energyRunSeconds > cfg.maxMonotoneEnergySeconds) {
        // This scene is the "overflow" point — flag it
        const suggestion: PacingIssue['suggestion'] =
          sceneEnergy === 'low' ? 'insert_broll' : 'insert_text_overlay'

        issues.push({
          sceneId: String(scene.sceneIndex),
          accumulatedMonotoneSeconds: Math.round(energyRunSeconds),
          suggestion,
          affectedField: 'energyLevel'
        })

        logger.info(
          `[PacingGuard] Monotone energy "${sceneEnergy}" ` +
          `for ${Math.round(energyRunSeconds)}s at scene ${scene.sceneIndex} → ${suggestion}`
        )

        // Annotate scene for downstream modules
        scene.isPatternInterrupt = true

        // Reset run counter so we don't flag every subsequent scene
        energyRunStart = i
        energyRunSeconds = scene.duration
      }
    } else {
      // Energy level changed — reset run
      currentEnergy = sceneEnergy
      energyRunStart = i
      energyRunSeconds = scene.duration
    }
  }

  // ── Step 3: Sliding window — detect monotone shotType stretches ───────────
  if (cfg.requireShotTypeVariety) {
    let shotRunSeconds = 0
    let currentShot: SceneShotType = scenes[0]?.shotType ?? 'medium'

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      const sceneShot = scene.shotType as SceneShotType

      if (sceneShot === currentShot) {
        shotRunSeconds += scene.duration

        if (shotRunSeconds > cfg.maxMonotoneShotSeconds) {
          // Suggest varying the next scene's shot type
          const suggestedNext = nextShotType(currentShot)

          issues.push({
            sceneId: String(scene.sceneIndex),
            accumulatedMonotoneSeconds: Math.round(shotRunSeconds),
            suggestion: 'vary_shot_type',
            affectedField: 'shotType'
          })

          logger.info(
            `[PacingGuard] Monotone shot "${currentShot}" ` +
            `for ${Math.round(shotRunSeconds)}s at scene ${scene.sceneIndex} ` +
            `→ suggest "${suggestedNext}" next`
          )

          // Annotate the NEXT scene (not the flagged one) with desired shotType
          // so context-query-gen biases the Tier A stock queries
          if (i + 1 < scenes.length) {
            const nextScene = scenes[i + 1]
            if (!nextScene.isPatternInterrupt) {
              nextScene.shotType = suggestedNext
              nextScene.isPatternInterrupt = true
            }
          }

          // Reset run counter
          shotRunSeconds = scene.duration
          // Keep currentShot unchanged so the NEXT annotation is accurate
        }
      } else {
        currentShot = sceneShot
        shotRunSeconds = scene.duration
      }
    }
  }

  // ── Step 4: Summary log ───────────────────────────────────────────────────
  const breakCount = scenes.filter((s) => s.isPatternInterrupt).length
  logger.info(
    `[PacingGuard] Analysis complete: ${issues.length} issues found, ` +
    `${breakCount} scenes annotated as pattern-interrupt candidates.`
  )

  return issues
}

// ─── Flatten helper (shared by planner.ts and renderer.ts) ───────────────────

/** Flatten all scenes from a Gemini-generated or algorithmic plan structure */
export function flattenPlanScenes(plan: {
  chapters: Array<{
    sequences?: Array<{ scenes?: PacingScene[] }>
    chapters_seq?: Array<{ scenes?: PacingScene[] }>
  }>
}): PacingScene[] {
  return plan.chapters.flatMap((ch) => {
    const seqs = ch.sequences ?? ch.chapters_seq ?? []
    return seqs.flatMap((seq) => seq.scenes ?? [])
  })
}
