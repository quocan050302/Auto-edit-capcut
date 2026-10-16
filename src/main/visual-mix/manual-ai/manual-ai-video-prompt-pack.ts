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
import { detectVisualNiche, type GeneralVisualNiche } from '../general-image-prompt'
import {
  type ManualAiVisualBrief,
  type ManualAiSceneDirection
} from './manual-ai-types'
import { loadManualAiPromptPack, sanitizePromptLine, formatSceneLabel } from './manual-ai-prompt-pack'

// ─── Versioning & Types ───────────────────────────────────────────────────────

export const MANUAL_AI_VIDEO_PROMPT_SCHEMA_VERSION = 1

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

const HUTTERITE_KEYWORDS = /\b(hutterite|colony|colonies|communal\s*(?:farm|living|kitchen|work|meal)|anabaptist)\b/i

export function detectVideoNiche(
  groundingText: string,
  profile: VisualMixProfile,
  globalContext?: GlobalScriptContext,
  visualBrief?: ManualAiVisualBrief
): VideoVisualNiche {
  if (profile === 'health') return 'health'

  const combined = `${groundingText} ${globalContext?.primarySubject || ''} ${globalContext?.centralThesis || ''} ${visualBrief?.corePromise || ''}`.toLowerCase()

  // 1. Communal / Hutterite documentary specialization
  if (HUTTERITE_KEYWORDS.test(combined)) {
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

// ─── Role-Based Camera Motion ────────────────────────────────────────────────

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

// ─── Pure Scene Video Prompt Builder ─────────────────────────────────────────

export function buildManualSceneVideoPrompt(params: ManualVideoPromptParams): string {
  const { scene, profile, globalContext, visualBrief, sceneDirection, outputResolution } = params

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

  // 1. Subject & Core Action
  let subject = cleanText(sceneDirection?.visualEvent?.subject || intent || narration)
  subject = truncateWords(subject, 20)
  if (!subject) {
    subject = isHealth ? 'human physiological tissue structures' : 'documentary subject in authentic setting'
  }

  let action = cleanText(sceneDirection?.visualEvent?.action)
  if (!action) {
    if (isHealth) {
      action = 'actively engaging in physiological fluid circulation and cellular activity'
    } else if (niche === 'hutterite-documentary') {
      action = 'carrying out coordinated communal agricultural labor'
    } else if (niche === 'food') {
      action = 'undergoing culinary preparation with realistic texture and moisture change'
    } else if (niche === 'technology') {
      action = 'operating with precision mechanical movement and digital system activity'
    } else if (niche === 'finance') {
      action = 'conducting focused commercial and financial operations'
    } else if (niche === 'history') {
      action = 'demonstrating period-authentic work and grounded practical interaction'
    } else {
      action = 'demonstrating realistic purposeful documentary activity'
    }
  }

  // 2. Camera Motion & Framing
  const cameraMotion = pickRoleCameraMotion(sceneDirection?.sceneRole, directive.cameraMotion)
  const shotType = cleanText(sceneDirection?.composition?.shotType) || (isHealth ? 'macro cutaway shot' : 'medium observational shot')
  const lensFeel = cleanText(sceneDirection?.composition?.lensFeel) || (isHealth ? '100mm medical macro lens' : '35mm cinematic lens')

  // 3. Temporal Progression (Beginning, Middle, Ending)
  const narrationSummary = cleanText(narration)
  const narrationClause = narrationSummary ? `grounded in the scene narrative: ${truncateWords(narrationSummary, 15)}` : ''
  const beginningClause = narrationClause
    ? `In the beginning, establish ${subject}, ${narrationClause}.`
    : `In the beginning, establish ${subject} initiating action.`
  const middleChange = cleanText(sceneDirection?.visualEvent?.change)
  const middleClause = middleChange
    ? `As the shot progresses, develop ${action} with ${middleChange} while the camera executes a ${cameraMotion}.`
    : `As the clip progresses, maintain smooth visible development of ${action} while the camera executes a ${cameraMotion}.`

  const consequence = cleanText(sceneDirection?.visualEvent?.consequence)
  const endingClause = consequence
    ? `Toward the end of the shot, settle on the consequence: ${consequence}.`
    : `Toward the end of the shot, smoothly complete the visible motion without abrupt stops.`

  // 4. Lighting & Environment
  const lighting = cleanText(sceneDirection?.lighting) || directive.lighting
  const environment = cleanText(sceneDirection?.composition?.background) || directive.environment
  const environmentClause = `Environment and atmosphere: ${environment}, illuminated by ${lighting}.`

  // 5. Continuity
  let continuityClause = ''
  if (sceneDirection?.continuityNote) {
    continuityClause = `Continuity: ${cleanText(sceneDirection.continuityNote)}.`
  } else {
    continuityClause = `Maintain strict continuity of wardrobe, architecture, lighting color temperature, and documentary palette with surrounding scenes.`
  }

  // 6. Text Overlay Negative Space
  let overlayReserveClause = ''
  if (sceneDirection?.textOverlay?.enabled && sceneDirection.textOverlay?.position) {
    const pos = sceneDirection.textOverlay.position.replace('-', ' ')
    overlayReserveClause = `Reserve clean, uncluttered negative space in the ${pos} quadrant for external editorial captions.`
  }

  // 7. Technical Specifications & Duration
  const durationClause = `Target clip duration: ${durationSecs} seconds.`
  const techClause = `Horizontal 16:9 video (${dims}).`
  const negativeClause = `${directive.negativeConstraints}.`

  // Compose
  const assemble = (includeEnding: boolean, includeContinuity: boolean): string => {
    const parts = [
      `${directive.style} capturing ${subject}.`,
      beginningClause,
      middleClause,
      includeEnding ? endingClause : '',
      `Framing: ${shotType} on a ${lensFeel}.`,
      environmentClause,
      includeContinuity ? continuityClause : '',
      overlayReserveClause,
      durationClause,
      techClause,
      negativeClause
    ]
    return sanitizePromptLine(parts.filter(Boolean).join(' '))
  }

  let prompt = assemble(true, true)
  // Target: normal 120-200, high hook 160-260, ceiling 300 words
  if (countWords(prompt) > 280) prompt = assemble(false, true)
  if (countWords(prompt) > 280) prompt = assemble(false, false)

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
  const txtPath = getManualAiVideoPromptTxtPath(projectDir)
  if (fs.existsSync(txtPath)) {
    try {
      const content = fs.readFileSync(txtPath, 'utf-8').trim()
      if (content) return content
    } catch {
      /* fall through to pack load */
    }
  }
  const pack = loadManualAiVideoPromptPack(projectDir)
  if (!pack) return null
  return formatManualAiVideoPromptText(pack)
}

/**
 * Generates (or reuses cached) video prompts for all AI-owned scenes in the project.
 * Completely separate from image prompt persistence.
 */
export function ensureManualAiVideoPromptPack(projectDir: string): ManualAiVideoPromptPack {
  // 1. Identify AI-owned scenes from the image prompt pack
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

  if (imagePack && Array.isArray(imagePack.scenes) && imagePack.scenes.length > 0) {
    aiScenesToGenerate = imagePack.scenes.map((s) => {
      const fromPlan = planScenesMap.get(s.sceneIndex)
      return {
        sceneIndex: s.sceneIndex,
        narration: fromPlan?.narration || s.prompt, // s.prompt or narration
        visualIntent: fromPlan?.visualIntent,
        duration: fromPlan?.duration
      }
    })
  } else if (planScenesMap.size > 0) {
    for (const [idx, s] of planScenesMap.entries()) {
      if (s.strategy === 'ai-still') {
        aiScenesToGenerate.push({
          sceneIndex: idx,
          narration: s.narration,
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

  // 3. Load existing cached video pack if any
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
      continuityNote: sceneDirection?.continuityNote
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
        outputResolution
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

  // 5. Validation (Section 77)
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
    `[ManualAI:VideoPrompt] ensureManualAiVideoPromptPack completed for project=${projectDir} totalPrompts=${entries.length}`
  )

  return newPack
}
