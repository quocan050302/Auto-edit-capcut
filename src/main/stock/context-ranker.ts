/**
 * Context-Aware Ranker -- Phase 7
 *
 * Scores candidates using global + local + geographic + chapter + technical
 * dimensions (total 100 points), plus penalty system for wrong community,
 * wrong geography, negative keywords, repeated assets, etc.
 */

import type { StockSearchResult, GlobalScriptContext, ContextScoreBreakdown } from "../../../shared/types"

export interface ContextRankCtx {
  globalContext: GlobalScriptContext
  chapterTitle: string
  chapterPurpose: string
  narration: string
  visualIntent: string
  scenePurpose: string
  sceneDurationSecs: number
  preferredAspectRatio: string
  usedAssetIds: Set<string>
  preferredTimePeriod?: string
}

// ------ Scoring helpers -----------------------------------------------------

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2)
  )
}

function overlapScore(ref: Set<string>, candidate: Set<string>): number {
  if (ref.size === 0) return 0
  let hits = 0
  ref.forEach((t) => { if (candidate.has(t)) hits++ })
  return Math.min(1, hits / Math.max(1, Math.min(ref.size, 5)))
}

function candidateTokens(c: StockSearchResult): Set<string> {
  const titleTokens = tokenize(c.title)
  const tagTokens = new Set(c.tags.flatMap((t) => t.toLowerCase().split(/\s+/).filter((x) => x.length > 2)))
  return new Set([...titleTokens, ...tagTokens])
}

// ------ Dimension scorers (0-1 each) ----------------------------------------

function localRelevanceScore(c: StockSearchResult, ctx: ContextRankCtx): number {
  const refTokens = new Set([...tokenize(ctx.visualIntent), ...tokenize(ctx.narration)])
  return overlapScore(refTokens, candidateTokens(c))
}

function globalSubjectScore(c: StockSearchResult, ctx: ContextRankCtx): number {
  const anchors = new Set([
    ...ctx.globalContext.exactTopicAnchors,
    ...ctx.globalContext.contextualAnchors
  ].flatMap((a) => a.toLowerCase().split(/\s+/)))
  return overlapScore(anchors, candidateTokens(c))
}

function geographyScore(c: StockSearchResult, ctx: ContextRankCtx): number {
  const geos = [
    ctx.globalContext.geography.primaryCountry,
    ctx.globalContext.geography.primaryRegion,
    ...ctx.globalContext.geography.secondaryLocations
  ].filter(Boolean) as string[]

  if (geos.length === 0) return 0.5
  const geoTokens = new Set(geos.flatMap((g) => g.toLowerCase().split(/\s+/)))
  return overlapScore(geoTokens, candidateTokens(c))
}

function timePeriodScore(c: StockSearchResult, ctx: ContextRankCtx): number {
  const period = (ctx.preferredTimePeriod ?? ctx.globalContext.timeContext.primaryPeriod).toLowerCase()
  const tokens = candidateTokens(c)
  const modernTerms = new Set(["contemporary", "modern", "current", "today", "present"])
  const historicTerms = new Set(["historical", "vintage", "antique", "old", "century", "archival"])

  const isModerrn = period === "contemporary" || period === "modern"
  if (isModerrn && tokens.has("contemporary")) return 1
  if (!isModerrn && [...historicTerms].some((t) => tokens.has(t))) return 1
  if (isModerrn && [...historicTerms].some((t) => tokens.has(t))) return 0.2
  return 0.5 // neutral
}

function chapterPurposeScore(c: StockSearchResult, ctx: ContextRankCtx): number {
  const refTokens = new Set([...tokenize(ctx.chapterTitle), ...tokenize(ctx.chapterPurpose)])
  return overlapScore(refTokens, candidateTokens(c))
}

function technicalScore(c: StockSearchResult): number {
  const minDim = Math.min(c.width, c.height)
  if (minDim >= 2160) return 1.0
  if (minDim >= 1080) return 0.9
  if (minDim >= 720) return 0.6
  return 0.3
}

function compositionScore(c: StockSearchResult, preferredAr: string): number {
  const [pw, ph] = preferredAr.split(":").map(Number)
  const preferred = pw / ph
  const actual = c.width / c.height
  if (!preferred || !actual) return 0.5
  const diff = Math.abs(preferred - actual) / preferred
  return Math.max(0, 1 - diff * 2)
}

function durationScore(c: StockSearchResult, sceneDuration: number): number {
  if (c.mediaType === "photo") return 0.8
  const clipDur = c.durationSecs ?? 0
  if (clipDur <= 0) return 0.4
  if (clipDur >= sceneDuration) return 1.0
  return Math.max(0.2, clipDur / sceneDuration)
}

// ------ Penalty system -------------------------------------------------------

interface PenaltyResult {
  total: number
  reasons: string[]
}

function applyPenalties(c: StockSearchResult, ctx: ContextRankCtx): PenaltyResult {
  const reasons: string[] = []
  let total = 0
  const tokens = candidateTokens(c)

  // Wrong community (-60 each)
  for (const community of ctx.globalContext.communities) {
    for (const wrong of community.mustNotConfuseWith) {
      const wrongTokens = tokenize(wrong)
      if ([...wrongTokens].some((t) => tokens.has(t))) {
        total += 60
        reasons.push(`Wrong community: contains "${wrong}" (should be "${community.name}")`)
      }
    }
  }

  // Forbidden substitutions (-50)
  for (const forbidden of ctx.globalContext.forbiddenSubstitutions) {
    const fTokens = tokenize(forbidden)
    if ([...fTokens].filter((t) => t.length > 3).some((t) => tokens.has(t))) {
      total += 50
      reasons.push(`Forbidden substitution: ${forbidden}`)
    }
  }

  // Negative keywords (-30)
  for (const neg of ctx.globalContext.negativeKeywords) {
    const negTokens = tokenize(neg)
    if ([...negTokens].some((t) => tokens.has(t))) {
      total += 30
      reasons.push(`Negative keyword: ${neg}`)
    }
  }

  // Repeated asset (-20)
  if (ctx.usedAssetIds.has(c.assetId)) {
    total += 20
    reasons.push("Asset already used")
  }

  return { total, reasons }
}

// ------ Match label ---------------------------------------------------------

function getMatchLabel(score: number, penalties: number): ContextScoreBreakdown["matchLabel"] {
  const adjusted = score - penalties
  if (adjusted >= 80) return "STRONG_MATCH"
  if (adjusted >= 65) return "ACCEPTABLE"
  if (adjusted >= 50) return "ILLUSTRATIVE"
  return "REJECTED"
}

function getVisualTruthLabel(
  c: StockSearchResult,
  ctx: ContextRankCtx,
  localScore: number,
  globalScore: number
): ContextScoreBreakdown["visualTruthLabel"] {
  const tokens = candidateTokens(c)
  const hasExactAnchor = ctx.globalContext.exactTopicAnchors.some((a) =>
    a.toLowerCase().split(/\s+/).every((t) => tokens.has(t))
  )

  if (hasExactAnchor && localScore >= 0.5) return "EXACT_SUBJECT"
  if (globalScore >= 0.3 && localScore >= 0.3) return "CONTEXTUAL_MATCH"

  const isHistorical = ctx.globalContext.timeContext.historicalPeriods.length > 0
    && (tokens.has("historical") || tokens.has("vintage") || tokens.has("archival"))
  if (isHistorical) return "HISTORICAL"

  return "ILLUSTRATIVE"
}

// ------ Main scoring function (100-point scale) ------------------------------

export function scoreContextCandidate(
  candidate: StockSearchResult,
  ctx: ContextRankCtx
): ContextScoreBreakdown {
  const local = localRelevanceScore(candidate, ctx) * 30
  const global = globalSubjectScore(candidate, ctx) * 25
  const geo = geographyScore(candidate, ctx) * 15
  const time = timePeriodScore(candidate, ctx) * 10
  const chapter = chapterPurposeScore(candidate, ctx) * 10
  const tech = (technicalScore(candidate) * 0.6 + compositionScore(candidate, ctx.preferredAspectRatio) * 0.4) * 5
  const dur = durationScore(candidate, ctx.sceneDurationSecs)
  const sequenceContinuity = dur * 5

  const rawScore = local + global + geo + time + chapter + tech + sequenceContinuity
  const { total: penalties, reasons: penaltyReasons } = applyPenalties(candidate, ctx)
  const totalScore = Math.max(0, rawScore - penalties)

  const matchLabel = getMatchLabel(rawScore, penalties)
  const visualTruthLabel = getVisualTruthLabel(candidate, ctx, local / 30, global / 25)

  return {
    localRelevance: Math.round(local),
    globalSubjectRelevance: Math.round(global),
    geographyMatch: Math.round(geo),
    timePeriodMatch: Math.round(time),
    chapterPurposeMatch: Math.round(chapter),
    technicalQuality: Math.round(tech),
    sequenceContinuity: Math.round(sequenceContinuity),
    totalScore: Math.round(totalScore),
    penalties: -Math.round(penalties),
    penaltyReasons,
    matchLabel,
    visualTruthLabel
  }
}

export function rankContextCandidates(
  candidates: StockSearchResult[],
  ctx: ContextRankCtx
): Array<StockSearchResult & { contextScore: ContextScoreBreakdown }> {
  return candidates
    .map((c) => ({ ...c, contextScore: scoreContextCandidate(c, ctx) }))
    .filter((c) => c.contextScore.matchLabel !== "REJECTED")
    .sort((a, b) => b.contextScore.totalScore - a.contextScore.totalScore)
}
