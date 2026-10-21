import type {
  GlobalScriptContext,
  VisualMixScenePlan
} from '../../../../shared/types'
import type {
  ManualAiSceneDirection
} from './manual-ai-types'
import type { VisualIdentityBible } from '../../content-intelligence/visual-identity-types'
import {
  type EditorialGenerationSettings,
  DEFAULT_EDITORIAL_SETTINGS
} from './editorial-focus-settings'

// ─── Universal Editorial Focus Types ──────────────────────────────────────────

export type EditorialPresentationMode = 'none' | 'single-label' | 'comparison'
export type EditorialAnimation = 'fade-in' | 'focus-pop' | 'line-draw' | 'soft-slide' | 'reveal-hold'
export type EditorialLabelPosition = 'top-left' | 'top-right' | 'center-left' | 'center-right'
export type EditorialReadabilityProfile = 'standard' | 'senior-friendly'

export interface EditorialFocusInstruction {
  sceneIndex: number
  presentationMode: EditorialPresentationMode
  exactText?: string
  secondaryText?: string
  focusTarget?: string
  focusPurpose?: string
  labelPosition?: EditorialLabelPosition
  leaderLine?: boolean
  highlightTarget?: boolean
  animation?: EditorialAnimation
  appearanceTimeSecs?: number
  holdDurationSecs?: number
  language?: string
  readabilityProfile?: EditorialReadabilityProfile
  confidence: number
  evidenceSource: string
  reason?: string
  warnings: string[]
}

export interface ResolveEditorialFocusParams {
  scene: VisualMixScenePlan
  sceneDirection?: ManualAiSceneDirection
  globalContext?: GlobalScriptContext
  identityBible?: VisualIdentityBible
  niche: string
  durationSecs: number
  previousInstructions?: EditorialFocusInstruction[]
  settings?: EditorialGenerationSettings
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanText(text: any): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/["'`]/g, '')
    .replace(/[^\p{L}\p{N}\s,.\-:;%()/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

const COMMON_ABBREVIATIONS = new Set([
  'DNA', 'RNA', 'MRI', 'CT', 'ECG', 'EKG', 'AI', 'CPU', 'GPU', 'RAM',
  'CNC', 'GPS', 'LED', 'LCD', 'UHD', 'NASA', 'ESA', 'FDA', 'WHO', 'USD',
  'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CNY', 'ROI', 'GDP', 'B2B', 'SaaS'
])

function capitalizeWord(word: string, isFirst: boolean, lowerWords: Set<string>): string {
  if (!word) return ''
  const upper = word.toUpperCase()
  if (COMMON_ABBREVIATIONS.has(upper)) return upper
  const stripped = word.replace(/[^a-zA-Z0-9]/g, '')
  if (COMMON_ABBREVIATIONS.has(stripped.toUpperCase())) {
    return word.toUpperCase()
  }
  const lower = word.toLowerCase()
  if (!isFirst && lowerWords.has(lower)) {
    return lower
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function toEditorialTitleCase(text: string): string {
  const words = text.split(/\s+/).filter(Boolean)
  const lowerWords = new Set(['and', 'or', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'as', 'via', 'vs', 'vs.'])

  return words
    .map((word, i) => {
      if (word.includes('-')) {
        return word
          .split('-')
          .map((sub, subIdx) => capitalizeWord(sub, i === 0 && subIdx === 0, lowerWords))
          .join('-')
      }
      return capitalizeWord(word, i === 0, lowerWords)
    })
    .join(' ')
}

const ABSTRACT_CONCEPTS_REGEX =
  /\b(concept|principle|idea|trend|inflation|growth|cooperation|unity|longevity|efficiency|tradition|faith|philosophy|strategy|future|past|legacy|mindset|culture)\b/i

const HEALTH_EXCLUSIVE_TERMS =
  /\b(cellular|mitochondria|alveoli|coronary|myocardial|artery|vein|organ|tissue|biological|pathogen|enzyme|diagnosis|symptom|bloodstream)\b/i

const AMISH_STEREOTYPE_TERMS =
  /\b(amish|horse\s*buggy|buggy|horse-drawn|bonnet|straw\s*hat|quaint|primitive|pre-industrial)\b/i

const HUMAN_CLINICAL_TERMS =
  /\b(human\s*patient|clinical\s*trial|hospital\s*bed|patient|surgeon|stethoscope)\b/i

function isBiologicalOrHealthNiche(niche: string): boolean {
  const norm = (niche || '').toLowerCase()
  return (
    norm === 'health' ||
    norm.includes('wildlife') ||
    norm.includes('biology') ||
    norm.includes('nature') ||
    norm.includes('animal') ||
    norm.includes('zoology') ||
    norm.includes('veterinary')
  )
}

// ─── Content Resolver ────────────────────────────────────────────────────────

interface FocusContentResult {
  presentationMode: EditorialPresentationMode
  exactText?: string
  secondaryText?: string
  focusTarget?: string
  focusPurpose?: string
  evidenceSource: string
  confidence: number
  reason?: string
  warnings: string[]
}

function resolveFocusContent(params: ResolveEditorialFocusParams): FocusContentResult {
  const { scene, sceneDirection, globalContext, niche, previousInstructions, settings } = params
  const warnings: string[] = []

  // Check recent instructions to avoid consecutive duplicate labels
  const recent = previousInstructions && previousInstructions.length > 0
    ? previousInstructions[previousInstructions.length - 1]
    : null
  const priorRecent = previousInstructions && previousInstructions.length > 1
    ? previousInstructions[previousInstructions.length - 2]
    : null

  // 1. Check existing sceneDirection.textOverlay first (highest fidelity grounded intelligence)
  if (sceneDirection?.textOverlay?.enabled && sceneDirection.textOverlay.text) {
    const rawText = cleanText(sceneDirection.textOverlay.text)
    if (rawText.length > 0) {
      // Validate that candidate text does not contain unsupported numbers
      const hasNumber = /\d/.test(rawText)
      const numberInContext =
        /\d/.test(scene.narration) || (globalContext && /\d/.test(globalContext.centralThesis || ''))
      if (hasNumber && !numberInContext) {
        warnings.push(`Suppressed invented numerical text: "${rawText}"`)
      } else {
        // Semantic cross-niche guard
        if (niche !== 'health' && HEALTH_EXCLUSIVE_TERMS.test(rawText)) {
          warnings.push(`Cross-niche guard: suppressed medical terminology in ${niche} scene: "${rawText}"`)
        } else if (niche === 'hutterite-documentary' && AMISH_STEREOTYPE_TERMS.test(rawText)) {
          warnings.push(`Hutterite authenticity guard: suppressed Amish stereotype in text: "${rawText}"`)
        } else if (niche === 'nature' && HUMAN_CLINICAL_TERMS.test(rawText)) {
          warnings.push(`Nature guard: suppressed human clinical term in wildlife scene: "${rawText}"`)
        } else {
          const formatted = toEditorialTitleCase(rawText)

          // Deduplication: do not repeat exact same text consecutively
          if (recent?.exactText && recent.exactText.toLowerCase() === formatted.toLowerCase()) {
            return {
              presentationMode: 'none',
              evidenceSource: 'deduplication',
              confidence: 0.9,
              reason: 'Suppressed consecutive duplicate label',
              warnings
            }
          }

          // Target determination
          let focusTarget = cleanText(sceneDirection.visualEvent?.subject)
          if (!focusTarget && sceneDirection.composition?.focalPriority) {
            focusTarget = cleanText(sceneDirection.composition.focalPriority)
          }
          if (!focusTarget) {
            focusTarget = formatted
          }

          // Check for comparison
          const isComparison =
            sceneDirection.textOverlay.purpose === 'comparison' ||
            /\b(vs\.?|versus|compared\s+to|while)\b/i.test(scene.narration)

          let secondaryText: string | undefined
          if (isComparison && /\s+vs\.?\s+/i.test(formatted)) {
            const parts = formatted.split(/\s+vs\.?\s+/i)
            if (parts.length === 2) {
              return {
                presentationMode: 'comparison',
                exactText: parts[0].trim(),
                secondaryText: parts[1].trim(),
                focusTarget,
                focusPurpose: 'comparison',
                evidenceSource: 'sceneDirection.textOverlay',
                confidence: sceneDirection.confidence || 0.95,
                reason: sceneDirection.textOverlay.reason || 'Visual Director comparative overlay',
                warnings
              }
            }
          }

          return {
            presentationMode: 'single-label',
            exactText: formatted,
            secondaryText,
            focusTarget,
            focusPurpose: sceneDirection.textOverlay.purpose || 'mechanism',
            evidenceSource: 'sceneDirection.textOverlay',
            confidence: sceneDirection.confidence || 0.9,
            reason: sceneDirection.textOverlay.reason || 'Visual Director grounded textOverlay',
            warnings
          }
        }
      }
    }
  }

  // 2. If textOverlay is disabled or missing, check if editorial settings justify a grounded label
  const density = settings?.labelDensity || 'minimal'

  // Minimal mode: strictly default to none when no explicit textOverlay was enabled
  if (density === 'minimal') {
    return {
      presentationMode: 'none',
      evidenceSource: 'minimal-density-default',
      confidence: 1.0,
      reason: 'Minimal label density: no overlay explicitly commanded',
      warnings
    }
  }

  // Balanced mode: evaluate whether this scene contains a concrete visible object or mechanism
  // Guard: Avoid 3 consecutive labeled scenes
  if (
    recent &&
    recent.presentationMode &&
    recent.presentationMode !== 'none' &&
    priorRecent &&
    priorRecent.presentationMode &&
    priorRecent.presentationMode !== 'none'
  ) {
    return {
      presentationMode: 'none',
      evidenceSource: 'density-pacing-guard',
      confidence: 0.9,
      reason: 'Preventing more than 2 consecutive scenes from having labels',
      warnings
    }
  }

  // Extract candidate grounded focal subject
  const subjectCandidate =
    cleanText(sceneDirection?.visualEvent?.subject) ||
    cleanText(scene.visualIntent?.split(/[,.;]/)[0])

  if (!subjectCandidate || countWords(subjectCandidate) > 5 || countWords(subjectCandidate) < 1) {
    return {
      presentationMode: 'none',
      evidenceSource: 'insufficient-grounding',
      confidence: 0.85,
      reason: 'Scene lacks a short grounded visual focal subject',
      warnings
    }
  }

  // Guard: Reject generic or abstract nouns
  if (ABSTRACT_CONCEPTS_REGEX.test(subjectCandidate)) {
    return {
      presentationMode: 'none',
      evidenceSource: 'abstract-subject-guard',
      confidence: 0.9,
      reason: 'Subject is abstract; clean documentary shot without text preferred',
      warnings
    }
  }

  // Guard: Cross-niche semantic filters
  // 1. Human clinical terms are strictly excluded outside health documentaries
  if (niche !== 'health' && HUMAN_CLINICAL_TERMS.test(subjectCandidate)) {
    return {
      presentationMode: 'none',
      evidenceSource: 'cross-niche-guard',
      confidence: 0.95,
      reason: 'Human clinical terms excluded outside health domain',
      warnings
    }
  }

  // 2. Biological / anatomical terms are excluded from non-biological niches (finance, tech, history, agriculture)
  if (!isBiologicalOrHealthNiche(niche) && HEALTH_EXCLUSIVE_TERMS.test(subjectCandidate)) {
    return {
      presentationMode: 'none',
      evidenceSource: 'cross-niche-guard',
      confidence: 0.95,
      reason: 'Biological terminology excluded outside health and life science domains',
      warnings
    }
  }

  // 3. Prevent Amish stereotypes in Hutterite documentary
  if (niche === 'hutterite-documentary' && AMISH_STEREOTYPE_TERMS.test(subjectCandidate)) {
    return {
      presentationMode: 'none',
      evidenceSource: 'hutterite-authenticity-guard',
      confidence: 0.95,
      reason: 'Stereotype term prevented',
      warnings
    }
  }

  const formattedLabel = toEditorialTitleCase(subjectCandidate)

  // Deduplication check
  if (recent?.exactText && recent.exactText.toLowerCase() === formattedLabel.toLowerCase()) {
    return {
      presentationMode: 'none',
      evidenceSource: 'deduplication',
      confidence: 0.9,
      reason: 'Suppressed consecutive duplicate label',
      warnings
    }
  }

  return {
    presentationMode: 'single-label',
    exactText: formattedLabel,
    focusTarget: subjectCandidate,
    focusPurpose: sceneDirection?.sceneRole || 'visual-focus',
    evidenceSource: 'scene.visualIntent',
    confidence: 0.8,
    reason: 'Balanced density grounded visual subject label',
    warnings
  }
}

// ─── Presentation Resolver ───────────────────────────────────────────────────

function resolveFocusPresentation(
  content: FocusContentResult,
  params: ResolveEditorialFocusParams
): EditorialFocusInstruction {
  const { scene, sceneDirection, durationSecs, settings } = params
  const sceneDuration = durationSecs > 0 ? durationSecs : 5

  if (content.presentationMode === 'none' || !content.exactText) {
    return {
      sceneIndex: scene.sceneIndex,
      presentationMode: 'none',
      confidence: content.confidence,
      evidenceSource: content.evidenceSource,
      reason: content.reason,
      warnings: content.warnings
    }
  }

  const readabilityProfile: EditorialReadabilityProfile =
    settings?.readability === 'senior-friendly' ? 'senior-friendly' : 'standard'

  // Position: use existing sceneDirection position or pick safe default
  let labelPosition: EditorialLabelPosition = 'top-left'
  if (sceneDirection?.textOverlay?.position) {
    labelPosition = sceneDirection.textOverlay.position
  } else if (scene.sceneIndex % 2 === 1) {
    labelPosition = 'top-right'
  }

  // Leader line & highlight target
  const isAbstract = ABSTRACT_CONCEPTS_REGEX.test(content.focusTarget || '')
  const preferLeader = settings?.preferLeaderLines !== false
  const leaderLine = preferLeader && !isAbstract && content.presentationMode !== 'comparison'
  const highlightTarget = !isAbstract && content.presentationMode !== 'comparison'

  // Animation selection based on meaning & readability profile
  let animation: EditorialAnimation = 'fade-in'
  if (readabilityProfile === 'senior-friendly') {
    // Senior-friendly avoids rapid pop or bounce; prefers steady line-draw or smooth fade
    animation = leaderLine ? 'line-draw' : 'fade-in'
  } else {
    if (content.focusPurpose === 'reveal' || content.focusPurpose === 'mechanism') {
      animation = 'reveal-hold'
    } else if (content.focusPurpose === 'hook') {
      animation = 'focus-pop'
    } else if (content.presentationMode === 'comparison') {
      animation = 'soft-slide'
    } else if (leaderLine) {
      animation = 'line-draw'
    } else {
      animation = 'fade-in'
    }
  }

  // Timing: calculate appearance and hold duration strictly respecting scene duration
  // Timeline constraints:
  // appearanceTimeSecs >= 0
  // holdDurationSecs >= 0
  // appearanceTimeSecs + holdDurationSecs <= sceneDuration
  const rawAppearance =
    scene.sceneIndex <= 2
      ? 0.3
      : Math.min(0.6, Math.max(0.2, Number((sceneDuration * 0.12).toFixed(2))))

  // If scene is very short (e.g. <= 1.5s), clamp appearance to at most 15% of scene duration
  const appearanceTimeSecs =
    sceneDuration <= 1.5
      ? Math.max(0.05, Number((sceneDuration * 0.15).toFixed(2)))
      : Math.min(rawAppearance, Math.max(0.2, Number((sceneDuration - 0.5).toFixed(2))))

  // Allocate remaining window for hold
  const availableTime = Math.max(0, Number((sceneDuration - appearanceTimeSecs).toFixed(2)))
  // Leave exit cushion if scene is long enough
  const exitCushion = sceneDuration > 2.0 ? 0.3 : 0.05
  const maxHold = Math.max(0, Number((availableTime - exitCushion).toFixed(2)))

  const targetHold = readabilityProfile === 'senior-friendly' ? 3.0 : 2.5
  let holdDurationSecs = Math.min(3.5, Math.min(targetHold, maxHold))

  if (holdDurationSecs <= 0 && availableTime > 0.2) {
    holdDurationSecs = Number((availableTime * 0.8).toFixed(2))
  }
  // Hard clamp invariant
  if (appearanceTimeSecs + holdDurationSecs > sceneDuration) {
    holdDurationSecs = Math.max(0, Number((sceneDuration - appearanceTimeSecs).toFixed(2)))
  }

  return {
    sceneIndex: scene.sceneIndex,
    presentationMode: content.presentationMode,
    exactText: content.exactText,
    secondaryText: content.secondaryText,
    focusTarget: content.focusTarget,
    focusPurpose: content.focusPurpose,
    labelPosition,
    leaderLine,
    highlightTarget,
    animation,
    appearanceTimeSecs,
    holdDurationSecs,
    language: 'en',
    readabilityProfile,
    confidence: content.confidence,
    evidenceSource: content.evidenceSource,
    reason: content.reason,
    warnings: content.warnings
  }
}

// ─── Public Generic Editorial Resolver ───────────────────────────────────────

/**
 * Universal, deterministic, domain-independent Editorial Focus Resolver.
 * Uses grounded scene narration, visualIntent, and existing textOverlay metadata.
 * Works seamlessly with all existing and unknown future niches.
 */
export function resolveEditorialFocus(params: ResolveEditorialFocusParams): EditorialFocusInstruction {
  const content = resolveFocusContent(params)
  return resolveFocusPresentation(content, params)
}
