import { join } from 'path'
import * as fs from 'fs'
import type {
  VisualGrammarType,
  VisualGrammarDecision,
  VisualGrammarPlan,
  CaptionPlan,
  ProductionIntelligenceSettings
} from '../../../shared/types'
import type { ProofVisual } from '../retention/retention-types'
import { FlattenedSceneEntry, flattenEditPlanScenes } from '../utils/scene-plan'
import { atomicWriteJson, readJsonSafe } from './json-store'
import { loadProductionSettings } from './production-settings'
import { logger } from '../logger'

export interface GrammarDetectionResult {
  type: VisualGrammarType
  confidence: number
  reason: string
  primaryText?: string
  secondaryText?: string
  position?: string
}

// ─── Regex Matchers for Grammar Detection ──────────────────────────────────────

// Date / Year patterns (e.g. 1963, 2024, 1800s, 19th century, October 1945)
const YEAR_REGEX = /\b(1[6-9]\d{2}|20\d{2})('?s)?\b/
const CENTURY_REGEX = /\b(\d{1,2}(?:st|nd|rd|th))\s+century\b/i
const MONTH_YEAR_REGEX = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(1[6-9]\d{2}|20\d{2})\b/i

// Stats, Money, Percentages (e.g. $12,000, 40%, 25.5%, 60,000 people, 500 triệu đô la)
const STAT_PERCENT_REGEX = /\b(\d+(?:\.\d+)?%)(?!\w)/
const STAT_MONEY_REGEX = /(\$\s*\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:million|billion|trillion))?|\b\d+(?:\.\d+)?\s*(?:million|billion|triệu|tỷ)\s*(?:dollars|đô la|đồng|usd|vnd)?\b)/i
const STAT_COUNT_REGEX = /\b(\d+(?:,\d{3})+|\d{2,}\s*(?:thousand|hundred))\s+([a-zA-Z]+)\b/i

// Location patterns (e.g. Montana, Manitoba, South Dakota, New York, Manitoba, Canada, Tokyo, Paris)
const LOCATION_INDICATOR_REGEX = /(?:^|\s|\b)(?:in|at|near|across|from|tại|ở)\s+(?:thành phố|thủ đô|city|capital)?\s*([A-Za-zÀ-ỹ]+(?:\s+[A-Za-zÀ-ỹ]+)*(?:,\s*[A-Za-zÀ-ỹ]+)?)/iu

// Quote patterns (quotation marks or "said", "declared", "stated")
const QUOTE_MARK_REGEX = /["“]([^"”]{6,100})["”]/
const QUOTE_VERB_REGEX = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:said|declared|stated|proclaimed|whispered|wrote)\b[:,\s]*["“]?([^"”.!]{6,80})["”]?/i

// Comparison patterns (A vs B, instead of, compared to, on the other hand, trong khi, so với, thay vì)
const COMPARISON_REGEX = /(?:instead of|compared to|versus|\bvs\.?\b|on the other hand|while [a-z]+ [a-z]+, [a-z]+|rather than|trong khi|thay vì|so với|ngược lại|mặt khác|trái ngược)/i

// Document / Legal / Official records (contracts, bills, laws, docket, files, charter, hợp đồng, giấy tờ, hồ sơ)
const DOCUMENT_REGEX = /(?:document|contract|treaty|accord|constitution|charter|bill|law|docket|manifesto|record|file|deed|license|affidavit|hợp đồng|giấy tờ|hồ sơ|văn bản|nghị quyết|nghị định|hóa đơn|luật|hiến pháp)/iu

export function classifyVisualGrammar(opts: {
  narration: string
  visualIntent?: string
  sceneIndex: number
  duration?: number
  isFirstInChapter?: boolean
  chapterTitle?: string
  mediaType?: string
}): GrammarDetectionResult {
  return classifyNarrationGrammar(opts.narration, opts)
}

/**
 * Classifies narration into a candidate Visual Scene Grammar decision.
 * Pure function for deterministic testing.
 */
export function classifyNarrationGrammar(
  narration: string,
  scene: { isFirstInChapter?: boolean; chapterTitle?: string; sceneIndex: number; mediaType?: string }
): GrammarDetectionResult {
  const text = narration.trim()


  // 1. Chapter Title Card: First scene in chapter
  if (scene.isFirstInChapter && scene.chapterTitle && scene.sceneIndex > 1) {
    return {
      type: 'chapter_title',
      confidence: 0.95,
      reason: `First scene in chapter: "${scene.chapterTitle}"`,
      primaryText: scene.chapterTitle.toUpperCase(),
      secondaryText: `CHAPTER ${scene.chapterTitle}`,
      position: 'center'
    }
  }

  // 2. Date Card
  const monthYearMatch = text.match(MONTH_YEAR_REGEX)
  if (monthYearMatch) {
    return {
      type: 'date_card',
      confidence: 0.9,
      reason: `Temporal anchor: "${monthYearMatch[0]}"`,
      primaryText: monthYearMatch[0].toUpperCase(),
      secondaryText: 'HISTORICAL TIMELINE',
      position: 'top_right'
    }
  }

  const yearMatch = text.match(YEAR_REGEX)
  if (yearMatch) {
    return {
      type: 'date_card',
      confidence: 0.88,
      reason: `Year reference: "${yearMatch[0]}"`,
      primaryText: yearMatch[0],
      secondaryText: 'CHRONOLOGY',
      position: 'top_right'
    }
  }

  const centuryMatch = text.match(CENTURY_REGEX)
  if (centuryMatch) {
    return {
      type: 'date_card',
      confidence: 0.85,
      reason: `Era reference: "${centuryMatch[0]}"`,
      primaryText: centuryMatch[0].toUpperCase(),
      secondaryText: 'HISTORICAL ERA',
      position: 'top_right'
    }
  }

  // 3. Stat Card (Money, Percent, Large Quantity)
  const moneyMatch = text.match(STAT_MONEY_REGEX)
  if (moneyMatch) {
    return {
      type: 'stat_card',
      confidence: 0.92,
      reason: `Financial figure: "${moneyMatch[0]}"`,
      primaryText: moneyMatch[0].trim(),
      secondaryText: 'KEY DATA POINT',
      position: 'bottom_left'
    }
  }

  const percentMatch = text.match(STAT_PERCENT_REGEX)
  if (percentMatch) {
    return {
      type: 'stat_card',
      confidence: 0.9,
      reason: `Percentage metric: "${percentMatch[0]}"`,
      primaryText: percentMatch[0],
      secondaryText: 'STATISTICAL METRIC',
      position: 'bottom_left'
    }
  }

  const countMatch = text.match(STAT_COUNT_REGEX)
  if (countMatch && !countMatch[2].match(/^(seconds|minutes|hours|days|weeks|months|years)$/i)) {
    return {
      type: 'stat_card',
      confidence: 0.85,
      reason: `Quantifiable count: "${countMatch[0]}"`,
      primaryText: countMatch[1],
      secondaryText: countMatch[2].toUpperCase(),
      position: 'bottom_left'
    }
  }

  // 4. Quote Card
  const quoteMarkMatch = text.match(QUOTE_MARK_REGEX)
  if (quoteMarkMatch && quoteMarkMatch[1].length > 10) {
    return {
      type: 'quote_card',
      confidence: 0.88,
      reason: 'Quotation in narration',
      primaryText: `"${quoteMarkMatch[1].trim()}"`,
      secondaryText: 'RECORDED TESTIMONY',
      position: 'bottom_right'
    }
  }

  const quoteVerbMatch = text.match(QUOTE_VERB_REGEX)
  if (quoteVerbMatch && quoteVerbMatch[2].length > 8) {
    return {
      type: 'quote_card',
      confidence: 0.82,
      reason: `Attributed statement: ${quoteVerbMatch[1]}`,
      primaryText: `"${quoteVerbMatch[2].trim()}"`,
      secondaryText: quoteVerbMatch[1].toUpperCase(),
      position: 'bottom_right'
    }
  }

  // 5. Comparison Card
  if (COMPARISON_REGEX.test(text) && text.length > 20) {
    if (text.includes(',')) {
      const commaParts = text.split(',')
      const a = commaParts[0].replace(COMPARISON_REGEX, '').trim().split(/\s+/).slice(-4).join(' ')
      const b = commaParts[1].trim().split(/\s+/).slice(0, 4).join(' ')
      if (a && b) {
        return {
          type: 'comparison_card',
          confidence: 0.8,
          reason: 'Contrastive statement structure',
          primaryText: a.toUpperCase(),
          secondaryText: `VS. ${b.toUpperCase()}`,
          position: 'center_bottom'
        }
      }
    }
    const parts = text.split(COMPARISON_REGEX).map((p) => p.trim()).filter(Boolean)
    if (parts.length >= 2) {
      const a = parts[0].split(/\s+/).slice(-4).join(' ')
      const b = parts[1].split(/\s+/).slice(0, 4).join(' ')
      return {
        type: 'comparison_card',
        confidence: 0.78,
        reason: 'Contrastive statement structure',
        primaryText: a.toUpperCase(),
        secondaryText: `VS. ${b.toUpperCase()}`,
        position: 'center_bottom'
      }
    }
  }

  // 6. Document Card
  if (DOCUMENT_REGEX.test(text)) {
    const docMatch = text.match(DOCUMENT_REGEX)
    return {
      type: 'document_card',
      confidence: 0.8,
      reason: `Historical or official record reference: "${docMatch?.[0]}"`,
      primaryText: (docMatch?.[0] || 'OFFICIAL RECORD').toUpperCase(),
      secondaryText: 'ARCHIVAL DOSSIER',
      position: 'bottom_right'
    }
  }

  // 7. Location Card
  const locMatch = text.match(LOCATION_INDICATOR_REGEX)
  if (locMatch && !locMatch[1].match(/^(January|February|March|April|May|June|July|August|September|October|November|December|Chapter|Scene|Part)$/i)) {
    return {
      type: 'location_card',
      confidence: 0.75,
      reason: `Geographic location reference: "${locMatch[1]}"`,
      primaryText: locMatch[1].toUpperCase(),
      secondaryText: 'LOCATION',
      position: 'top_left'
    }
  }

  // 8. Photo Parallax if image asset
  if (scene.mediaType === 'image') {
    return {
      type: 'photo_parallax',
      confidence: 0.7,
      reason: 'Still photo suitable for documentary parallax depth movement',
      position: 'center'
    }
  }

  // Default: stock video
  return {
    type: 'stock_video',
    confidence: 0.6,
    reason: 'Standard contextual footage'
  }
}

/**
 * Filter decisions to enforce:
 * - Max density (default 25% of total scenes)
 * - Min 6s spacing between graphic cards
 * - No two consecutive full graphic cards (except chapter_title)
 * - Collision avoidance with big_statement captions and proof visuals
 */
export function enforceGrammarDensityAndSpacing(
  rawDecisions: VisualGrammarDecision[],
  scenes: Array<{ sceneIndex: number; startTime: number; endTime: number; duration: number }>,
  maxDensity = 0.25,
  minSpacingSecs = 6.0,
  captionPlan?: CaptionPlan,
  proofVisuals?: ProofVisual[]
): VisualGrammarDecision[] {
  const totalScenes = scenes.length
  const maxAllowedGraphics = Math.max(1, Math.floor(totalScenes * maxDensity))

  let lastGraphicEndTime = -999
  let lastGraphicType: VisualGrammarType = 'stock_video'
  let graphicCount = 0

  const results: VisualGrammarDecision[] = []

  for (let i = 0; i < rawDecisions.length; i++) {
    const dec = { ...rawDecisions[i] }
    const sc = scenes.find((s) => s.sceneIndex === dec.sceneIndex)
    if (!sc) {
      results.push(dec)
      continue
    }

    const isGraphic =
      dec.type !== 'stock_video' &&
      dec.type !== 'stock_image' &&
      dec.type !== 'photo_parallax'

    if (!isGraphic) {
      dec.enabled = true
      results.push(dec)
      continue
    }

    // 1. Check max density quota
    if (graphicCount >= maxAllowedGraphics) {
      dec.enabled = false
      dec.reason += ' (disabled: reached max 25% density limit)'
      results.push(dec)
      continue
    }

    // 2. Check consecutive full graphic cards
    if (
      lastGraphicType !== 'stock_video' &&
      lastGraphicType !== 'stock_image' &&
      lastGraphicType !== 'photo_parallax' &&
      dec.type !== 'chapter_title' &&
      lastGraphicType !== 'chapter_title'
    ) {
      dec.enabled = false
      dec.reason += ' (disabled: anti-clutter rule — avoid consecutive graphic cards)'
      results.push(dec)
      continue
    }

    // 3. Check min spacing rule (6s)
    const proposedStartTime = sc.startTime + dec.startOffset
    if (proposedStartTime - lastGraphicEndTime < minSpacingSecs && dec.type !== 'chapter_title') {
      dec.enabled = false
      dec.reason += ` (disabled: min ${minSpacingSecs}s spacing from previous graphic)`
      results.push(dec)
      continue
    }

    // 4. Collision check with big_statement captions
    if (captionPlan?.phrases) {
      const collision = captionPlan.phrases.some((p) => {
        if (p.presetType === 'big_statement' || p.emphasisType === 'hook') {
          const pStart = p.startTime
          const pEnd = p.endTime
          const gStart = proposedStartTime
          const gEnd = proposedStartTime + dec.duration
          return Math.max(pStart, gStart) < Math.min(pEnd, gEnd)
        }
        return false
      })
      if (collision) {
        dec.enabled = false
        dec.reason += ' (disabled: collision avoidance with prominent kinetic caption)'
        results.push(dec)
        continue
      }
    }

    // 5. Collision check with ProofVisuals
    if (proofVisuals) {
      const proofCollision = proofVisuals.some((pv) => {
        if (pv.absoluteStartTime != null && pv.absoluteEndTime != null) {
          const pvStart = pv.absoluteStartTime
          const pvEnd = pv.absoluteEndTime
          const gStart = proposedStartTime
          const gEnd = proposedStartTime + dec.duration
          return Math.max(pvStart, gStart) < Math.min(pvEnd, gEnd)
        }
        return false
      })
      if (proofCollision) {
        dec.enabled = false
        dec.reason += ' (disabled: avoided duplicate overlay with active proof visual)'
        results.push(dec)
        continue
      }
    }

    // Approved graphic card
    dec.enabled = true
    lastGraphicEndTime = proposedStartTime + dec.duration
    lastGraphicType = dec.type
    graphicCount++
    results.push(dec)
  }

  return results
}

// ─── Plan Generation & Persistence ─────────────────────────────────────────────

export interface GenerateVisualGrammarParams {
  projectDir: string
  editPlan: unknown
  captionPlan?: CaptionPlan
  proofVisuals?: ProofVisual[]
  settings?: ProductionIntelligenceSettings
}

export function generateVisualGrammarPlan(params: GenerateVisualGrammarParams): VisualGrammarPlan {
  const { projectDir, editPlan, captionPlan, proofVisuals } = params
  const prodSettings = params.settings ?? loadProductionSettings(projectDir)

  const flattened = flattenEditPlanScenes<{
    narrativeText?: string
    visualIntent?: string
    startTime?: number
    endTime?: number
    duration?: number
    mediaType?: string
  }>(editPlan as Record<string, unknown>)

  const rawDecisions: VisualGrammarDecision[] = flattened.map((entry) => {
    const narration = entry.scene.narrativeText ?? ''
    const classification = classifyNarrationGrammar(narration, {
      isFirstInChapter: entry.isFirstInChapter,
      chapterTitle: entry.chapterTitle,
      sceneIndex: entry.sceneIndex,
      mediaType: entry.scene.mediaType
    })

    const duration = entry.scene.duration ?? ((entry.scene.endTime ?? 0) - (entry.scene.startTime ?? 0))
    const graphicDuration = Math.min(Math.max(2.5, duration * 0.6), 4.5)
    const startOffset = Math.min(0.5, Math.max(0, duration - graphicDuration))

    return {
      sceneId: entry.sceneId,
      sceneIndex: entry.sceneIndex,
      type: classification.type,
      confidence: classification.confidence,
      reason: classification.reason,
      primaryText: classification.primaryText,
      secondaryText: classification.secondaryText,
      sourceNarration: narration.slice(0, 100),
      startOffset,
      duration: graphicDuration,
      position: classification.position ?? 'bottom_right',
      enabled: prodSettings.enabled && prodSettings.visualSceneGrammarEnabled
    }
  })

  const sceneInfos = flattened.map((f) => ({
    sceneIndex: f.sceneIndex,
    startTime: f.scene.startTime ?? 0,
    endTime: f.scene.endTime ?? 0,
    duration: f.scene.duration ?? ((f.scene.endTime ?? 0) - (f.scene.startTime ?? 0))
  }))

  const finalDecisions = enforceGrammarDensityAndSpacing(
    rawDecisions,
    sceneInfos,
    prodSettings.maxVisualGrammarDensity || 0.25,
    6.0,
    captionPlan,
    proofVisuals
  )

  const activeGraphics = finalDecisions.filter(
    (d) =>
      d.enabled &&
      d.type !== 'stock_video' &&
      d.type !== 'stock_image' &&
      d.type !== 'photo_parallax'
  )

  const plan: VisualGrammarPlan = {
    version: 1,
    generatedAt: new Date().toISOString(),
    density: flattened.length > 0 ? activeGraphics.length / flattened.length : 0,
    totalScenes: flattened.length,
    graphicCount: activeGraphics.length,
    decisions: finalDecisions
  }

  // Persist plan atomically to analysis/visual-grammar-plan.json
  const planPath = join(projectDir, 'analysis', 'visual-grammar-plan.json')
  atomicWriteJson(planPath, plan)
  logger.info(
    `[VisualGrammar] Generated plan with ${activeGraphics.length}/${flattened.length} graphics (${Math.round(plan.density * 100)}% density)`
  )

  return plan
}

export function loadVisualGrammarPlan(projectDir: string): VisualGrammarPlan | null {
  const planPath = join(projectDir, 'analysis', 'visual-grammar-plan.json')
  if (!fs.existsSync(planPath)) return null
  return readJsonSafe<VisualGrammarPlan | null>(planPath, null)
}
