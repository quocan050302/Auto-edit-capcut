import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../logger'
import type {
  AiImageOutputResolution,
  GlobalScriptContext,
  VisualMixProfile,
  VisualMixScenePlan
} from '../../../../shared/types'
import { detectVisualNiche } from '../general-image-prompt'
import {
  type ManualAiVisualBrief,
  type ManualAiSceneDirection
} from './manual-ai-types'
import {
  loadManualAiPromptPack,
  sanitizePromptLine,
  formatSceneLabel
} from './manual-ai-prompt-pack'
import type {
  SceneIdentityBinding,
  VisualIdentityBible
} from '../../content-intelligence/visual-identity-types'
import {
  loadVisualIdentityBible
} from '../../content-intelligence/visual-identity-bible'
import {
  resolveVideoSubjectGrounding,
  type VideoSubjectGrounding
} from './manual-ai-video-subject-grounding'
import {
  extractSceneVideoKeywords,
  extractSceneAvoidKeywords
} from './manual-ai-video-keywords'

// ─── Versioning & Types ───────────────────────────────────────────────────────

export const MANUAL_AI_VIDEO_PROMPT_SCHEMA_VERSION = 2

export type VideoVisualNiche =
  | 'health'
  | 'history'
  | 'hutterite-documentary'
  | 'finance'
  | 'food'
  | 'technology'
  | 'travel'
  | 'nature'
  | 'documentary'

export interface ManualAiVideoPromptEntry {
  sceneIndex: number
  sceneId: string
  prompt: string
  inputHash: string
  durationSecs: number
  niche: string
  expectedFilename: string
}

export interface ManualAiVideoPromptPack {
  schemaVersion: number
  generatedAt: string
  profile: 'health' | 'general'
  scenes: ManualAiVideoPromptEntry[]
}

export interface ManualVideoPromptParams {
  scene: VisualMixScenePlan
  profile: VisualMixProfile
  globalContext?: GlobalScriptContext
  visualBrief?: ManualAiVisualBrief
  sceneDirection?: ManualAiSceneDirection
  previousScene?: VisualMixScenePlan
  nextScene?: VisualMixScenePlan
  outputResolution: AiImageOutputResolution
  identityBible?: VisualIdentityBible
  sceneIdentity?: SceneIdentityBinding
  subjectGrounding?: VideoSubjectGrounding
  visualKeywords?: string[]
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

function sha256(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('||')).digest('hex')
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

// ─── Video Niche Directives ──────────────────────────────────────────────────

export interface VideoNicheDirective {
  style: string
  motionFocus: string
  cameraMotion: string
  environment: string
  lighting: string
  negativeConstraints: string
}

export const VIDEO_NICHE_DIRECTIVES: Record<VideoVisualNiche, VideoNicheDirective> = {
  health: {
    style: 'Photorealistic medical documentary sequence with biologically plausible anatomy and accurate physiological flow',
    motionFocus: 'realistic internal physiological motion, cellular transport, fluid dynamics, and biological cause-and-effect progression',
    cameraMotion: 'purposeful slow macro push-in with precise medical cutaway tracking',
    environment: 'dark navy medical background with subtle volumetric depth and accurate cellular tissue environment',
    lighting: 'clean clinical lighting with gentle directional rim light and dimensional highlights',
    negativeConstraints: 'no fake diagnostic numbers, no exaggerated disease gore, no speculative molecular diagrams, no speech, no background music, no UI text, no embedded captions, no logo, no watermark'
  },
  history: {
    style: 'Cinematic historical documentary reconstruction with authentic period-accurate material culture and garments',
    motionFocus: 'grounded historical human activity, practical manual labor, realistic era-specific tools, and environmental dynamics',
    cameraMotion: 'slow observational lateral tracking shot with smooth cinematic stabilization',
    environment: 'authentic historical setting with period architecture, natural dust motes, and atmospheric environmental depth',
    lighting: 'natural golden-hour illumination with long soft shadows and subtle atmospheric haze',
    negativeConstraints: 'no modern artifacts, no anachronistic objects, no artificial camera shake, no dialogue, no background music, no subtitles, no watermark, no logo'
  },
  'hutterite-documentary': {
    style: 'Authentic cinematic documentary of communal agrarian life with respectful observational realism',
    motionFocus: 'purposeful collective agricultural work, communal kitchen preparation, workshop craftsmanship, and realistic community coordination',
    cameraMotion: 'steady walking-speed lateral dolly shot framing both individual craftsmanship and collective scale',
    environment: 'authentic communal farmstead, colony kitchen or agricultural yard with practical working architecture and expansive rural sky',
    lighting: 'natural crisp morning daylight with atmospheric environmental depth',
    negativeConstraints: 'no Amish stereotyping, no invented religious dramatics, no talking to camera, no background music, no text overlays, no subtitles, no logo, no watermark'
  },
  finance: {
    style: 'Premium editorial financial documentary visual with sleek institutional realism',
    motionFocus: 'purposeful business operations, professional collaboration, active trading floor activity, and strategic decision-making',
    cameraMotion: 'restrained executive push-in with smooth architectural parallax',
    environment: 'modern corporate office, trading floor, or financial headquarters with refined glass and steel architecture',
    lighting: 'crisp daylight with sophisticated interior ambient reflections',
    negativeConstraints: 'no floating currency symbols, no fictional earnings charts, no glowing holographic graphs, no speech, no music, no subtitles, no logo, no watermark'
  },
  food: {
    style: 'High-end culinary documentary cinematography with rich sensory texture and authentic kitchen realism',
    motionFocus: 'physical cooking dynamics, gentle rising steam, slicing fresh ingredients, simmering liquids, and natural culinary motion',
    cameraMotion: 'smooth close-up tracking move with shallow depth of field focusing on culinary action',
    environment: 'authentic professional kitchen or rustic culinary workspace with natural wooden prep tables and focused cookware',
    lighting: 'soft directional window light accentuating fresh textures, moisture, and natural warmth',
    negativeConstraints: 'no cartoonish food animation, no unnatural floating ingredients, no speech, no music, no subtitles, no logo, no watermark'
  },
  technology: {
    style: 'Modern technical documentary sequence showcasing authentic engineering operations and sophisticated machinery',
    motionFocus: 'precise mechanical movement, active data center servers, robotic manufacturing, and tangible hardware processes',
    cameraMotion: 'controlled linear track along machinery showing mechanism interaction and operational flow',
    environment: 'clean advanced laboratory, data facility, or high-tech manufacturing floor',
    lighting: 'cool balanced ambient illumination with subtle indicator highlights and clean specular reflections',
    negativeConstraints: 'no generic sci-fi neon grids, no unreadable hallucinated UI text, no impossible fictional mechanisms, no speech, no music, no subtitles, no logo, no watermark'
  },
  travel: {
    style: 'Cinematic location documentary sequence capturing authentic cultural geography and human-scale exploration',
    motionFocus: 'natural pedestrian movement, environmental wind, moving local transit, and observational human journeys',
    cameraMotion: 'sweeping slow-panning camera move revealing expansive geographical scale',
    environment: 'authentic regional landscape, historic town square, or dramatic natural terrain with deep layered perspective',
    lighting: 'warm natural sunlight with atmospheric haze and rich environmental contrast',
    negativeConstraints: 'no tourist cliches, no staged exaggerated behavior, no dialogue, no background music, no subtitles, no logo, no watermark'
  },
  nature: {
    style: 'Cinematic natural-history documentary sequence with National Geographic observational clarity',
    motionFocus: 'authentic wildlife behavior, environmental dynamics, flowing water, swaying canopy, and shifting weather',
    cameraMotion: 'stabilized telephoto observational tracking keeping natural subject in steady frame',
    environment: 'pristine natural habitat with dense ecological layering and organic depth',
    lighting: 'unfiltered natural ambient light with rich organic tones and environmental depth',
    negativeConstraints: 'no anthropomorphized animal behavior, no artificial lighting, no narration audio, no music, no subtitles, no watermark, no logo'
  },
  documentary: {
    style: 'Photorealistic cinematic documentary sequence with natural observational presence',
    motionFocus: 'authentic human activity, environmental movement, and grounded narrative progression',
    cameraMotion: 'steady observational track at eye level maintaining clear compositional focus',
    environment: 'believable real-world environment with layered depth and natural spatial cues',
    lighting: 'natural cinematic illumination with balanced contrast and documentary color grading',
    negativeConstraints: 'no staged melodrama, no speech, no background music, no UI elements, no embedded subtitles, no watermark, no logo'
  }
}

// ─── Niche Detection ─────────────────────────────────────────────────────────

// Specific regex: requires actual Hutterite / Hutterian / Anabaptist markers, NOT standalone "colony"!
const HUTTERITE_SPECIFIC_REGEX = /\b(hutterite|hutterites|hutterian|anabaptist|hutterite\s*colony|hutterian\s*brethren)\b/i
const COMMUNAL_FARM_REGEX = /\b(communal\s*(?:farm|living|kitchen|work|meal))\b/i

export function detectVideoNiche(
  groundingText: string,
  profile: VisualMixProfile,
  globalContext?: GlobalScriptContext,
  visualBrief?: ManualAiVisualBrief
): VideoVisualNiche {
  if (profile === 'health') return 'health'

  const combined = `${groundingText} ${globalContext?.primarySubject || ''} ${globalContext?.centralThesis || ''} ${visualBrief?.corePromise || ''}`.toLowerCase()

  // 1. Communal / Hutterite documentary specialization (requires explicit Hutterite / Anabaptist context, never colony alone)
  if (HUTTERITE_SPECIFIC_REGEX.test(combined)) {
    return 'hutterite-documentary'
  }
  if (
    COMMUNAL_FARM_REGEX.test(combined) &&
    (globalContext?.primarySubject?.toLowerCase().includes('hutterite') ||
      globalContext?.communities?.some((c) => HUTTERITE_SPECIFIC_REGEX.test(c.name)))
  ) {
    return 'hutterite-documentary'
  }

  // 2. Explicit visualBrief primary niche if matched
  const briefNiche = (visualBrief?.primaryNiche || '').toLowerCase() as VideoVisualNiche
  if (briefNiche && briefNiche in VIDEO_NICHE_DIRECTIVES && briefNiche !== 'documentary') {
    return briefNiche
  }

  // 3. Fall back to existing general niche detector
  const detected = detectVisualNiche(groundingText, globalContext)
  return detected in VIDEO_NICHE_DIRECTIVES ? (detected as VideoVisualNiche) : 'documentary'
}

// ─── Physically Compatible Camera Motion ─────────────────────────────────────

function pickRoleCameraMotion(
  role: string | undefined,
  defaultMotion: string
): string {
  switch (role) {
    case 'hook':
    case 'reveal':
      return 'slow purposeful push-in focusing closely on the critical detail'
    case 'mechanism':
    case 'cause-effect':
      return 'steady controlled tracking shot following physical progression and interaction'
    case 'problem':
    case 'question':
      return 'slow observational lateral dolly capturing tension and environmental scale'
    case 'lifestyle':
    case 'demonstration':
      return 'stabilized walking-speed medium tracking shot keeping pace with the subject'
    case 'setup':
    case 'transition':
      return 'wide establishing drift revealing spatial context and environmental scale'
    default:
      return defaultMotion
  }
}

export function resolveVideoCameraMotion(params: {
  scene: VisualMixScenePlan
  sceneDirection?: ManualAiSceneDirection
  directive: VideoNicheDirective
  niche: VideoVisualNiche
}): string {
  const { scene, sceneDirection, directive, niche } = params
  const text = `${scene.visualIntent || ''} ${scene.narration || ''} ${sceneDirection?.composition?.shotType || ''}`.toLowerCase()

  // 1. Aerial / drone / panoramic shot: Drone glide or slow aerial tracking
  if (/\b(aerial|drone|bird'?s eye|overhead|top-down|high altitude|landscape panorama)\b/i.test(text)) {
    return 'drone glide with slow cinematic aerial tracking revealing spatial geography'
  }

  // 2. Macro / close-up document or fine object: Restrained slider maintaining locked macro framing
  if (/\b(macro|extreme close-up|document|ledger|paper|parchment|microscopic|texture close-up)\b/i.test(text)) {
    return 'restrained slider movement maintaining locked macro framing on fine details'
  }

  // 3. Workshop / craft / manual labor / cooking interaction
  if (/\b(workshop|repair|maintenance|hand tools|workbench|cooking|chopping|baking|culinary prep)\b/i.test(text)) {
    return 'controlled lateral tracking keeping pace with the hands and machinery interaction'
  }

  // 4. Architecture / institutional building / courthouse exterior
  if (/\b(courthouse|facade|columns|architecture|institution|hallway|interior architecture)\b/i.test(text)) {
    return 'stable wide reveal with gentle architectural parallax'
  }

  // 5. Internal anatomy / cellular transport / medical cutaway
  if (niche === 'health' || /\b(capillary|cellular|tissue|artery|vessel|organ|glomerulus|nephron)\b/i.test(text)) {
    return 'purposeful slow cutaway tracking following the anatomical pathway'
  }

  // 6. Stationary observation / timelapse
  if (/\b(timelapse|time-lapse|stationary|locked-off|static observation|standstill)\b/i.test(text)) {
    return 'locked-off camera with subtle natural environmental drift'
  }

  // 7. Role-based fallback
  return pickRoleCameraMotion(sceneDirection?.sceneRole, directive.cameraMotion)
}

// ─── Observable Action Synthesizer ───────────────────────────────────────────

function resolveObservableAction(params: {
  scene: VisualMixScenePlan
  grounding: VideoSubjectGrounding
  niche: VideoVisualNiche
  sceneDirection?: ManualAiSceneDirection
}): string {
  const { scene, grounding, niche, sceneDirection } = params
  const dirAction = cleanText(sceneDirection?.visualEvent?.action)
  const isHealth = niche === 'health'

  // If sceneDirection has a real, specific action (not generic fallback), use it
  if (
    dirAction &&
    !dirAction.includes('demonstrating concrete dynamic action') &&
    !dirAction.includes('demonstrating realistic purposeful') &&
    !dirAction.includes('actively engaging in physiological')
  ) {
    if (!isHealth && /\b(biological|physiological|cellular|organ|tissue)\b/i.test(dirAction)) {
      // Cross-domain semantic guard: strip biological terms for non-health
    } else {
      return dirAction
    }
  }

  const text = `${scene.visualIntent || ''} ${scene.narration || ''}`.toLowerCase()

  // Scene-grounded domain specific observable actions
  if (isHealth) {
    if (text.includes('glomerulus') || text.includes('nephron') || text.includes('kidney')) {
      return 'arterial blood flows steadily through glomerular capillaries as metabolic waste filters across the semi-permeable membrane'
    }
    if (text.includes('bladder')) {
      return 'urine droplets descend through ureters into the bladder lumen, causing gentle expansion of the elastic bladder wall'
    }
    return 'actively circulating physiological fluid through vascular pathways and microvascular beds'
  }

  if (niche === 'hutterite-documentary') {
    if (/\b(workshop|equipment|machine|maintenance|fitting|tool)\b/i.test(text)) {
      return 'one worker steadies a mechanical housing while another carefully checks a fastening and adjusts a fitting using an appropriate hand tool'
    }
    if (/\b(kitchen|cooking|baking|meal|bread|prep)\b/i.test(text)) {
      return 'workers portion fresh ingredients and stir large simmering preparation vessels on clean stainless steel counters'
    }
    if (/\b(courthouse|court|legal records|law)\b/i.test(text)) {
      return 'the camera frames the monumental stone facade and institutional steps as daylight reveals architectural details'
    }
    if (/\b(document|deed|records|ledger|parchment|registry)\b/i.test(text)) {
      return 'a hand carefully turns the aged ledger page, examining the ink registry entries and official seals'
    }
    if (/\b(aerial|drone|farmstead|colony|prairie)\b/i.test(text)) {
      return 'the camera tracks across the layout of communal residential buildings, grain silos, and expansive cultivated acreage'
    }
    return 'collaboratively operating modern agricultural equipment and coordinating farmstead operations'
  }

  if (niche === 'food') {
    return 'slicing fresh ingredients with focused knife work and simmering aromatic liquids on prep cookware'
  }
  if (niche === 'technology') {
    return 'operating with precision mechanical calibration and hardware data flow'
  }
  if (niche === 'finance') {
    return 'reviewing corporate financial records and analyzing market performance indicators'
  }
  if (niche === 'history') {
    if (/\b(roman|legion|soldier|guard)\b/i.test(text)) {
      return 'soldiers march in disciplined formation along the frontier perimeter, keeping watchful observation'
    }
    return 'demonstrating period-authentic craftsmanship and grounded era-specific interaction'
  }
  if (niche === 'nature') {
    return 'foraging and navigating naturally through the native habitat without disturbance'
  }
  if (niche === 'travel') {
    return 'traversing regional pathways as local surroundings and geography unfold'
  }

  // General documentary fallback
  if (grounding.socialBehavior.length > 0) {
    return grounding.socialBehavior[0]
  }
  return 'engaging in purposeful daily activity grounded in authentic real-world surroundings'
}

// ─── Pure Scene Video Prompt Builder ─────────────────────────────────────────

export function buildManualSceneVideoPrompt(params: ManualVideoPromptParams): string {
  const { scene, profile, globalContext, visualBrief, sceneDirection, outputResolution, identityBible, sceneIdentity } = params

  const isHealth = profile === 'health'
  const dims = outputResolution === '4k' ? '3840x2160' : outputResolution === '2k' ? '2560x1440' : '1920x1080'

  const narration = cleanText(scene.narration)
  const intent = cleanText(scene.visualIntent)
  const groundingText = `${narration} ${intent}`.trim()

  const niche = detectVideoNiche(groundingText, profile, globalContext, visualBrief)
  const directive = VIDEO_NICHE_DIRECTIVES[niche]

  const durationSecs =
    typeof scene.duration === 'number' && Number.isFinite(scene.duration) && scene.duration > 0
      ? Math.round(scene.duration)
      : 5

  // 1. Resolve Subject Grounding
  const grounding =
    params.subjectGrounding ||
    resolveVideoSubjectGrounding({
      scene,
      globalContext,
      identityBible,
      sceneIdentity,
      sceneDirection,
      profile
    })

  // 2. Camera Motion & Framing
  const cameraMotion = resolveVideoCameraMotion({ scene, sceneDirection, directive, niche })
  const shotType = cleanText(sceneDirection?.composition?.shotType) || (isHealth ? 'macro cutaway shot' : 'medium observational shot')
  const lensFeel = cleanText(sceneDirection?.composition?.lensFeel) || (isHealth ? '100mm medical macro lens' : '35mm cinematic lens')

  // 3. Subject & Appearance Specification
  const subject = grounding.canonicalSubject || (isHealth ? 'human physiological tissue structures' : 'documentary subject in authentic setting')
  const action = resolveObservableAction({ scene, grounding, niche, sceneDirection })

  // Subject wardrobe / traits clause
  let subjectDetailClause = ''
  if (grounding.presence === 'dominant' || grounding.presence === 'visible') {
    const parts: string[] = []
    if (grounding.wardrobe.length > 0) {
      parts.push(`wearing ${grounding.wardrobe.slice(0, 3).join(', ')}`)
    }
    if (grounding.physicalAppearance.length > 0) {
      parts.push(`with ${grounding.physicalAppearance.slice(0, 2).join(', ')}`)
    }
    if (parts.length > 0) {
      const forbiddenHint = grounding.forbiddenSubstitutions.length > 0
        ? ` Their appearance and clothing should reflect the identity details established for this community rather than ${grounding.forbiddenSubstitutions[0]}.`
        : ''
      subjectDetailClause = `A small group of ${subject} ${parts.join(' ')}.${forbiddenHint}`
    }
  }

  // 4. Temporal Progression (Beginning, Middle, Ending)
  const narrationSummary = cleanText(narration)
  const narrationClause = narrationSummary ? `grounded in the scene narrative: ${truncateWords(narrationSummary, 15)}` : ''
  const beginningClause = narrationClause
    ? `In the beginning, establish ${subject}, ${narrationClause}.`
    : `In the beginning, establish ${subject} initiating action.`

  const middleChange = cleanText(sceneDirection?.visualEvent?.change)
  // Semantic guard for middle change
  const cleanMiddleChange = !isHealth && /\b(biological|physiological|cellular)\b/i.test(middleChange) ? '' : middleChange
  const middleClause = cleanMiddleChange
    ? `As the shot progresses, develop ${action} with ${cleanMiddleChange} while the camera executes a ${cameraMotion}.`
    : `As the clip progresses, maintain smooth visible development of ${action} while the camera executes a ${cameraMotion}.`

  // Consequence / Ending with cross-domain semantic guard
  let rawConsequence = cleanText(sceneDirection?.visualEvent?.consequence)
  if (!isHealth) {
    if (/\b(biological|physiological|cellular|organ|tissue)\b/i.test(rawConsequence)) {
      rawConsequence = 'observable real-world development'
    }
  }
  const endingClause = rawConsequence
    ? `Toward the end of the shot, settle on the consequence: ${rawConsequence}.`
    : `Toward the end of the shot, smoothly complete the visible motion without abrupt stops.`

  // 5. Lighting & Environment
  const lighting = cleanText(sceneDirection?.lighting) || directive.lighting
  const envDetail = grounding.environment[0] || cleanText(sceneDirection?.composition?.background) || directive.environment
  const environmentClause = `Environment and atmosphere: ${envDetail}, illuminated by ${lighting}.`

  // 6. Realism & Continuity
  const realismClause = isHealth
    ? 'Preserve anatomically accurate cellular proportions and believable physiological fluid mechanics.'
    : 'Preserve the real-world proportions of equipment, believable body mechanics and authentic contemporary rural working atmosphere.'

  let continuityClause = ''
  if (sceneDirection?.continuityNote) {
    continuityClause = `Maintain strict continuity: ${cleanText(sceneDirection.continuityNote)}.`
  } else {
    continuityClause = 'Maintain strict continuity of wardrobe, architecture, lighting color temperature, and documentary palette with surrounding scenes.'
  }

  // 7. Text Overlay Reserve
  let overlayReserveClause = ''
  if (sceneDirection?.textOverlay?.enabled && sceneDirection.textOverlay?.position) {
    const pos = sceneDirection.textOverlay.position.replace('-', ' ')
    overlayReserveClause = `Reserve clean, uncluttered negative space in the ${pos} quadrant for external editorial captions.`
  }

  // 8. Technical Specifications & Duration
  const durationClause = `Target clip duration: ${durationSecs} seconds.`
  const techClause = `Horizontal 16:9 video (${dims}).`
  const negativeClause = `${directive.negativeConstraints}.`

  // 9. Keywords & Avoid Constraints
  const visualKeywords = params.visualKeywords || extractSceneVideoKeywords({ scene, grounding, globalContext, sceneDirection, niche })
  const avoidKeywords = extractSceneAvoidKeywords({ scene, grounding, globalContext, sceneDirection, niche })

  const keywordsClause = `Visual keywords: ${visualKeywords.join(', ')}.`
  const avoidClause = avoidKeywords.length > 0 ? `Avoid: ${avoidKeywords.join(', ')}.` : ''

  // 10. Assemble Prompt with Budget Control (Target 150-250, Hard Limit 320 words)
  const assemble = (level: number): string => {
    // Level 0: Full prompt
    // Level 1: Trim generic realism clause
    // Level 2: Trim continuity clause
    // Level 3: Trim ending clause
    const parts: string[] = [
      `${directive.style} capturing ${subject}.`,
      subjectDetailClause,
      beginningClause,
      middleClause,
      level < 3 ? endingClause : '',
      `Framing: ${shotType} on a ${lensFeel}.`,
      environmentClause,
      level < 1 ? realismClause : '',
      level < 2 ? continuityClause : '',
      overlayReserveClause,
      durationClause,
      techClause,
      negativeClause,
      keywordsClause,
      avoidClause
    ]
    return sanitizePromptLine(parts.filter(Boolean).join(' '))
  }

  let prompt = assemble(0)
  if (countWords(prompt) > 310) prompt = assemble(1)
  if (countWords(prompt) > 310) prompt = assemble(2)
  if (countWords(prompt) > 310) prompt = assemble(3)

  return prompt
}

// ─── Input Hash for Video Prompt ─────────────────────────────────────────────

export function computeManualVideoPromptInputHash(params: {
  sceneIndex: number
  narration: string
  visualIntent?: string
  duration?: number
  profile: VisualMixProfile
  niche: string
  outputResolution: AiImageOutputResolution
  sceneRole?: string
  hookLevel?: string
  visualEvent?: { subject?: string; action?: string; change?: string; consequence?: string }
  continuityNote?: string
  cameraMotion?: string
  groundingTraits?: string
  globalContextHash?: string
  keywords?: string[]
  avoidKeywords?: string[]
}): string {
  const parts = [
    String(params.sceneIndex),
    cleanText(params.narration),
    cleanText(params.visualIntent),
    String(params.duration || 5),
    params.profile,
    params.niche,
    params.outputResolution,
    params.sceneRole || '',
    params.hookLevel || '',
    params.visualEvent?.subject || '',
    params.visualEvent?.action || '',
    params.visualEvent?.change || '',
    params.visualEvent?.consequence || '',
    params.continuityNote || '',
    params.cameraMotion || '',
    params.groundingTraits || '',
    params.globalContextHash || '',
    (params.keywords || []).join(','),
    (params.avoidKeywords || []).join(','),
    String(MANUAL_AI_VIDEO_PROMPT_SCHEMA_VERSION)
  ]
  return sha256(parts)
}

// ─── Formatter ───────────────────────────────────────────────────────────────

export function formatManualAiVideoPromptText(
  pack: Pick<ManualAiVideoPromptPack, 'scenes'>
): string {
  return [...pack.scenes]
    .sort((a, b) => a.sceneIndex - b.sceneIndex)
    .map((entry) => `${formatSceneLabel(entry.sceneIndex)} | ${sanitizePromptLine(entry.prompt)}`)
    .join('\n\n')
}

// ─── Persistence & Pack Management ───────────────────────────────────────────

export function getManualAiVideoPromptJsonPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'manual-ai-video-prompts.json')
}

export function getManualAiVideoPromptTxtPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'manual-ai-video-prompts.txt')
}

export function loadManualAiVideoPromptPack(projectDir: string): ManualAiVideoPromptPack | null {
  const p = getManualAiVideoPromptJsonPath(projectDir)
  if (!fs.existsSync(p)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as ManualAiVideoPromptPack
    if (!parsed || !Array.isArray(parsed.scenes)) return null
    return parsed
  } catch (err) {
    logger.warn(`[ManualAI:VideoPrompt] Failed to read video prompt pack ${p}: ${err}`)
    return null
  }
}

export function saveManualAiVideoPromptPackFiles(
  projectDir: string,
  pack: ManualAiVideoPromptPack
): void {
  writeFileAtomic(getManualAiVideoPromptJsonPath(projectDir), JSON.stringify(pack, null, 2))
  writeFileAtomic(getManualAiVideoPromptTxtPath(projectDir), formatManualAiVideoPromptText(pack) + '\n')
}

export function readManualAiVideoPromptText(projectDir: string): string | null {
  const pack = loadManualAiVideoPromptPack(projectDir)
  if (pack && pack.schemaVersion === MANUAL_AI_VIDEO_PROMPT_SCHEMA_VERSION) {
    const txtPath = getManualAiVideoPromptTxtPath(projectDir)
    if (fs.existsSync(txtPath)) {
      try {
        const content = fs.readFileSync(txtPath, 'utf-8').trim()
        if (content) return content
      } catch {
        /* fall through to pack load */
      }
    }
    return formatManualAiVideoPromptText(pack)
  }
  // Missing or outdated schemaVersion -> ensure fresh generation
  try {
    const newPack = ensureManualAiVideoPromptPack(projectDir)
    return formatManualAiVideoPromptText(newPack)
  } catch {
    return null
  }
}

/**
 * Generates (or reuses cached) video prompts for all AI-owned scenes in the project.
 * Completely separate from image prompt persistence.
 */
export function ensureManualAiVideoPromptPack(projectDir: string): ManualAiVideoPromptPack {
  // 1. Identify AI-owned scenes from the image prompt pack and plans
  const imagePack = loadManualAiPromptPack(projectDir)
  let aiScenesToGenerate: Array<{ sceneIndex: number; narration: string; visualIntent?: string; duration?: number }> = []
  let profile: 'health' | 'general' = imagePack?.profile ?? 'general'
  let outputResolution: AiImageOutputResolution = imagePack?.outputResolution ?? '1080p'

  // Also check visual-mix-plan.json for scene metadata
  const planPath = path.join(projectDir, 'analysis', 'visual-mix-plan.json')
  let planScenesMap = new Map<number, VisualMixScenePlan>()
  if (fs.existsSync(planPath)) {
    try {
      const planData = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
      if (planData?.profile) profile = planData.profile
      if (planData?.outputResolution) outputResolution = planData.outputResolution
      if (Array.isArray(planData?.scenes)) {
        for (const s of planData.scenes) {
          planScenesMap.set(s.sceneIndex, s)
        }
      }
    } catch {
      /* ignore read errors */
    }
  }

  // Fallback to master-edit-plan.json for authoritative narration if needed
  const masterEditPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
  if (fs.existsSync(masterEditPath)) {
    try {
      const masterData = JSON.parse(fs.readFileSync(masterEditPath, 'utf-8'))
      const chapters = masterData?.chapters || []
      for (const ch of chapters) {
        for (const seq of ch.chapters_seq || []) {
          for (const sc of seq.scenes || []) {
            if (!planScenesMap.has(sc.sceneIndex)) {
              planScenesMap.set(sc.sceneIndex, {
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

  if (imagePack && Array.isArray(imagePack.scenes) && imagePack.scenes.length > 0) {
    aiScenesToGenerate = imagePack.scenes.map((s) => {
      const fromPlan = planScenesMap.get(s.sceneIndex)
      // Never use s.prompt (the image prompt) as narration!
      const resolvedNarration = fromPlan?.narration || fromPlan?.visualIntent || `Scene ${s.sceneIndex}`
      return {
        sceneIndex: s.sceneIndex,
        narration: resolvedNarration,
        visualIntent: fromPlan?.visualIntent,
        duration: fromPlan?.duration
      }
    })
  } else if (planScenesMap.size > 0) {
    for (const [idx, s] of planScenesMap.entries()) {
      if (s.strategy === 'ai-still') {
        aiScenesToGenerate.push({
          sceneIndex: idx,
          narration: s.narration || s.visualIntent || `Scene ${idx}`,
          visualIntent: s.visualIntent,
          duration: s.duration
        })
      }
    }
  }

  if (aiScenesToGenerate.length === 0) {
    throw new Error('No AI-owned scenes found. Start production or generate a visual mix plan first.')
  }

  // 2. Load optional artifacts
  let globalContext: GlobalScriptContext | undefined
  const contextPath = path.join(projectDir, 'analysis', 'global-script-context.json')
  if (fs.existsSync(contextPath)) {
    try {
      globalContext = JSON.parse(fs.readFileSync(contextPath, 'utf-8'))
    } catch {
      /* ignore */
    }
  }

  // Load Visual Identity Bible if available
  const identityBible = loadVisualIdentityBible(projectDir)

  let visualBrief: ManualAiVisualBrief | undefined
  const briefPath = path.join(projectDir, 'analysis', 'manual-ai-visual-brief.json')
  if (fs.existsSync(briefPath)) {
    try {
      visualBrief = JSON.parse(fs.readFileSync(briefPath, 'utf-8'))
    } catch {
      /* ignore */
    }
  }

  const directionsMap = new Map<number, ManualAiSceneDirection>()
  const directionsPath = path.join(projectDir, 'analysis', 'manual-ai-scene-directions.json')
  if (fs.existsSync(directionsPath)) {
    try {
      const dirArtifact = JSON.parse(fs.readFileSync(directionsPath, 'utf-8'))
      if (Array.isArray(dirArtifact?.directions)) {
        for (const d of dirArtifact.directions) {
          directionsMap.set(d.sceneIndex, d)
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Load existing cached video pack if any (must match current schema version)
  const existingPack = loadManualAiVideoPromptPack(projectDir)
  const existingByScene = new Map<number, ManualAiVideoPromptEntry>()
  if (existingPack && existingPack.schemaVersion === MANUAL_AI_VIDEO_PROMPT_SCHEMA_VERSION) {
    for (const entry of existingPack.scenes) {
      existingByScene.set(entry.sceneIndex, entry)
    }
  }

  // 4. Generate entries
  aiScenesToGenerate.sort((a, b) => a.sceneIndex - b.sceneIndex)
  const entries: ManualAiVideoPromptEntry[] = []

  const globalContextHash = globalContext
    ? sha256([
        globalContext.primarySubject || '',
        globalContext.centralThesis || '',
        (globalContext.exactTopicAnchors || []).join(','),
        (globalContext.forbiddenSubstitutions || []).join(',')
      ])
    : ''

  for (let i = 0; i < aiScenesToGenerate.length; i++) {
    const item = aiScenesToGenerate[i]
    const scenePlan: VisualMixScenePlan = planScenesMap.get(item.sceneIndex) || {
      sceneIndex: item.sceneIndex,
      narration: item.narration,
      visualIntent: item.visualIntent,
      duration: item.duration || 5,
      strategy: 'ai-still',
      assetType: 'ai-image',
      imagePrompt: ''
    }

    const sceneDirection = directionsMap.get(item.sceneIndex)
    const groundingText = `${scenePlan.narration} ${scenePlan.visualIntent || ''}`.trim()
    const niche = detectVideoNiche(groundingText, profile, globalContext, visualBrief)
    const directive = VIDEO_NICHE_DIRECTIVES[niche]

    const subjectGrounding = resolveVideoSubjectGrounding({
      scene: scenePlan,
      globalContext,
      identityBible: identityBible ?? undefined,
      sceneDirection,
      profile
    })

    const cameraMotion = resolveVideoCameraMotion({
      scene: scenePlan,
      sceneDirection,
      directive,
      niche
    })

    const visualKeywords = extractSceneVideoKeywords({
      scene: scenePlan,
      grounding: subjectGrounding,
      globalContext,
      sceneDirection,
      niche
    })

    const avoidKeywords = extractSceneAvoidKeywords({
      scene: scenePlan,
      grounding: subjectGrounding,
      globalContext,
      sceneDirection,
      niche
    })

    const groundingTraits = sha256([
      subjectGrounding.canonicalSubject,
      subjectGrounding.presence,
      subjectGrounding.wardrobe.join(','),
      subjectGrounding.architecture.join(','),
      subjectGrounding.environment.join(','),
      subjectGrounding.machinery.join(','),
      subjectGrounding.tools.join(','),
      subjectGrounding.forbiddenSubstitutions.join(',')
    ])

    const inputHash = computeManualVideoPromptInputHash({
      sceneIndex: item.sceneIndex,
      narration: scenePlan.narration,
      visualIntent: scenePlan.visualIntent,
      duration: scenePlan.duration,
      profile,
      niche,
      outputResolution,
      sceneRole: sceneDirection?.sceneRole,
      hookLevel: sceneDirection?.hookLevel,
      visualEvent: sceneDirection?.visualEvent,
      continuityNote: sceneDirection?.continuityNote,
      cameraMotion,
      groundingTraits,
      globalContextHash,
      keywords: visualKeywords,
      avoidKeywords
    })

    const cached = existingByScene.get(item.sceneIndex)
    if (cached && cached.inputHash === inputHash) {
      entries.push(cached)
    } else {
      const prev = i > 0 ? planScenesMap.get(aiScenesToGenerate[i - 1].sceneIndex) : undefined
      const next = i < aiScenesToGenerate.length - 1 ? planScenesMap.get(aiScenesToGenerate[i + 1].sceneIndex) : undefined

      const prompt = buildManualSceneVideoPrompt({
        scene: scenePlan,
        profile,
        globalContext,
        visualBrief,
        sceneDirection,
        previousScene: prev,
        nextScene: next,
        outputResolution,
        identityBible: identityBible ?? undefined,
        subjectGrounding,
        visualKeywords
      })

      entries.push({
        sceneIndex: item.sceneIndex,
        sceneId: `scene_${item.sceneIndex}`,
        prompt,
        inputHash,
        durationSecs: typeof scenePlan.duration === 'number' && scenePlan.duration > 0 ? Math.round(scenePlan.duration) : 5,
        niche,
        expectedFilename: `S${String(item.sceneIndex).padStart(4, '0')}.mp4`
      })
    }
  }

  // 5. Validation
  const seenIndices = new Set<number>()
  for (const entry of entries) {
    if (seenIndices.has(entry.sceneIndex)) {
      throw new Error(`Duplicate sceneIndex ${entry.sceneIndex} in video prompt pack.`)
    }
    seenIndices.add(entry.sceneIndex)
    if (!entry.prompt || entry.prompt.trim().length === 0) {
      throw new Error(`Empty prompt generated for scene ${entry.sceneIndex}.`)
    }
  }

  const newPack: ManualAiVideoPromptPack = {
    schemaVersion: MANUAL_AI_VIDEO_PROMPT_SCHEMA_VERSION,
    generatedAt: existingPack?.generatedAt || new Date().toISOString(),
    profile,
    scenes: entries
  }

  // Save atomic
  saveManualAiVideoPromptPackFiles(projectDir, newPack)

  logger.info(
    `[ManualAI:VideoPrompt] ensureManualAiVideoPromptPack completed for project=${projectDir} totalPrompts=${entries.length} schemaVersion=${MANUAL_AI_VIDEO_PROMPT_SCHEMA_VERSION}`
  )

  return newPack
}
