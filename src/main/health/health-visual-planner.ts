import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { flattenEditPlanScenes } from '../utils/scene-plan'
import type {
  HealthVisualPlan,
  HealthVisualScenePlan,
  HealthVisualStrategy,
  HealthVisualCategory,
  HealthScientificAccuracy,
  HealthMotionPreset,
  HealthMotionSpec,
  HealthMotionReport,
  HealthVisualConfig
} from './health-visual-types'
import { HEALTH_SCHEMA_VERSION, DEFAULT_HEALTH_CONFIG } from './health-visual-types'
import { computeHealthGenerationHash } from './health-visual-cache'
import { HealthMotionDirector } from './health-motion-director'
import { HealthSfxDirector, SfxDirectorSceneInput } from './health-sfx-director'

// ─── Semantic Matching Keywords ──────────────────────────────────────────────

const ANATOMY_REGEX =
  /\b(liver|stomach|gut|intestine|colon|kidney|heart|brain|lung|pancreas|organ|cell|cellular|tissue|blood\s*flow|bloodstream|vessel|artery|vein|neuron|synapse|digestive|immune|microbiome|bacteria|pathogen|antibody|hormone|enzyme|receptor|insulin|glucose|mitochondria|dna|gene|biology|anatomical|anatomy|arteries|veins|synapses|neurons)\b/i

const MECHANISM_REGEX =
  /\b(mechanism|physiology|biological|pathway|absorption|metabolism|circadian|clock|inflammation|oxidation|synthesis|breakdown|secretion|cascade|reaction|osmosis|filtering|barrier|toxic|detox|function|physiological|biochemical|molecule|cellular\s*level|molecular)\b/i

const LIFESTYLE_REGEX =
  /\b(walk|walking|sleep|sleeping|bed|wake|waking|run|running|jog|jogging|exercise|exercising|gym|workout|lift|lifting|stretch|stretching|cook|cooking|eat|eating|drink|drinking|kitchen|meal|plate|table|grocery|store|supermarket|person|people|man|woman|human|face|smile|smiling|laugh|laughing|stress|stressed|work|working|desk|office|morning|evening|routine|lifestyle|park|nature|sunlight|fresh\s*air)\b/i

const FOOD_REGEX =
  /\b(salad|vegetable|fruit|apple|berry|berries|snack|sugar|fat|oil|meat|fish|water|tea|coffee|recipe|diet|nutrition|breakfast|lunch|dinner)\b/i

const EXERCISE_REGEX =
  /\b(exercise|gym|workout|running|jogging|walking|stretching|training|fitness|cardio|weights)\b/i

const EVIDENCE_REGEX =
  /\b(study|studies|research|scientist|scientists|researcher|researchers|university|clinical|trial|trials|evidence|paper|journal|published|findings|data|statistics|laboratory)\b/i

export interface RawSceneData {
  sceneIndex: number
  sceneId?: string
  narrativeText?: string
  visualIntent?: string
  startTime: number
  endTime: number
  duration: number
  searchQueries?: string[]
}

export interface SceneClassification {
  category: HealthVisualCategory
  scientificAccuracy: HealthScientificAccuracy
  aiSuitabilityScore: number
  stockSuitabilityScore: number
  reasoning: string
}

export function classifySceneSemantics(
  scene: RawSceneData,
  totalScenes: number
): SceneClassification {
  const text = `${scene.narrativeText || ''} ${scene.visualIntent || ''}`.toLowerCase()

  const isAnatomy = ANATOMY_REGEX.test(text)
  const isMechanism = MECHANISM_REGEX.test(text)
  const isLifestyle = LIFESTYLE_REGEX.test(text)
  const isFood = FOOD_REGEX.test(text)
  const isExercise = EXERCISE_REGEX.test(text)
  const isEvidence = EVIDENCE_REGEX.test(text)

  // 1. Anatomy: internal organs, cellular systems, biology
  if (isAnatomy) {
    return {
      category: 'anatomy',
      scientificAccuracy: 'anatomical',
      aiSuitabilityScore: 95,
      stockSuitabilityScore: 15,
      reasoning: 'Detailed anatomical/organ subject best communicated via 3D medical visual'
    }
  }

  // 2. Mechanism: internal biological/physiological processes
  if (isMechanism && !isLifestyle) {
    return {
      category: 'mechanism',
      scientificAccuracy: 'mechanistic',
      aiSuitabilityScore: 90,
      stockSuitabilityScore: 20,
      reasoning: 'Microscopic or biological mechanism requires conceptual explanatory visual'
    }
  }

  // 3. Real human actions / lifestyle / workout / food
  if (isLifestyle || isExercise || (isFood && !isMechanism)) {
    const category: HealthVisualCategory = isExercise
      ? 'exercise'
      : isFood
        ? 'food'
        : 'lifestyle'
    return {
      category,
      scientificAccuracy: 'conceptual',
      aiSuitabilityScore: 25,
      stockSuitabilityScore: 90,
      reasoning: 'Real person, exercise, food or lifestyle footage is best portrayed with real stock footage'
    }
  }

  // 4. Evidence / study / clinical
  if (isEvidence) {
    return {
      category: 'evidence',
      scientificAccuracy: 'conceptual',
      aiSuitabilityScore: 70,
      stockSuitabilityScore: 50,
      reasoning: 'Scientific study reference; visual conceptual background'
    }
  }

  // 5. Default conceptual
  // Hook scene (scene 1) often works well as high-impact AI visualization or establishing shot
  const isHook = scene.sceneIndex === 1
  return {
    category: 'conceptual',
    scientificAccuracy: 'conceptual',
    aiSuitabilityScore: isHook ? 85 : 75,
    stockSuitabilityScore: isHook ? 40 : 45,
    reasoning: 'Health concept visual explanation'
  }
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

const BASE_MEDICAL_STYLE =
  'Premium cinematic medical documentary visualization, clean professional educational composition, scientifically plausible human anatomy, clear focal subject, high visual clarity, controlled dark navy / neutral background, realistic dimensional lighting, high detail, 16:9 horizontal composition, no text, no labels, no watermark, no logo.'

export function buildHealthImagePrompt(
  narration: string,
  visualIntent: string,
  category: HealthVisualCategory
): string {
  // Strip any accidental text instructions
  let cleanedSubject = (visualIntent || narration || '')
    .replace(/[^\w\s,.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleanedSubject.length > 200) {
    cleanedSubject = cleanedSubject.slice(0, 200).trim()
  }

  let specificDetails = ''
  switch (category) {
    case 'anatomy':
      specificDetails =
        'detailed anatomical focus showing clean realistic organ structures and biological tissues'
      break
    case 'mechanism':
      specificDetails =
        'conceptual visualization of physiological processes, microscopic biological depth, dynamic bio-lighting'
      break
    case 'evidence':
      specificDetails =
        'cinematic laboratory science aesthetic, clean clinical glassware, conceptual scientific discovery, dark elegant mood'
      break
    default:
      specificDetails =
        'cinematic medical education perspective, clean visual focus on health and wellness science'
      break
  }

  return `${cleanedSubject}, ${specificDetails}, ${BASE_MEDICAL_STYLE}`
}

export function pickMotionPreset(
  category: HealthVisualCategory,
  sceneIndex: number
): HealthMotionPreset {
  switch (category) {
    case 'anatomy':
      return 'slow-push-in'
    case 'mechanism':
      return sceneIndex % 2 === 0 ? 'slow-push-in' : 'micro-drift'
    case 'conceptual':
      return sceneIndex % 2 === 0 ? 'pan-left' : 'pan-right'
    case 'food':
      return 'slow-push-in'
    case 'exercise':
    case 'lifestyle':
      return 'micro-drift'
    case 'evidence':
      return sceneIndex % 2 === 0 ? 'slow-push-in' : 'slow-push-out'
    default:
      return 'slow-push-in'
  }
}

export const generateHealthImagePrompt = buildHealthImagePrompt
export const assignMotionPreset = pickMotionPreset

export function classifyNarrationSemantics(text: string): SceneClassification {
  return classifySceneSemantics(
    {
      sceneIndex: 1,
      narrativeText: text,
      visualIntent: text,
      startTime: 0,
      endTime: 5,
      duration: 5
    },
    10
  )
}

// ─── Planner ─────────────────────────────────────────────────────────────────

export class HealthVisualPlanner {
  private config?: HealthVisualConfig

  constructor(config?: HealthVisualConfig) {
    this.config = config
  }

  public createPlan(
    editPlan: {
      scenes: Array<{
        sceneIndex?: number
        narrativeText?: string
        narration?: string
        visualIntent?: string
        visualDescription?: string
        startTime?: number
        endTime?: number
        duration?: number
        searchQueries?: string[]
      }>
    },
    projectDir?: string
  ): HealthVisualPlan {
    const rawScenes: RawSceneData[] = (editPlan.scenes || []).map((s, idx) => ({
      sceneIndex: s.sceneIndex ?? idx + 1,
      narrativeText: s.narrativeText ?? s.narration ?? '',
      visualIntent: s.visualIntent ?? s.visualDescription ?? '',
      startTime: s.startTime ?? 0,
      endTime: s.endTime ?? 5,
      duration: s.duration ?? (s.endTime ?? 5) - (s.startTime ?? 0),
      searchQueries: s.searchQueries
    }))
    return HealthVisualPlanner.buildPlan(projectDir || '', rawScenes, this.config)
  }

  public static getPlanPath(projectDir: string): string {
    return path.join(projectDir, 'analysis', 'health-visual-plan.json')
  }

  public static loadPlan(projectDir: string): HealthVisualPlan | null {
    const p = this.getPlanPath(projectDir)
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as HealthVisualPlan
      } catch {
        return null
      }
    }
    return null
  }

  public static buildPlan(
    projectDir: string,
    rawScenes: RawSceneData[],
    config?: HealthVisualConfig
  ): HealthVisualPlan {
    const aiRatio = config?.aiRatio ?? DEFAULT_HEALTH_CONFIG.aiRatio
    const stockRatio = config?.stockRatio ?? DEFAULT_HEALTH_CONFIG.stockRatio
    const totalScenes = rawScenes.length

    logger.info(`[HealthVisual] Building plan for ${totalScenes} scenes`)

    if (totalScenes === 0) {
      return {
        schemaVersion: HEALTH_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        targetAiRatio: aiRatio,
        targetStockRatio: stockRatio,
        totalScenes: 0,
        targetAiScenes: 0,
        targetStockScenes: 0,
        scenes: []
      }
    }

    const targetAiScenes = Math.max(0, Math.min(totalScenes, Math.round(totalScenes * aiRatio)))
    const targetStockScenes = totalScenes - targetAiScenes

    logger.info(`[HealthVisual] Target ratio: AI=${targetAiScenes}, Stock=${targetStockScenes}`)

    // 1. Semantic classification & scoring for each scene
    const classified = rawScenes.map((scene) => {
      const cls = classifySceneSemantics(scene, totalScenes)
      return {
        scene,
        cls,
        diff: cls.aiSuitabilityScore - cls.stockSuitabilityScore
      }
    })

    // 2. Deterministic ranking: highest AI suitability relative to stock
    // Stable tie-break by sceneIndex ascending
    const rankedIndices = [...classified]
      .sort((a, b) => {
        if (b.diff !== a.diff) {
          return b.diff - a.diff
        }
        return a.scene.sceneIndex - b.scene.sceneIndex
      })
      .map((item) => item.scene.sceneIndex)

    const selectedAiIndices = new Set<number>(rankedIndices.slice(0, targetAiScenes))

    // 3. Visual Pacing pass: avoid > 5 consecutive AI stills or > 2 consecutive stock scenes
    // (Only swaps scenes where semantic gap is modest)
    const strategyMap = new Map<number, HealthVisualStrategy>()
    for (const item of classified) {
      strategyMap.set(
        item.scene.sceneIndex,
        selectedAiIndices.has(item.scene.sceneIndex) ? 'ai-still' : 'stock'
      )
    }

    // Pacing smoothing:
    for (let i = 0; i < rawScenes.length; i++) {
      const idx = rawScenes[i].sceneIndex
      const currentStrategy = strategyMap.get(idx)

      // Check consecutive stock (allow max 2)
      if (currentStrategy === 'stock' && i >= 2) {
        const prev1 = strategyMap.get(rawScenes[i - 1].sceneIndex)
        const prev2 = strategyMap.get(rawScenes[i - 2].sceneIndex)
        if (prev1 === 'stock' && prev2 === 'stock') {
          // Find a subsequent or prior scene that is AI with low AI diff to swap
          const swapCandidate = classified.find(
            (c) =>
              strategyMap.get(c.scene.sceneIndex) === 'ai-still' &&
              c.cls.category !== 'anatomy' &&
              c.scene.sceneIndex > idx
          )
          if (swapCandidate && classified[i].cls.category !== 'lifestyle') {
            strategyMap.set(idx, 'ai-still')
            strategyMap.set(swapCandidate.scene.sceneIndex, 'stock')
          }
        }
      }
    }

    // 4. Build final scene plans with Motion Director and SFX Director
    const recentPresets: HealthMotionPreset[] = []
    const aiScenesForSfx: SfxDirectorSceneInput[] = []

    const scenePlans: HealthVisualScenePlan[] = classified.map(({ scene, cls }) => {
      const strategy = strategyMap.get(scene.sceneIndex) || 'stock'
      const narration = scene.narrativeText || ''
      const visualIntent = scene.visualIntent || narration

      let motionSpec: HealthMotionSpec | undefined
      let motionPreset: HealthMotionPreset = 'push-in-center'
      let imagePrompt: string | undefined
      let stockQueries: string[] | undefined
      let generationHash: string | undefined

      if (strategy === 'ai-still') {
        motionSpec = HealthMotionDirector.planSceneMotion({
          sceneIndex: scene.sceneIndex,
          category: cls.category,
          narration,
          visualIntent,
          duration: scene.duration,
          scientificAccuracy: cls.scientificAccuracy,
          recentPresets
        })
        motionPreset = motionSpec.preset
        recentPresets.push(motionPreset)

        aiScenesForSfx.push({
          sceneIndex: scene.sceneIndex,
          startTime: scene.startTime,
          endTime: scene.endTime,
          duration: scene.duration,
          category: cls.category,
          narration,
          visualIntent,
          motionPreset
        })

        imagePrompt = buildHealthImagePrompt(narration, visualIntent, cls.category)
        generationHash = computeHealthGenerationHash(
          scene.sceneIndex,
          narration,
          visualIntent,
          imagePrompt,
          config
        )
      } else {
        // Stock queries
        stockQueries = scene.searchQueries && scene.searchQueries.length > 0
          ? scene.searchQueries
          : [visualIntent.slice(0, 60), cls.category, 'medical health']
      }

      logger.info(
        `[HealthVisual] Scene ${scene.sceneIndex} classified ${cls.category} -> ${strategy} (${cls.reasoning})`
      )

      return {
        sceneIndex: scene.sceneIndex,
        narration,
        visualIntent,
        strategy,
        category: cls.category,
        reasoning: cls.reasoning,
        scientificAccuracy: cls.scientificAccuracy,
        imagePrompt,
        stockQueries,
        motionPreset,
        motion: motionSpec,
        generationHash,
        startTime: scene.startTime,
        endTime: scene.endTime,
        duration: scene.duration
      }
    })

    // Plan subtle SFX cues for AI scenes
    const sfxCues = HealthSfxDirector.planSfxCues(aiScenesForSfx)
    for (const sp of scenePlans) {
      if (sfxCues.has(sp.sceneIndex)) {
        sp.sfxCue = sfxCues.get(sp.sceneIndex)
      }
    }

    const finalPlan: HealthVisualPlan = {
      schemaVersion: HEALTH_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      targetAiRatio: aiRatio,
      targetStockRatio: stockRatio,
      totalScenes,
      targetAiScenes,
      targetStockScenes,
      scenes: scenePlans
    }

    // 5. Generate and save motion/SFX report & plan atomically if projectDir is provided
    if (projectDir && projectDir.trim().length > 0) {
      const motionDistribution: Record<string, number> = {}
      let maxConsecutive = 0
      let currConsecutive = 0
      let lastPreset = ''

      for (const p of recentPresets) {
        motionDistribution[p] = (motionDistribution[p] || 0) + 1
        if (p === lastPreset) {
          currConsecutive++
        } else {
          lastPreset = p
          currConsecutive = 1
        }
        if (currConsecutive > maxConsecutive) {
          maxConsecutive = currConsecutive
        }
      }

      const sfxDistribution: Record<string, number> = {}
      for (const cue of sfxCues.values()) {
        sfxDistribution[cue.type] = (sfxDistribution[cue.type] || 0) + 1
      }

      const report: HealthMotionReport = {
        totalAiScenes: recentPresets.length,
        motionDistribution,
        sfxCueCount: sfxCues.size,
        sfxDistribution,
        maxConsecutiveSameMotion: maxConsecutive,
        generatedAt: new Date().toISOString()
      }

      const reportPath = path.join(projectDir, 'analysis', 'health-motion-report.json')
      try {
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8')
      } catch (err) {
        logger.warn(`[HealthVisual] Failed to write motion report: ${err}`)
      }

      const planPath = this.getPlanPath(projectDir)
      const dir = path.dirname(planPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const tmpPath = `${planPath}.tmp.${Date.now()}`
      fs.writeFileSync(tmpPath, JSON.stringify(finalPlan, null, 2), 'utf-8')
      fs.renameSync(tmpPath, planPath)
    }

    return finalPlan
  }

  public static loadScenesFromEditPlan(projectDir: string): RawSceneData[] {
    const planPath = path.join(projectDir, 'analysis', 'master-edit-plan.json')
    if (!fs.existsSync(planPath)) {
      return []
    }

    try {
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
      const entries = flattenEditPlanScenes<{
        sceneIndex: number
        sceneId?: string
        narrativeText?: string
        visualIntent?: string
        startTime: number
        endTime: number
        duration: number
        searchQueries?: string[]
      }>(plan)

      return entries.map((e) => ({
        sceneIndex: e.scene.sceneIndex,
        sceneId: e.sceneId,
        narrativeText: e.scene.narrativeText,
        visualIntent: e.scene.visualIntent,
        startTime: e.scene.startTime,
        endTime: e.scene.endTime,
        duration: e.scene.duration,
        searchQueries: e.scene.searchQueries
      }))
    } catch (err) {
      logger.error(`[HealthVisualPlanner] Failed to load edit plan: ${err}`)
      return []
    }
  }
}
