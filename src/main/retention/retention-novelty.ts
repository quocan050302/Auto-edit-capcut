/**
 * retention-novelty.ts — Semantic Visual Novelty Engine
 *
 * Computes deterministic, lightweight visual signatures and novelty scores
 * across consecutive scenes (default window: 4 scenes).
 *
 * No external computer vision or remote embedding API calls required.
 * Pure local-first, deterministic calculation.
 */

import type { RetentionMotif, RetentionSceneRole } from './retention-types'

export interface SceneVisualSignature {
  sceneIndex: number
  sceneId: string
  visualSource?: 'ai-still' | 'stock' | 'manual-ai' | 'auto' | string
  mediaKind?: 'image' | 'video'
  shotType?: string
  energyLevel?: string
  visualIntentKeywords: string[]
  category?: string // health category or prompt category
  motionPreset?: string
  subjectType?: 'human' | 'anatomy' | 'object' | 'environment' | 'data' | 'conceptual' | 'unknown'
  role?: RetentionSceneRole
  motifId?: string
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'in', 'on', 'at', 'of', 'for', 'with', 'by', 'about', 'against',
  'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to',
  'from', 'up', 'down', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have',
  'has', 'had', 'do', 'does', 'did', 'and', 'but', 'if', 'or', 'because', 'as',
  'until', 'while', 'this', 'that', 'these', 'those', 'it', 'its', 'show', 'showing',
  'shot', 'view', 'close', 'up', 'scene', 'visual', 'cinematic', 'high', 'quality',
  'you', 'your', 'we', 'our', 'us', 'they', 'them', 'their', 'he', 'him', 'his', 'she', 'her',
  'now', 'right', 'here', 'there', 'just', 'even', 'also', 'any', 'all', 'some', 'many', 'much',
  'more', 'most', 'very', 'really', 'however', 'furthermore', 'what', 'why', 'how', 'when',
  'where', 'which', 'who', 'whose', 'whom', 'can', 'could', 'will', 'would', 'should',
  'may', 'might', 'must', 'without', 'well', 'like'
])

export function extractNormalizedKeywords(text?: string): string[] {
  if (!text || typeof text !== 'string') return []
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))

  return Array.from(new Set(tokens))
}

export function classifySubjectType(
  visualIntent?: string,
  category?: string,
  narrativeText?: string
): SceneVisualSignature['subjectType'] {
  const combined = `${category || ''} ${visualIntent || ''} ${narrativeText || ''}`.toLowerCase()

  if (
    combined.includes('anatomy') ||
    combined.includes('organ') ||
    combined.includes('kidney') ||
    combined.includes('heart') ||
    combined.includes('liver') ||
    combined.includes('artery') ||
    combined.includes('blood') ||
    combined.includes('cell') ||
    combined.includes('neuron') ||
    combined.includes('tissue') ||
    combined.includes('vessel') ||
    combined.includes('microscopic')
  ) {
    return 'anatomy'
  }

  if (
    combined.includes('person') ||
    combined.includes('doctor') ||
    combined.includes('patient') ||
    combined.includes('man') ||
    combined.includes('woman') ||
    combined.includes('face') ||
    combined.includes('hand') ||
    combined.includes('worker') ||
    combined.includes('lifestyle') ||
    combined.includes('human')
  ) {
    return 'human'
  }

  if (
    combined.includes('data') ||
    combined.includes('chart') ||
    combined.includes('graph') ||
    combined.includes('study') ||
    combined.includes('stat') ||
    combined.includes('evidence') ||
    combined.includes('percentage') ||
    combined.includes('number')
  ) {
    return 'data'
  }

  if (
    combined.includes('landscape') ||
    combined.includes('hospital') ||
    combined.includes('clinic') ||
    combined.includes('room') ||
    combined.includes('city') ||
    combined.includes('outdoor') ||
    combined.includes('nature') ||
    combined.includes('environment')
  ) {
    return 'environment'
  }

  if (
    combined.includes('pill') ||
    combined.includes('bottle') ||
    combined.includes('food') ||
    combined.includes('equipment') ||
    combined.includes('machine') ||
    combined.includes('tool') ||
    combined.includes('object')
  ) {
    return 'object'
  }

  if (combined.includes('conceptual') || combined.includes('mechanism')) {
    return 'conceptual'
  }

  return 'unknown'
}

function computeKeywordJaccard(kw1: string[], kw2: string[]): number {
  if (kw1.length === 0 || kw2.length === 0) return 0
  const set1 = new Set(kw1)
  const set2 = new Set(kw2)
  let intersection = 0
  for (const w of set1) {
    if (set2.has(w)) intersection++
  }
  const union = set1.size + set2.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * Calculates similarity between two scene signatures in range [0, 1].
 */
export function computeSignatureSimilarity(
  current: SceneVisualSignature,
  previous: SceneVisualSignature,
  isIntentionalMotif: boolean = false
): number {
  let sim = 0

  // 1. Source similarity (AI still vs Stock) — max 0.15
  if (current.visualSource && previous.visualSource && current.visualSource === previous.visualSource) {
    sim += 0.15
  }

  // 2. Shot type similarity — max 0.20
  if (current.shotType && previous.shotType && current.shotType.toLowerCase() === previous.shotType.toLowerCase()) {
    sim += 0.20
  }

  // 3. Category / subject similarity — max 0.30
  const sameCategory = Boolean(
    current.category &&
    previous.category &&
    current.category.toLowerCase() === previous.category.toLowerCase()
  )
  const sameSubject = Boolean(
    current.subjectType &&
    previous.subjectType &&
    current.subjectType !== 'unknown' &&
    current.subjectType === previous.subjectType
  )

  let categorySim = sameCategory ? 0.30 : sameSubject ? 0.20 : 0
  if (isIntentionalMotif && (sameCategory || sameSubject)) {
    // If it's an intentional motif recurring, reduce category repetition penalty by 60%
    categorySim *= 0.4
  }
  sim += categorySim

  // 4. Normalized keyword Jaccard overlap — max 0.25
  const kwOverlap = computeKeywordJaccard(current.visualIntentKeywords, previous.visualIntentKeywords)
  sim += kwOverlap * (isIntentionalMotif ? 0.12 : 0.25)

  // 5. Motion preset similarity — max 0.10
  if (
    current.motionPreset &&
    previous.motionPreset &&
    current.motionPreset === previous.motionPreset
  ) {
    sim += 0.10
  }

  // Maximum similarity is capped at 0.88 to allow residual baseline novelty on initial repeat
  return Math.min(0.88, Math.max(0.0, sim))
}

/**
 * Computes novelty score for current scene compared to previous scenes.
 * Range: 0.0 (highly repetitive) to 1.0 (strongly novel).
 */
export function computeNoveltyScore(
  current: SceneVisualSignature,
  recentHistory: SceneVisualSignature[],
  motifsOrWindowSize: RetentionMotif[] | number = [],
  windowSizeOpt: number = 4
): number {
  if (recentHistory.length === 0) {
    return 1.0
  }

  let motifs: RetentionMotif[] = []
  let windowSize = 4

  if (typeof motifsOrWindowSize === 'number') {
    windowSize = motifsOrWindowSize
  } else if (Array.isArray(motifsOrWindowSize)) {
    motifs = motifsOrWindowSize
    windowSize = windowSizeOpt
  }

  const window = recentHistory.slice(-windowSize)
  const weights = [0.45, 0.25, 0.18, 0.12].slice(0, window.length)

  // Align weights so the most recent scene has highest weight
  let totalWeight = 0
  let weightedDistanceSum = 0
  let highSimStreak = 0

  for (let idx = 0; idx < window.length; idx++) {
    const prev = window[window.length - 1 - idx] // scene i-1, i-2, etc.
    const weight = weights[idx] || 0.1

    // Check if current scene and prev scene share an intentional motif
    const isMotif = Boolean(
      (current.motifId && prev.motifId && current.motifId === prev.motifId) ||
      (current.motifId && motifs.some((m) => m.id === current.motifId && m.recurringSceneIndices.includes(prev.sceneIndex))) ||
      (current.motifId && (prev.category === current.category || prev.visualIntentKeywords.some((kw) => current.motifId?.includes(kw))))
    )

    const similarity = computeSignatureSimilarity(current, prev, isMotif)
    if (similarity >= 0.50) {
      highSimStreak++
    }

    const distance = 1.0 - similarity
    weightedDistanceSum += distance * weight
    totalWeight += weight
  }

  let score = totalWeight > 0 ? weightedDistanceSum / totalWeight : 1.0

  // Attention fatigue: as consecutive similar scenes accumulate in window, decrease novelty
  if (highSimStreak >= 2) {
    const fatiguePenalty = (highSimStreak - 1) * 0.04
    score = Math.max(0.01, score - fatiguePenalty)
  }

  return Math.round(score * 100) / 100
}

/**
 * Checks if a scene falls in a low novelty streak (e.g. 3+ consecutive scenes with novelty < threshold).
 */
export function isLowNoveltyStreak(
  noveltyScores: number[],
  minStreakOrThreshold: number = 3,
  thresholdOrMinStreak?: number
): boolean {
  let minStreak = 3
  let threshold = 0.40

  if (thresholdOrMinStreak !== undefined) {
    if (minStreakOrThreshold >= 1 && Number.isInteger(minStreakOrThreshold) && thresholdOrMinStreak < 1) {
      minStreak = minStreakOrThreshold
      threshold = thresholdOrMinStreak
    } else {
      threshold = minStreakOrThreshold
      minStreak = thresholdOrMinStreak
    }
  } else {
    if (minStreakOrThreshold < 1) {
      threshold = minStreakOrThreshold
    } else {
      minStreak = minStreakOrThreshold
    }
  }

  if (noveltyScores.length < minStreak) return false
  const lastN = noveltyScores.slice(-minStreak)
  return lastN.every((s) => s < threshold)
}
