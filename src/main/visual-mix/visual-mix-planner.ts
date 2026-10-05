import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { flattenEditPlanScenes } from '../utils/scene-plan'
import type {
  VisualMixPlan,
  VisualMixScenePlan,
  VisualStrategy,
  VisualMixProfile,
  VisualMixConfig,
  GlobalScriptContext,
  HealthMotionSpec,
  HealthMotionPreset
} from '../../../shared/types'
import { VISUAL_MIX_SCHEMA_VERSION } from './visual-mix-types'
import { computeGenerationHash } from './visual-mix-cache'
import { buildGeneralImagePrompt } from './general-image-prompt'
import { HealthVisualPlanner, RawSceneData } from '../health/health-visual-planner'
import { resolvePresetDefaults } from '../health/health-motion'

export interface GeneralSceneClassification {
  category: string
  aiSuitabilityScore: number
  stockSuitabilityScore: number
  reasoning: string
}

// Regex rules for General suitability scoring (Section 14)
const AI_PREFERENCE_REGEX =
  /\b(concept|abstract|theory|metaphor|symbol|symbolic|reconstruction|ancient|rome|egypt|pharaoh|myth|future|futuristic|internal|system|architecture|structure|infographic|diagram|invisible|secret|origin|vision|imagine|thought|mind|idea|revolution|century|galaxy|cosmos|quantum|microscopic|hidden)\b/i

const REAL_FOOTAGE_PREFERENCE_REGEX =
  /\b(people|crowd|walking|walk|running|run|driving|drive|car|traffic|city|street|intersection|shopping|market|store|cooking|cook|eating|eat|gym|exercise|workout|laughing|smiling|talking|conversation|interview|office|working|desk|nature|ocean|waves|beach|park|forest|travel|lifestyle|real-world|documentary\s*footage)\b/i

export function classifyGeneralSceneSuitability(
  sceneOrNarration: RawSceneData | string,
  totalScenesOrIntent?: number | string
): GeneralSceneClassification {
  const narrativeText = typeof sceneOrNarration === 'string' ? sceneOrNarration : sceneOrNarration.narrativeText
  const visualIntent =
    typeof totalScenesOrIntent === 'string'
      ? totalScenesOrIntent
      : typeof sceneOrNarration === 'object'
        ? sceneOrNarration.visualIntent
        : ''
  const sceneIndex = typeof sceneOrNarration === 'object' ? sceneOrNarration.sceneIndex : 1
  const text = `${narrativeText || ''} ${visualIntent || ''}`.toLowerCase()

  const prefersAi = AI_PREFERENCE_REGEX.test(text)
  const prefersReal = REAL_FOOTAGE_PREFERENCE_REGEX.test(text)

  if (prefersAi && !prefersReal) {
    const isHistorical = /\b(ancient|rome|egypt|pharaoh|century|reconstruction|myth)\b/i.test(text)
    return {
      category: isHistorical ? 'historical' : 'conceptual',
      aiSuitabilityScore: 90,
      stockSuitabilityScore: 25,
      reasoning: 'Conceptual, symbolic or hard-to-find visual best suited for AI still'
    }
  }

  if (prefersReal && !prefersAi) {
    const isNature = /\b(nature|ocean|waves|beach|forest|cliff|sky|river)\b/i.test(text)
    return {
      category: isNature ? 'nature' : 'lifestyle',
      aiSuitabilityScore: 25,
      stockSuitabilityScore: 90,
      reasoning: 'Real people, activities, or real-world establishing shot best suited for stock footage'
    }
  }

  if (prefersAi && prefersReal) {
    return {
      category: 'general',
      aiSuitabilityScore: 65,
      stockSuitabilityScore: 60,
      reasoning: 'Mixed conceptual and real elements'
    }
  }

  // Hook scene (scene 1)
  const isHook = sceneIndex === 1
  return {
    category: isHook ? 'hook' : 'general',
    aiSuitabilityScore: isHook ? 75 : 55,
    stockSuitabilityScore: isHook ? 50 : 50,
    reasoning: 'Standard documentary scene'
  }
}

const GENERIC_MOTION_PRESETS: HealthMotionPreset[] = [
  'push-in-center',
  'push-in-left',
  'push-in-right',
  'push-out-center',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down',
  'drift-up-left',
  'drift-up-right',
  'drift-down-left',
  'drift-down-right',
  'still-hold'
]

/**
 * Plans camera motion for general custom mix scenes (Section 39).
 * Avoids medical pulse / mechanism assumptions.
 */
export function planGeneralSceneMotion(params: {
  sceneIndex: number
  visualIntent: string
  duration: number
  recentPresets: HealthMotionPreset[]
}): { motionSpec: HealthMotionSpec; motionPreset: HealthMotionPreset } {
  const { sceneIndex, visualIntent, duration, recentPresets } = params
  const text = visualIntent.toLowerCase()

  let preset: HealthMotionPreset

  if (text.includes('landscape') || text.includes('sweeping') || text.includes('horizon')) {
    preset = sceneIndex % 2 === 0 ? 'pan-right' : 'pan-left'
  } else if (text.includes('tower') || text.includes('tall') || text.includes('sky') || text.includes('rising')) {
    preset = 'pan-up'
  } else if (text.includes('ground') || text.includes('detail') || text.includes('deep')) {
    preset = 'push-in-center'
  } else if (text.includes('vast') || text.includes('overview') || text.includes('reveal')) {
    preset = 'push-out-center'
  } else {
    // Rotation across presets based on sceneIndex
    const available = GENERIC_MOTION_PRESETS.filter((p) => p !== 'still-hold')
    preset = available[sceneIndex % available.length]
  }

  // Guard against repetition > 2 consecutive times
  if (recentPresets.length >= 2) {
    const p1 = recentPresets[recentPresets.length - 1]
    const p2 = recentPresets[recentPresets.length - 2]
    if (preset === p1 && preset === p2) {
      preset = preset === 'push-in-center' ? 'pan-right' : 'push-in-center'
    }
  }

  const spec = resolvePresetDefaults(preset, duration)
  return { motionSpec: spec, motionPreset: preset }
}

export class VisualMixPlanner {
  public planVisualMix(params: {
    profile: VisualMixProfile
    config: VisualMixConfig
    projectDir?: string
    rawScenes?: RawSceneData[]
    masterPlan?: any
    globalContext?: GlobalScriptContext
  }): VisualMixPlan {
    const projectDir = params.projectDir ?? process.cwd()
    let rawScenes = params.rawScenes
    if (!rawScenes && params.masterPlan?.scenes) {
      rawScenes = params.masterPlan.scenes.map((s: any, idx: number) => ({
        sceneIndex: idx + 1,
        sceneId: s.sceneId,
        narrativeText: s.narrationText,
        visualIntent: s.visualIntent,
        startTime: s.start,
        endTime: s.end,
        duration: s.duration,
        searchQueries: s.searchQueries
      }))
    }
    return VisualMixPlanner.buildPlan({
      projectDir,
      rawScenes: rawScenes ?? [],
      config: params.config,
      profile: params.profile,
      globalContext: params.globalContext
    })
  }

  public static getPlanPath(projectDir: string): string {
    return path.join(projectDir, 'analysis', 'visual-mix-plan.json')
  }

  public static loadPlan(projectDir: string): VisualMixPlan | null {
    const p = this.getPlanPath(projectDir)
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as VisualMixPlan
      } catch {
        return null
      }
    }
    return null
  }

  public static loadScenesFromEditPlan(projectDir: string): RawSceneData[] {
    return HealthVisualPlanner.loadScenesFromEditPlan(projectDir)
  }

  public static buildPlan(params: {
    projectDir: string
    rawScenes: RawSceneData[]
    config: VisualMixConfig
    profile: VisualMixProfile
    globalContext?: GlobalScriptContext
  }): VisualMixPlan {
    const { projectDir, rawScenes, config, profile, globalContext } = params
    const totalScenes = rawScenes.length
    const aiRatio = config.aiImageRatio
    const stockRatio = config.stockFootageRatio

    logger.info(
      `[VisualMixPlanner] Planning visuals for profile=${profile}, mode=${config.mode}, AI=${aiRatio}, Stock=${stockRatio} (${totalScenes} scenes)`
    )

    // 1. Health profile delegates to HealthVisualPlanner to preserve medical logic & SFX
    if (profile === 'health') {
      const healthPlan = HealthVisualPlanner.buildPlan(projectDir, rawScenes, {
        aiRatio,
        stockRatio,
        width: config.width,
        height: config.height,
        motionEnabled: config.motionEnabled
      })

      const convertedScenes: VisualMixScenePlan[] = healthPlan.scenes.map((s) => ({
        sceneIndex: s.sceneIndex,
        narration: s.narration,
        visualIntent: s.visualIntent,
        strategy: s.strategy,
        category: s.category,
        reasoning: s.reasoning,
        imagePrompt: s.imagePrompt,
        stockQueries: s.stockQueries,
        motionPreset: s.motionPreset,
        motion: s.motion,
        sfxCue: s.sfxCue,
        generationHash: s.generationHash,
        startTime: s.startTime,
        endTime: s.endTime,
        duration: s.duration
      }))

      const visualMixPlan: VisualMixPlan = {
        schemaVersion: VISUAL_MIX_SCHEMA_VERSION,
        generatedAt: healthPlan.generatedAt,
        profile: 'health',
        sourceMode: config.mode,
        requestedAiRatio: aiRatio,
        requestedStockRatio: stockRatio,
        totalScenes: healthPlan.totalScenes,
        targetAiScenes: healthPlan.targetAiScenes,
        targetStockScenes: healthPlan.targetStockScenes,
        scenes: convertedScenes
      }

      // Save both visual-mix-plan.json and health-visual-plan.json
      if (projectDir) {
        const analysisDir = path.join(projectDir, 'analysis')
        if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true })
        fs.writeFileSync(this.getPlanPath(projectDir), JSON.stringify(visualMixPlan, null, 2), 'utf-8')
      }

      return visualMixPlan
    }

    // 2. General Profile visual planning
    if (totalScenes === 0) {
      return {
        schemaVersion: VISUAL_MIX_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        profile: 'general',
        sourceMode: config.mode,
        requestedAiRatio: aiRatio,
        requestedStockRatio: stockRatio,
        totalScenes: 0,
        targetAiScenes: 0,
        targetStockScenes: 0,
        scenes: []
      }
    }

    const targetAiScenes = Math.max(0, Math.min(totalScenes, Math.round(totalScenes * aiRatio)))
    const targetStockScenes = totalScenes - targetAiScenes

    // Score and rank general scenes
    const classified = rawScenes.map((scene) => {
      const cls = classifyGeneralSceneSuitability(scene, totalScenes)
      return {
        scene,
        cls,
        diff: cls.aiSuitabilityScore - cls.stockSuitabilityScore
      }
    })

    // Deterministic ranking: sort by diff descending, tie break by sceneIndex ascending
    const ranked = [...classified].sort((a, b) => {
      if (b.diff !== a.diff) return b.diff - a.diff
      return a.scene.sceneIndex - b.scene.sceneIndex
    })

    const selectedAiIndices = new Set<number>(
      ranked.slice(0, targetAiScenes).map((item) => item.scene.sceneIndex)
    )

    const strategyMap = new Map<number, VisualStrategy>()
    for (const item of classified) {
      strategyMap.set(
        item.scene.sceneIndex,
        selectedAiIndices.has(item.scene.sceneIndex) ? 'ai-still' : 'stock'
      )
    }

    // Pacing smoothing (Section 15):
    // Avoid > 5 consecutive AI stills or > 3 consecutive stock scenes when AI ratio is high
    for (let i = 0; i < rawScenes.length; i++) {
      const idx = rawScenes[i].sceneIndex
      const currentStrategy = strategyMap.get(idx)

      // Consecutive stock smoothing
      if (currentStrategy === 'stock' && i >= 3 && targetAiScenes > targetStockScenes) {
        const p1 = strategyMap.get(rawScenes[i - 1].sceneIndex)
        const p2 = strategyMap.get(rawScenes[i - 2].sceneIndex)
        const p3 = strategyMap.get(rawScenes[i - 3].sceneIndex)
        if (p1 === 'stock' && p2 === 'stock' && p3 === 'stock') {
          const swapCandidate = classified.find(
            (c) =>
              strategyMap.get(c.scene.sceneIndex) === 'ai-still' &&
              c.scene.sceneIndex > idx
          )
          if (swapCandidate) {
            strategyMap.set(idx, 'ai-still')
            strategyMap.set(swapCandidate.scene.sceneIndex, 'stock')
          }
        }
      }

      // Consecutive AI smoothing (cap at 5)
      if (currentStrategy === 'ai-still' && i >= 5 && targetStockScenes > 0) {
        let allPrevAi = true
        for (let k = 1; k <= 5; k++) {
          if (strategyMap.get(rawScenes[i - k].sceneIndex) !== 'ai-still') {
            allPrevAi = false
            break
          }
        }
        if (allPrevAi) {
          const swapStock = classified.find(
            (c) =>
              strategyMap.get(c.scene.sceneIndex) === 'stock' &&
              c.scene.sceneIndex > idx
          )
          if (swapStock) {
            strategyMap.set(idx, 'stock')
            strategyMap.set(swapStock.scene.sceneIndex, 'ai-still')
          }
        }
      }
    }

    const recentPresets: HealthMotionPreset[] = []
    const scenePlans: VisualMixScenePlan[] = classified.map(({ scene, cls }) => {
      const strategy = strategyMap.get(scene.sceneIndex) || 'stock'
      const narration = scene.narrativeText || ''
      const visualIntent = scene.visualIntent || narration

      let motionSpec: HealthMotionSpec | undefined
      let motionPreset: string | undefined
      let imagePrompt: string | undefined
      let stockQueries: string[] | undefined
      let generationHash: string | undefined

      if (strategy === 'ai-still') {
        const motionPlan = planGeneralSceneMotion({
          sceneIndex: scene.sceneIndex,
          visualIntent,
          duration: scene.duration,
          recentPresets
        })
        motionSpec = motionPlan.motionSpec
        motionPreset = motionPlan.motionPreset
        recentPresets.push(motionPlan.motionPreset)

        imagePrompt = buildGeneralImagePrompt({
          narration,
          visualIntent,
          globalContext,
          sceneIndex: scene.sceneIndex
        })

        generationHash = computeGenerationHash({
          sceneIndex: scene.sceneIndex,
          narration,
          visualIntent,
          imagePrompt,
          profile: 'general',
          width: config.width,
          height: config.height
        })
      } else {
        stockQueries =
          scene.searchQueries && scene.searchQueries.length > 0
            ? scene.searchQueries
            : [visualIntent.slice(0, 60), 'documentary footage']
      }

      return {
        sceneIndex: scene.sceneIndex,
        narration,
        visualIntent,
        strategy,
        reasoning: cls.reasoning,
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

    const finalPlan: VisualMixPlan = {
      schemaVersion: VISUAL_MIX_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      profile: 'general',
      sourceMode: config.mode,
      requestedAiRatio: aiRatio,
      requestedStockRatio: stockRatio,
      totalScenes,
      targetAiScenes,
      targetStockScenes,
      scenes: scenePlans
    }

    if (projectDir) {
      const analysisDir = path.join(projectDir, 'analysis')
      if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true })
      fs.writeFileSync(this.getPlanPath(projectDir), JSON.stringify(finalPlan, null, 2), 'utf-8')
    }

    return finalPlan
  }
}
