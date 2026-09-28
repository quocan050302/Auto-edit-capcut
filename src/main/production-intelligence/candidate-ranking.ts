import { join } from 'path'
import type {
  StockSearchResult,
  StockCandidate,
  StockCandidateScore,
  GlobalScriptContext,
  StockSearchPlan
} from '../../../shared/types'
import {
  deduplicateCandidates,
  calculateDiversityScoreAndPenalty,
  HistoricalAssignmentSummary
} from './diversity-engine'
import { atomicWriteJson, readJsonSafe } from './json-store'
import { logger } from '../logger'

export interface CandidateScoringContext {
  narration: string
  visualIntent?: string
  searchPlan?: StockSearchPlan
  globalContext?: GlobalScriptContext | null
  chapterTitle?: string
  chapterPurpose?: string
  sceneDurationSecs: number
  preferredAspectRatio: string
  assignmentHistory: HistoricalAssignmentSummary[]
  isLocked?: boolean
  isMotif?: boolean
}

function tokenize(text?: string): Set<string> {
  if (!text) return new Set()
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  )
}

function tokenOverlap(ref: Set<string>, candidateTokens: Set<string>): number {
  if (ref.size === 0) return 0
  let hits = 0
  for (const t of ref) {
    if (candidateTokens.has(t)) hits++
  }
  return Math.min(1, hits / Math.max(1, Math.min(ref.size, 5)))
}

function extractCandidateTokens(c: StockSearchResult): Set<string> {
  const titleTokens = tokenize(c.title)
  const tagTokens = new Set(
    (c.tags ?? []).flatMap((t) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((x) => x.length > 2)
    )
  )
  return new Set([...titleTokens, ...tagTokens])
}

// 1. Local Relevance (max 30)
export function calculateLocalRelevance(
  c: StockSearchResult,
  narration: string,
  visualIntent?: string,
  searchPlan?: StockSearchPlan
): { score: number; reasons: string[]; rejectionReasons: string[] } {
  const cTokens = extractCandidateTokens(c)
  const reasons: string[] = []
  const rejectionReasons: string[] = []

  const refTokens = new Set([...tokenize(visualIntent), ...tokenize(narration)])
  const overlap = tokenOverlap(refTokens, cTokens)
  let score = overlap * 25

  if (searchPlan?.requiredTerms?.length) {
    const reqTokens = new Set(searchPlan.requiredTerms.flatMap((t) => [...tokenize(t)]))
    const reqOverlap = tokenOverlap(reqTokens, cTokens)
    if (reqOverlap > 0) {
      score += 5
      reasons.push('Matches required search terms')
    }
  } else if (overlap > 0.4) {
    score += 5
    reasons.push('High visual intent alignment')
  }

  // Check negative terms from search plan
  if (searchPlan?.negativeTerms?.length) {
    for (const neg of searchPlan.negativeTerms) {
      const negTokens = tokenize(neg)
      if ([...negTokens].some((t) => cTokens.has(t))) {
        rejectionReasons.push(`Contains negative term: ${neg}`)
        score = Math.max(0, score - 15)
      }
    }
  }

  return {
    score: Math.min(30, Math.round(score)),
    reasons,
    rejectionReasons
  }
}

// 2. Global Context Fit (max 20)
export function calculateGlobalContextFit(
  c: StockSearchResult,
  globalContext?: GlobalScriptContext | null
): { score: number; reasons: string[]; rejectionReasons: string[] } {
  if (!globalContext) {
    return { score: 14, reasons: ['Neutral global context (no AI script context)'], rejectionReasons: [] }
  }

  const cTokens = extractCandidateTokens(c)
  const reasons: string[] = []
  const rejectionReasons: string[] = []
  let score = 0

  // Primary subject & topic anchors (up to 10 pts)
  const anchors = new Set(
    [
      ...globalContext.exactTopicAnchors,
      ...globalContext.contextualAnchors,
      globalContext.primarySubject
    ].flatMap((a) => (a ? [...tokenize(a)] : []))
  )
  const anchorOverlap = tokenOverlap(anchors, cTokens)
  score += anchorOverlap * 10
  if (anchorOverlap > 0.3) {
    reasons.push('Matches central documentary subject')
  }

  // Geography match (up to 5 pts)
  const geos = [
    globalContext.geography.primaryCountry,
    globalContext.geography.primaryRegion,
    ...globalContext.geography.secondaryLocations
  ].filter(Boolean) as string[]
  if (geos.length > 0) {
    const geoTokens = new Set(geos.flatMap((g) => [...tokenize(g)]))
    const geoOverlap = tokenOverlap(geoTokens, cTokens)
    score += geoOverlap * 5
    if (geoOverlap > 0) {
      reasons.push('Consistent with target region/geography')
    }
  } else {
    score += 3
  }

  // Time period match (up to 5 pts)
  const period = (globalContext.timeContext.primaryPeriod || '').toLowerCase()
  const isModern = period.includes('modern') || period.includes('contemporary') || period.includes('current')
  const historicTokens = new Set(['vintage', 'historical', 'antique', 'archival', 'century', 'retro', 'black and white'])
  const hasHistoric = [...historicTokens].some((t) => cTokens.has(t))

  if (isModern) {
    if (hasHistoric) {
      score += 1
      rejectionReasons.push('Historic imagery in contemporary context')
    } else {
      score += 5
    }
  } else if (period) {
    if (hasHistoric) {
      score += 5
      reasons.push('Authentic historical aesthetic match')
    } else {
      score += 3
    }
  } else {
    score += 4
  }

  // Forbidden substitutions check
  for (const forbidden of globalContext.forbiddenSubstitutions ?? []) {
    const fTokens = tokenize(forbidden)
    if ([...fTokens].filter((t) => t.length > 3).some((t) => cTokens.has(t))) {
      rejectionReasons.push(`Violates forbidden substitution: "${forbidden}"`)
      score = Math.max(0, score - 15)
    }
  }

  // Negative keywords check
  for (const neg of globalContext.negativeKeywords ?? []) {
    const nTokens = tokenize(neg)
    if ([...nTokens].some((t) => cTokens.has(t))) {
      rejectionReasons.push(`Matches global negative keyword: "${neg}"`)
      score = Math.max(0, score - 10)
    }
  }

  return {
    score: Math.max(0, Math.min(20, Math.round(score))),
    reasons,
    rejectionReasons
  }
}

// 3. Chapter Context Fit (max 10)
export function calculateChapterContextFit(
  c: StockSearchResult,
  chapterTitle?: string,
  chapterPurpose?: string
): { score: number; reasons: string[] } {
  if (!chapterTitle && !chapterPurpose) {
    return { score: 7, reasons: [] }
  }

  const cTokens = extractCandidateTokens(c)
  const chapterTokens = new Set([...tokenize(chapterTitle), ...tokenize(chapterPurpose)])
  const overlap = tokenOverlap(chapterTokens, cTokens)
  const score = Math.round(Math.max(4, overlap * 10))

  const reasons: string[] = []
  if (overlap > 0.3) {
    reasons.push(`Supports chapter theme "${chapterTitle ?? ''}"`)
  }

  return { score: Math.min(10, score), reasons }
}

// 4. Technical Quality (max 10)
export function calculateTechnicalQuality(c: StockSearchResult): { score: number; reasons: string[] } {
  const minDim = Math.min(c.width, c.height)
  let score = 5
  const reasons: string[] = []

  if (minDim >= 2160) {
    score = 10
    reasons.push('4K UHD resolution')
  } else if (minDim >= 1080) {
    score = 9
    reasons.push('Full HD 1080p resolution')
  } else if (minDim >= 720) {
    score = 7
    reasons.push('HD 720p resolution')
  } else if (minDim >= 480) {
    score = 4
  } else {
    score = 2
  }

  return { score, reasons }
}

// 5. Motion Suitability (max 10) - based on duration suitability, media type, and preview availability
export function calculateMotionSuitability(
  c: StockSearchResult,
  sceneDurationSecs: number
): { score: number; reasons: string[] } {
  let score = 5
  const reasons: string[] = []

  if (c.mediaType === 'video') {
    const clipDur = c.durationSecs ?? 0
    if (clipDur >= sceneDurationSecs) {
      score = 10
      reasons.push(`Video clip duration (${clipDur}s) covers scene length (${sceneDurationSecs}s)`)
    } else if (clipDur > 0) {
      score = Math.max(6, Math.round(7 * (clipDur / sceneDurationSecs)))
      reasons.push(`Video clip duration (${clipDur}s)`)
    } else {
      score = 7
    }
  } else {
    // Photo suitability (works with Ken Burns / photo parallax)
    score = 6
    reasons.push('High-res photo suitable for motion pan/zoom')
  }

  if (c.previewUrl) {
    score = Math.min(10, score + 1)
  }

  return { score: Math.min(10, score), reasons }
}

// 6. Aspect Ratio Fit (max 5)
export function calculateAspectRatioFit(
  c: StockSearchResult,
  preferredAspectRatio: string
): { score: number; reasons: string[] } {
  const [pw, ph] = preferredAspectRatio.split(':').map(Number)
  const target = pw && ph ? pw / ph : 16 / 9
  const actual = c.width && c.height ? c.width / c.height : target
  const diff = Math.abs(target - actual) / target

  let score = 5
  const reasons: string[] = []
  if (diff < 0.05) {
    score = 5
    reasons.push(`Exact aspect ratio match (${preferredAspectRatio})`)
  } else if (diff < 0.25) {
    score = 4
  } else if (diff < 0.5) {
    score = 3
  } else {
    score = 1
  }

  return { score, reasons }
}

/**
 * 100-point total score computation for a single candidate.
 */
export function scoreStockCandidate(
  c: StockSearchResult,
  ctx: CandidateScoringContext
): StockCandidateScore {
  const local = calculateLocalRelevance(c, ctx.narration, ctx.visualIntent, ctx.searchPlan)
  const global = calculateGlobalContextFit(c, ctx.globalContext)
  const chapter = calculateChapterContextFit(c, ctx.chapterTitle, ctx.chapterPurpose)
  const tech = calculateTechnicalQuality(c)
  const motion = calculateMotionSuitability(c, ctx.sceneDurationSecs)
  const aspect = calculateAspectRatioFit(c, ctx.preferredAspectRatio)
  const diversity = calculateDiversityScoreAndPenalty(c, ctx.assignmentHistory, ctx.isMotif || ctx.isLocked)

  const positiveSubtotal =
    local.score +
    global.score +
    chapter.score +
    tech.score +
    motion.score +
    aspect.score +
    diversity.diversityScore

  const totalScore = Math.max(0, Math.min(100, positiveSubtotal + diversity.reusePenalty))

  const allReasons = [
    ...local.reasons,
    ...global.reasons,
    ...chapter.reasons,
    ...tech.reasons,
    ...motion.reasons,
    ...aspect.reasons
  ]

  const allRejections = [
    ...local.rejectionReasons,
    ...global.rejectionReasons,
    ...diversity.penaltyReasons
  ]

  return {
    localRelevance: local.score,
    globalContextFit: global.score,
    chapterContextFit: chapter.score,
    technicalQuality: tech.score,
    motionSuitability: motion.score,
    aspectRatioFit: aspect.score,
    diversityScore: diversity.diversityScore,
    reusePenalty: diversity.reusePenalty,
    totalScore,
    reasons: Array.from(new Set(allReasons)),
    rejectionReasons: Array.from(new Set(allRejections))
  }
}

/**
 * Aggregate search results, deduplicate, score, and rank top candidates.
 */
export function rankCandidatesForScene(
  sceneId: string,
  sceneIndex: number,
  candidates: StockSearchResult[],
  ctx: CandidateScoringContext,
  maxCandidates = 3
): StockCandidate[] {
  const deduped = deduplicateCandidates(candidates)

  const scored: StockCandidate[] = deduped.map((result) => {
    const score = scoreStockCandidate(result, ctx)
    const isRejected = score.rejectionReasons.length > 0 && score.totalScore < 30
    return {
      candidateId: `${sceneId}_${result.provider}_${result.assetId}`,
      sceneId,
      sceneIndex,
      result,
      score,
      rank: 0,
      selected: false,
      approved: false,
      rejected: isRejected
    }
  })

  // Sort by totalScore desc; unrejected first
  scored.sort((a, b) => {
    if (a.rejected !== b.rejected) return a.rejected ? 1 : -1
    return b.score.totalScore - a.score.totalScore
  })

  // Assign ranks
  const top = scored.slice(0, maxCandidates)
  top.forEach((c, idx) => {
    c.rank = idx + 1
    if (idx === 0 && !c.rejected) {
      c.selected = true
    }
  })

  return top
}

// ── Persistence for stock-candidates.json ───────────────────────────────────

export type ProjectCandidatesStore = Record<string, StockCandidate[]>

export function getCandidatesStorePath(projectDir: string): string {
  return join(projectDir, 'analysis', 'stock-candidates.json')
}

export function loadStockCandidates(projectDir: string): ProjectCandidatesStore {
  const filePath = getCandidatesStorePath(projectDir)
  return readJsonSafe<ProjectCandidatesStore>(filePath, {})
}

export function saveStockCandidates(
  projectDir: string,
  data: ProjectCandidatesStore
): boolean {
  const filePath = getCandidatesStorePath(projectDir)
  return atomicWriteJson(filePath, data)
}
