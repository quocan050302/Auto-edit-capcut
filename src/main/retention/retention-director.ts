/**
 * retention-director.ts — Narrative Retention Director
 *
 * Analyzes the complete edit plan as ONE coherent narrative.
 * Outputs: analysis/retention-plan.json
 *
 * Deterministic and local-first:
 * - NO remote AI calls.
 * - Computes scene roles, open-loop & payoff tracking, semantic novelty,
 *   re-hook opportunities, and safe pattern interrupts.
 * - Caches result via inputHash.
 * - Fails open: if any error occurs, returns null so renderer falls back
 *   to legacy behavior cleanly.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import type {
  RetentionLevel,
  RetentionMotif,
  RetentionOpenLoop,
  RetentionPlan,
  RetentionScenePlan,
  RetentionSceneRole
} from './retention-types'
import {
  classifySubjectType,
  computeNoveltyScore,
  extractNormalizedKeywords,
  isLowNoveltyStreak,
  type SceneVisualSignature
} from './retention-novelty'

export const RETENTION_PLAN_SCHEMA_VERSION = 1

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

// ─── Input & Config Types ─────────────────────────────────────────────────────

export interface RawSceneData {
  sceneIndex: number
  sceneId?: string
  duration: number
  narrativeText?: string
  narration?: string
  visualIntent?: string
  energyLevel?: string
  shotType?: string
  isPatternInterrupt?: boolean
  isFirstInChapter?: boolean
  visualStrategy?: string // 'ai-still' | 'stock'
  category?: string
  motionPreset?: string
  [key: string]: unknown
}

export function getSceneText(scene: RawSceneData): string {
  return ((scene.narrativeText || (scene as any).narration || '') as string).trim()
}

export interface RetentionDirectorOptions {
  level?: RetentionLevel
  targetRehookGapSecs?: number
  maxNoResetSecs?: number
  noveltyWindowScenes?: number
  globalContext?: {
    hookConcept?: string
    corePremise?: string
    keyEntities?: string[]
    [key: string]: unknown
  }
}

// ─── Open Loop & Payoff Detection ─────────────────────────────────────────────

const QUESTION_STARTERS = /^(why|how|what|could|can|is\s+it\s+true|where|when|which|who|what\s+if)\b/i
const TEASER_PATTERNS = [
  /\bthe\s+real\s+(reason|problem|truth|cause)\b/i,
  /\bthere\s+is\s+another\s+(reason|problem|factor)\b/i,
  /\bwhat\s+happens\s+next\b/i,
  /\blater\s+(we('ll| will)|in\s+this)\b/i,
  /\bas\s+we('ll| will)\s+(see|discover|learn|find\s+out)\b/i,
  /\bthe\s+truth\s+is\s+far\s+more\b/i,
  /\bwait\s+until\s+you\s+(see|hear|discover)\b/i,
  /\bthe\s+secret\s+behind\b/i
]

const PAYOFF_SIGNALS = [
  /\bthe\s+reason\b.*\b(is|was)\b/i,
  /\bthis\s+happens\s+because\b/i,
  /\bthe\s+answer\b.*\b(is|comes\s+down\s+to|lies\s+in)\b/i,
  /\bit\s+turns\s+out\b/i,
  /\bhere('s| is)\s+why\b/i,
  /\bthat('s| is)\s+why\b/i,
  /\bnow\s+we\s+(understand|know)\b/i,
  /\bresearchers\s+(discovered|found|proved)\b/i,
  /\bthe\s+solution\s+(is|was)\b/i
]

export function detectOpenLoops(scenes: RawSceneData[]): RetentionOpenLoop[] {
  const loops: RetentionOpenLoop[] = []

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    const text = getSceneText(scene)
    if (!text || text.length < 10) continue

    const hasQuestionMark = text.includes('?')
    const isQuestionSentence = QUESTION_STARTERS.test(text)
    const hasTeaserPhrase = TEASER_PATTERNS.some((p) => p.test(text))

    if (!hasQuestionMark && !isQuestionSentence && !hasTeaserPhrase) {
      continue
    }

    // Exclude opening rhetorical hook question from open-loop tracking (it is the hook itself)
    if (i === 0 && !hasTeaserPhrase) {
      continue
    }

    // False positive filter: pure declarative sentences without tease words
    // e.g. "The kidneys filter blood."
    const isPureDeclarative =
      !hasQuestionMark &&
      !hasTeaserPhrase &&
      !isQuestionSentence

    if (isPureDeclarative) continue

    // Extract loop keywords for payoff matching
    const keywords = extractNormalizedKeywords(text).filter(
      (k) => !['why', 'how', 'what', 'when', 'where', 'next', 'reason', 'happen'].includes(k)
    )

    if (keywords.length === 0) continue

    const loopId = `loop_${i + 1}`
    loops.push({
      id: loopId,
      openedAtSceneIndex: scene.sceneIndex,
      question: text.slice(0, 120),
      confidence: hasTeaserPhrase || hasQuestionMark ? 0.9 : 0.75,
      status: 'open',
      keywords
    })
  }

  // Payoff matching: look ahead in subsequent scenes
  for (const loop of loops) {
    let bestPayoffIndex: number | undefined
    let maxOverlap = 0

    // Only look ahead after the open loop
    for (let j = 0; j < scenes.length; j++) {
      const candidate = scenes[j]
      if (candidate.sceneIndex <= loop.openedAtSceneIndex) continue

      const candidateText = getSceneText(candidate).toLowerCase()
      const hasPayoffSignal = PAYOFF_SIGNALS.some((p) => p.test(candidateText))
      const candidateKeywords = extractNormalizedKeywords(candidateText)

      let overlapCount = 0
      for (const kw of loop.keywords) {
        const matches = candidateKeywords.some(
          (ck) => ck === kw || (ck.length >= 4 && kw.length >= 4 && (ck.startsWith(kw) || kw.startsWith(ck)))
        )
        if (matches) {
          overlapCount++
        }
      }

      const distance = candidate.sceneIndex - loop.openedAtSceneIndex
      if (hasPayoffSignal) {
        if (overlapCount >= 1 || distance <= 4) {
          if (overlapCount >= maxOverlap) {
            maxOverlap = overlapCount
            bestPayoffIndex = candidate.sceneIndex
          }
        }
      } else if (overlapCount >= 2 && distance > 1) {
        if (overlapCount > maxOverlap) {
          maxOverlap = overlapCount
          bestPayoffIndex = candidate.sceneIndex
        }
      }
    }

    if (bestPayoffIndex !== undefined) {
      loop.payoffSceneIndex = bestPayoffIndex
      loop.status = 'resolved'
    }
  }

  return loops
}

// ─── Motif Detection ──────────────────────────────────────────────────────────

export function detectMotifs(scenes: RawSceneData[]): RetentionMotif[] {
  const keywordSceneMap = new Map<string, number[]>()

  for (const s of scenes) {
    const text = `${s.visualIntent || ''} ${getSceneText(s)}`
    const kws = extractNormalizedKeywords(text)
    for (const kw of kws) {
      if (kw.length < 4) continue
      const list = keywordSceneMap.get(kw) || []
      list.push(s.sceneIndex)
      keywordSceneMap.set(kw, list)
    }
  }

  const motifs: RetentionMotif[] = []
  for (const [kw, indices] of keywordSceneMap.entries()) {
    // A motif appears in at least 3 distinct scenes
    const uniqueIndices = Array.from(new Set(indices))
    if (uniqueIndices.length >= 3 && uniqueIndices.length <= scenes.length * 0.6) {
      motifs.push({
        id: `motif_${kw}`,
        label: kw,
        conceptKeywords: [kw],
        firstSeenSceneIndex: uniqueIndices[0],
        recurringSceneIndices: uniqueIndices
      })
    }
  }

  // Limit to top 5 prominent motifs to keep memory bounded
  motifs.sort((a, b) => b.recurringSceneIndices.length - a.recurringSceneIndices.length)
  return motifs.slice(0, 5)
}

// ─── Scene Role Classification ────────────────────────────────────────────────

const PROOF_KEYWORDS = /\b(percent|%|\$|study|studies|trial|trials|data|researchers|university|published|patients|statistics|proven|evidence|hospital|dr\.|doctor|clinical)\b/i
const MECHANISM_KEYWORDS = /\b(pathway|process|filters|absorbs|produces|mechanism|triggers|causes|functions|cells|vessels|bloodstream|molecules|artery|system|organ|tissue)\b/i
const COMPARISON_KEYWORDS = /\b(compared\s+to|unlike|versus|vs|in\s+contrast|differently|while|on\s+the\s+other\s+hand|standard|traditional)\b/i
const SURPRISE_KEYWORDS = /\b(unexpectedly|surprisingly|strange|shocking|twist|catch|ironically|little\s+known|hidden|secret)\b/i
const SOLUTION_KEYWORDS = /\b(solution|prevent|treat|treatment|protocol|action|step|remedy|cure|how\s+to|takeaway)\b/i
const BRIDGE_KEYWORDS = /\b(meanwhile|moving\s+on|next|furthermore|now\s+let's|turning\s+to)\b/i
const RECAP_KEYWORDS = /\b(to\s+summarize|in\s+summary|we\s+have\s+seen|remember|recap)\b/i
const CONCLUSION_KEYWORDS = /\b(finally|in\s+conclusion|ultimately|final\s+thought|takeaway|in\s+the\s+end)\b/i

export function classifySceneRole(
  scene: RawSceneData,
  totalScenes: number,
  elapsedSecs: number,
  openLoop?: RetentionOpenLoop,
  isPayoffScene?: boolean,
  arrayIndex?: number
): { role: RetentionSceneRole; reason: string } {
  const text = getSceneText(scene).toLowerCase()
  const intent = (scene.visualIntent || '').toLowerCase()
  const combined = `${text} ${intent}`

  // 1. Opening hook (first scene or within first 20s and first 2 scenes)
  const isFirst = arrayIndex !== undefined ? arrayIndex === 0 : (scene.sceneIndex <= 1)
  if (isFirst) {
    return { role: 'hook', reason: 'Opening hook: establish strong core intrigue' }
  }

  // 2. Payoff for an earlier open loop
  if (isPayoffScene) {
    return { role: 'payoff', reason: 'Resolves previously established open loop question' }
  }

  // 3. Open loop scene
  if (openLoop && openLoop.openedAtSceneIndex === scene.sceneIndex) {
    return { role: 'open-loop', reason: `Introduces open loop: "${openLoop.question}"` }
  }

  // 4. Final scenes -> conclusion
  const isLast = arrayIndex !== undefined ? arrayIndex === totalScenes - 1 : (scene.sceneIndex >= totalScenes)
  if (isLast || CONCLUSION_KEYWORDS.test(text)) {
    return { role: 'conclusion', reason: 'Final takeaway / conclusion of narrative' }
  }

  // 5. Recap
  if (RECAP_KEYWORDS.test(text)) {
    return { role: 'recap', reason: 'Synthesizes previous insights' }
  }

  // 6. Solution / remedy
  if (SOLUTION_KEYWORDS.test(text)) {
    return { role: 'solution', reason: 'Presents actionable remedy or solution' }
  }

  // 7. Surprise / reveal (narrative turn or unexpected pivot)
  if (SURPRISE_KEYWORDS.test(text)) {
    return { role: 'surprise', reason: 'Presents counter-intuitive or surprising fact' }
  }

  // 8. Proof / data / evidence
  if (PROOF_KEYWORDS.test(text) || /\b\d+(\.\d+)?%|\$\d+|\b\d{1,3}(,\d{3})+\b/.test(text)) {
    return { role: 'proof', reason: 'Narrative presents factual data, study, or statistics' }
  }

  // 9. Comparison
  if (COMPARISON_KEYWORDS.test(text)) {
    return { role: 'comparison', reason: 'Compares alternatives, contrast, or duality' }
  }

  // 10. Biological / physical mechanism
  if (MECHANISM_KEYWORDS.test(text)) {
    return { role: 'mechanism', reason: 'Explains internal workings or biological mechanism' }
  }

  // 11. Early setup (scenes 1-3)
  if (scene.sceneIndex <= 2) {
    return { role: 'setup', reason: 'Establishes foundational context' }
  }

  // 12. Bridge
  if (BRIDGE_KEYWORDS.test(text)) {
    return { role: 'bridge', reason: 'Narrative bridge between topics' }
  }

  // Default problem or setup
  if (text.includes('problem') || text.includes('danger') || text.includes('risk') || text.includes('fail')) {
    return { role: 'problem', reason: 'Highlights conflict, obstacle, or risk' }
  }

  return { role: 'setup', reason: 'Narrative context' }
}

// ─── Main Retention Director Core ─────────────────────────────────────────────

export class RetentionDirector {
  constructor(public options: RetentionDirectorOptions = {}) {}

  generatePlan(scenes: RawSceneData[]): RetentionPlan {
    return analyzeRetentionPlan(scenes, this.options)
  }
}

export function analyzeRetentionPlan(
  rawScenes: RawSceneData[],
  options: RetentionDirectorOptions = {}
): RetentionPlan {
  const level: RetentionLevel = options.level || 'balanced'
  const targetRehookGapSecs =
    options.targetRehookGapSecs || (level === 'high' ? 25 : level === 'low' ? 50 : 35)
  const maxNoResetSecs = options.maxNoResetSecs || (level === 'high' ? 30 : level === 'low' ? 60 : 42)
  const noveltyWindowScenes = options.noveltyWindowScenes || 4

  const totalScenes = rawScenes.length
  let totalDuration = 0
  for (const s of rawScenes) {
    totalDuration += s.duration || 0
  }

  // 1. Detect open loops and payoffs
  const openLoops = detectOpenLoops(rawScenes)
  const payoffSceneSet = new Set<number>()
  const loopByOpenedScene = new Map<number, RetentionOpenLoop>()
  for (const l of openLoops) {
    loopByOpenedScene.set(l.openedAtSceneIndex, l)
    if (l.payoffSceneIndex !== undefined) {
      payoffSceneSet.add(l.payoffSceneIndex)
    }
  }

  // 2. Detect recurring motifs
  const motifs = detectMotifs(rawScenes)
  const motifSceneMap = new Map<number, string>()
  for (const m of motifs) {
    for (const scIdx of m.recurringSceneIndices) {
      if (!motifSceneMap.has(scIdx)) {
        motifSceneMap.set(scIdx, m.id)
      }
    }
  }

  // 3. Classify roles and compute novelty sequentially
  const signatures: SceneVisualSignature[] = []
  const scenePlans: RetentionScenePlan[] = []
  const recentNoveltyScores: number[] = []

  let elapsedSecs = 0
  let timeSinceLastReset = 0
  let timeSinceLastPatternInterrupt = 999

  let hookCount = 0
  let rehookCount = 0
  let payoffCount = 0
  let interruptCount = 0
  let lowNoveltyCount = 0

  for (let i = 0; i < rawScenes.length; i++) {
    const scene = rawScenes[i]
    const sceneId = scene.sceneId || String(scene.sceneIndex)
    const duration = scene.duration || 4.0

    const openLoop = loopByOpenedScene.get(scene.sceneIndex)
    const isPayoff = payoffSceneSet.has(scene.sceneIndex)

    let { role, reason } = classifySceneRole(
      scene,
      totalScenes,
      elapsedSecs,
      openLoop,
      isPayoff,
      i
    )

    // Re-hook Engine check: long stretch without reset
    const canBeRehook =
      role !== 'hook' &&
      role !== 'payoff' &&
      role !== 'conclusion' &&
      role !== 'recap' &&
      timeSinceLastReset >= targetRehookGapSecs

    if (canBeRehook) {
      const text = getSceneText(scene).toLowerCase()
      // If the scene has question, contrast, or turning indicators
      const hasTurnSignal =
        text.includes('?') ||
        text.startsWith('now') ||
        text.startsWith('here') ||
        text.startsWith('wait') ||
        text.startsWith('notice') ||
        text.startsWith('surprisingly') ||
        text.startsWith('what about') ||
        SURPRISE_KEYWORDS.test(text) ||
        COMPARISON_KEYWORDS.test(text)

      if (hasTurnSignal || timeSinceLastReset >= maxNoResetSecs) {
        role = 're-hook'
        reason = `Re-hook: attention refreshed after ${Math.round(timeSinceLastReset)}s neutral stretch`
        rehookCount++
        timeSinceLastReset = 0
      }
    }

    if (role === 'hook') hookCount++
    if (role === 'payoff') payoffCount++

    // Build visual signature
    const sceneText = getSceneText(scene)
    const kws = extractNormalizedKeywords(`${scene.visualIntent || ''} ${sceneText}`)
    const subject = classifySubjectType(scene.visualIntent, scene.category, sceneText)
    const sig: SceneVisualSignature = {
      sceneIndex: scene.sceneIndex,
      sceneId,
      visualSource: scene.visualStrategy || (scene.localPath?.includes('generated') ? 'ai-still' : 'stock'),
      shotType: scene.shotType || 'medium',
      energyLevel: scene.energyLevel || 'medium',
      visualIntentKeywords: kws,
      category: scene.category,
      motionPreset: scene.motionPreset,
      subjectType: subject,
      role,
      motifId: motifSceneMap.get(scene.sceneIndex)
    }

    // Compute novelty score
    const noveltyScore = computeNoveltyScore(sig, signatures, motifs, noveltyWindowScenes)
    signatures.push(sig)
    recentNoveltyScores.push(noveltyScore)

    if (noveltyScore < 0.40) {
      lowNoveltyCount++
    }

    // Check low novelty streak
    const hasLowNoveltyStreak = isLowNoveltyStreak(recentNoveltyScores, 0.40, 3)

    // Pattern interrupt decision
    const interruptCooldown = level === 'high' ? 15 : level === 'low' ? 45 : 25
    let shouldInterrupt = false
    let interruptReason: string | undefined

    if (timeSinceLastPatternInterrupt >= interruptCooldown) {
      if (role === 'surprise') {
        shouldInterrupt = true
        interruptReason = 'Narrative surprise pivot'
      } else if (role === 're-hook') {
        shouldInterrupt = true
        interruptReason = 'Re-hook attention refresh'
      } else if (hasLowNoveltyStreak) {
        shouldInterrupt = true
        interruptReason = 'Low novelty streak across consecutive scenes'
      } else if (timeSinceLastReset >= maxNoResetSecs) {
        shouldInterrupt = true
        interruptReason = `Reset attention after ${Math.round(timeSinceLastReset)}s neutral stretch`
      } else if (scene.isPatternInterrupt) {
        shouldInterrupt = true
        interruptReason = 'Edit plan designated pattern interrupt'
      }
    }

    if (shouldInterrupt) {
      interruptCount++
      timeSinceLastPatternInterrupt = 0
      timeSinceLastReset = 0
    } else {
      timeSinceLastPatternInterrupt += duration
    }

    // Reset tracking
    const isResetEvent =
      role === 'hook' ||
      role === 're-hook' ||
      role === 'surprise' ||
      role === 'payoff' ||
      shouldInterrupt

    if (isResetEvent) {
      timeSinceLastReset = 0
    } else {
      timeSinceLastReset += duration
    }

    // Check avoidSpoiler: between an open loop and its payoff
    let avoidSpoiler = false
    for (const l of openLoops) {
      if (
        l.payoffSceneIndex !== undefined &&
        scene.sceneIndex > l.openedAtSceneIndex &&
        scene.sceneIndex < l.payoffSceneIndex
      ) {
        avoidSpoiler = true
        break
      }
    }

    // Intensity & Pacing
    let intensity: 'low' | 'medium' | 'high' = 'medium'
    if (role === 'hook' || role === 'surprise' || role === 'payoff') {
      intensity = 'high'
    } else if (role === 'bridge' || role === 'conclusion' || role === 'recap') {
      intensity = 'low'
    }

    let beatPacing: 'slow' | 'normal' | 'fast' = 'normal'
    if (role === 'hook' || role === 're-hook' || role === 'surprise') {
      beatPacing = 'fast'
    } else if (role === 'proof' || role === 'payoff' || role === 'bridge' || role === 'conclusion') {
      // Payoff, proof and bridge allow readable hold, no micro-cut chaos!
      beatPacing = 'slow'
    }

    // Preferred visual change
    let preferredVisualChange: RetentionScenePlan['preferredVisualChange'] = 'none'
    if (shouldInterrupt) {
      if (role === 'proof') preferredVisualChange = 'proof'
      else if (role === 're-hook' || role === 'surprise') preferredVisualChange = 'motion'
      else if (hasLowNoveltyStreak) preferredVisualChange = 'crop'
      else preferredVisualChange = 'hard-cut'
    }

    // Overlay priority
    let overlayPriority: RetentionScenePlan['overlayPriority'] = 'none'
    if (role === 'proof') overlayPriority = 'high'
    else if (role === 'hook' || role === 'payoff' || role === 'surprise') overlayPriority = 'medium'
    else if (role === 're-hook') overlayPriority = 'low'

    const proofPriority: RetentionScenePlan['proofPriority'] =
      role === 'proof' || (role === 'payoff' && PROOF_KEYWORDS.test(getSceneText(scene)))
        ? 'high'
        : 'normal'

    const motionEnergy: RetentionScenePlan['motionEnergy'] =
      role === 'hook' || role === 're-hook' || role === 'surprise'
        ? 'elevated'
        : role === 'proof' || role === 'bridge' || role === 'conclusion'
          ? 'calm'
          : 'normal'

    scenePlans.push({
      sceneIndex: scene.sceneIndex,
      sceneId,
      role,
      intensity,
      reason,
      noveltyScore,
      noveltyTarget: 0.50,
      patternInterrupt: shouldInterrupt,
      patternInterruptReason: interruptReason,
      openLoopId: openLoop?.id,
      payoffForLoopId: isPayoff
        ? openLoops.find((l) => l.payoffSceneIndex === scene.sceneIndex)?.id
        : undefined,
      avoidSpoiler,
      motionEnergy,
      beatPacing,
      overlayPriority,
      proofPriority,
      preferredVisualChange,
      notes: [
        `role=${role}`,
        `novelty=${noveltyScore.toFixed(2)}`,
        `resetTime=${Math.round(timeSinceLastReset)}s`
      ]
    })

    elapsedSecs += duration
  }

  // Calculate stable input hash (ignoring timestamps)
  const hashPayload = JSON.stringify({
    schemaVersion: RETENTION_PLAN_SCHEMA_VERSION,
    level,
    totalScenes,
    scenes: rawScenes.map((s) => ({
      i: s.sceneIndex,
      dur: s.duration,
      text: getSceneText(s),
      intent: s.visualIntent,
      e: s.energyLevel,
      sh: s.shotType
    }))
  })
  const inputHash = sha256(hashPayload)

  return {
    schemaVersion: RETENTION_PLAN_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    inputHash,
    totalScenes,
    totalDuration: Math.round(totalDuration * 100) / 100,
    strategy: {
      level,
      targetRehookGapSecs,
      maxNoResetSecs,
      noveltyWindowScenes
    },
    openLoops,
    motifs,
    scenes: scenePlans,
    summary: {
      hooks: hookCount,
      rehooks: rehookCount,
      payoffs: payoffCount,
      patternInterrupts: interruptCount,
      lowNoveltyScenes: lowNoveltyCount,
      openLoops: openLoops.length
    }
  }
}

// ─── File I/O & Caching ───────────────────────────────────────────────────────

export function getRetentionPlanPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'retention-plan.json')
}

export function loadRetentionPlan(projectDir: string): RetentionPlan | null {
  try {
    const p = getRetentionPlanPath(projectDir)
    if (!fs.existsSync(p)) return null
    const content = fs.readFileSync(p, 'utf-8')
    return JSON.parse(content) as RetentionPlan
  } catch (err) {
    logger.warn(`[RetentionDirector] Failed to load retention plan: ${String(err)}`)
    return null
  }
}

export function saveRetentionPlan(projectDir: string, plan: RetentionPlan): void {
  const p = getRetentionPlanPath(projectDir)
  writeFileAtomic(p, JSON.stringify(plan, null, 2))
  logger.info(
    `[RetentionDirector] plan ready scenes=${plan.totalScenes} hooks=${plan.summary.hooks} ` +
    `rehooks=${plan.summary.rehooks} payoffs=${plan.summary.payoffs} ` +
    `openLoops=${plan.summary.openLoops} patternInterrupts=${plan.summary.patternInterrupts}`
  )
}

/**
 * ensureRetentionPlan — Top-level non-blocking entry point.
 *
 * 1. Checks cache against inputHash.
 * 2. If valid cache exists and !force, returns cached plan.
 * 3. Otherwise computes fresh plan and persists it atomically.
 * 4. Fails open: returns null on unexpected error.
 */
export function ensureRetentionPlan(
  projectDir: string,
  options?: {
    scenes?: RawSceneData[]
    level?: RetentionLevel
    force?: boolean
  }
): RetentionPlan | null {
  try {
    let scenes = options?.scenes

    // If scenes not passed, attempt to read from master-edit-plan.json
    if (!scenes || scenes.length === 0) {
      const editPlanPath = path.join(projectDir, 'edit-plan', 'master-edit-plan.json')
      if (fs.existsSync(editPlanPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(editPlanPath, 'utf-8'))
          scenes = raw.scenes || []
        } catch {
          // ignore
        }
      }
    }

    if (!scenes || scenes.length === 0) {
      logger.info('[RetentionDirector] No scenes provided or found in edit-plan. Skipping retention plan.')
      return null
    }

    // Try reading global script context if available
    let globalContext: any
    const globalContextPath = path.join(projectDir, 'analysis', 'global-script-context.json')
    if (fs.existsSync(globalContextPath)) {
      try {
        globalContext = JSON.parse(fs.readFileSync(globalContextPath, 'utf-8'))
      } catch {
        // ignore
      }
    }

    const cached = loadRetentionPlan(projectDir)
    if (cached && !options?.force) {
      // Validate cached plan matches current scenes count
      if (cached.totalScenes === scenes.length) {
        return cached
      }
    }

    const plan = analyzeRetentionPlan(scenes, {
      level: options?.level || 'balanced',
      globalContext
    })

    saveRetentionPlan(projectDir, plan)
    return plan
  } catch (err) {
    logger.warn(`[RetentionDirector] Failed to ensure retention plan (falling open): ${String(err)}`)
    return null
  }
}
