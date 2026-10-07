import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { logger } from '../logger'
import type {
  HealthSfxType,
  HealthSfxCuePlan,
  HealthMotionPreset,
  HealthVisualCategory,
  AudioSfxAssignment,
  AudioPlan
} from './health-visual-types'
import { SfxCacheManager } from '../sfx/sfx-cache'
import { SfxResolver } from '../sfx/sfx-resolver'
import { RetentionSfxPlanner } from '../sfx/retention-sfx-planner'
import type { RetentionPlan } from '../retention/retention-types'
import type { HealthSfxCacheManifest, ResolvedSfx } from '../sfx/sfx-types'

export interface SfxDirectorSceneInput {
  sceneIndex: number
  startTime: number
  endTime: number
  duration: number
  category: HealthVisualCategory
  narration?: string
  visualIntent?: string
  motionPreset: HealthMotionPreset
}

export type { HealthSfxCacheEntry, HealthSfxCacheManifest } from '../sfx/sfx-types'

// ─── Query Candidates per SFX Type ──────────────────────────────────────────

export const HEALTH_SFX_QUERIES: Record<HealthSfxType, string[]> = {
  none: [],
  'soft-whoosh': ['soft whoosh', 'gentle swoosh', 'air whoosh'],
  'reverse-whoosh': ['reverse whoosh', 'reverse swoosh'],
  'air-swish': ['soft swish', 'air swish'],
  'digital-scan': ['digital scan', 'scanner sweep', 'soft sci fi scan'],
  'soft-pulse': ['soft pulse tone', 'subtle pulse ambient'],
  heartbeat: ['soft heartbeat', 'heart beat'],
  'soft-impact': ['soft impact', 'cinematic soft hit'],
  'clock-tick': ['single clock tick', 'soft clock tick'],
  'subtle-riser': ['soft riser', 'subtle cinematic riser']
}

// ─── Default Sound Parameters ────────────────────────────────────────────────

export const HEALTH_SFX_PARAMS: Record<HealthSfxType, { volumeDb: number; duration: number }> = {
  none: { volumeDb: -99, duration: 0 },
  'soft-whoosh': { volumeDb: -24, duration: 0.75 },
  'reverse-whoosh': { volumeDb: -25, duration: 0.85 },
  'air-swish': { volumeDb: -25, duration: 0.65 },
  'digital-scan': { volumeDb: -26, duration: 1.10 },
  'soft-pulse': { volumeDb: -26, duration: 1.20 },
  heartbeat: { volumeDb: -25, duration: 1.40 },
  'soft-impact': { volumeDb: -22, duration: 0.60 },
  'clock-tick': { volumeDb: -26, duration: 0.50 },
  'subtle-riser': { volumeDb: -25, duration: 1.50 }
}

export class HealthSfxDirector {
  public static getCachePath(projectDir: string): string {
    return SfxCacheManager.getCachePath(projectDir)
  }

  public static getAudioDir(projectDir: string): string {
    return SfxCacheManager.getAudioDir(projectDir)
  }

  public static loadCacheManifest(projectDir: string): HealthSfxCacheManifest {
    return SfxCacheManager.loadCacheManifest(projectDir)
  }

  public static saveCacheManifest(projectDir: string, manifest: HealthSfxCacheManifest): void {
    SfxCacheManager.saveCacheManifest(projectDir, manifest)
  }

  /**
   * Plans subtle, context-matched SFX cues for Health AI scenes,
   * enforcing density targets (25-35%), cooldowns (5-7s), and variety.
   */
  public static planSfxCues(scenes: SfxDirectorSceneInput[]): Map<number, HealthSfxCuePlan> {
    const cueMap = new Map<number, HealthSfxCuePlan>()
    if (scenes.length === 0) return cueMap

    let lastSfxTime = -999
    let lastStrongSfxTime = -999
    const recentTypes: HealthSfxType[] = []

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      const text = `${scene.narration || ''} ${scene.visualIntent || ''}`.toLowerCase()

      // Skip very short scenes (< 2s)
      if (scene.duration < 2.0) continue

      // Skip serious medical warning context
      if (/\b(warning|danger|fatal|emergency|poison|severe|lethal|overdose)\b/i.test(text)) {
        continue
      }

      // Check minimum cooldown (5.0s between any noticeable SFX)
      const timeSinceLast = scene.startTime - lastSfxTime
      if (timeSinceLast < 5.0) {
        continue
      }

      // Determine candidate SFX type based on motion and narrative semantics
      let candidateType: HealthSfxType = 'none'
      let reason = ''
      let strength: 'subtle' | 'accent' = 'subtle'

      // 1. Hook / Opener scene
      if (i === 0 && /\b(discover|secret|truth|journey|revealed|hidden)\b/i.test(text)) {
        candidateType = 'subtle-riser'
        reason = 'Cinematic opener hook'
        strength = 'accent'
      }
      // 2. Heart / pulse / rhythm
      else if (/\b(heart|cardiac|pulse|beat|blood\s*pressure)\b/i.test(text)) {
        candidateType = 'heartbeat'
        reason = 'Biological pulse matching cardiac visual'
      }
      // 3. Clock / circadian / timing
      else if (/\b(clock|circadian|hour|morning|night|rhythm|wake|time)\b/i.test(text)) {
        candidateType = 'clock-tick'
        reason = 'Subtle clock cue for circadian timing'
      }
      // 4. Evidence reveal / crucial discovery
      else if (scene.category === 'evidence' && /\b(found|discovered|showed|proved|evidence|breakthrough)\b/i.test(text)) {
        candidateType = 'soft-impact'
        reason = 'Understated impact for clinical evidence reveal'
        strength = 'accent'
      }
      // 5. Molecular / biological mechanism / cellular pathway
      else if (scene.category === 'mechanism' && /\b(receptor|glucose|insulin|enzyme|pathway|synthesis|scan|signal)\b/i.test(text)) {
        candidateType = 'digital-scan'
        reason = 'Subtle scanner sweep for biological mechanism'
      }
      // 6. Motion-matched whoosh / swish
      else if (scene.motionPreset.startsWith('pan-')) {
        candidateType = 'air-swish'
        reason = 'Gentle air swish matching camera pan'
      } else if (scene.motionPreset.startsWith('push-out')) {
        candidateType = 'reverse-whoosh'
        reason = 'Reverse whoosh matching camera push-out'
      } else if (scene.motionPreset.startsWith('push-in') || scene.motionPreset.startsWith('focus-')) {
        candidateType = 'soft-whoosh'
        reason = 'Soft whoosh accentuating focus push-in'
      }

      if (candidateType === 'none') continue

      // Enforce strong SFX spacing (at least 12s apart)
      if (strength === 'accent') {
        if (scene.startTime - lastStrongSfxTime < 12.0) {
          continue
        }
      }

      // Check consecutive same type spam (strictly max 2 identical types consecutively)
      const last1 = recentTypes[recentTypes.length - 1]
      const last2 = recentTypes[recentTypes.length - 2]
      if (candidateType === last1 && candidateType === last2) {
        // Attempt fallback to alternative motion-compatible sound or subtle pulse
        if (scene.motionPreset.startsWith('pan-') && last1 !== 'air-swish') {
          candidateType = 'air-swish'
          reason = 'Air swish variation for camera pan'
        } else if ((scene.motionPreset.startsWith('push-in') || scene.motionPreset.startsWith('focus-')) && last1 !== 'soft-whoosh') {
          candidateType = 'soft-whoosh'
          reason = 'Soft whoosh variation for camera push-in'
        } else if (scene.motionPreset.startsWith('push-out') && last1 !== 'reverse-whoosh') {
          candidateType = 'reverse-whoosh'
          reason = 'Reverse whoosh variation for camera push-out'
        } else if (candidateType === 'digital-scan' && last1 !== 'soft-pulse') {
          candidateType = 'soft-pulse'
          reason = 'Soft pulse variation for biological mechanism'
        } else {
          continue
        }
      }

      const params = HEALTH_SFX_PARAMS[candidateType]
      const cue: HealthSfxCuePlan = {
        sceneIndex: scene.sceneIndex,
        type: candidateType,
        queryCandidates: HEALTH_SFX_QUERIES[candidateType],
        relativeStart: 0.15,
        duration: Math.min(params.duration, scene.duration - 0.3),
        volumeDb: params.volumeDb,
        reason,
        strength
      }

      cueMap.set(scene.sceneIndex, cue)
      lastSfxTime = scene.startTime + cue.relativeStart
      if (strength === 'accent') {
        lastStrongSfxTime = lastSfxTime
      }
      recentTypes.push(candidateType)

      logger.info(
        `[HealthSFX] Scene ${scene.sceneIndex} -> ${candidateType} @ +${cue.relativeStart}s (${cue.volumeDb}dB)`
      )
    }

    logger.info(`[HealthSFX] ${cueMap.size} cues planned for ${scenes.length} scenes`)
    return cueMap
  }

  /**
   * Resolves and caches audio files for each unique SFX type.
   * Leverages the prioritized SfxResolver:
   * 1. Project cache
   * 2. HyperFrames bundled / library resolver
   * 3. Deterministic local FFmpeg synthesis
   * 4. Openverse audio fallback
   * Returns a Map of HealthSfxType to local file path.
   */
  public static async resolveAndDownloadSfxTypes(
    projectDir: string,
    types: HealthSfxType[],
    openverseToken?: string
  ): Promise<Map<HealthSfxType, string>> {
    const resolvedResult = await SfxResolver.resolveUniqueTypes(projectDir, types, { openverseToken })
    const pathMap = new Map<HealthSfxType, string>()

    for (const [type, resolved] of resolvedResult.entries()) {
      if (resolved.localPath && fs.existsSync(resolved.localPath)) {
        pathMap.set(type, resolved.localPath)
      }
    }

    return pathMap
  }

  /**
   * Applies planned Health SFX cues to the project's audio plan,
   * augmenting with RetentionPlan if available,
   * setting approved: true and approvedLocalPath for Auto Production.
   */
  public static async applyHealthSfxToAudioPlan(
    projectDir: string,
    cues: Map<number, HealthSfxCuePlan>,
    scenes: SfxDirectorSceneInput[],
    openverseToken?: string,
    retentionPlan?: RetentionPlan | null
  ): Promise<AudioPlan> {
    const audioPlanPath = path.join(projectDir, 'analysis', 'audio-plan.json')
    let plan: AudioPlan = {
      generatedAt: new Date().toISOString(),
      sections: [],
      sfxAssignments: []
    }

    if (fs.existsSync(audioPlanPath)) {
      try {
        plan = JSON.parse(fs.readFileSync(audioPlanPath, 'utf-8'))
      } catch {
        // use default
      }
    }

    // Augment cues with retention intelligence if available
    const activeCues = retentionPlan
      ? RetentionSfxPlanner.augmentCuesWithRetention(cues, scenes, retentionPlan)
      : cues

    // Resolve unique SFX types
    const uniqueTypes = Array.from(new Set(Array.from(activeCues.values()).map((c) => c.type)))
    const resolvedDetailMap = await SfxResolver.resolveUniqueTypes(projectDir, uniqueTypes, { openverseToken })

    // Build Health SFX assignments
    const healthSfxAssignments: AudioSfxAssignment[] = []
    const sceneMap = new Map(scenes.map((s) => [s.sceneIndex, s]))

    for (const [sceneIndex, cue] of activeCues.entries()) {
      const scene = sceneMap.get(sceneIndex)
      if (!scene) continue

      const resolved = resolvedDetailMap.get(cue.type)
      const localPath = resolved?.localPath
      const sfxStart = scene.startTime + cue.relativeStart
      const sfxEnd = Math.min(scene.endTime, sfxStart + cue.duration)

      // Set accurate provider creator metadata
      const creator = resolved?.creator || (resolved?.provider === 'procedural' ? 'Local Procedural SFX' : resolved?.provider === 'hyperframes' ? 'HyperFrames SFX Library' : 'Openverse Audio')

      const assignment: AudioSfxAssignment = {
        sceneIndex,
        startTime: sfxStart,
        endTime: sfxEnd,
        sfxQuery: cue.type,
        sfxCandidate: localPath
          ? {
              id: resolved?.sourceId || `health-sfx-${cue.type}`,
              title: `Health SFX (${cue.type})`,
              creator,
              foreignLandingUrl: resolved?.sourceUrl || '',
              downloadUrl: '',
              durationSecs: resolved?.durationSecs || cue.duration,
              license: resolved?.license || 'Project Cache'
            }
          : undefined,
        approved: !!localPath,
        approvedLocalPath: localPath,
        volumeDb: cue.volumeDb,
        fadeInSecs: 0.05,
        fadeOutSecs: 0.15
      }

      healthSfxAssignments.push(assignment)
    }

    // Retain existing manual non-Health SFX assignments, replace or prepend Health assignments
    const nonHealthSfx = (plan.sfxAssignments || []).filter(
      (a) => !activeCues.has(a.sceneIndex) && !a.sfxQuery.startsWith('soft-') && !a.sfxQuery.startsWith('air-')
    )
    plan.sfxAssignments = [...healthSfxAssignments, ...nonHealthSfx].sort((a, b) => a.startTime - b.startTime)

    // Compute motion/sfx plan hash for cache validation
    const hashPayload = Array.from(activeCues.entries())
      .map(([idx, c]) => `${idx}:${c.type}:${c.relativeStart}:${c.volumeDb}`)
      .join('|')
    const planHash = crypto.createHash('md5').update(hashPayload).digest('hex')

    plan.healthSfx = {
      enabled: true,
      planHash,
      generatedAt: new Date().toISOString(),
      cueCount: healthSfxAssignments.filter((a) => a.approved).length
    }

    const dir = path.dirname(audioPlanPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(audioPlanPath, JSON.stringify(plan, null, 2), 'utf-8')
    logger.info(`[HealthSFX] Successfully integrated ${plan.healthSfx.cueCount} approved SFX into audio-plan.json`)

    return plan
  }

  /**
   * Repairs missing Health SFX in an existing audio plan without modifying valid background music.
   * Used when audio-plan.json already has valid music sections but 0 or incomplete approved SFX.
   */
  public static async repairMissingHealthSfx(
    projectDir: string,
    cues: Map<number, HealthSfxCuePlan>,
    scenes: SfxDirectorSceneInput[],
    openverseToken?: string,
    retentionPlan?: RetentionPlan | null
  ): Promise<AudioPlan> {
    const audioPlanPath = path.join(projectDir, 'analysis', 'audio-plan.json')
    if (!fs.existsSync(audioPlanPath)) {
      return this.applyHealthSfxToAudioPlan(projectDir, cues, scenes, openverseToken, retentionPlan)
    }

    let existingPlan: AudioPlan
    try {
      existingPlan = JSON.parse(fs.readFileSync(audioPlanPath, 'utf-8'))
    } catch {
      return this.applyHealthSfxToAudioPlan(projectDir, cues, scenes, openverseToken, retentionPlan)
    }

    logger.info('[HealthSFX] Repair mode: resolving missing Health SFX while preserving existing music sections')
    return this.applyHealthSfxToAudioPlan(projectDir, cues, scenes, openverseToken, retentionPlan)
  }
}
