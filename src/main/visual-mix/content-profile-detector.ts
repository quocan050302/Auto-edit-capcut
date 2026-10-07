import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import type {
  ContentProfileMode,
  ResolvedContentProfile,
  ContentProfileDetection,
  GlobalScriptContext
} from '../../../shared/types'
import { resolveContentProfileMode } from '../../../shared/types'

export const CONTENT_PROFILE_SCHEMA_VERSION = 1

export interface RawSceneProfileInput {
  sceneIndex?: number
  narrativeText?: string
  narration?: string
  visualIntent?: string
  visualDescription?: string
}

export interface DetectContentProfileParams {
  projectDir: string
  scriptText?: string
  rawScenes?: RawSceneProfileInput[]
  globalContext?: GlobalScriptContext
  mode?: ContentProfileMode
  forceRefresh?: boolean
}

// ─── Semantic Signal Definitions (Section 19) ────────────────────────────────

const ANATOMICAL_ORGAN_SIGNALS = [
  'liver', 'kidney', 'kidneys', 'heart', 'brain', 'gut', 'lung', 'lungs',
  'pancreas', 'stomach', 'intestine', 'intestines', 'colon', 'gallbladder',
  'spleen', 'artery', 'arteries', 'vein', 'veins', 'bloodstream', 'blood vessel',
  'blood vessels', 'neuron', 'neurons', 'synapse', 'synapses', 'neurotransmitter',
  'microbiome', 'microbiota', 'cells', 'cellular', 'mitochondria', 'dna', 'rna'
]

const PHYSIOLOGICAL_MECHANISM_SIGNALS = [
  'physiology', 'physiological', 'metabolism', 'metabolic', 'insulin', 'glucose',
  'blood sugar', 'glycogen', 'insulin resistance', 'blood pressure', 'hypertension',
  'cholesterol', 'triglyceride', 'inflammation', 'inflammatory', 'oxidation',
  'oxidative stress', 'hormone', 'hormones', 'endocrine', 'cortisol', 'adrenaline',
  'melatonin', 'dopamine', 'serotonin', 'digestive process', 'digestion',
  'nutrient absorption', 'circadian rhythm', 'rem sleep', 'deep sleep', 'sleep cycle',
  'autophagy', 'apoptosis', 'immune system', 'pathogen', 'antibody', 'antibodies'
]

const CLINICAL_MEDICAL_SIGNALS = [
  'cardiovascular', 'gastrointestinal', 'neurological', 'biomarker', 'clinical trial',
  'clinical trials', 'pathology', 'pathological', 'symptom', 'symptoms',
  'medical diagnosis', 'human anatomy', 'anatomical structure', 'supplements',
  'micronutrient', 'micronutrients', 'electrolyte', 'electrolytes'
]

// Patterns that may use "health" in non-biological contexts
const FALSE_POSITIVE_TRIGGERS = [
  /\bfinancial health\b/i,
  /\beconomic health\b/i,
  /\bhealth of the economy\b/i,
  /\bcompany health\b/i,
  /\bbusiness health\b/i,
  /\bmarket health\b/i,
  /\bcommunity health\b/i,
  /\bpolitical health\b/i,
  /\bsystem health\b/i
]

/**
 * Returns the filepath for analysis/content-profile.json
 */
export function getContentProfilePath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'content-profile.json')
}

/**
 * Loads an existing content-profile.json artifact if present and valid.
 */
export function loadContentProfileArtifact(projectDir: string): ContentProfileDetection | null {
  const filePath = getContentProfilePath(projectDir)
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as ContentProfileDetection
    if (parsed && (parsed.resolvedProfile === 'health' || parsed.resolvedProfile === 'general')) {
      return parsed
    }
  } catch {
    /* ignore and recompute */
  }
  return null
}

/**
 * Persists the content-profile.json artifact atomically.
 */
export function saveContentProfileArtifact(
  projectDir: string,
  detection: ContentProfileDetection
): void {
  const analysisDir = path.join(projectDir, 'analysis')
  if (!fs.existsSync(analysisDir)) {
    fs.mkdirSync(analysisDir, { recursive: true })
  }
  const filePath = getContentProfilePath(projectDir)
  const tempPath = `${filePath}.${Date.now()}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(detection, null, 2), 'utf-8')
  fs.renameSync(tempPath, filePath)
}

/**
 * Pure heuristic evaluator that analyzes text and global context signals to
 * determine if content is substantially Health or General.
 */
export function evaluateContentProfileSemantics(params: {
  scriptText?: string
  scenes?: RawSceneProfileInput[]
  globalContext?: GlobalScriptContext
}): {
  resolvedProfile: ResolvedContentProfile
  confidence: number
  reasons: string[]
  detectedSignals: string[]
} {
  const { scriptText = '', scenes = [], globalContext } = params

  // Aggregate narrative and visual intent text
  const sceneTexts = scenes.map((s) => `${s.narrativeText ?? s.narration ?? ''} ${s.visualIntent ?? s.visualDescription ?? ''}`)
  const combinedText = `${scriptText} ${sceneTexts.join(' ')}`.toLowerCase()

  // Extract signals from GlobalScriptContext if present
  const gSubject = (globalContext?.primarySubject || '').toLowerCase()
  const gThesis = (globalContext?.centralThesis || '').toLowerCase()
  const gAnchors = (globalContext?.exactTopicAnchors || []).map((a) => a.toLowerCase()).join(' ')
  const gContextCombined = `${gSubject} ${gThesis} ${gAnchors}`

  // Detect individual signals
  const foundSignals = new Set<string>()

  const allSignalList = [
    ...ANATOMICAL_ORGAN_SIGNALS,
    ...PHYSIOLOGICAL_MECHANISM_SIGNALS,
    ...CLINICAL_MEDICAL_SIGNALS
  ]

  let totalSignalOccurrences = 0
  for (const signal of allSignalList) {
    // Word boundary search
    const regex = new RegExp(`\\b${signal.replace(/\s+/g, '\\s+')}\\b`, 'gi')
    const matchesInText = combinedText.match(regex)
    const matchesInGlobal = gContextCombined.match(regex)
    const count = (matchesInText?.length || 0) + (matchesInGlobal?.length ? matchesInGlobal.length * 2 : 0)

    if (count > 0) {
      foundSignals.add(signal)
      totalSignalOccurrences += count
    }
  }

  // Check for false positive triggers (financial / economic / company health)
  let falsePositiveHits = 0
  for (const fpRegex of FALSE_POSITIVE_TRIGGERS) {
    if (fpRegex.test(combinedText)) {
      falsePositiveHits++
    }
  }

  const detectedSignals = Array.from(foundSignals)
  const reasons: string[] = []

  // Check organ and mechanism diversity
  const organHits = ANATOMICAL_ORGAN_SIGNALS.filter((s) => foundSignals.has(s))
  const mechanismHits = PHYSIOLOGICAL_MECHANISM_SIGNALS.filter((s) => foundSignals.has(s))
  const clinicalHits = CLINICAL_MEDICAL_SIGNALS.filter((s) => foundSignals.has(s))

  // Determine if Global Context specifically names an organ or physiology topic
  const isGlobalSubjectMedical =
    ANATOMICAL_ORGAN_SIGNALS.some((s) => gSubject.includes(s)) ||
    PHYSIOLOGICAL_MECHANISM_SIGNALS.some((s) => gSubject.includes(s))

  // Health Decision Criteria (Section 19):
  // Substantially about human anatomy, physiology, organs, nutrition mechanisms, sleep physiology, blood pressure, etc.
  // Distinct signals count >= 3, or organ + mechanism present, or strong global medical subject.
  const hasStrongOrganPresence = organHits.length >= 2
  const hasStrongMechanism = mechanismHits.length >= 2
  const hasDiverseSignals = (organHits.length > 0 && mechanismHits.length > 0) || detectedSignals.length >= 4
  const isHeavySignalDensity = totalSignalOccurrences >= 5 && detectedSignals.length >= 2

  const isHealth =
    (hasDiverseSignals || isGlobalSubjectMedical || (hasStrongOrganPresence && isHeavySignalDensity)) &&
    !(falsePositiveHits > 0 && detectedSignals.length < 3)

  if (isHealth) {
    if (organHits.length > 0) {
      reasons.push(`Identified biological/anatomical organs: ${organHits.slice(0, 5).join(', ')}`)
    }
    if (mechanismHits.length > 0) {
      reasons.push(`Detected physiological and metabolic mechanisms: ${mechanismHits.slice(0, 5).join(', ')}`)
    }
    if (clinicalHits.length > 0) {
      reasons.push(`Referenced clinical or medical context: ${clinicalHits.slice(0, 4).join(', ')}`)
    }
    if (isGlobalSubjectMedical) {
      reasons.push(`Global script context primary subject (${globalContext?.primarySubject}) centers on human physiology`)
    }
    if (reasons.length === 0) {
      reasons.push(`Detected ${detectedSignals.length} distinct biological/physiological signals throughout script`)
    }

    // Confidence scaling between 0.82 and 0.98
    const confidence = Math.min(0.98, Math.max(0.82, 0.80 + detectedSignals.length * 0.03 + (isGlobalSubjectMedical ? 0.08 : 0)))

    return {
      resolvedProfile: 'health',
      confidence: Math.round(confidence * 100) / 100,
      reasons,
      detectedSignals
    }
  }

  // Otherwise: General profile (Section 20)
  if (falsePositiveHits > 0) {
    reasons.push('Health terminology appears in metaphorical or financial/economic context')
  } else if (detectedSignals.length === 0) {
    reasons.push('No anatomical organs, clinical terms or physiological mechanisms detected')
  } else {
    reasons.push(
      `Isolated mentions (${detectedSignals.slice(0, 3).join(', ')}) insufficient to establish medical/physiological focus`
    )
  }
  reasons.push('Script narrative aligns with general documentary style (history, society, tech, culture, nature, or lifestyle)')

  const confidence = Math.min(0.98, Math.max(0.88, 0.98 - detectedSignals.length * 0.03))

  return {
    resolvedProfile: 'general',
    confidence: Math.round(confidence * 100) / 100,
    reasons,
    detectedSignals
  }
}

/**
 * Main Auto Content Profile Detector entrypoint (Section 18, 21, 22).
 * Reads script, edit plan, and global context; caches result in analysis/content-profile.json.
 */
export async function detectOrResolveContentProfile(
  params: DetectContentProfileParams
): Promise<ContentProfileDetection> {
  const { projectDir, forceRefresh = false } = params
  const mode = params.mode ?? 'auto'

  // If user explicitly configured an override:
  if (mode === 'health' || mode === 'general') {
    const overrideDetection: ContentProfileDetection = {
      schemaVersion: CONTENT_PROFILE_SCHEMA_VERSION,
      mode,
      resolvedProfile: mode,
      confidence: 1.0,
      reasons: [`Explicit user profile mode override: ${mode}`],
      detectedSignals: [],
      generatedAt: new Date().toISOString()
    }
    saveContentProfileArtifact(projectDir, overrideDetection)
    logger.info(`[ContentProfile] Explicit profile override applied: ${mode}`)
    return overrideDetection
  }

  // Check existing cached artifact unless forceRefresh is true (Section 21 & 22)
  if (!forceRefresh) {
    const cached = loadContentProfileArtifact(projectDir)
    if (cached && cached.mode === 'auto') {
      logger.info(`[ContentProfile] Reusing cached profile detection: ${cached.resolvedProfile} (confidence=${cached.confidence})`)
      return cached
    }
  }

  // Load script text from disk if not directly passed
  let scriptText = params.scriptText ?? ''
  if (!scriptText) {
    const possibleScriptPaths = [
      path.join(projectDir, 'source', 'script.txt'),
      path.join(projectDir, 'source', 'script.md'),
      path.join(projectDir, 'analysis', 'script.txt')
    ]
    for (const p of possibleScriptPaths) {
      if (fs.existsSync(p)) {
        try {
          scriptText = fs.readFileSync(p, 'utf-8')
          break
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Load edit plan scenes from disk if not passed
  let rawScenes = params.rawScenes
  if (!rawScenes) {
    const planPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
    if (fs.existsSync(planPath)) {
      try {
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
        const scenes: RawSceneProfileInput[] = []
        for (const ch of plan.chapters || []) {
          const seqs = ch.chapters_seq ?? ch.sequences ?? []
          for (const seq of seqs) {
            for (const sc of seq.scenes || []) {
              scenes.push({
                sceneIndex: sc.sceneIndex,
                narrativeText: sc.narrativeText ?? sc.narration ?? '',
                visualIntent: sc.visualIntent ?? sc.visualDescription ?? ''
              })
            }
          }
        }
        rawScenes = scenes
      } catch {
        /* ignore */
      }
    }
  }

  // Load global script context from disk if not passed
  let globalContext = params.globalContext
  if (!globalContext) {
    const ctxPath = path.join(projectDir, 'analysis', 'global-script-context.json')
    if (fs.existsSync(ctxPath)) {
      try {
        globalContext = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'))
      } catch {
        /* ignore */
      }
    }
  }

  const evaluation = evaluateContentProfileSemantics({
    scriptText,
    scenes: rawScenes,
    globalContext
  })

  const detection: ContentProfileDetection = {
    schemaVersion: CONTENT_PROFILE_SCHEMA_VERSION,
    mode: 'auto',
    resolvedProfile: evaluation.resolvedProfile,
    confidence: evaluation.confidence,
    reasons: evaluation.reasons,
    detectedSignals: evaluation.detectedSignals,
    generatedAt: new Date().toISOString()
  }

  saveContentProfileArtifact(projectDir, detection)

  logger.info(
    `[ContentProfile] Auto-detected profile: ${detection.resolvedProfile} (confidence=${detection.confidence}, signals=[${detection.detectedSignals.slice(0, 6).join(', ')}])`
  )

  return detection
}
