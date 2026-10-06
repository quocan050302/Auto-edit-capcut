import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../logger'
import type {
  AiImageOutputResolution,
  GlobalScriptContext,
  HealthVisualCategory,
  VisualMixPlan,
  VisualMixProfile,
  VisualMixScenePlan
} from '../../../../shared/types'
import { NICHE_STYLE_DIRECTIVES, detectVisualNiche, type GeneralVisualNiche } from '../general-image-prompt'
import { getHealthCategoryDetails } from '../../health/health-visual-planner'
import {
  MANUAL_AI_PROMPT_SCHEMA_VERSION,
  expectedFilenameForScene,
  getManualAiPromptJsonPath,
  getManualAiPromptTxtPath,
  type ManualAiPromptEntry,
  type ManualAiPromptPack,
  type ManualAiVisualBrief,
  type ManualAiSceneDirection
} from './manual-ai-types'

// ─── Text helpers ────────────────────────────────────────────────────────────

/** Removes quotes / odd symbols but keeps Unicode letters (scripts may be non-English). */
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

function normWs(text: string | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim()
}

function sha256(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('||')).digest('hex')
}

/**
 * Guarantees ONE physical line: embedded CR/LF become spaces, whitespace is collapsed and the
 * "|" separator used by the TXT format is neutralised.
 */
export function sanitizePromptLine(prompt: string): string {
  return (prompt || '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Prompt recipe (deterministic, local, reuses Health / General intelligence) ──

interface ShotPreset {
  composition: string
  camera: string
}

const SHOT_WIDE: ShotPreset = {
  composition: 'wide establishing composition with the subject in the left third and generous negative space on the right',
  camera: '24mm full-frame lens at eye level'
}
const SHOT_MEDIUM: ShotPreset = {
  composition: 'medium composition centered on the subject with shallow depth of field',
  camera: '50mm lens at eye level'
}
const SHOT_LOW: ShotPreset = {
  composition: 'low-angle three-quarter view that emphasises scale and presence',
  camera: '35mm lens from a low camera position'
}
const SHOT_HIGH: ShotPreset = {
  composition: 'high-angle overview with clear leading lines toward the subject',
  camera: '35mm lens from an elevated camera position'
}
const SHOT_MACRO: ShotPreset = {
  composition: 'tight detail framing with a softly blurred background',
  camera: '100mm macro lens at close range'
}
const SHOT_SYMMETRIC: ShotPreset = {
  composition: 'symmetrical frontal composition with strong central focus',
  camera: '50mm lens centered on the subject'
}
const SHOT_ROTATION: ShotPreset[] = [
  SHOT_WIDE,
  SHOT_MEDIUM,
  SHOT_LOW,
  SHOT_SYMMETRIC,
  SHOT_HIGH,
  SHOT_MACRO
]

function pickShot(text: string, sceneIndex: number): ShotPreset {
  if (/\b(overview|vast|landscape|world|global|city|skyline|horizon|panorama)\b/i.test(text)) return SHOT_WIDE
  if (/\b(cell|cells|micro|microscopic|molecule|texture|detail|close|hand|hands|tissue)\b/i.test(text)) return SHOT_MACRO
  if (/\b(towering|massive|giant|rise|rising|power|powerful|dominate)\b/i.test(text)) return SHOT_LOW
  return SHOT_ROTATION[(Math.max(1, sceneIndex) - 1) % SHOT_ROTATION.length]
}

const HEALTH_LIGHTING = [
  'soft directional key light with a cool rim light separating the subject from a deep navy backdrop',
  'clean diffused clinical lighting with gentle highlights and a subtle volumetric glow',
  'low-contrast soft light with realistic dimensional falloff and gentle shadows'
]

const NICHE_LIGHTING: Record<GeneralVisualNiche, string> = {
  history: 'low golden-hour sun with long soft shadows and atmospheric haze',
  finance: 'crisp architectural daylight with refined contrast and clean reflections',
  food: 'soft window light with gentle highlights and appetizing texture detail',
  technology: 'cool ambient light with subtle accent glow and clean specular highlights',
  travel: 'warm natural light with rich depth and sweeping atmosphere',
  nature: 'natural diffused light with rich environmental depth',
  documentary: 'natural cinematic light with balanced contrast'
}

const NICHE_OPENING: Record<GeneralVisualNiche, string> = {
  history: 'Premium cinematic historical reconstruction still of',
  finance: 'Premium editorial financial documentary still of',
  food: 'High-end food documentary photograph of',
  technology: 'Modern technical documentary visualization still of',
  travel: 'Cinematic location documentary photograph of',
  nature: 'Cinematic natural-history documentary photograph of',
  documentary: 'Realistic cinematic documentary still of'
}

const NICHE_BACKGROUND: Record<GeneralVisualNiche, string> = {
  history: 'period-accurate environment with layered atmospheric depth',
  finance: 'clean modern urban or office environment with soft depth',
  food: 'tidy culinary setting with softly defocused kitchen details',
  technology: 'sleek contemporary environment with softly defocused equipment',
  travel: 'authentic location with layered depth and natural scale cues',
  nature: 'natural habitat with layered foliage and atmospheric depth',
  documentary: 'believable real-world environment with soft layered depth'
}

function pickTimeOfDay(text: string): string {
  if (/\b(night|midnight|sleep|sleeping|asleep|bedtime|dark|moon)\b/i.test(text)) return 'night-time with cool moonlit tones'
  if (/\b(morning|dawn|sunrise|wake|waking|breakfast)\b/i.test(text)) return 'early morning light'
  if (/\b(evening|sunset|dusk)\b/i.test(text)) return 'golden-hour evening light'
  return ''
}

function pickMood(text: string): string {
  if (/\b(danger|risk|warning|toxic|crisis|collapse|damage|threat|decline|disease|harm)\b/i.test(text)) {
    return 'tense, cautionary mood'
  }
  if (/\b(hope|benefit|improve|healthy|recover|success|restore|strong|protect)\b/i.test(text)) {
    return 'hopeful, reassuring mood'
  }
  if (/\b(mystery|secret|hidden|unknown|discover|reveal|unexpected)\b/i.test(text)) {
    return 'intriguing, quietly mysterious mood'
  }
  return 'calm, authoritative documentary mood'
}

const HEALTH_SAFETY =
  'Scientifically plausible anatomy with correct organ relationships, medical documentary quality, no fake diagnostic results, no exact molecular structures, no citations, no medical text inside the image.'

function shortIdea(scene: VisualMixScenePlan | undefined): string {
  if (!scene) return ''
  return truncateWords(cleanText(scene.visualIntent || scene.narration), 6)
}

export interface ManualPromptParams {
  scene: VisualMixScenePlan
  profile: VisualMixProfile
  globalContext?: GlobalScriptContext
  previousScene?: VisualMixScenePlan
  nextScene?: VisualMixScenePlan
  outputResolution: AiImageOutputResolution
  visualBrief?: ManualAiVisualBrief
  sceneDirection?: ManualAiSceneDirection
}

export function calculatePromptQualityScore(params: {
  prompt: string
  narration: string
  visualIntent?: string
  role?: string
  hookLevel?: string
  hasOverlay?: boolean
}): number {
  const p = params.prompt.toLowerCase()
  const n = `${params.narration} ${params.visualIntent || ''}`.toLowerCase()

  // 1. Scene Grounding (0-25)
  const nWords = n.split(/\s+/).filter((w) => w.length > 3)
  const matched = nWords.filter((w) => p.includes(w))
  const groundingRatio = nWords.length > 0 ? matched.length / Math.min(nWords.length, 6) : 1
  const groundingScore = Math.min(25, Math.round(groundingRatio * 25))

  // 2. Visible Event (0-25)
  const eventVerbs = [
    'filtering', 'flowing', 'filling', 'contracting', 'narrowing', 'expanding',
    'releasing', 'absorbing', 'accumulating', 'separating', 'slowing', 'accelerating',
    'signaling', 'responding', 'circulating', 'descending', 'rising', 'rushing',
    'pumping', 'clearing', 'moving', 'holding', 'walking', 'working', 'analyzing', 'demonstrating'
  ]
  const hasEventVerb = eventVerbs.some((v) => p.includes(v))
  const visibleEventScore = hasEventVerb ? 25 : 12

  // 3. Composition Specificity (0-15)
  const hasShot = /shot|cutaway|angle|framing|composition|close-up|overview|macro/.test(p)
  const hasLens = /mm|lens|focal|depth of field|rim light/.test(p)
  const compScore = (hasShot ? 8 : 0) + (hasLens ? 7 : 0)

  // 4. Hook / Curiosity (0-15)
  const hasHook = /hook|tension|comprehension|clarity|reveal|unmistakable|vital|crucial|understand/.test(p)
  const hookScore = hasHook ? 15 : 10

  // 5. Continuity & Lighting (0-10)
  const hasLighting = /lighting|light|palette|glow|contrast|ambient/.test(p)
  const continuityScore = hasLighting ? 10 : 5

  // 6. Constraints & Safety (0-10)
  const hasRes = /16:9|1920x1080|2560x1440|3840x2160/.test(p)
  const hasNegative = /only the exact specified|no text|no watermark|no logo/.test(p)
  const safetyScore = (hasRes ? 5 : 0) + (hasNegative ? 5 : 0)

  return Math.min(100, Math.max(0, groundingScore + visibleEventScore + compScore + hookScore + continuityScore + safetyScore))
}

/**
 * Builds ONE detailed, scene-specific image prompt (single physical line).
 * Reuses the existing Health category wording / General niche tables; the automatic
 * `scene.imagePrompt` stays the grounding style core and is never replaced.
 */
export function buildManualScenePrompt(params: ManualPromptParams): string {
  const { scene, profile, globalContext, previousScene, nextScene, outputResolution, visualBrief, sceneDirection } = params
  const isHealth = profile === 'health'
  const dims = outputResolution === '4k' ? '3840x2160' : outputResolution === '2k' ? '2560x1440' : '1920x1080'

  const narration = cleanText(scene.narration)
  const intent = cleanText(scene.visualIntent)
  const groundingText = `${narration} ${intent}`
  const niche = detectVisualNiche(groundingText, globalContext)

  // ─── Level B Director Composition (when SceneDirection is available) ────────
  if (sceneDirection) {
    const role = sceneDirection.sceneRole
    const hook = sceneDirection.hookLevel
    const isMechanism = ['mechanism', 'cause-effect', 'consequence', 'reveal'].includes(role)
    const isHighHook = hook === 'high'

    // 1. Opening & Subject & Event Action
    let subject = cleanText(sceneDirection.visualEvent?.subject || intent || narration)
    subject = truncateWords(subject, 24)

    let action = cleanText(sceneDirection.visualEvent?.action)
    if (!action && isHealth) {
      action = 'actively filtering and transporting biological fluid'
    } else if (!action) {
      action = 'demonstrating dynamic documentary action'
    }

    let opening: string
    if (isHealth) {
      const cutawayType = isHighHook ? 'macro cutaway' : isMechanism ? 'detailed cutaway' : 'visualization'
      opening = `Premium cinematic medical documentary ${cutawayType} of ${subject} ${action}`
    } else {
      opening = `${NICHE_OPENING[niche]} ${subject}, ${action}`
    }

    // 2. Visible change & Cause/Effect
    const changeClause = sceneDirection.visualEvent?.change
      ? `with ${cleanText(sceneDirection.visualEvent.change)}`
      : ''
    const causeClause = sceneDirection.visualEvent?.cause
      ? `visibly triggered by ${cleanText(sceneDirection.visualEvent.cause)}`
      : ''
    const consequenceClause = sceneDirection.visualEvent?.consequence
      ? `resulting in ${cleanText(sceneDirection.visualEvent.consequence)}`
      : ''
    const dynamics = [changeClause, causeClause, consequenceClause].filter(Boolean).join(', ')

    // 3. Narrative comprehension & hook
    const viewerNotice = cleanText(sceneDirection.viewerShouldNotice || narration)
    const comprehensionClause = viewerNotice
      ? `The viewer should immediately understand that ${truncateWords(viewerNotice, 16)}.`
      : ''

    // 4. Composition & Framing
    const comp = sceneDirection.composition
    const subjectFraming = isMechanism
      ? 'with the main subject occupying roughly 60-70% of the useful frame'
      : 'with strong central presence'
    const compositionClause = `Composition: ${comp.shotType || 'close three-quarter view'}, ${subjectFraming}, ${comp.cameraAngle || 'eye level'}, ${comp.lensFeel || (isHealth ? '85mm medical-documentary lens' : '50mm prime lens')}, ${comp.focalPriority || 'precise focal priority'}.`

    // 5. Depth, Foreground & Background
    const fg = cleanText(comp.foreground) || 'dominant active subject'
    const bg = cleanText(comp.background) || (isHealth ? 'controlled dark navy background with gentle biological volumetric depth' : NICHE_BACKGROUND[niche])
    const depthClause = `Foreground: ${fg}. Background: ${bg}.`

    // 6. Lighting & Color
    const lighting = cleanText(sceneDirection.lighting) || (isHealth ? HEALTH_LIGHTING[(Math.max(1, scene.sceneIndex) - 1) % HEALTH_LIGHTING.length] : NICHE_LIGHTING[niche])
    const color = cleanText(sceneDirection.colorStrategy) || (isHealth ? 'deep navy blue with warm tissue highlights' : 'authentic documentary grade')
    const lightClause = `Lighting and palette: ${lighting}, ${color}.`

    // 7. Safety / Medical or Documentary realism
    const realismClause = isHealth
      ? 'Realistic internal tissue, plausible organ and vessel relationships, directional biological visual flow, medical documentary realism, no gore, no fake diagnostic results, no anatomical labels.'
      : 'High-end cinematic documentary realism, natural candid behavior, believable real-world environment, balanced cinematic grade.'

    // 8. Continuity
    const continuityNote = cleanText(sceneDirection.continuityNote)
    const continuityClause = continuityNote
      ? `Continuity: ${continuityNote}.`
      : ''

    // 9. Negative Space & Text Overlay
    let negativeSpaceClause = ''
    let overlayDirective = ''
    let overlayConstraint = ''

    if (sceneDirection.textOverlay?.enabled && sceneDirection.textOverlay?.text) {
      const pos = sceneDirection.textOverlay.position || 'top-right'
      const posDesc = pos.replace('-', ' ')
      negativeSpaceClause = `Reserve clean negative space in the ${posDesc} area.`
      overlayDirective = `Render exactly one editorial text overlay reading "${sceneDirection.textOverlay.text}" in large bold clean sans-serif typography, positioned in the ${posDesc} negative-space area, high-contrast white lettering with one restrained accent colour, perfectly legible, exact spelling, no additional words.`
      overlayConstraint = isHealth
        ? `Only the exact specified editorial overlay text is permitted. No other text, no captions, no anatomical labels, no UI, no watermark, no logo.`
        : `Only the exact specified editorial overlay text is permitted. No other text, no captions, no UI, no watermark, no logo.`
    } else {
      if (comp.negativeSpace) {
        negativeSpaceClause = `Composition balance: ${cleanText(comp.negativeSpace)}.`
      }
      overlayConstraint = isHealth
        ? `No text overlay, no subtitles, no anatomical labels, no UI, no watermark, no logo.`
        : `No text overlay, no subtitles, no UI, no watermark, no logo.`
    }

    const frameClause = `16:9 horizontal frame (${dims}).`

    const composeWithTarget = (includeDynamics: boolean, includeNotice: boolean, includeContinuity: boolean): string => {
      const parts = [
        `${opening}${dynamics && includeDynamics ? `, ${dynamics}` : ''}.`,
        includeNotice ? comprehensionClause : '',
        compositionClause,
        depthClause,
        lightClause,
        realismClause,
        includeContinuity ? continuityClause : '',
        negativeSpaceClause,
        overlayDirective,
        overlayConstraint,
        frameClause
      ]
      return sanitizePromptLine(parts.filter(Boolean).join(' '))
    }

    let prompt = composeWithTarget(true, true, true)
    // Target: normal 130-200, high hook 160-230, hard max 260 words
    if (countWords(prompt) > 250) prompt = composeWithTarget(true, true, false)
    if (countWords(prompt) > 250) prompt = composeWithTarget(false, true, false)
    if (countWords(prompt) > 250) prompt = composeWithTarget(false, false, false)
    return prompt
  }

  // ─── Fallback Local Composer (when SceneDirection is absent) ────────────────
  const opening = isHealth ? 'Premium cinematic medical documentary still of' : NICHE_OPENING[niche]
  let subject = truncateWords(intent || narration, 28)
  const narrationIdea = truncateWords(narration || intent, 24)

  const shot = pickShot(groundingText, scene.sceneIndex)
  const timeOfDay = pickTimeOfDay(groundingText)
  const mood = pickMood(groundingText)
  const lighting = isHealth
    ? HEALTH_LIGHTING[(Math.max(1, scene.sceneIndex) - 1) % HEALTH_LIGHTING.length]
    : NICHE_LIGHTING[niche]

  const worldEnv = globalContext?.visualWorld?.environment?.[0]
  const colorMood = cleanText(globalContext?.visualWorld?.colorMood)
  const background = isHealth
    ? 'clear foreground subject over a controlled dark navy gradient background with soft volumetric depth'
    : `clear foreground subject over a ${cleanText(worldEnv) || NICHE_BACKGROUND[niche]}`

  // For health, make sure an active visible verb is present
  if (isHealth && !/\b(filter|flow|fill|contract|narrow|expand|release|absorb|accumulat|separat|slow|accelerat|signal|respond|circulat|pump)\b/i.test(subject)) {
    subject = `${subject}, actively demonstrating physiological biological processes`
  }

  const styleCore = isHealth
    ? `${getHealthCategoryDetails((scene.category as HealthVisualCategory) || 'conceptual')}. ${HEALTH_SAFETY}`
    : `${NICHE_STYLE_DIRECTIVES[niche]}.`

  const anchorSubject = cleanText(globalContext?.primarySubject)
  const worldParts = [
    anchorSubject ? `topic ${truncateWords(anchorSubject, 6)}` : '',
    colorMood ? `colour mood ${truncateWords(colorMood, 4)}` : ''
  ].filter(Boolean)
  const worldClause = worldParts.length > 0 ? `Consistent visual world: ${worldParts.join(', ')}.` : ''

  const prevIdea = shortIdea(previousScene)
  const nextIdea = shortIdea(nextScene)
  const continuityParts = [
    prevIdea ? `follows a scene about ${prevIdea}` : '',
    nextIdea ? `leads into a scene about ${nextIdea}` : ''
  ].filter(Boolean)
  const continuityClause =
    continuityParts.length > 0
      ? `Continuity: ${continuityParts.join(' and ')}; keep the same palette and documentary look.`
      : ''

  const constraints = `16:9 horizontal frame (${dims}), photorealistic cinematic realism, no text, no subtitles, no labels, no watermark, no logo.`

  const compose = (narrationWords: number, withWorld: boolean, withContinuity: boolean): string => {
    const parts = [
      `${opening} ${subject}.`,
      narrationIdea ? `It visualizes the narration idea: ${truncateWords(narrationIdea, narrationWords)}.` : '',
      `Composition: ${shot.composition}, ${shot.camera}.`,
      `Foreground and background: ${background}.`,
      `Lighting and mood: ${lighting}${timeOfDay ? `, ${timeOfDay}` : ''}, ${mood}.`,
      styleCore,
      withWorld ? worldClause : '',
      withContinuity ? continuityClause : '',
      constraints
    ]
    return sanitizePromptLine(parts.filter(Boolean).join(' '))
  }

  // Target word count ~120-180 words, hard max 220 words
  let prompt = compose(24, true, true)
  if (countWords(prompt) > 200) prompt = compose(20, true, false)
  if (countWords(prompt) > 200) prompt = compose(14, false, false)
  return prompt
}

// ─── Hashes ──────────────────────────────────────────────────────────────────

export function computeManualPromptHash(params: {
  narration: string
  visualIntent: string
  profile: VisualMixProfile
  prompt: string
  outputResolution: AiImageOutputResolution
}): string {
  return sha256([
    normWs(params.narration),
    normWs(params.visualIntent),
    params.profile,
    params.prompt,
    params.outputResolution,
    String(MANUAL_AI_PROMPT_SCHEMA_VERSION)
  ])
}

function computeInputHash(params: {
  sceneIndex: number
  narration: string
  visualIntent: string
  basePrompt: string
  profile: VisualMixProfile
  outputResolution: AiImageOutputResolution
}): string {
  return sha256([
    String(params.sceneIndex),
    normWs(params.narration),
    normWs(params.visualIntent),
    normWs(params.basePrompt),
    params.profile,
    params.outputResolution,
    String(MANUAL_AI_PROMPT_SCHEMA_VERSION)
  ])
}

// ─── Pack build / guards ─────────────────────────────────────────────────────

type PlanForPack = Pick<VisualMixPlan, 'scenes' | 'totalScenes' | 'targetAiScenes'>

export function buildManualAiPromptPack(params: {
  plan: PlanForPack
  profile: VisualMixProfile
  globalContext?: GlobalScriptContext
  outputResolution: AiImageOutputResolution
  visualBrief?: ManualAiVisualBrief
  sceneDirections?: Map<number, ManualAiSceneDirection> | ManualAiSceneDirection[]
  now?: Date
}): ManualAiPromptPack {
  const { plan, profile, globalContext, outputResolution, visualBrief, sceneDirections } = params
  const ordered = [...plan.scenes].sort((a, b) => a.sceneIndex - b.sceneIndex)
  const entries: ManualAiPromptEntry[] = []

  let directionsMap: Map<number, ManualAiSceneDirection> | undefined
  if (sceneDirections) {
    if (sceneDirections instanceof Map) {
      directionsMap = sceneDirections
    } else if (Array.isArray(sceneDirections)) {
      directionsMap = new Map(sceneDirections.map((d) => [d.sceneIndex, d]))
    }
  }

  for (let i = 0; i < ordered.length; i++) {
    const scene = ordered[i]
    if (scene.strategy !== 'ai-still') continue

    const sceneDirection = directionsMap?.get(scene.sceneIndex)
    const prompt = buildManualScenePrompt({
      scene,
      profile,
      globalContext,
      previousScene: ordered[i - 1],
      nextScene: ordered[i + 1],
      outputResolution,
      visualBrief,
      sceneDirection
    })

    const qualityScore = calculatePromptQualityScore({
      prompt,
      narration: scene.narration,
      visualIntent: scene.visualIntent,
      role: sceneDirection?.sceneRole,
      hookLevel: sceneDirection?.hookLevel,
      hasOverlay: sceneDirection?.textOverlay?.enabled
    })

    entries.push({
      sceneIndex: scene.sceneIndex,
      sceneId: `scene_${scene.sceneIndex}`,
      prompt,
      promptHash: computeManualPromptHash({
        narration: scene.narration,
        visualIntent: scene.visualIntent,
        profile,
        prompt,
        outputResolution
      }),
      inputHash: computeInputHash({
        sceneIndex: scene.sceneIndex,
        narration: scene.narration,
        visualIntent: scene.visualIntent,
        basePrompt: scene.imagePrompt || '',
        profile,
        outputResolution
      }),
      expectedFilename: expectedFilenameForScene(scene.sceneIndex),
      status: 'waiting-image',
      sceneRole: sceneDirection?.sceneRole,
      hookLevel: sceneDirection?.hookLevel,
      visualEvent: sceneDirection?.visualEvent ? {
        subject: sceneDirection.visualEvent.subject,
        action: sceneDirection.visualEvent.action,
        change: sceneDirection.visualEvent.change,
        consequence: sceneDirection.visualEvent.consequence
      } : undefined,
      textOverlay: sceneDirection?.textOverlay ? {
        enabled: sceneDirection.textOverlay.enabled,
        text: sceneDirection.textOverlay.text,
        purpose: sceneDirection.textOverlay.purpose,
        position: sceneDirection.textOverlay.position,
        emphasis: sceneDirection.textOverlay.emphasis,
        reason: sceneDirection.textOverlay.reason
      } : undefined,
      directorSource: sceneDirection ? (sceneDirection.confidence > 0.8 ? 'ai' : 'fallback') : undefined,
      directorConfidence: sceneDirection?.confidence,
      qualityScore
    })
  }

  entries.sort((a, b) => a.sceneIndex - b.sceneIndex)

  const totalPrompts = entries.length
  const avgWords = totalPrompts > 0 ? Math.round(entries.reduce((sum, e) => sum + countWords(e.prompt), 0) / totalPrompts) : 0
  const highHook = entries.filter((e) => e.hookLevel === 'high').length
  const mediumHook = entries.filter((e) => e.hookLevel === 'medium').length
  const lowHook = entries.filter((e) => e.hookLevel === 'low').length

  logger.info(
    `[ManualAI:Prompts] generated=${totalPrompts} avgWords=${avgWords} highHook=${highHook} mediumHook=${mediumHook} lowHook=${lowHook}`
  )

  return {
    schemaVersion: MANUAL_AI_PROMPT_SCHEMA_VERSION,
    generatedAt: (params.now ?? new Date()).toISOString(),
    profile,
    totalProjectScenes: plan.totalScenes,
    expectedAiImages: plan.targetAiScenes,
    imageMode: 'prompt',
    outputResolution,
    scenes: entries
  }
}

/**
 * Hard guard: the pack must contain EXACTLY one prompt per AI-owned scene,
 * no duplicates and no Stock-owned scene.
 */
export function assertManualAiPromptPack(pack: ManualAiPromptPack, plan: PlanForPack): void {
  const aiIndices = new Set(plan.scenes.filter((s) => s.strategy === 'ai-still').map((s) => s.sceneIndex))
  const seen = new Set<number>()
  let duplicates = 0
  let notOwned = 0
  for (const e of pack.scenes) {
    if (seen.has(e.sceneIndex)) duplicates++
    seen.add(e.sceneIndex)
    if (!aiIndices.has(e.sceneIndex)) notOwned++
  }
  if (pack.scenes.length !== plan.targetAiScenes || seen.size !== aiIndices.size || duplicates > 0 || notOwned > 0) {
    throw new Error(
      `MANUAL_AI_PROMPT_COUNT_MISMATCH expected=${plan.targetAiScenes} actual=${pack.scenes.length} ` +
        `unique=${seen.size} duplicates=${duplicates} notAiOwned=${notOwned}`
    )
  }
}

// ─── TXT format ──────────────────────────────────────────────────────────────

export function formatSceneLabel(sceneIndex: number): string {
  return `SCENE ${String(sceneIndex).padStart(3, '0')}`
}

/**
 * Exact export format: one physical line per prompt, exactly ONE blank line between prompts,
 * real project scene numbers, sorted by sceneIndex. No markdown, no JSON.
 */
export function formatManualAiPromptText(pack: Pick<ManualAiPromptPack, 'scenes'>): string {
  const sorted = [...pack.scenes].sort((a, b) => a.sceneIndex - b.sceneIndex)
  return sorted.map((e) => `${formatSceneLabel(e.sceneIndex)} | ${sanitizePromptLine(e.prompt)}`).join('\n\n')
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function loadManualAiPromptPack(projectDir: string): ManualAiPromptPack | null {
  const p = getManualAiPromptJsonPath(projectDir)
  if (!fs.existsSync(p)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as ManualAiPromptPack
    if (!parsed || !Array.isArray(parsed.scenes)) return null
    return parsed
  } catch (err) {
    logger.warn(`[ManualAI] Failed to read prompt pack ${p}: ${err}`)
    return null
  }
}

export function saveManualAiPromptPackFiles(projectDir: string, pack: ManualAiPromptPack): void {
  writeFileAtomic(getManualAiPromptJsonPath(projectDir), JSON.stringify(pack, null, 2))
  writeFileAtomic(getManualAiPromptTxtPath(projectDir), formatManualAiPromptText(pack) + '\n')
}

export function readManualAiPromptText(projectDir: string): string | null {
  const pack = loadManualAiPromptPack(projectDir)
  if (!pack) return null
  return formatManualAiPromptText(pack)
}

export interface EnsurePromptPackResult {
  pack: ManualAiPromptPack
  /** True when the persisted pack was kept unchanged (no regeneration / rewrite). */
  reused: boolean
  generationMs: number
}

/**
 * Generates (or reuses) the persisted prompt pack for the CURRENT Visual Mix plan.
 * A persisted entry is kept whenever its INPUTS are unchanged, so prompts never change just
 * because the app was reopened. Entries whose narration / intent changed are regenerated
 * (their old imported image becomes stale through the promptHash).
 */
export function ensureManualAiPromptPack(params: {
  projectDir: string
  plan: PlanForPack
  profile: VisualMixProfile
  globalContext?: GlobalScriptContext
  outputResolution: AiImageOutputResolution
  visualBrief?: ManualAiVisualBrief
  sceneDirections?: Map<number, ManualAiSceneDirection> | ManualAiSceneDirection[]
}): EnsurePromptPackResult {
  const t0 = Date.now()
  const { projectDir, plan, profile, globalContext, outputResolution, visualBrief, sceneDirections } = params

  const fresh = buildManualAiPromptPack({
    plan,
    profile,
    globalContext,
    outputResolution,
    visualBrief,
    sceneDirections
  })
  const persisted = loadManualAiPromptPack(projectDir)

  let merged = fresh
  if (
    persisted &&
    persisted.schemaVersion === MANUAL_AI_PROMPT_SCHEMA_VERSION &&
    persisted.profile === profile &&
    persisted.outputResolution === outputResolution
  ) {
    const byScene = new Map(persisted.scenes.map((e) => [e.sceneIndex, e]))
    const scenes = fresh.scenes.map((e) => {
      const old = byScene.get(e.sceneIndex)
      return old && old.inputHash === e.inputHash ? { ...old, expectedFilename: e.expectedFilename, status: 'waiting-image' as const } : e
    })
    merged = { ...fresh, generatedAt: persisted.generatedAt, scenes }
  }

  assertManualAiPromptPack(merged, plan)

  const txtPath = getManualAiPromptTxtPath(projectDir)
  const unchanged =
    !!persisted &&
    fs.existsSync(txtPath) &&
    persisted.profile === merged.profile &&
    persisted.outputResolution === merged.outputResolution &&
    persisted.totalProjectScenes === merged.totalProjectScenes &&
    persisted.expectedAiImages === merged.expectedAiImages &&
    JSON.stringify(persisted.scenes) === JSON.stringify(merged.scenes)

  if (!unchanged) {
    merged = persisted && merged.generatedAt === persisted.generatedAt ? { ...merged, generatedAt: new Date().toISOString() } : merged
    saveManualAiPromptPackFiles(projectDir, merged)
  }

  return { pack: unchanged ? (persisted as ManualAiPromptPack) : merged, reused: unchanged, generationMs: Date.now() - t0 }
}
