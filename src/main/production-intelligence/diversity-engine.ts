import type { StockSearchResult } from '../../../shared/types'

export interface HistoricalAssignmentSummary {
  sceneIndex: number
  provider?: string
  assetId?: string
  creator?: string
  title?: string
  tags?: string[]
  downloadUrl?: string
  pageUrl?: string
  thumbnailUrl?: string
  isMotif?: boolean
  isLocked?: boolean
}

export function normalizeUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return ''
  try {
    const parsed = new URL(rawUrl.trim())
    // Strip common tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'h']
    trackingParams.forEach((p) => parsed.searchParams.delete(p))
    let path = parsed.pathname
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1)
    }
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}${parsed.search}`
  } catch {
    return rawUrl.trim().toLowerCase().replace(/\/+$/, '')
  }
}

export function areCandidatesDuplicate(a: StockSearchResult, b: StockSearchResult): boolean {
  if (a.provider === b.provider && a.assetId === b.assetId) return true

  const aPage = normalizeUrl(a.pageUrl)
  const bPage = normalizeUrl(b.pageUrl)
  if (aPage && bPage && aPage === bPage) return true

  const aDownload = normalizeUrl(a.downloadUrl)
  const bDownload = normalizeUrl(b.downloadUrl)
  if (aDownload && bDownload && aDownload === bDownload) return true

  const aThumb = normalizeUrl(a.thumbnailUrl)
  const bThumb = normalizeUrl(b.thumbnailUrl)
  if (aThumb && bThumb && aThumb === bThumb) return true

  return false
}

export function deduplicateCandidates(candidates: StockSearchResult[]): StockSearchResult[] {
  const result: StockSearchResult[] = []
  const seenIds = new Set<string>()
  const seenPages = new Set<string>()
  const seenDownloads = new Set<string>()
  const seenThumbs = new Set<string>()

  for (const c of candidates) {
    const idKey = `${c.provider}:${c.assetId}`
    const pageKey = normalizeUrl(c.pageUrl)
    const downloadKey = normalizeUrl(c.downloadUrl)
    const thumbKey = normalizeUrl(c.thumbnailUrl)

    if (seenIds.has(idKey)) continue
    if (pageKey && seenPages.has(pageKey)) continue
    if (downloadKey && seenDownloads.has(downloadKey)) continue
    if (thumbKey && seenThumbs.has(thumbKey)) continue

    seenIds.add(idKey)
    if (pageKey) seenPages.add(pageKey)
    if (downloadKey) seenDownloads.add(downloadKey)
    if (thumbKey) seenThumbs.add(thumbKey)

    result.push(c)
  }

  return result
}

function calculateJaccardSimilarity(wordsA: Set<string>, wordsB: Set<string>): number {
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let intersection = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++
  }
  const union = wordsA.size + wordsB.size - intersection
  return union > 0 ? intersection / union : 0
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

/**
 * Calculates diversity score (0..15) and reuse penalty (-30..0)
 * based on the history of previous scene assignments.
 */
export function calculateDiversityScoreAndPenalty(
  candidate: StockSearchResult,
  history: HistoricalAssignmentSummary[],
  isExemptMotif = false
): { diversityScore: number; reusePenalty: number; penaltyReasons: string[] } {
  let diversityScore = 15
  let reusePenalty = 0
  const penaltyReasons: string[] = []

  if (history.length === 0) {
    return { diversityScore, reusePenalty: 0, penaltyReasons }
  }

  const prevScene = history[history.length - 1]
  const prevPrevScene = history.length > 1 ? history[history.length - 2] : null

  // 1. Check if asset was already used in another scene
  const isReused = history.some(
    (h) =>
      (h.provider === candidate.provider && h.assetId === candidate.assetId) ||
      (h.downloadUrl && normalizeUrl(h.downloadUrl) === normalizeUrl(candidate.downloadUrl))
  )

  if (isReused) {
    if (isExemptMotif) {
      // Intentional motif or locked continuity — no penalty
    } else {
      reusePenalty = -25
      penaltyReasons.push(`Asset ${candidate.assetId} was already used in a previous scene`)
      diversityScore = Math.max(0, diversityScore - 10)
    }
  }

  // 2. Provider repetition penalty (3 consecutive scenes with same provider)
  if (
    prevScene?.provider === candidate.provider &&
    prevPrevScene?.provider === candidate.provider
  ) {
    reusePenalty = Math.max(-30, reusePenalty - 5)
    penaltyReasons.push(`Provider '${candidate.provider}' repeated for 3 consecutive scenes`)
    diversityScore = Math.max(0, diversityScore - 3)
  }

  // 3. Title & tag similarity with previous scene (framing/subject monotony)
  if (prevScene) {
    const candidateTokens = new Set([
      ...tokenize(candidate.title),
      ...candidate.tags.flatMap((t) => [...tokenize(t)])
    ])
    const prevTokens = new Set([
      ...tokenize(prevScene.title),
      ...(prevScene.tags ?? []).flatMap((t) => [...tokenize(t)])
    ])

    const similarity = calculateJaccardSimilarity(candidateTokens, prevTokens)
    if (similarity > 0.6) {
      reusePenalty = Math.max(-30, reusePenalty - 10)
      penaltyReasons.push(`High visual/metadata similarity (${Math.round(similarity * 100)}%) with previous scene`)
      diversityScore = Math.max(0, diversityScore - 5)
    } else if (similarity > 0.4) {
      diversityScore = Math.max(0, diversityScore - 2)
    }
  }

  // 4. Same creator repetition penalty
  if (prevScene?.creator && candidate.creator && prevScene.creator.toLowerCase() === candidate.creator.toLowerCase()) {
    reusePenalty = Math.max(-30, reusePenalty - 5)
    penaltyReasons.push(`Same creator '${candidate.creator}' repeated from previous scene`)
  }

  return {
    diversityScore: Math.max(0, Math.min(15, diversityScore)),
    reusePenalty: Math.max(-30, Math.min(0, reusePenalty)),
    penaltyReasons
  }
}
