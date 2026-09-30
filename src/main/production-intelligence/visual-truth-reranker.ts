import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'
import { spawn } from 'child_process'
import { GoogleGenAI } from '@google/genai'
import type {
  StockCandidate,
  StockSearchResult,
  VisualTruthVerification,
  VisualTruthLabel,
  VisualTruthWeights,
  GlobalScriptContext,
  SceneContextPacket,
  ClaimEvidenceLedger,
  ProductionIntelligenceSettings
} from '../../../shared/types'
import { DEFAULT_VISUAL_TRUTH_WEIGHTS } from '../../../shared/types'
import { atomicWriteJson, readJsonSafe } from './json-store'
import { logger } from '../logger'
import { normalizeApiKey } from '../utils/api-key'
import { getAvailableModelsForTask } from '../ai/model-router'
import { classifyGeminiErrorKind, recordModelFailure, recordModelSuccess } from '../ai/model-health'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegStatic: string = require('ffmpeg-static')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobeStatic: { path: string } = require('ffprobe-static')

export const VISUAL_TRUTH_ANALYSIS_VERSION = '1.0.0'

export interface VisualTruthStore {
  version: string
  updatedAt: string
  verifications: Record<string, VisualTruthVerification> // keyed by cacheKey
}

export function getVisualTruthStorePath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'visual-truth.json')
}

export function loadVisualTruthStore(projectDir: string): VisualTruthStore {
  const filePath = getVisualTruthStorePath(projectDir)
  return readJsonSafe<VisualTruthStore>(filePath, {
    version: VISUAL_TRUTH_ANALYSIS_VERSION,
    updatedAt: new Date().toISOString(),
    verifications: {}
  })
}

export function saveVisualTruthStore(projectDir: string, store: VisualTruthStore): void {
  const filePath = getVisualTruthStorePath(projectDir)
  store.updatedAt = new Date().toISOString()
  atomicWriteJson(filePath, store)
}

export function generateVerificationCacheKey(
  candidateId: string,
  sceneVisualIntent: string,
  globalContextHash: string
): string {
  const intentHash = crypto.createHash('md5').update(sceneVisualIntent.trim()).digest('hex').slice(0, 10)
  return `${candidateId}_${intentHash}_${globalContextHash}_${VISUAL_TRUTH_ANALYSIS_VERSION}`
}

// ─── Circuit Breaker for Vision API ──────────────────────────────────────────

class VisionCircuitBreaker {
  private failureCount = 0
  private lastFailureTime = 0
  private readonly threshold = 3
  private readonly cooldownMs = 60000 // 1 minute cooldown

  public isOpen(): boolean {
    if (this.failureCount >= this.threshold) {
      if (Date.now() - this.lastFailureTime > this.cooldownMs) {
        // Half-open: allow one retry
        return false
      }
      return true
    }
    return false
  }

  public recordFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()
  }

  public recordSuccess(): void {
    this.failureCount = 0
  }
}

export const visionCircuitBreaker = new VisionCircuitBreaker()

// ─── Frame Extraction via FFmpeg ────────────────────────────────────────────

export interface ExtractedFrames {
  tempDir: string
  frameBase64List: string[]
  cleanup: () => void
}

/**
 * Downloads media preview safely with timeout to local disk
 */
async function downloadPreviewTemp(url: string, destPath: string, timeoutMs = 8000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return false
    const buffer = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(destPath, buffer)
    return true
  } catch (err) {
    clearTimeout(timer)
    return false
  }
}

/**
 * Probes video duration using ffprobe
 */
async function probeDuration(filePath: string): Promise<number> {
  if (!ffprobeStatic?.path || !fs.existsSync(filePath)) return 0

  return new Promise((resolve) => {
    const proc = spawn(
      ffprobeStatic.path,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath
      ],
      { windowsHide: true }
    )

    let stdout = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        const dur = parseFloat(stdout.trim())
        resolve(dur > 0 ? dur : 0)
      } else {
        resolve(0)
      }
    })
    proc.on('error', () => resolve(0))
  })
}

/**
 * Extracts up to maxFrames (default 3) representative frames from video at ~20%, ~50%, ~80%
 */
export async function extractCandidateFrames(
  candidate: StockSearchResult,
  maxFrames = 3
): Promise<ExtractedFrames | null> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtruth_'))
  const cleanup = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    } catch {
      /* ignore */
    }
  }

  try {
    const isImage = candidate.mediaType === 'photo'
    const mediaUrl = candidate.previewUrl || candidate.thumbnailUrl || candidate.downloadUrl
    if (!mediaUrl) {
      cleanup()
      return null
    }

    const localTemp = path.join(tempDir, isImage ? 'preview.jpg' : 'preview.mp4')
    const ok = await downloadPreviewTemp(mediaUrl, localTemp)
    if (!ok || !fs.existsSync(localTemp) || fs.statSync(localTemp).size === 0) {
      cleanup()
      return null
    }

    if (isImage) {
      const b64 = fs.readFileSync(localTemp).toString('base64')
      return { tempDir, frameBase64List: [b64], cleanup }
    }

    // Video: probe duration
    let duration = candidate.durationSecs || 0
    if (duration <= 0) {
      duration = await probeDuration(localTemp)
    }
    if (duration <= 0) duration = 5 // fallback duration

    // Timestamps at 20%, 50%, 80% (avoiding black first/last frame)
    const timestamps: number[] = []
    if (maxFrames === 1) {
      timestamps.push(duration * 0.5)
    } else if (maxFrames === 2) {
      timestamps.push(Math.max(0.3, duration * 0.3), Math.max(0.6, duration * 0.7))
    } else {
      timestamps.push(
        Math.max(0.3, duration * 0.2),
        Math.max(0.6, duration * 0.5),
        Math.min(duration - 0.3, duration * 0.8)
      )
    }

    const frameBase64List: string[] = []

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i]
      const framePath = path.join(tempDir, `frame_${i}.jpg`)

      await new Promise<void>((resolve) => {
        if (!ffmpegStatic) {
          resolve()
          return
        }
        const p = spawn(
          ffmpegStatic,
          [
            '-y',
            '-ss', String(ts),
            '-i', localTemp,
            '-vframes', '1',
            '-vf', 'scale=640:-1',
            '-q:v', '4',
            framePath
          ],
          { windowsHide: true }
        )
        p.on('close', () => resolve())
        p.on('error', () => resolve())
      })

      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 100) {
        frameBase64List.push(fs.readFileSync(framePath).toString('base64'))
      }
    }

    if (frameBase64List.length === 0) {
      cleanup()
      return null
    }

    return { tempDir, frameBase64List, cleanup }
  } catch (err) {
    cleanup()
    return null
  }
}

// ─── Score Calculation & Clamping ───────────────────────────────────────────

export function clampScore(val: unknown, min = 0, max = 100): number {
  const num = Number(val)
  if (isNaN(num)) return min
  return Math.min(max, Math.max(min, Math.round(num)))
}

export function computeCombinedVisualTruthScore(
  metadataScore: number,
  verification: VisualTruthVerification,
  weights: VisualTruthWeights = DEFAULT_VISUAL_TRUTH_WEIGHTS
): { finalScore: number; breakdown: Record<string, number> } {
  // Normalize metadata score to 0..100
  const meta = clampScore(metadataScore, 0, 100)

  // Visual Verification score is composed of matches
  const visualVerificationScore = clampScore(
    verification.subjectMatch * 0.3 +
    verification.actionMatch * 0.3 +
    verification.visualIntentMatch * 0.2 +
    verification.narrationMatch * 0.2
  )

  const weightedSum =
    meta * weights.metadataRelevance +
    visualVerificationScore * weights.visualVerification +
    clampScore(verification.geographyMatch) * weights.globalContext +
    clampScore(verification.actionMatch) * weights.actionMatch +
    clampScore(verification.sequenceContinuity) * weights.sequenceContinuity +
    clampScore(verification.technicalQuality) * weights.technicalQuality

  let penalty = 0
  if (verification.genericStockRisk > 60) {
    penalty += (verification.genericStockRisk / 100) * weights.genericStockPenalty
  }
  if (verification.contradictionRisk > 40) {
    penalty += (verification.contradictionRisk / 100) * weights.contradictionPenalty
  }

  // Documentary Evidence Value bonus if relevant evidence is present
  const evidenceBonus = (verification.documentaryEvidenceValue / 100) * 10

  const rawFinal = weightedSum - penalty + evidenceBonus
  const finalScore = clampScore(rawFinal, 0, 100)

  return {
    finalScore,
    breakdown: {
      metadata: Math.round(meta * weights.metadataRelevance),
      visual: Math.round(visualVerificationScore * weights.visualVerification),
      penalty: Math.round(penalty),
      evidenceBonus: Math.round(evidenceBonus)
    }
  }
}

// ─── Visual Truth Verification via Gemini Vision ────────────────────────────

export function sanitizeVisualTruthVerification(
  p: any,
  candidateId: string,
  sceneId: string,
  minConfidence = 50,
  successfulModel?: string
): VisualTruthVerification {
  const confidence = clampScore(p?.confidence, 0, 100)

  // Low confidence fallback to UNKNOWN
  let truthLabel: VisualTruthLabel = p?.truthLabel || 'UNKNOWN'
  const validLabels: VisualTruthLabel[] = [
    'EXACT_SUBJECT',
    'CONTEXTUAL_MATCH',
    'ILLUSTRATIVE',
    'HISTORICAL',
    'GENERIC_STOCK',
    'CONTRADICTORY',
    'UNKNOWN'
  ]
  if (!validLabels.includes(truthLabel)) {
    truthLabel = 'UNKNOWN'
  }
  if (confidence < minConfidence && truthLabel !== 'CONTRADICTORY') {
    truthLabel = 'UNKNOWN'
  }

  const contradictionRisk = clampScore(p?.contradictionRisk)

  return {
    candidateId,
    sceneId,
    actualSubjects: Array.isArray(p?.actualSubjects) ? p.actualSubjects.map(String) : [],
    actualActions: Array.isArray(p?.actualActions) ? p.actualActions.map(String) : [],
    visibleObjects: Array.isArray(p?.visibleObjects) ? p.visibleObjects.map(String) : [],
    visibleText: Array.isArray(p?.visibleText) ? p.visibleText.map(String) : [],
    possibleLocations: Array.isArray(p?.possibleLocations) ? p.possibleLocations.map(String) : [],
    possibleTimePeriods: Array.isArray(p?.possibleTimePeriods) ? p.possibleTimePeriods.map(String) : [],
    subjectMatch: clampScore(p?.subjectMatch),
    actionMatch: clampScore(p?.actionMatch),
    objectMatch: clampScore(p?.objectMatch),
    geographyMatch: clampScore(p?.geographyMatch),
    timePeriodMatch: clampScore(p?.timePeriodMatch),
    narrationMatch: clampScore(p?.narrationMatch),
    visualIntentMatch: clampScore(p?.visualIntentMatch),
    documentaryEvidenceValue: clampScore(p?.documentaryEvidenceValue),
    sequenceContinuity: clampScore(p?.sequenceContinuity),
    genericStockRisk: clampScore(p?.genericStockRisk),
    contradictionRisk,
    technicalQuality: clampScore(p?.technicalQuality),
    truthLabel,
    positiveReasons: Array.isArray(p?.positiveReasons) ? p.positiveReasons.map(String) : [],
    negativeReasons: Array.isArray(p?.negativeReasons) ? p.negativeReasons.map(String) : [],
    contradictionReasons: Array.isArray(p?.contradictionReasons) ? p.contradictionReasons.map(String) : [],
    confidence,
    approved: Boolean(p?.approved && truthLabel !== 'CONTRADICTORY'),
    requiresReview: Boolean(
      p?.requiresReview ||
      truthLabel === 'CONTRADICTORY' ||
      truthLabel === 'UNKNOWN' ||
      confidence < minConfidence ||
      contradictionRisk > 50
    ),
    analyzedAt: new Date().toISOString(),
    analysisVersion: VISUAL_TRUTH_ANALYSIS_VERSION,
    model: successfulModel
  }
}

export interface AnalyzeCandidateParams {
  candidate: StockSearchResult
  sceneId: string
  narration: string
  visualIntent: string
  globalContext?: GlobalScriptContext | null
  chapterTitle?: string
  chapterPurpose?: string
  hasClaim?: boolean
  claimWarning?: string
  apiKey: string
  model?: string
  timeoutMs?: number
  minConfidence?: number
  framesCount?: number
}

export async function analyzeCandidateVisualTruth(
  params: AnalyzeCandidateParams
): Promise<VisualTruthVerification | null> {
  const {
    candidate,
    sceneId,
    narration,
    visualIntent,
    globalContext,
    chapterTitle,
    chapterPurpose,
    hasClaim,
    claimWarning,
    apiKey,
    timeoutMs = 15000,
    minConfidence = 60,
    framesCount = 3
  } = params

  if (visionCircuitBreaker.isOpen()) {
    logger.warn(`[VisualTruth] Vision circuit breaker open, skipping AI vision analysis`)
    return null
  }

  const cleanKey = normalizeApiKey(apiKey)
  if (!cleanKey) return null

  // Extract frames
  const extracted = await extractCandidateFrames(candidate, framesCount)
  if (!extracted || extracted.frameBase64List.length === 0) {
    return null
  }

  const models = getAvailableModelsForTask('visual_truth', params.model)
  const forbiddenSubs = globalContext?.forbiddenSubstitutions?.join('; ') || 'None'
  const primarySubject = globalContext?.primarySubject || 'General documentary subject'
  const timePeriod = globalContext?.timeContext?.primaryPeriod || 'Modern / Unspecified'

  const prompt = `You are a Lead Visual Truth Inspector and Archival Researcher for a high-end US documentary.
Inspect the provided image frame(s) extracted from a stock candidate video or photo.
Determine if the footage genuinely depicts what the narration, visual intent, and documentary context describe.

Scene Context:
- Scene Narration: "${narration}"
- Visual Intent: "${visualIntent}"
- Chapter Context: "${chapterTitle || ''} — ${chapterPurpose || ''}"
- Global Subject: "${primarySubject}"
- Required Time Period: "${timePeriod}"
- STRICTLY FORBIDDEN SUBSTITUTIONS / FALSE TROUGHT: "${forbiddenSubs}"
- Factual Claim in Scene: ${hasClaim ? `YES (${claimWarning || 'Requires documentary proof'})` : 'No'}

Stock Candidate Metadata:
- Title: "${candidate.title}"
- Tags: "${(candidate.tags || []).join(', ')}"
- Provider: "${candidate.provider}"

Carefully inspect the frames for:
1. Actual subjects and actions happening in the frames.
2. Contradictions:
   - Wrong religious/ethnic group (e.g., Amish/Mennonite shown instead of Hutterite, or Caucasian shown when Asian community required)
   - Wrong historical era (e.g. smartphones/cars in historical scene)
   - Distracting watermarks, foreign language signs, prominent unrelated logos
   - Cartoon / 3D render when realistic live-action required
   - Generic staged shopping carts when price comparison / shelf unit price was specified
3. Documentary Evidence Value: Does this show actual real-life documentary evidence (e.g. receipt, price label, map, document, real archive) or purely staged/decorative footage?

Respond with STRICT JSON matching this schema:
{
  "actualSubjects": ["woman in grocery aisle"],
  "actualActions": ["examining price tag on shelf"],
  "visibleObjects": ["shelf labels", "groceries"],
  "visibleText": ["optional visible text"],
  "possibleLocations": ["supermarket"],
  "possibleTimePeriods": ["contemporary"],
  "subjectMatch": 85,
  "actionMatch": 80,
  "objectMatch": 75,
  "geographyMatch": 80,
  "timePeriodMatch": 90,
  "narrationMatch": 85,
  "visualIntentMatch": 90,
  "documentaryEvidenceValue": 70,
  "sequenceContinuity": 80,
  "genericStockRisk": 20,
  "contradictionRisk": 5,
  "technicalQuality": 85,
  "truthLabel": "EXACT_SUBJECT" | "CONTEXTUAL_MATCH" | "ILLUSTRATIVE" | "HISTORICAL" | "GENERIC_STOCK" | "CONTRADICTORY" | "UNKNOWN",
  "positiveReasons": ["Directly shows shelf price tags as requested in narration"],
  "negativeReasons": [],
  "contradictionReasons": [],
  "confidence": 85,
  "approved": true,
  "requiresReview": false
}`

  let rawJson = ''
  let successfulModel = ''

  for (const currentModel of models) {
    try {
      const ai = new GoogleGenAI({ apiKey: cleanKey, httpOptions: { apiVersion: 'v1beta' } })

      // Build parts with image frames
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
        { text: prompt }
      ]

      for (const b64 of extracted.frameBase64List) {
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: b64
          }
        })
      }

      // Execute with timeout
      const callPromise = ai.models.generateContent({
        model: currentModel,
        contents: [{ role: 'user', parts: parts as unknown as Array<{ text: string }> }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 2048
        }
      })

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Visual truth timeout after ${timeoutMs}ms`)), timeoutMs)
      )

      const response = await Promise.race([callPromise, timeoutPromise])
      rawJson = response.text ?? ''
      if (rawJson) {
        successfulModel = currentModel
        visionCircuitBreaker.recordSuccess()
        recordModelSuccess(currentModel)
        break
      }
    } catch (err: unknown) {
      const { kind, message } = classifyGeminiErrorKind(err)
      recordModelFailure(currentModel, kind)
      visionCircuitBreaker.recordFailure()
      logger.warn(`[VisualTruth] Model ${currentModel} failed (${kind}): ${message}`)
    }
  }

  // Clean temp frames immediately
  extracted.cleanup()

  if (!rawJson) {
    return null
  }

  try {
    const p = JSON.parse(rawJson)
    return sanitizeVisualTruthVerification(p, candidate.assetId, sceneId, minConfidence, successfulModel)
  } catch (err) {
    logger.warn(`[VisualTruth] Failed to parse vision JSON: ${String(err)}`)
    return null
  }
}

// ─── Shortlist Reranking Orchestration ──────────────────────────────────────

export interface RerankShortlistParams {
  projectDir: string
  sceneId: string
  sceneIndex: number
  narration: string
  visualIntent: string
  candidates: StockCandidate[]
  globalContext?: GlobalScriptContext | null
  chapterTitle?: string
  chapterPurpose?: string
  claimLedger?: ClaimEvidenceLedger | null
  settings: ProductionIntelligenceSettings
  apiKey?: string
  onProgress?: (message: string, current: number, total: number) => void
  onEvent?: (eventName: string, payload: Record<string, unknown>) => void
}

/**
 * Executes Two-Tier Visual Truth Reranking:
 * Tier 1: Existing metadata ranking already produced candidates.
 * Tier 2: Shortlist top N candidates, verify visual frames with Vision, compute combined score, and rerank.
 * Fallback: If Vision is disabled, offline, or rate-limited, safely retains metadata ranking.
 */
export async function rerankShortlistedCandidates(
  params: RerankShortlistParams
): Promise<{
  candidates: StockCandidate[]
  winner: StockCandidate
  usedFallback: boolean
}> {
  const {
    projectDir,
    sceneId,
    sceneIndex,
    narration,
    visualIntent,
    candidates,
    globalContext,
    chapterTitle,
    chapterPurpose,
    claimLedger,
    settings,
    apiKey,
    onProgress,
    onEvent
  } = params

  if (candidates.length === 0) {
    throw new Error('No candidates provided for reranking.')
  }

  // Feature Flag Check
  const enabled =
    settings.enabled &&
    (settings.visualTruthEnabled ?? settings.productionIntelligence?.visualTruthEnabled ?? true)

  if (!enabled || !apiKey || !normalizeApiKey(apiKey)) {
    logger.info(`[VisualTruth] Visual Truth Reranker disabled or key missing — using metadata ranking`)
    onEvent?.('visual-truth:fallback', { sceneId, reason: 'Feature disabled or API key missing' })
    const winner = candidates.find((c) => c.selected) || candidates[0]
    return { candidates, winner, usedFallback: true }
  }

  const shortlistSize =
    settings.visualTruthShortlistSize ?? settings.productionIntelligence?.visualTruthShortlistSize ?? 6
  const framesCount =
    settings.visualTruthFrameCount ?? settings.productionIntelligence?.visualTruthFrameCount ?? 3
  const timeoutMs =
    settings.visualTruthTimeoutMs ?? settings.productionIntelligence?.visualTruthTimeoutMs ?? 15000
  const minConfidence =
    settings.visualTruthMinConfidence ?? settings.productionIntelligence?.visualTruthMinConfidence ?? 60

  const shortlist = candidates.slice(0, Math.min(candidates.length, shortlistSize))
  logger.info(`[VisualTruth] Scene ${sceneId}: analyzing ${shortlist.length} shortlisted candidates`)
  onEvent?.('visual-truth:started', { sceneId, totalCandidates: shortlist.length })

  const store = loadVisualTruthStore(projectDir)
  const ctxHash = globalContext?.exactTopicAnchors?.join(',') || 'no-ctx'

  // Check if scene has linked factual claim
  const sceneClaims = (claimLedger?.claims || []).filter((c) => c.sceneIds.includes(sceneId))
  const hasClaim = sceneClaims.length > 0
  const claimWarning = hasClaim
    ? `Claim: "${sceneClaims[0].normalizedClaim}" (${sceneClaims[0].type})`
    : undefined

  let visionFailures = 0

  for (let idx = 0; idx < shortlist.length; idx++) {
    const candidate = shortlist[idx]
    onProgress?.(`Visual verification Scene ${sceneIndex} Candidates ${idx + 1}/${shortlist.length}`, idx + 1, shortlist.length)

    const cacheKey = generateVerificationCacheKey(candidate.candidateId, visualIntent, ctxHash)
    let verification: VisualTruthVerification | null = store.verifications[cacheKey] || null

    if (!verification) {
      try {
        verification = await analyzeCandidateVisualTruth({
          candidate: candidate.result,
          sceneId,
          narration,
          visualIntent,
          globalContext,
          chapterTitle,
          chapterPurpose,
          hasClaim,
          claimWarning,
          apiKey,
          timeoutMs,
          minConfidence,
          framesCount
        })

        if (verification) {
          store.verifications[cacheKey] = verification
          saveVisualTruthStore(projectDir, store)
        } else {
          visionFailures++
        }
      } catch (err) {
        visionFailures++
        logger.warn(`[VisualTruth] Verification error for candidate ${candidate.candidateId}: ${String(err)}`)
      }
    }

    if (verification) {
      candidate.visualTruth = verification
      const { finalScore } = computeCombinedVisualTruthScore(candidate.score.totalScore, verification)
      candidate.finalScore = finalScore

      logger.info(
        `[VisualTruth] Candidate ${candidate.candidateId}: ${verification.truthLabel}, score ${finalScore}`
      )
      onEvent?.('visual-truth:candidate-analyzed', {
        sceneId,
        candidateId: candidate.candidateId,
        truthLabel: verification.truthLabel,
        finalScore,
        positiveReasons: verification.positiveReasons,
        negativeReasons: verification.negativeReasons
      })
    } else {
      // Fallback for this candidate to metadata score
      candidate.finalScore = candidate.score.totalScore
    }
  }

  // If all vision calls failed, trigger clean fallback
  const usedFallback = visionFailures >= shortlist.length
  if (usedFallback) {
    logger.warn(`[VisualTruth] Vision unavailable — using metadata fallback`)
    onEvent?.('visual-truth:fallback', { sceneId, reason: 'All vision calls failed or timed out' })
  }

  // Rerank candidates based on finalScore desc; penalize CONTRADICTORY candidates
  shortlist.sort((a, b) => {
    const aIsContradictory = a.visualTruth?.truthLabel === 'CONTRADICTORY'
    const bIsContradictory = b.visualTruth?.truthLabel === 'CONTRADICTORY'
    if (aIsContradictory !== bIsContradictory) {
      return aIsContradictory ? 1 : -1
    }
    return (b.finalScore ?? b.score.totalScore) - (a.finalScore ?? a.score.totalScore)
  })

  // Re-assemble full candidates list (shortlist reranked first, remainder unchanged)
  const remaining = candidates.slice(shortlist.length)
  const rerankedList = [...shortlist, ...remaining]

  // Re-assign ranks and mark winner
  rerankedList.forEach((c, idx) => {
    c.rank = idx + 1
    c.selected = idx === 0
  })

  const winner = rerankedList[0]
  logger.info(`[VisualTruth] Scene ${sceneId} — selected ${winner.candidateId}, score ${winner.finalScore ?? winner.score.totalScore}`)
  onEvent?.('visual-truth:scene-completed', {
    sceneId,
    selectedCandidateId: winner.candidateId,
    truthLabel: winner.visualTruth?.truthLabel || 'UNKNOWN',
    finalScore: winner.finalScore ?? winner.score.totalScore
  })

  return { candidates: rerankedList, winner, usedFallback }
}
