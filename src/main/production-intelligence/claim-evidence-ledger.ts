import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { GoogleGenAI } from '@google/genai'
import type {
  DocumentaryClaim,
  EvidenceSource,
  ClaimEvidenceLedger,
  ClaimType,
  ClaimVerificationStatus,
  EvidenceType,
  GlobalScriptContext
} from '../../../shared/types'
import { atomicWriteJson, readJsonSafe } from './json-store'
import { logger } from '../logger'
import { normalizeApiKey } from '../utils/api-key'
import { getAvailableModelsForTask } from '../ai/model-router'
import { classifyGeminiErrorKind, recordModelFailure, recordModelSuccess } from '../ai/model-health'

export const CLAIM_EXTRACTION_VERSION = '1.0.0'

export function getClaimLedgerPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'claim-evidence-ledger.json')
}

export function computeScriptHash(text: string): string {
  return crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

export function computeGlobalContextHash(ctx?: GlobalScriptContext | null): string {
  if (!ctx) return 'no-ctx'
  const summary = `${ctx.primarySubject}:${ctx.centralThesis}:${ctx.exactTopicAnchors?.join(',')}`
  return crypto.createHash('sha256').update(summary).digest('hex').slice(0, 16)
}

export interface ScriptSceneInput {
  sceneId: string
  sceneIndex: number
  narration: string
  visualIntent?: string
  chapterId?: string
  chapterTitle?: string
  sequenceId?: string
}

export interface ExtractClaimsParams {
  projectDir: string
  scriptText?: string | null
  globalContext?: GlobalScriptContext | null
  scenes: ScriptSceneInput[]
  apiKey?: string
  model?: string
  forceRegenerate?: boolean
  onProgress?: (message: string, progress: number) => void
}

/**
 * Fallback regex-based extraction for numbers, money, dates, and comparisons
 * if Gemini is offline, rate-limited, or has invalid key.
 */
export function extractClaimsRuleBased(
  scenes: ScriptSceneInput[],
  scriptHash: string,
  ctxHash: string
): ClaimEvidenceLedger {
  const claims: DocumentaryClaim[] = []
  const now = new Date().toISOString()

  // Match statistics (e.g. 50%, 3.5 percent), money ($500, 10 billion dollars), years/dates (1994, 2023)
  const statRegex = /\b\d+(\.\d+)?\s*(%|percent|percentage)\b/i
  const moneyRegex = /(\$\s*\d+[\d,.]*|\b\d+[\d,.]*\s*(dollars|cents|USD|billion|million|trillion))\b/i
  const dateRegex = /\b(18\d\d|19\d\d|20\d\d)\b/

  for (const sc of scenes) {
    const text = sc.narration.trim()
    if (!text) continue

    const sentences = text.split(/(?<=[.?!])\s+/).filter((s) => s.length > 10)
    for (const sent of sentences) {
      let type: ClaimType | null = null
      let importance: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'MEDIUM'
      let proofVisualType: DocumentaryClaim['proofVisualType'] = undefined

      if (moneyRegex.test(sent)) {
        type = 'MONEY'
        importance = 'HIGH'
        proofVisualType = 'STAT_CARD'
      } else if (statRegex.test(sent)) {
        type = 'STATISTIC'
        importance = 'HIGH'
        proofVisualType = 'STAT_CARD'
      } else if (dateRegex.test(sent)) {
        type = 'DATE'
        importance = 'MEDIUM'
        proofVisualType = 'DOCUMENT_CARD'
      }

      if (type) {
        const id = `claim_${crypto.createHash('md5').update(sent).digest('hex').slice(0, 10)}`
        // Avoid duplicate claim
        const existing = claims.find((c) => c.normalizedClaim.toLowerCase() === sent.toLowerCase())
        if (existing) {
          if (!existing.sceneIds.includes(sc.sceneId)) {
            existing.sceneIds.push(sc.sceneId)
          }
        } else {
          claims.push({
            id,
            scriptText: sent,
            normalizedClaim: sent,
            type,
            chapterId: sc.chapterId,
            sequenceId: sc.sequenceId,
            sceneIds: [sc.sceneId],
            importance,
            confidence: 75,
            verificationStatus: 'UNSOURCED',
            evidenceSourceIds: [],
            proofVisualRecommended: true,
            proofVisualType,
            warnings: [
              `Extracted via rule-based parser. Requires authoritative citation.`
            ],
            extractionVersion: CLAIM_EXTRACTION_VERSION,
            createdAt: now,
            updatedAt: now
          })
        }
      }
    }
  }

  const ledger: ClaimEvidenceLedger = {
    projectId: 'default',
    scriptHash,
    globalContextHash: ctxHash,
    claims,
    sources: [],
    summary: computeLedgerSummary(claims),
    generatedAt: now,
    version: CLAIM_EXTRACTION_VERSION
  }

  return ledger
}

export function computeLedgerSummary(claims: DocumentaryClaim[]): ClaimEvidenceLedger['summary'] {
  let verified = 0
  let partiallyVerified = 0
  let unsourced = 0
  let contradicted = 0
  let criticalUnsourced = 0

  for (const c of claims) {
    if (c.verificationStatus === 'VERIFIED') verified++
    else if (c.verificationStatus === 'PARTIALLY_VERIFIED') partiallyVerified++
    else if (c.verificationStatus === 'UNSOURCED') {
      unsourced++
      if (c.importance === 'CRITICAL' || c.importance === 'HIGH') criticalUnsourced++
    } else if (c.verificationStatus === 'CONTRADICTED') contradicted++
  }

  const totalClaims = claims.length
  const covered = verified + partiallyVerified
  const coveragePct = totalClaims > 0 ? Math.round((covered / totalClaims) * 100) : 100

  return {
    totalClaims,
    verified,
    partiallyVerified,
    unsourced,
    contradicted,
    criticalUnsourced,
    coveragePct
  }
}

/**
 * Validates and sanitizes claims returned from Gemini to prevent hallucinations.
 * CRITICAL RULE: AI must NEVER invent fake URLs, publishers, authors, or verified statuses.
 */
function sanitizeAiClaims(
  rawClaims: unknown[],
  scenes: ScriptSceneInput[]
): DocumentaryClaim[] {
  const validSceneIds = new Set(scenes.map((s) => s.sceneId))
  const sceneMap = new Map(scenes.map((s) => [s.sceneId, s]))
  const now = new Date().toISOString()
  const claims: DocumentaryClaim[] = []

  if (!Array.isArray(rawClaims)) return claims

  for (let idx = 0; idx < rawClaims.length; idx++) {
    const raw = rawClaims[idx]
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>

    const scriptText = String(r.scriptText || r.claimText || '').trim()
    if (!scriptText) continue

    const normalizedClaim = String(r.normalizedClaim || scriptText).trim()

    // Validate type
    const validTypes: ClaimType[] = [
      'STATISTIC',
      'MONEY',
      'DATE',
      'HISTORICAL_EVENT',
      'PERSON',
      'COMPANY',
      'LOCATION',
      'POLICY',
      'QUOTE',
      'COMPARISON',
      'CAUSAL',
      'GENERAL_FACT'
    ]
    const rawType = String(r.type || 'GENERAL_FACT').toUpperCase() as ClaimType
    const type: ClaimType = validTypes.includes(rawType) ? rawType : 'GENERAL_FACT'

    // Validate importance
    const rawImp = String(r.importance || 'MEDIUM').toUpperCase()
    const importance =
      rawImp === 'CRITICAL' || rawImp === 'HIGH' || rawImp === 'LOW' ? rawImp : 'MEDIUM'

    // Validate sceneIds
    let sceneIds: string[] = []
    if (Array.isArray(r.sceneIds)) {
      sceneIds = r.sceneIds.map(String).filter((id) => validSceneIds.has(id))
    }
    if (sceneIds.length === 0) {
      // Find matching scene by text substring
      const match = scenes.find((s) => s.narration.toLowerCase().includes(scriptText.toLowerCase()))
      if (match) sceneIds = [match.sceneId]
    }
    if (sceneIds.length === 0 && scenes.length > 0) {
      sceneIds = [scenes[0].sceneId]
    }

    const firstScene = sceneMap.get(sceneIds[0])

    // ANTI-HALLUCINATION: AI cannot claim a source exists unless user added it
    // Initial verificationStatus is always UNSOURCED unless script explicitly quotes a primary source
    const rawStatus = String(r.verificationStatus || '').toUpperCase()
    const verificationStatus: ClaimVerificationStatus =
      rawStatus === 'PARTIALLY_VERIFIED' || rawStatus === 'VERIFIED'
        ? 'UNSOURCED' // strictly enforce UNSOURCED until user provides citation
        : rawStatus === 'CONTRADICTED'
        ? 'CONTRADICTED'
        : 'UNSOURCED'

    const warnings: string[] = Array.isArray(r.warnings)
      ? r.warnings.map(String)
      : []

    if (verificationStatus === 'UNSOURCED' && warnings.length === 0) {
      warnings.push(`Factual claim requires documentation or authoritative source citation.`)
    }

    const id = String(r.id || `claim_${idx + 1}_${crypto.createHash('md5').update(scriptText).digest('hex').slice(0, 8)}`)

    let proofVisualType: DocumentaryClaim['proofVisualType'] = undefined
    if (r.proofVisualType) {
      const pvt = String(r.proofVisualType).toUpperCase()
      if (['STAT_CARD', 'DOCUMENT_CARD', 'QUOTE_CARD', 'COMPARISON_CARD', 'DATA_NOTE', 'ARCHIVE_VISUAL'].includes(pvt)) {
        proofVisualType = pvt as DocumentaryClaim['proofVisualType']
      }
    }

    claims.push({
      id,
      scriptText,
      normalizedClaim,
      type,
      chapterId: firstScene?.chapterId,
      sequenceId: firstScene?.sequenceId,
      sceneIds,
      importance,
      confidence: Math.min(100, Math.max(0, Number(r.confidence) || 80)),
      verificationStatus,
      evidenceSourceIds: [],
      proofVisualRecommended: Boolean(r.proofVisualRecommended ?? (type === 'STATISTIC' || type === 'MONEY')),
      proofVisualType,
      warnings,
      extractionVersion: CLAIM_EXTRACTION_VERSION,
      createdAt: now,
      updatedAt: now
    })
  }

  return claims
}

/**
 * Extracts documentary claims from full script using Gemini with structured JSON output.
 * If model fails or API is unavailable, falls back to rule-based extraction without blocking.
 */
export async function extractDocumentaryClaims(
  params: ExtractClaimsParams
): Promise<ClaimEvidenceLedger> {
  const { projectDir, scriptText, globalContext, scenes, apiKey, forceRegenerate, onProgress } = params
  const ledgerPath = getClaimLedgerPath(projectDir)

  const fullText =
    scriptText?.trim() || scenes.map((s) => s.narration).join('\n') || ''
  const scriptHash = computeScriptHash(fullText)
  const ctxHash = computeGlobalContextHash(globalContext)

  // 1. Check existing cache
  if (!forceRegenerate && fs.existsSync(ledgerPath)) {
    try {
      const existing = readJsonSafe<ClaimEvidenceLedger>(ledgerPath, null as unknown as ClaimEvidenceLedger)
      if (
        existing &&
        existing.claims &&
        existing.scriptHash === scriptHash &&
        existing.globalContextHash === ctxHash
      ) {
        logger.info(`[ClaimLedger] Using cached Claim & Evidence Ledger (${existing.claims.length} claims)`)
        onProgress?.(`Loaded cached Claim Ledger (${existing.claims.length} claims)`, 1.0)
        return existing
      }
    } catch {
      /* ignore */
    }
  }

  onProgress?.(`Analyzing script for factual claims and evidence requirements...`, 0.1)

  const cleanKey = normalizeApiKey(apiKey)
  if (!cleanKey) {
    logger.warn(`[ClaimLedger] No Gemini API key provided. Using rule-based claim extraction.`)
    onProgress?.(`Gemini key unavailable — using rule-based claim extraction`, 0.5)
    const fallbackLedger = extractClaimsRuleBased(scenes, scriptHash, ctxHash)
    atomicWriteJson(ledgerPath, fallbackLedger)
    return fallbackLedger
  }

  const models = getAvailableModelsForTask('claim_analysis', params.model)

  const sceneBriefs = scenes.slice(0, 150).map((s) => ({
    sceneId: s.sceneId,
    sceneIndex: s.sceneIndex,
    chapter: s.chapterTitle ?? s.chapterId ?? '',
    narration: s.narration
  }))

  const prompt = `You are a Senior Documentary Fact-Checker and Archive Producer for a high-end investigative documentary.
Analyze the following documentary script and its scene breakdown to identify ALL statements that require documentary proof or citation.

CRITICAL RULES:
1. Do NOT treat general narrative actions (e.g. "She looked out the window", "The rain fell gently") as factual claims.
2. Focus on:
   - STATISTIC (percentages, market share, headcounts)
   - MONEY (dollar amounts, profits, costs, fines, valuations)
   - DATE (specific years, historical milestones, policy launch dates)
   - HISTORICAL_EVENT (battles, legal rulings, treaties, disasters)
   - PERSON (specific public figures, allegations, quotes, titles)
   - COMPANY (corporate actions, monopolies, revenue, investigations)
   - LOCATION (geopolitical claims, boundaries, treaty zones)
   - POLICY (laws, regulations, legal mandates, institutional rules)
   - QUOTE (direct or indirect quotes attributed to real individuals)
   - COMPARISON ("largest in history", "twice as expensive", "faster than X")
   - CAUSAL ("X directly caused Y", "the collapse occurred because of Z")
3. ANTI-HALLUCINATION:
   - DO NOT fabricate citations, URLs, author names, or publisher names.
   - Leave verificationStatus as "UNSOURCED".
   - Include specific guidance in 'warnings' about what type of primary source is needed (e.g., "Requires SEC 10-K filing or BLS statistical report").
4. Map each claim to its corresponding sceneIds from the provided scene list.

Global Context:
- Primary Subject: ${globalContext?.primarySubject ?? 'Documentary subject'}
- Central Thesis: ${globalContext?.centralThesis ?? 'Documentary thesis'}

Scenes:
${JSON.stringify(sceneBriefs, null, 2)}

Respond with STRICT JSON matching this schema:
{
  "claims": [
    {
      "id": "claim_1",
      "scriptText": "exact sentence or clause from script",
      "normalizedClaim": "concise factual assertion",
      "type": "STATISTIC" | "MONEY" | "DATE" | "HISTORICAL_EVENT" | "PERSON" | "COMPANY" | "LOCATION" | "POLICY" | "QUOTE" | "COMPARISON" | "CAUSAL" | "GENERAL_FACT",
      "importance": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
      "confidence": 85,
      "sceneIds": ["scene_001"],
      "proofVisualRecommended": true,
      "proofVisualType": "STAT_CARD" | "DOCUMENT_CARD" | "QUOTE_CARD" | "COMPARISON_CARD" | "DATA_NOTE" | "ARCHIVE_VISUAL",
      "warnings": ["Requires specific primary documentation."]
    }
  ]
}`

  let rawJson = ''
  let successfulModel = ''

  for (const currentModel of models) {
    try {
      onProgress?.(`Extracting claims with ${currentModel}...`, 0.3)
      const ai = new GoogleGenAI({ apiKey: cleanKey, httpOptions: { apiVersion: 'v1beta' } })
      const res = await ai.models.generateContent({
        model: currentModel,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 8192
        }
      })
      rawJson = res.text ?? ''
      if (rawJson) {
        successfulModel = currentModel
        recordModelSuccess(currentModel)
        break
      }
    } catch (err: unknown) {
      const { kind, message } = classifyGeminiErrorKind(err)
      recordModelFailure(currentModel, kind)
      logger.warn(`[ClaimLedger] Model ${currentModel} failed (${kind}): ${message}`)
    }
  }

  let claims: DocumentaryClaim[] = []
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson)
      const list = Array.isArray(parsed) ? parsed : parsed.claims || []
      claims = sanitizeAiClaims(list, scenes)
      logger.info(`[ClaimLedger] Extracted ${claims.length} claims using ${successfulModel}`)
    } catch (err) {
      logger.error(`[ClaimLedger] Failed to parse AI claim response: ${String(err)}`)
    }
  }

  // Fallback if AI produced no claims
  if (claims.length === 0) {
    logger.warn(`[ClaimLedger] AI returned no claims, executing rule-based fallback`)
    const fallbackLedger = extractClaimsRuleBased(scenes, scriptHash, ctxHash)
    atomicWriteJson(ledgerPath, fallbackLedger)
    return fallbackLedger
  }

  const now = new Date().toISOString()
  const ledger: ClaimEvidenceLedger = {
    projectId: path.basename(projectDir),
    scriptHash,
    globalContextHash: ctxHash,
    claims,
    sources: [],
    summary: computeLedgerSummary(claims),
    generatedAt: now,
    version: CLAIM_EXTRACTION_VERSION
  }

  atomicWriteJson(ledgerPath, ledger)
  onProgress?.(`Claim Ledger ready (${claims.length} claims, ${ledger.summary.unsourced} unsourced)`, 1.0)
  return ledger
}

// ─── Source & Claim Management CRUD ──────────────────────────────────────────

export function addEvidenceSource(
  projectDir: string,
  source: Omit<EvidenceSource, 'id'> & { id?: string }
): { success: boolean; source?: EvidenceSource; error?: string } {
  const ledgerPath = getClaimLedgerPath(projectDir)
  const ledger = readJsonSafe<ClaimEvidenceLedger>(ledgerPath, null as unknown as ClaimEvidenceLedger)
  if (!ledger) {
    return { success: false, error: 'Claim ledger does not exist.' }
  }

  const id = source.id || `src_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const newSource: EvidenceSource = {
    ...source,
    id,
    manuallyAdded: true
  }

  ledger.sources.push(newSource)
  atomicWriteJson(ledgerPath, ledger)
  return { success: true, source: newSource }
}

export function linkSourceToClaim(
  projectDir: string,
  claimId: string,
  sourceId: string,
  newStatus?: ClaimVerificationStatus
): { success: boolean; claim?: DocumentaryClaim; error?: string } {
  const ledgerPath = getClaimLedgerPath(projectDir)
  const ledger = readJsonSafe<ClaimEvidenceLedger>(ledgerPath, null as unknown as ClaimEvidenceLedger)
  if (!ledger) {
    return { success: false, error: 'Claim ledger does not exist.' }
  }

  const claim = ledger.claims.find((c) => c.id === claimId)
  if (!claim) {
    return { success: false, error: `Claim ${claimId} not found.` }
  }

  const source = ledger.sources.find((s) => s.id === sourceId)
  if (!source) {
    return { success: false, error: `Source ${sourceId} not found.` }
  }

  if (!claim.evidenceSourceIds.includes(sourceId)) {
    claim.evidenceSourceIds.push(sourceId)
  }

  if (newStatus) {
    claim.verificationStatus = newStatus
  } else if (claim.verificationStatus === 'UNSOURCED') {
    claim.verificationStatus = 'VERIFIED'
  }

  claim.updatedAt = new Date().toISOString()
  ledger.summary = computeLedgerSummary(ledger.claims)
  atomicWriteJson(ledgerPath, ledger)
  return { success: true, claim }
}

export function unlinkSourceFromClaim(
  projectDir: string,
  claimId: string,
  sourceId: string
): { success: boolean; claim?: DocumentaryClaim; error?: string } {
  const ledgerPath = getClaimLedgerPath(projectDir)
  const ledger = readJsonSafe<ClaimEvidenceLedger>(ledgerPath, null as unknown as ClaimEvidenceLedger)
  if (!ledger) {
    return { success: false, error: 'Claim ledger does not exist.' }
  }

  const claim = ledger.claims.find((c) => c.id === claimId)
  if (!claim) {
    return { success: false, error: `Claim ${claimId} not found.` }
  }

  claim.evidenceSourceIds = claim.evidenceSourceIds.filter((id) => id !== sourceId)
  if (
    claim.evidenceSourceIds.length === 0 &&
    (claim.verificationStatus === 'VERIFIED' || claim.verificationStatus === 'PARTIALLY_VERIFIED')
  ) {
    claim.verificationStatus = 'UNSOURCED'
  }

  claim.updatedAt = new Date().toISOString()
  ledger.summary = computeLedgerSummary(ledger.claims)
  atomicWriteJson(ledgerPath, ledger)
  return { success: true, claim }
}

export function updateClaimStatus(
  projectDir: string,
  claimId: string,
  status: ClaimVerificationStatus,
  warningText?: string
): { success: boolean; claim?: DocumentaryClaim; error?: string } {
  const ledgerPath = getClaimLedgerPath(projectDir)
  const ledger = readJsonSafe<ClaimEvidenceLedger>(ledgerPath, null as unknown as ClaimEvidenceLedger)
  if (!ledger) {
    return { success: false, error: 'Claim ledger does not exist.' }
  }

  const claim = ledger.claims.find((c) => c.id === claimId)
  if (!claim) {
    return { success: false, error: `Claim ${claimId} not found.` }
  }

  claim.verificationStatus = status
  if (warningText) {
    if (!claim.warnings.includes(warningText)) {
      claim.warnings.push(warningText)
    }
  }

  claim.updatedAt = new Date().toISOString()
  ledger.summary = computeLedgerSummary(ledger.claims)
  atomicWriteJson(ledgerPath, ledger)
  return { success: true, claim }
}

// ─── Manifest Export (CSV & JSON) ───────────────────────────────────────────

export function escapeCsvField(val?: string | number | null): string {
  if (val === undefined || val === null) return '""'
  const str = String(val).replace(/"/g, '""')
  return `"${str}"`
}

export function exportClaimManifests(
  projectDir: string,
  exportDir?: string
): {
  success: boolean
  csvPath?: string
  jsonPath?: string
  licensesPath?: string
  error?: string
} {
  try {
    const ledgerPath = getClaimLedgerPath(projectDir)
    const ledger = readJsonSafe<ClaimEvidenceLedger>(ledgerPath, null as unknown as ClaimEvidenceLedger)
    if (!ledger) {
      return { success: false, error: 'Claim ledger not found for export.' }
    }

    const outDir = exportDir || path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })

    // 1. JSON Export
    const jsonPath = path.join(outDir, 'claim-evidence-ledger.json')
    atomicWriteJson(jsonPath, ledger)

    // 2. CSV Export
    const csvPath = path.join(outDir, 'sources.csv')
    const sourceMap = new Map<string, EvidenceSource>(ledger.sources.map((s) => [s.id, s]))

    const headers = [
      'claim_id',
      'scene_ids',
      'claim_text',
      'claim_type',
      'importance',
      'verification_status',
      'source_title',
      'publisher',
      'source_url',
      'published_at',
      'accessed_at',
      'license',
      'attribution',
      'asset_id',
      'local_path',
      'timecode',
      'notes'
    ]

    const rows: string[] = [headers.join(',')]

    for (const claim of ledger.claims) {
      const linkedSources = claim.evidenceSourceIds
        .map((id) => sourceMap.get(id))
        .filter(Boolean) as EvidenceSource[]

      if (linkedSources.length === 0) {
        rows.push(
          [
            escapeCsvField(claim.id),
            escapeCsvField(claim.sceneIds.join(';')),
            escapeCsvField(claim.scriptText || claim.normalizedClaim),
            escapeCsvField(claim.type),
            escapeCsvField(claim.importance),
            escapeCsvField(claim.verificationStatus),
            escapeCsvField('UNSOURCED'),
            escapeCsvField(''),
            escapeCsvField(''),
            escapeCsvField(''),
            escapeCsvField(''),
            escapeCsvField(''),
            escapeCsvField(''),
            escapeCsvField(''),
            escapeCsvField(''),
            escapeCsvField(''),
            escapeCsvField(claim.warnings.join('; '))
          ].join(',')
        )
      } else {
        for (const src of linkedSources) {
          const timecode =
            src.timecodeStart !== undefined && src.timecodeEnd !== undefined
              ? `${src.timecodeStart}-${src.timecodeEnd}`
              : ''
          rows.push(
            [
              escapeCsvField(claim.id),
              escapeCsvField(claim.sceneIds.join(';')),
              escapeCsvField(claim.scriptText || claim.normalizedClaim),
              escapeCsvField(claim.type),
              escapeCsvField(claim.importance),
              escapeCsvField(claim.verificationStatus),
              escapeCsvField(src.title),
              escapeCsvField(src.publisher),
              escapeCsvField(src.url),
              escapeCsvField(src.publishedAt),
              escapeCsvField(src.accessedAt),
              escapeCsvField(src.license),
              escapeCsvField(src.attribution),
              escapeCsvField(src.assetId),
              escapeCsvField(src.localPath),
              escapeCsvField(timecode),
              escapeCsvField(src.notes)
            ].join(',')
          )
        }
      }
    }

    fs.writeFileSync(csvPath, rows.join('\n'), 'utf-8')

    // 3. Licenses Export
    const licensesPath = path.join(outDir, 'licenses.json')
    const licenses = ledger.sources.map((s) => ({
      sourceId: s.id,
      title: s.title ?? 'Untitled Source',
      publisher: s.publisher ?? 'Unknown',
      license: s.license ?? 'All Rights Reserved / Fair Use Claim',
      attribution: s.attribution ?? s.publisher ?? s.title ?? '',
      url: s.url
    }))
    atomicWriteJson(licensesPath, {
      project: path.basename(projectDir),
      exportedAt: new Date().toISOString(),
      licenses
    })

    logger.info(`[EvidenceExport] Exported ${ledger.claims.length} claims and ${ledger.sources.length} sources to ${outDir}`)
    return { success: true, csvPath, jsonPath, licensesPath }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`[EvidenceExport] Failed exporting manifests: ${msg}`)
    return { success: false, error: msg }
  }
}
