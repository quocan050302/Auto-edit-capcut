/**
 * Multi-factor candidate ranking for stock media selection.
 * Pure scoring function — no I/O, no side effects.
 *
 * finalScore =
 *   semanticScore   × 0.50
 *   technicalScore  × 0.20
 *   compositionScore × 0.15
 *   durationScore   × 0.15
 *   - reusePenalty  0.30 (if already used)
 */

import type { StockSearchResult } from '../../../shared/types'

export interface ScoreContext {
  visualIntent: string
  narrationText: string
  sceneDurationSecs: number
  preferredAspectRatio: string  // e.g. '16:9'
  usedAssetIds: Set<string>
}

// ─── Semantic scoring ─────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
  )
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  a.forEach((token) => { if (b.has(token)) intersection++ })
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

function semanticScore(candidate: StockSearchResult, ctx: ScoreContext): number {
  const intentTokens = tokenize(ctx.visualIntent)
  const narrationTokens = tokenize(ctx.narrationText)
  const refTokens = new Set([...intentTokens, ...narrationTokens])

  const titleTokens = tokenize(candidate.title)
  const tagTokens = new Set(candidate.tags.flatMap((t) => t.toLowerCase().split(/\s+/)))
  const candidateTokens = new Set([...titleTokens, ...tagTokens])

  return Math.min(1, jaccardSimilarity(refTokens, candidateTokens) * 5)
}

// ─── Technical scoring ────────────────────────────────────────────────────────

function technicalScore(candidate: StockSearchResult): number {
  const minDim = Math.min(candidate.width, candidate.height)
  if (minDim >= 2160) return 1.0
  if (minDim >= 1080) return 0.9
  if (minDim >= 720) return 0.6
  return 0.3
}

// ─── Composition scoring (aspect ratio match) ─────────────────────────────────

function compositionScore(candidate: StockSearchResult, preferredAr: string): number {
  const [pw, ph] = preferredAr.split(':').map(Number)
  const preferred = pw / ph
  const actual = candidate.width / candidate.height

  if (!preferred || !actual) return 0.5
  const diff = Math.abs(preferred - actual) / preferred
  return Math.max(0, 1 - diff * 2)
}

// ─── Duration scoring (for video) ─────────────────────────────────────────────

function durationScore(candidate: StockSearchResult, sceneDuration: number): number {
  if (candidate.mediaType === 'photo') return 0.8 // photos are fine for any duration
  const clipDur = candidate.durationSecs ?? 0
  if (clipDur <= 0) return 0.4
  if (clipDur >= sceneDuration) return 1.0
  // Clip is shorter than scene — penalise proportionally (can loop, but not ideal)
  return Math.max(0.2, clipDur / sceneDuration)
}

// ─── Main scoring function ────────────────────────────────────────────────────

export function scoreCandidate(
  candidate: StockSearchResult,
  ctx: ScoreContext
): number {
  const sem = semanticScore(candidate, ctx) * 0.50
  const tech = technicalScore(candidate) * 0.20
  const comp = compositionScore(candidate, ctx.preferredAspectRatio) * 0.15
  const dur = durationScore(candidate, ctx.sceneDurationSecs) * 0.15
  const reuse = ctx.usedAssetIds.has(candidate.assetId) ? 0.30 : 0

  return Math.max(0, sem + tech + comp + dur - reuse)
}

export function rankCandidates(
  candidates: StockSearchResult[],
  ctx: ScoreContext
): Array<StockSearchResult & { score: number }> {
  return candidates
    .map((c) => ({ ...c, score: scoreCandidate(c, ctx) }))
    .sort((a, b) => b.score - a.score)
}
