import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../logger'
import type {
  AiImageOutputResolution,
  GlobalScriptContext,
  VisualMixProfile,
  VisualMixScenePlan
} from '../../../../shared/types'
import {
  type ManualAiVisualBrief,
  type ManualAiSceneDirection,
  getVisualMixPlanFilePath,
  getManualAiSceneDirectionsPath,
  getManualAiVisualBriefPath
} from './manual-ai-types'
import {
  sanitizePromptLine,
  formatSceneLabel,
  loadManualAiPromptPack
} from './manual-ai-prompt-pack'
import {
  detectVideoNiche,
  type VideoVisualNiche,
  VIDEO_NICHE_DIRECTIVES,
  resolveVideoCameraMotion,
  ensureManualAiVideoPromptPack
} from './manual-ai-video-prompt-pack'
import {
  resolveVideoSubjectGrounding,
  type VideoSubjectGrounding
} from './manual-ai-video-subject-grounding'
import { loadVisualIdentityBible } from '../../content-intelligence/visual-identity-bible'
import type { VisualIdentityBible } from '../../content-intelligence/visual-identity-types'
import type { RetentionPlan, RetentionScenePlan } from '../../retention/retention-types'

// ─── Universal Opening Hook Types ───────────────────────────────────────────

export type OpeningHookArchetype =
  | 'unusual-detail'
  | 'scale-contrast'
  | 'hidden-mechanism'
  | 'unexpected-perspective'
  | 'visible-consequence'
  | 'before-after-tension'
  | 'evidence-reveal'
  | 'physical-contrast'
  | 'process-at-critical-moment'
  | 'mystery-object'

export interface OpeningVisualHookBlueprint {
  sceneIndex: number
  openingRank: number
  canonicalSubject: string
  niche: string
  sceneNarration: string
  visualIntent: string
  hookArchetype: OpeningHookArchetype
  visualFocalPoint: string
  strikingDetail: string
  visibleAction: string
  viewerQuestion: string
  shotType: string
  cameraAngle: string
  lighting: string
  revealInstruction?: string
  requiredIdentityTraits: string[]
  forbiddenSubstitutions: string[]
  evidenceSource: string
  confidence: number
}

export interface OpeningHookQualityResult {
  score: number // 0-100
  passed: boolean
  dimensions: {
    subjectSpecificity: number
    grounding: number
    unusualDetail: number
    focalClarity: number
    visibleActionOrMoment: number
    visualContrast: number
    cameraPlausibility: number
    noveltyRelative: number
    accuracy: number
    absenceOfContradictions: number
  }
  reasons: string[]
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

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return words.join(' ')
  return words.slice(0, maxWords).join(' ').replace(/[,.;:\-]+$/, '')
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

// ─── Universal Niche Anchor Templates ────────────────────────────────────────

interface NicheOpeningDetails {
  defaultArchetype: OpeningHookArchetype
  lighting: string
  realismDirective: string
  questionTemplate: string
  forbiddenKeywords: string[]
}

const NICHE_OPENING_PROFILES: Record<string, NicheOpeningDetails> = {
  'hutterite-documentary': {
    defaultArchetype: 'unusual-detail',
    lighting: 'natural crisp prairie morning daylight with directional rim illumination and long soft shadows',
    realismDirective: 'authentic contemporary communal agrarian life, practical communal workwear, modern large-scale farm equipment',
    questionTemplate: 'Why does this modern communal agrarian system rely on this specific coordinated practice?',
    forbiddenKeywords: ['Amish horse and buggy', 'quaint horse buggy', 'straw bonnet', 'primitive technology', 'religious cult drama']
  },
  health: {
    defaultArchetype: 'hidden-mechanism',
    lighting: 'clean clinical medical lighting with cool deep navy gradient and gentle biological volumetric depth',
    realismDirective: 'anatomically accurate biological structures, realistic fluid dynamics and cellular transport mechanics',
    questionTemplate: 'What unseen physiological mechanism regulates this critical biological exchange?',
    forbiddenKeywords: ['fake diagnostic readouts', 'cartoonish 3D organs', 'exaggerated disease gore', 'speculative molecular diagrams']
  },
  history: {
    defaultArchetype: 'evidence-reveal',
    lighting: 'raking golden-hour daylight accentuating aged surface texture with deep natural shadows',
    realismDirective: 'period-accurate material culture, authentic historical artifacts, weathered physical documents and era-specific craftsmanship',
    questionTemplate: 'What crucial historical reality is recorded in this surviving physical artifact?',
    forbiddenKeywords: ['modern synthetic fabrics', 'anachronistic technology', 'fictional dramatic reenactment posing as archival evidence']
  },
  finance: {
    defaultArchetype: 'scale-contrast',
    lighting: 'crisp architectural daylight with refined glass reflections and balanced ambient contrast',
    realismDirective: 'institutional corporate realism, tangible business operations, real physical documentation and high-stakes operational environments',
    questionTemplate: 'How does this granular physical transaction reflect the immense scale of modern market operations?',
    forbiddenKeywords: ['floating green currency holograms', 'fake explosive trading graphs', 'cartoon money stacks']
  },
  food: {
    defaultArchetype: 'process-at-critical-moment',
    lighting: 'soft directional window daylight accentuating fresh moisture, steam, and crisp culinary texture',
    realismDirective: 'authentic culinary documentary realism, tangible ingredient textures, genuine thermal steam and knife precision',
    questionTemplate: 'What delicate physical transformation occurs at this exact culinary instant?',
    forbiddenKeywords: ['cartoon food animation', 'unnatural floating ingredients', 'neon saturated artificial colors']
  },
  technology: {
    defaultArchetype: 'hidden-mechanism',
    lighting: 'cool balanced laboratory illumination with subtle functional status LEDs and clean specular reflections',
    realismDirective: 'authentic engineering mechanisms, precise robotic movements, tangible silicon or machined hardware components',
    questionTemplate: 'What precise mechanical coordination allows this complex automated process to operate?',
    forbiddenKeywords: ['sci-fi holographic grids', 'hallucinated floating code', 'impossible perpetual motion devices']
  },
  travel: {
    defaultArchetype: 'unexpected-perspective',
    lighting: 'warm atmospheric daylight with layered geographic depth and rich regional color fidelity',
    realismDirective: 'authentic location documentary realism, natural architectural weathering, genuine pedestrian movement',
    questionTemplate: 'What enduring cultural relationship is revealed through this specific physical vantage point?',
    forbiddenKeywords: ['staged tourist cliches', 'unrealistic saturated postcards', 'exaggerated exoticism']
  },
  nature: {
    defaultArchetype: 'unusual-detail',
    lighting: 'unfiltered natural ambient light with rich organic tones and dense ecological depth',
    realismDirective: 'authentic wildlife behavior, plausible natural geology and genuine ecological interaction',
    questionTemplate: 'How does this minute biological adaptation enable survival in this demanding habitat?',
    forbiddenKeywords: ['anthropomorphized animal behavior', 'artificial studio lighting', 'CGI creature movements']
  },
  documentary: {
    defaultArchetype: 'unusual-detail',
    lighting: 'natural documentary illumination with balanced contrast and authentic real-world color grade',
    realismDirective: 'observational documentary realism, candid human presence, authentic practical tools and unvarnished working environments',
    questionTemplate: 'What essential truth about this operation becomes evident when examined in close physical detail?',
    forbiddenKeywords: ['staged melodrama', 'sensationalized disaster effects', 'fake crisis scenarios']
  }
}

// ─── Archetype Rotation Matrix for First 10 Scenes ───────────────────────────

const RANK_DEFAULT_ARCHETYPES: Record<number, OpeningHookArchetype[]> = {
  1: ['unusual-detail', 'process-at-critical-moment', 'hidden-mechanism'],
  2: ['scale-contrast', 'physical-contrast', 'unexpected-perspective'],
  3: ['mystery-object', 'hidden-mechanism', 'before-after-tension'],
  4: ['process-at-critical-moment', 'evidence-reveal', 'visible-consequence'],
  5: ['visible-consequence', 'unusual-detail', 'hidden-mechanism'],
  6: ['unexpected-perspective', 'scale-contrast', 'physical-contrast'],
  7: ['physical-contrast', 'evidence-reveal', 'process-at-critical-moment'],
  8: ['visible-consequence', 'before-after-tension', 'mystery-object'],
  9: ['before-after-tension', 'hidden-mechanism', 'scale-contrast'],
  10: ['unusual-detail', 'process-at-critical-moment', 'visible-consequence']
}

const RANK_SHOT_TYPES: Record<number, { shotType: string; cameraAngle: string }> = {
  1: { shotType: 'extreme macro close-up focusing sharply on fine surface detail', cameraAngle: 'eye level perpendicular angle' },
  2: { shotType: 'low-angle medium three-quarter shot emphasizing scale contrast', cameraAngle: 'steep low angle looking upward' },
  3: { shotType: 'tight detail close-up concealing surrounding context', cameraAngle: 'focused 45-degree angle' },
  4: { shotType: 'medium observational tracking framing active physical interaction', cameraAngle: 'eye level steady three-quarter angle' },
  5: { shotType: 'macro close-up on physical engagement between tools and materials', cameraAngle: 'downward 60-degree close-range angle' },
  6: { shotType: 'elevated three-quarter overview revealing broader spatial context', cameraAngle: 'elevated 30-degree high angle' },
  7: { shotType: 'candid eye-level medium shot maintaining observational distance', cameraAngle: 'natural eye level profile' },
  8: { shotType: 'tight low-angle composition on tangible evidence or consequence', cameraAngle: 'ground-level low angle' },
  9: { shotType: 'dynamic medium tracking shot following purposeful physical progression', cameraAngle: 'slight low-angle three-quarter view' },
  10: { shotType: 'cinematic medium-wide progression with pronounced leading lines', cameraAngle: 'eye-level centered with deep vanishing perspective' }
}

// ─── Extract Grounded Focal Point from Scene ─────────────────────────────────

function extractGroundedFocalPoint(
  scene: VisualMixScenePlan,
  niche: string,
  grounding: VideoSubjectGrounding,
  sceneDirection?: ManualAiSceneDirection
): { focalPoint: string; strikingDetail: string; visibleAction: string } {
  const narration = cleanText(scene.narration)
  const intent = cleanText(scene.visualIntent)
  const text = `${intent} ${narration}`.toLowerCase()

  // 1. If scene direction provided a concrete visual event, prioritize it
  if (sceneDirection?.visualEvent?.subject && sceneDirection.visualEvent.action) {
    const s = cleanText(sceneDirection.visualEvent.subject)
    const a = cleanText(sceneDirection.visualEvent.action)
    const c = cleanText(sceneDirection.visualEvent.change || sceneDirection.visualEvent.consequence || 'sharp physical clarity')
    return {
      focalPoint: s,
      strikingDetail: c,
      visibleAction: a
    }
  }

  // 2. Niche-specific concrete focal extractors
  if (niche === 'hutterite-documentary') {
    if (/\b(pipe|water|winter|freeze|frozen|cold|frost|ice|subzero)\b/i.test(text)) {
      return {
        focalPoint: 'a heavy industrial brass water coupling valve encrusted in thick rime frost',
        focalDetail: 'translucent ice crystals forming along the valve threading with frozen condensation',
        visibleAction: 'a pair of insulated leather work gloves applying steady counter-pressure to free the iced fitting'
      } as any
    }
    if (/\b(kitchen|bake|baking|bread|dough|cook|meal|communal kitchen)\b/i.test(text)) {
      return {
        focalPoint: 'the colossal spiral steel mixing arm of a commercial colony dough kneader',
        strikingDetail: 'taut bands of sourdough stretching and folding under mechanical torque',
        visibleAction: 'dense flour dust puffing slightly as the heavy arm drives through hundred-pound dough batches'
      }
    }
    if (/\b(workshop|repair|weld|welding|machine|lathe|tool|hardware|metal)\b/i.test(text)) {
      return {
        focalPoint: 'a heavy combine hydraulic piston assembly mounted on a colony steel workbench',
        strikingDetail: 'a fresh bead of dark lubricating oil catching the reflection of fluorescent shop lighting',
        visibleAction: 'a machinist using a hardened micrometer to verify the machined steel cylinder tolerance'
      }
    }
    if (/\b(harvest|combine|tractor|field|prairie|grain|wheat|corn|crop)\b/i.test(text)) {
      return {
        focalPoint: 'the massive rotating threshing cylinder of a modern combine harvester',
        strikingDetail: 'chaff and golden wheat dust swirling across gleaming hardened steel tines',
        visibleAction: 'the heavy reel drawing grain heads smoothly into the feeder house in continuous motion'
      }
    }
    if (/\b(record|book|ledger|german|script|letter|history|ancestor|document)\b/i.test(text)) {
      return {
        focalPoint: 'a leather-bound colony communal ledger opened to handwritten Fraktur script',
        strikingDetail: 'faded black iron gall ink strokes on heavy cotton rag paper with ruled ledger margins',
        visibleAction: 'weathered fingers turning an aged leaf to reveal meticulously numbered family records'
      }
    }
    // Default Hutterite focal point
    return {
      focalPoint: 'the communal working infrastructure of the colony farmstead',
      strikingDetail: 'practical galvanized steel fittings and organized tools showing decades of communal care',
      visibleAction: 'colony workers in practical denim overalls coordinating routine maintenance at dawn'
    }
  }

  if (niche === 'health') {
    if (/\b(kidney|glomerul|nephron|filter|filtration|renal)\b/i.test(text)) {
      return {
        focalPoint: 'a single renal glomerulus capillary loop in microscopic cutaway',
        strikingDetail: 'fenestrated endothelial wall actively filtering biological plasma under pulsatile pressure',
        visibleAction: 'cellular fluid streaming through micro-pores while cellular components remain retained'
      }
    }
    if (/\b(heart|cardiac|artery|vessel|blood|circulation|aorta)\b/i.test(text)) {
      return {
        focalPoint: 'the cross-section of a coronary arterial wall showing smooth muscle architecture',
        strikingDetail: 'layered collagen fibers flexing with each synchronized hydrostatic pulse',
        visibleAction: 'oxygenated erythrocytes gliding in steady laminar flow through the vascular lumen'
      }
    }
    if (/\b(cell|membrane|receptor|protein|lipid|molecule)\b/i.test(text)) {
      return {
        focalPoint: 'a cellular phospholipid bilayer with integrated membrane transport proteins',
        strikingDetail: 'hydrophobic lipid tails vibrating gently within the fluid mosaic matrix',
        visibleAction: 'conformation shifts in transmembrane channels enabling controlled ionic transport'
      }
    }
    return {
      focalPoint: 'the intricate micro-architecture of the target anatomical structure',
      strikingDetail: 'clearly delineated cellular tissue boundaries with subtle biological fluid glow',
      visibleAction: 'active physiological transport occurring steadily across biological membranes'
    }
  }

  if (niche === 'history') {
    if (/\b(document|treaty|letter|parchment|ledger|paper|signature)\b/i.test(text)) {
      return {
        focalPoint: 'an authentic period parchment document with a deeply stamped wax seal',
        strikingDetail: 'hairline stress fractures across the vermilion wax and feathering quill ink strokes',
        visibleAction: 'a hand in period-accurate wool cuffs adjusting an antique brass magnifying glass above the text'
      }
    }
    if (/\b(weapon|sword|iron|forge|blacksmith|armor|metal)\b/i.test(text)) {
      return {
        focalPoint: 'a hand-forged iron implement resting on a scarred timber workbench',
        strikingDetail: 'hammer marks and dark carbon patina preserved along the tempered edge',
        visibleAction: 'a metalworker lifting the cooling piece with wrought-iron tongs into quench water'
      }
    }
    return {
      focalPoint: 'an authentic period-specific artifact linked to the historical event',
      strikingDetail: 'tangible material wear, hand-tooled joinery, and genuine historical patina',
      visibleAction: 'purposeful manual handling revealing the functional craftsmanship of the era'
    }
  }

  if (niche === 'finance') {
    if (/\b(ledger|audit|document|report|balance|sheet|statement)\b/i.test(text)) {
      return {
        focalPoint: 'an audited physical financial balance sheet marked with red reconciliation notes',
        strikingDetail: 'handwritten variance annotations set against crisp laser-printed line items',
        visibleAction: 'an analyst placing an official validation stamp beside an unexpected numerical discrepancy'
      }
    }
    return {
      focalPoint: 'a high-frequency operational trading desk terminal displaying market flow depth',
      strikingDetail: 'live order-book data flickering across architectural glass reflections',
      visibleAction: 'fingers executing rapid keyboard commands as real-time spread numbers fluctuate'
    }
  }

  if (niche === 'food') {
    return {
      focalPoint: 'the precise physical boundary where raw ingredients undergo heat transformation',
      strikingDetail: 'fine moisture vaporising into fragrant steam as golden-brown crust caramelizes',
      visibleAction: 'a chef using a razor-sharp carbon knife to score the surface with rhythmic precision'
    }
  }

  if (niche === 'technology') {
    return {
      focalPoint: 'the precision micro-actuator linkage of an automated assembly mechanism',
      strikingDetail: 'sub-millimeter machined titanium gear teeth engaging without backlash',
      visibleAction: 'stepper motors executing synchronized high-speed micro-steps along linear rails'
    }
  }

  // 3. Fallback generic documentary focal point
  const subjectName = grounding.canonicalSubject || truncateWords(intent || narration, 6)
  return {
    focalPoint: `the central working component of ${subjectName}`,
    strikingDetail: 'weathered physical texture, practical wear marks and authentic environmental patina',
    visibleAction: 'deliberate hands-on interaction demonstrating functional operational mastery'
  }
}

// ─── Resolve Opening Visual Hook Blueprint ───────────────────────────────────

export function resolveOpeningVisualHook(params: {
  scene: VisualMixScenePlan
  openingRank: number // 1 to 10
  previousHooks: OpeningVisualHookBlueprint[]
  globalContext?: GlobalScriptContext
  sceneDirection?: ManualAiSceneDirection
  retentionHint?: RetentionScenePlan
  identityBible?: VisualIdentityBible
}): OpeningVisualHookBlueprint {
  const { scene, openingRank, previousHooks, globalContext, sceneDirection, retentionHint, identityBible } = params

  const rank = Math.max(1, Math.min(10, openingRank))
  const narration = cleanText(scene.narration)
  const intent = cleanText(scene.visualIntent)
  const groundingText = `${intent} ${narration}`.trim()

  // 1. Detect visual niche
  const profile: VisualMixProfile = (scene.category === 'health' || (sceneDirection && sceneDirection.sceneRole === 'mechanism')) ? 'health' : 'general'
  const niche = detectVideoNiche(groundingText, profile, globalContext)
  const nicheProfile = NICHE_OPENING_PROFILES[niche] || NICHE_OPENING_PROFILES['documentary']

  // 2. Resolve Subject Grounding
  const grounding = resolveVideoSubjectGrounding({
    scene,
    globalContext,
    identityBible,
    sceneDirection,
    profile
  })

  // 3. Select Hook Archetype with Novelty Avoidance
  const candidateArchetypes = RANK_DEFAULT_ARCHETYPES[rank] || ['unusual-detail']
  const lastArchetype = previousHooks.length > 0 ? previousHooks[previousHooks.length - 1].hookArchetype : null
  const secondLastArchetype = previousHooks.length > 1 ? previousHooks[previousHooks.length - 2].hookArchetype : null

  // Check scene text for strong archetype clues
  let selectedArchetype = candidateArchetypes[0]
  if (/\b(scale|massive|micro|microscopic|vast|tiny|thousands|colony-wide)\b/i.test(groundingText)) {
    selectedArchetype = 'scale-contrast'
  } else if (/\b(gear|pipe|valve|piston|wire|mechanism|filter|engine|pump)\b/i.test(groundingText)) {
    selectedArchetype = 'hidden-mechanism'
  } else if (/\b(ledger|document|record|certificate|paper|letter|contract)\b/i.test(groundingText)) {
    selectedArchetype = 'evidence-reveal'
  } else if (/\b(ice|frost|cold|heat|steam|rust|pressure|wear|crack)\b/i.test(groundingText)) {
    selectedArchetype = 'physical-contrast'
  } else if (/\b(knead|dough|weld|cut|slice|pour|assemble|inject|harvest)\b/i.test(groundingText)) {
    selectedArchetype = 'process-at-critical-moment'
  }

  // Avoid consecutive repeating archetype
  if (selectedArchetype === lastArchetype) {
    const alternative = candidateArchetypes.find((a) => a !== lastArchetype && a !== secondLastArchetype)
    if (alternative) selectedArchetype = alternative
  }

  // 4. Resolve Shot & Camera Angle (with anti-monotony variation)
  const rankPreset = RANK_SHOT_TYPES[rank] || RANK_SHOT_TYPES[1]
  let shotType = rankPreset.shotType
  let cameraAngle = rankPreset.cameraAngle

  // Avoid identical consecutive shot types
  if (previousHooks.length > 0 && previousHooks[previousHooks.length - 1].shotType === shotType) {
    if (shotType.includes('macro')) {
      shotType = 'tight low-angle composition with sharp foreground isolation'
      cameraAngle = 'low-angle looking slightly upward'
    } else {
      shotType = 'macro detail framing isolating the central mechanical feature'
      cameraAngle = 'downward 45-degree close-up'
    }
  }

  // 5. Extract Grounded Focal Point & Striking Detail
  const focalData = extractGroundedFocalPoint(scene, niche, grounding, sceneDirection)
  const canonicalSubject = grounding.canonicalSubject || cleanText(sceneDirection?.visualEvent?.subject) || 'authentic documentary subject'

  // 6. Formulate Viewer Curiosity Question (scene grounded)
  let viewerQuestion = nicheProfile.questionTemplate
  if (retentionHint?.reason) {
    viewerQuestion = `How does this specific detail explain why ${cleanText(retentionHint.reason)}?`
  } else if (sceneDirection?.viewerShouldNotice) {
    viewerQuestion = `Why is ${cleanText(sceneDirection.viewerShouldNotice)} happening at this pivotal stage?`
  } else if (narration) {
    viewerQuestion = `What unexpected consequence stems from ${truncateWords(narration, 10)}?`
  }

  // 7. Extract Required Traits & Forbidden Substitutions
  const requiredTraits = [
    ...grounding.wardrobe.slice(0, 2),
    ...grounding.tools.slice(0, 2),
    ...grounding.machinery.slice(0, 2),
    ...grounding.architecture.slice(0, 1)
  ].filter(Boolean)

  const forbiddenSubstitutions = [
    ...grounding.forbiddenSubstitutions,
    ...nicheProfile.forbiddenKeywords
  ].filter((v, i, a) => a.indexOf(v) === i)

  return {
    sceneIndex: scene.sceneIndex,
    openingRank: rank,
    canonicalSubject,
    niche,
    sceneNarration: narration,
    visualIntent: intent,
    hookArchetype: selectedArchetype,
    visualFocalPoint: focalData.focalPoint,
    strikingDetail: focalData.strikingDetail,
    visibleAction: focalData.visibleAction,
    viewerQuestion,
    shotType,
    cameraAngle,
    lighting: cleanText(sceneDirection?.lighting) || nicheProfile.lighting,
    requiredIdentityTraits: requiredTraits,
    forbiddenSubstitutions,
    evidenceSource: sceneDirection ? 'scene-direction' : 'grounding-engine',
    confidence: grounding.confidence || 0.85
  }
}

// ─── Image Prompt Hook Composer ──────────────────────────────────────────────

export function composeOpeningImagePrompt(params: {
  basePrompt: string
  blueprint: OpeningVisualHookBlueprint
  scene: VisualMixScenePlan
  outputResolution: AiImageOutputResolution
}): string {
  const { blueprint, outputResolution } = params
  const dims = outputResolution === '4k' ? '3840x2160' : outputResolution === '2k' ? '2560x1440' : '1920x1080'

  const nicheProfile = NICHE_OPENING_PROFILES[blueprint.niche] || NICHE_OPENING_PROFILES['documentary']

  // 1. Hook Header & Frozen Decisive Moment
  const openingHeader = `Documentary photograph capturing a compelling opening visual hook: an unexpected view of ${blueprint.visualFocalPoint}, frozen in a decisive instant as ${blueprint.visibleAction}.`

  // 2. Clear Visual Question
  const questionClause = `The visual presents a concrete narrative question: ${blueprint.viewerQuestion}`

  // 3. Composition & Spatial Hierarchy
  const compositionClause = `Composition: ${blueprint.shotType} from a ${blueprint.cameraAngle}, establishing ${blueprint.visualFocalPoint} with extreme focal priority and crisp separation from the background.`

  // 4. Concrete Physical Detail & Environment
  const detailClause = `Visual detail: ${blueprint.strikingDetail}, framed against an authentic background of ${blueprint.canonicalSubject}.`

  // 5. Lighting & Atmosphere
  const lightingClause = `Lighting: ${blueprint.lighting}.`

  // 6. Niche Realism & Required Identity Traits
  let identityClause = nicheProfile.realismDirective
  if (blueprint.requiredIdentityTraits.length > 0) {
    identityClause += `, featuring ${blueprint.requiredIdentityTraits.slice(0, 3).join(', ')}`
  }

  // 7. Forbidden Substitutions & Negative Directives
  const forbiddenClause = blueprint.forbiddenSubstitutions.length > 0
    ? `Strictly authentic depiction: no ${blueprint.forbiddenSubstitutions.slice(0, 3).join(', no ')}.`
    : ''

  // 8. Technical Standards
  const techClause = `16:9 horizontal frame (${dims}), photorealistic authentic documentary still, natural film grain, no text, no subtitles, no labels, no watermark, no logo.`

  // 9. Assemble and Budget Control (~130-220 words, hard max 260 words)
  const assemble = (includeQuestion: boolean, includeIdentity: boolean): string => {
    const parts = [
      openingHeader,
      includeQuestion ? questionClause : '',
      compositionClause,
      detailClause,
      lightingClause,
      includeIdentity ? identityClause : '',
      forbiddenClause,
      techClause
    ]
    return sanitizePromptLine(parts.filter(Boolean).join(' '))
  }

  let prompt = assemble(true, true)
  if (countWords(prompt) > 240) prompt = assemble(false, true)
  if (countWords(prompt) > 240) prompt = assemble(false, false)

  return prompt
}

// ─── Video Prompt Hook Composer ──────────────────────────────────────────────

export function composeOpeningVideoPrompt(params: {
  basePrompt: string
  blueprint: OpeningVisualHookBlueprint
  scene: VisualMixScenePlan
  durationSecs: number
  niche: string
}): string {
  const { blueprint, scene, durationSecs, niche } = params

  const directive = VIDEO_NICHE_DIRECTIVES[niche as VideoVisualNiche] || VIDEO_NICHE_DIRECTIVES.documentary
  const duration = durationSecs > 0 ? durationSecs : 5

  // 1. Appropriate Camera Motion
  const cameraMotion = resolveVideoCameraMotion({
    scene,
    directive,
    niche: niche as VideoVisualNiche
  })

  // 2. Beat 1: Immediate First-Frame Hook Action (0:00)
  const firstFrameBeat = `Opening frame (0:00): The shot opens immediately on ${blueprint.visualFocalPoint} with ${blueprint.strikingDetail}, initiating immediate physical engagement.`

  // 3. Beat 2: Active Physical Temporal Progression (0:01 - mid clip)
  const developmentBeat = `Development: As the clip progresses, ${blueprint.visibleAction} unfolds smoothly with the camera executing a ${cameraMotion}.`

  // 4. Beat 3: Controlled Revelation / Consequence / Narrative Handoff
  const payoffBeat = `Payoff: Toward the final seconds, settle on the consequence: ${blueprint.strikingDetail} in full functional operation, creating a compelling handoff to the following scene.`

  // 5. Framing & Environment
  const framingClause = `Framing: ${blueprint.shotType} from a ${blueprint.cameraAngle}. Environment: ${directive.environment}, illuminated by ${blueprint.lighting}.`

  // 6. Anti-Artifact Video Negative Directives
  const antiArtifactDirective = 'no distorted hands, no morphing equipment, no inconsistent object geometry, no unnatural movements, no unstable character identity, no impossible physical transformations'

  // 7. Identity & Forbidden Substitutions
  let identityClause = ''
  if (blueprint.requiredIdentityTraits.length > 0) {
    identityClause = `Subject traits: ${blueprint.requiredIdentityTraits.slice(0, 3).join(', ')}.`
  }
  const forbiddenClause = blueprint.forbiddenSubstitutions.length > 0
    ? `Strictly avoid: ${blueprint.forbiddenSubstitutions.slice(0, 3).join(', ')}.`
    : ''

  // 8. Technical Standards & Audio Safeguards
  const techClause = `Target clip duration: ${duration} seconds. Horizontal 16:9 video (1920x1080). No speech, no dialogue, no narration audio, no background music, no text overlays, no subtitles, no watermark, no logo.`

  // 9. Assemble Prompt with Word Budget (~160-260 words, hard max 320 words)
  const assemble = (includePayoff: boolean, includeIdentity: boolean): string => {
    const parts = [
      `${directive.style} capturing ${blueprint.canonicalSubject}.`,
      firstFrameBeat,
      developmentBeat,
      includePayoff ? payoffBeat : '',
      framingClause,
      includeIdentity ? identityClause : '',
      antiArtifactDirective,
      forbiddenClause,
      techClause
    ]
    return sanitizePromptLine(parts.filter(Boolean).join(' '))
  }

  let prompt = assemble(true, true)
  if (countWords(prompt) > 300) prompt = assemble(false, true)
  if (countWords(prompt) > 300) prompt = assemble(false, false)

  return prompt
}

// ─── Meaningful Opening Visual Hook Scorer ───────────────────────────────────

export function scoreOpeningVisualHook(params: {
  blueprint: OpeningVisualHookBlueprint
  generatedPrompt: string
  priorHooks: OpeningVisualHookBlueprint[]
}): OpeningHookQualityResult {
  const { blueprint, generatedPrompt, priorHooks } = params
  const p = generatedPrompt.toLowerCase()
  const reasons: string[] = []

  // 1. Subject Specificity (0-10)
  const subTokens = blueprint.canonicalSubject.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  const subMatches = subTokens.filter((w) => p.includes(w))
  const subjectSpecificity = subTokens.length > 0
    ? Math.min(10, Math.round((subMatches.length / subTokens.length) * 10))
    : 8

  // 2. Scene Grounding (0-10)
  const narrTokens = `${blueprint.sceneNarration} ${blueprint.visualIntent}`
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4)
  const narrMatches = narrTokens.filter((w) => p.includes(w))
  const grounding = narrTokens.length > 0
    ? Math.min(10, Math.round((narrMatches.length / Math.min(narrTokens.length, 5)) * 10))
    : 8

  // 3. Concrete Unusual Detail (0-10)
  const focalTokens = blueprint.visualFocalPoint.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  const focalMatches = focalTokens.filter((w) => p.includes(w))
  const unusualDetail = focalTokens.length > 0
    ? Math.min(10, Math.round((focalMatches.length / Math.min(focalTokens.length, 3)) * 10))
    : 7

  // 4. Immediate Focal Clarity (0-10)
  const hasFocalPriority = /focal priority|framing|focusing sharply|opening frame|dominant/i.test(p)
  const focalClarity = hasFocalPriority ? 10 : 6

  // 5. Visible Action or Meaningful Frozen Moment (0-10)
  const hasActionVerb = /\b(unfolds|initiates|freezing|frozen|turning|filtering|applying|kneading|drawing|gliding|engaging|operating|scoring|flexing)\b/i.test(p)
  const visibleActionOrMoment = hasActionVerb ? 10 : 6

  // 6. Visual Contrast (0-10)
  const hasContrast = /\b(contrast|separation|against|frost|steam|tension|macro|fine surface|scale|pressure|dark|gleaming)\b/i.test(p)
  const visualContrast = hasContrast ? 10 : 7

  // 7. Camera Plausibility (0-10)
  const hasPlausibleCamera = /\b(macro|close-up|tracking|angle|slider|overview|eye level|three-quarter)\b/i.test(p)
  const hasUnrealisticCamera = /\b(impossible camera|hyperspeed warp|infinite zoom)\b/i.test(p)
  const cameraPlausibility = (hasPlausibleCamera ? 8 : 4) + (hasUnrealisticCamera ? -4 : 2)

  // 8. Novelty Relative to Preceding Hooks (0-10)
  const lastHook = priorHooks.length > 0 ? priorHooks[priorHooks.length - 1] : null
  let noveltyRelative = 10
  if (lastHook) {
    if (lastHook.hookArchetype === blueprint.hookArchetype) noveltyRelative -= 3
    if (lastHook.shotType === blueprint.shotType) noveltyRelative -= 3
  }
  noveltyRelative = Math.max(4, noveltyRelative)

  // 9. Domain & Cultural Accuracy (0-10)
  let accuracy = 10
  // Remove negative constraints clauses before checking for forbidden positive depictions
  const positivePrompt = p
    .replace(/\b(?:strictly authentic depiction:?\s*no|strictly avoid:?|avoid:?|no\s+)[^.]*\./gi, ' ')
    .replace(/\b(?:no text|no subtitles|no watermark|no logo)[^.]*\./gi, ' ')
  for (const forbidden of blueprint.forbiddenSubstitutions) {
    const fLower = forbidden.toLowerCase().trim()
    if (!fLower) continue
    if (positivePrompt.includes(fLower)) {
      accuracy -= 5
      reasons.push(`Contains forbidden substitution: "${forbidden}"`)
    }
  }
  accuracy = Math.max(0, accuracy)

  // 10. Absence of Contradictions (0-10)
  let absenceOfContradictions = 10
  if (/extreme macro/i.test(p) && /wide establishing/i.test(p)) {
    absenceOfContradictions -= 5
    reasons.push('Contradictory shot types: macro and wide establishing')
  }
  if (/no text/i.test(p) && /render exactly one editorial text/i.test(p)) {
    absenceOfContradictions -= 5
    reasons.push('Contradictory text directives')
  }
  absenceOfContradictions = Math.max(0, absenceOfContradictions)

  const score = Math.round(
    subjectSpecificity +
      grounding +
      unusualDetail +
      focalClarity +
      visibleActionOrMoment +
      visualContrast +
      cameraPlausibility +
      noveltyRelative +
      accuracy +
      absenceOfContradictions
  )

  const passed = score >= 65 && absenceOfContradictions >= 5 && accuracy >= 5

  return {
    score,
    passed,
    dimensions: {
      subjectSpecificity,
      grounding,
      unusualDetail,
      focalClarity,
      visibleActionOrMoment,
      visualContrast,
      cameraPlausibility,
      noveltyRelative,
      accuracy,
      absenceOfContradictions
    },
    reasons
  }
}

// ─── Public API: Copy Text Composer ──────────────────────────────────────────

export function buildOpeningEnhancedCopyText(params: {
  mode: 'image' | 'video'
  projectDir: string
  baseEntries: Array<{ sceneIndex: number; prompt: string }>
}): string {
  const { mode, projectDir, baseEntries } = params
  if (!baseEntries || baseEntries.length === 0) return ''

  // 1. Sort entries deterministically by sceneIndex
  const sorted = [...baseEntries].sort((a, b) => a.sceneIndex - b.sceneIndex)

  // 2. Identify the first 10 AI-owned entries (regardless of global scene numbers)
  const openingSlice = sorted.slice(0, 10)
  const openingSceneIndices = new Set(openingSlice.map((e) => e.sceneIndex))

  // 3. Gracefully load optional project intelligence
  let globalContext: GlobalScriptContext | undefined
  const contextPath = path.join(projectDir, 'analysis', 'global-script-context.json')
  if (fs.existsSync(contextPath)) {
    try {
      globalContext = JSON.parse(fs.readFileSync(contextPath, 'utf-8'))
    } catch {
      /* ignore */
    }
  }

  const identityBible = loadVisualIdentityBible(projectDir) || undefined

  let visualMixScenesMap = new Map<number, VisualMixScenePlan>()
  const planPath = getVisualMixPlanFilePath(projectDir)
  let outputResolution: AiImageOutputResolution = '1080p'
  if (fs.existsSync(planPath)) {
    try {
      const planData = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
      if (planData?.outputResolution) outputResolution = planData.outputResolution
      if (Array.isArray(planData?.scenes)) {
        for (const s of planData.scenes) {
          visualMixScenesMap.set(s.sceneIndex, s)
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Fallback to master-edit-plan.json if visualMixScenesMap lacks scenes
  const masterEditPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
  if (fs.existsSync(masterEditPath)) {
    try {
      const masterData = JSON.parse(fs.readFileSync(masterEditPath, 'utf-8'))
      for (const ch of masterData?.chapters || []) {
        for (const seq of ch.chapters_seq || []) {
          for (const sc of seq.scenes || []) {
            if (!visualMixScenesMap.has(sc.sceneIndex)) {
              visualMixScenesMap.set(sc.sceneIndex, {
                sceneIndex: sc.sceneIndex,
                narration: sc.narrativeText || sc.narration || '',
                visualIntent: sc.visualIntent || '',
                duration: sc.duration || 5,
                strategy: 'ai-still',
                assetType: 'ai-image',
                imagePrompt: ''
              })
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  const directionsMap = new Map<number, ManualAiSceneDirection>()
  const directionsPath = getManualAiSceneDirectionsPath(projectDir)
  if (fs.existsSync(directionsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(directionsPath, 'utf-8'))
      const list: ManualAiSceneDirection[] = Array.isArray(raw) ? raw : raw?.scenes || []
      for (const d of list) {
        directionsMap.set(d.sceneIndex, d)
      }
    } catch {
      /* ignore */
    }
  }

  const retentionScenesMap = new Map<number, RetentionScenePlan>()
  const retentionPath = path.join(projectDir, 'analysis', 'retention-plan.json')
  if (fs.existsSync(retentionPath)) {
    try {
      const retentionData = JSON.parse(fs.readFileSync(retentionPath, 'utf-8')) as RetentionPlan
      if (Array.isArray(retentionData?.scenes)) {
        for (const s of retentionData.scenes) {
          retentionScenesMap.set(s.sceneIndex, s)
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 4. Compose Opening Hooks sequentially with novelty and quality verification
  const priorHooks: OpeningVisualHookBlueprint[] = []
  const enhancedMap = new Map<number, string>()

  for (let i = 0; i < openingSlice.length; i++) {
    const entry = openingSlice[i]
    const rank = i + 1

    let scenePlan = visualMixScenesMap.get(entry.sceneIndex)
    if (!scenePlan) {
      scenePlan = {
        sceneIndex: entry.sceneIndex,
        narration: entry.prompt || '',
        visualIntent: entry.prompt || '',
        duration: 5,
        strategy: 'ai-still',
        assetType: 'ai-image',
        imagePrompt: entry.prompt
      }
    }

    const sceneDirection = directionsMap.get(entry.sceneIndex)
    const retentionHint = retentionScenesMap.get(entry.sceneIndex)

    const blueprint = resolveOpeningVisualHook({
      scene: scenePlan,
      openingRank: rank,
      previousHooks: priorHooks,
      globalContext,
      sceneDirection,
      retentionHint,
      identityBible
    })

    let enhancedPrompt: string
    if (mode === 'image') {
      enhancedPrompt = composeOpeningImagePrompt({
        basePrompt: entry.prompt,
        blueprint,
        scene: scenePlan,
        outputResolution
      })
    } else {
      enhancedPrompt = composeOpeningVideoPrompt({
        basePrompt: entry.prompt,
        blueprint,
        scene: scenePlan,
        durationSecs: scenePlan.duration || 5,
        niche: blueprint.niche
      })
    }

    const evalResult = scoreOpeningVisualHook({
      blueprint,
      generatedPrompt: enhancedPrompt,
      priorHooks
    })

    if (evalResult.passed) {
      enhancedMap.set(entry.sceneIndex, enhancedPrompt)
      priorHooks.push(blueprint)
    } else {
      logger.warn(
        `[OpeningHookCopy] Scene ${entry.sceneIndex} hook evaluation fallback (score=${evalResult.score}): ${evalResult.reasons.join(', ')}`
      )
      enhancedMap.set(entry.sceneIndex, entry.prompt)
    }
  }

  // 5. Assemble final copied text: first 10 enhanced, remaining byte-for-byte identical
  const outputLines = sorted.map((entry) => {
    const promptText = openingSceneIndices.has(entry.sceneIndex)
      ? enhancedMap.get(entry.sceneIndex) || entry.prompt
      : entry.prompt

    return `${formatSceneLabel(entry.sceneIndex)} | ${sanitizePromptLine(promptText)}`
  })

  return outputLines.join('\n\n')
}
