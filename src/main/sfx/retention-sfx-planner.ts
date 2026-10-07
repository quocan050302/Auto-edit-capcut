import { logger } from '../logger'
import type { HealthSfxCuePlan, HealthSfxType } from '../health/health-visual-types'
import type { SfxDirectorSceneInput } from '../health/health-sfx-director'
import type { RetentionPlan, RetentionScenePlan } from '../retention/retention-types'

const STRONG_SFX_TYPES = new Set<HealthSfxType>(['soft-impact', 'subtle-riser', 'heartbeat'])

export class RetentionSfxPlanner {
  /**
   * Augments existing semantic Health SFX cues with Retention intelligence.
   *
   * Rules:
   * 1. Selective density target: roughly 15-25% maximum of total scenes.
   * 2. Existing meaningful semantic cues win over generic retention cues (Test 94).
   * 3. Roles mapped to subtle documentary accents:
   *    - hook: subtle-riser or soft-whoosh
   *    - re-hook: soft-whoosh or air-swish
   *    - surprise: soft-impact
   *    - payoff: soft-impact
   *    - proof: soft-impact or digital-scan
   *    - comparison: air-swish
   *    - mechanism: digital-scan / soft-pulse (only when narratively justified)
   *    - bridge, recap, conclusion: NO SFX
   * 4. Density & Cooldown guards:
   *    - Min gap between cues: ~4.5s
   *    - Accent gap: ~10.0s
   *    - Max 1 cue per scene normally
   *    - No > 2 consecutive identical SFX types
   *    - Suppress repetitive camera whooshes
   */
  public static augmentCuesWithRetention(
    existingCues: Map<number, HealthSfxCuePlan>,
    scenes: SfxDirectorSceneInput[],
    retentionPlan: RetentionPlan | null
  ): Map<number, HealthSfxCuePlan> {
    if (scenes.length === 0) {
      return new Map()
    }

    const sceneMap = new Map(scenes.map((s) => [s.sceneIndex, s]))
    const retentionSceneMap = new Map<number, RetentionScenePlan>()
    if (retentionPlan?.scenes) {
      for (const rScene of retentionPlan.scenes) {
        retentionSceneMap.set(rScene.sceneIndex, rScene)
      }
    }

    // Maximum allowed SFX scenes: 25% of total scenes (minimum 1 if scenes exist)
    const maxSfxScenes = Math.max(1, Math.floor(scenes.length * 0.25))

    // Step 1: Initialize merged candidate map with existing cues
    // Track whether a cue was an original semantic cue
    interface CandidateEntry {
      sceneIndex: number
      cue: HealthSfxCuePlan
      isOriginal: boolean
      priority: number // lower number = higher priority
      role?: string
    }

    const candidates = new Map<number, CandidateEntry>()

    for (const [idx, cue] of existingCues.entries()) {
      candidates.set(idx, {
        sceneIndex: idx,
        cue: { ...cue },
        isOriginal: true,
        priority: cue.type === 'clock-tick' || cue.type === 'heartbeat' || cue.type === 'digital-scan' ? 2 : 5
      })
    }

    // Step 2: Consider Retention cues if retention plan is available
    if (retentionPlan && retentionSceneMap.size > 0) {
      for (const scene of scenes) {
        const rPlan = retentionSceneMap.get(scene.sceneIndex)
        if (!rPlan) continue

        const role = rPlan.role
        const text = `${scene.narration || ''} ${scene.visualIntent || ''}`.toLowerCase()

        // Bridges, recaps, and conclusions never get retention SFX
        if (role === 'bridge' || role === 'recap' || role === 'conclusion') {
          continue
        }

        // Serious medical warning suppression
        if (/\b(warning|danger|fatal|emergency|poison|severe|lethal|overdose)\b/i.test(text)) {
          continue
        }

        let proposedType: HealthSfxType | null = null
        let volumeDb = -25
        let duration = 0.65
        let relativeStart = 0.1
        let priority = 10

        switch (role) {
          case 'hook':
            proposedType = 'subtle-riser'
            volumeDb = -23
            duration = 1.2
            relativeStart = 0.1
            priority = 1
            break

          case 'payoff':
            proposedType = 'soft-impact'
            volumeDb = -23
            duration = 0.5
            relativeStart = 0.15
            priority = 2
            break

          case 'surprise':
            proposedType = 'soft-impact'
            volumeDb = -22
            duration = 0.5
            relativeStart = 0.1
            priority = 3
            break

          case 're-hook':
            proposedType = 'soft-whoosh'
            volumeDb = -25
            duration = 0.65
            relativeStart = 0.15
            priority = 4
            break

          case 'proof':
            if (rPlan.proofPriority === 'high' || rPlan.overlayPriority === 'high') {
              proposedType = 'soft-impact'
              volumeDb = -24
              duration = 0.5
              relativeStart = 0.2
              priority = 5
            }
            break

          case 'comparison':
            proposedType = 'air-swish'
            volumeDb = -25
            duration = 0.55
            relativeStart = 0.15
            priority = 6
            break

          case 'mechanism':
            // Only if text describes active mechanism
            if (/\b(cell|receptor|molecule|flow|pump|filter|neuron|enzyme|absorb|vessel)\b/i.test(text)) {
              proposedType = 'digital-scan'
              volumeDb = -26
              duration = 0.7
              relativeStart = 0.2
              priority = 7
            }
            break

          default:
            if (rPlan.patternInterrupt) {
              proposedType = 'air-swish'
              volumeDb = -25
              duration = 0.55
              relativeStart = 0.1
              priority = 8
            }
            break
        }

        if (!proposedType) continue

        const existing = candidates.get(scene.sceneIndex)
        if (existing) {
          // Section 94: Existing meaningful semantic cues win over generic retention
          if (
            existing.cue.type === 'clock-tick' ||
            existing.cue.type === 'heartbeat' ||
            existing.cue.type === 'digital-scan'
          ) {
            // Keep existing semantic cue
            continue
          }

          // If retention priority is clearly higher, upgrade cue
          if (priority < existing.priority) {
            candidates.set(scene.sceneIndex, {
              sceneIndex: scene.sceneIndex,
              cue: {
                sceneIndex: scene.sceneIndex,
                type: proposedType,
                relativeStart,
                duration,
                volumeDb,
                reason: `retention-${role}`
              },
              isOriginal: false,
              priority,
              role
            })
          }
        } else {
          candidates.set(scene.sceneIndex, {
            sceneIndex: scene.sceneIndex,
            cue: {
              sceneIndex: scene.sceneIndex,
              type: proposedType,
              relativeStart,
              duration,
              volumeDb,
              reason: `retention-${role}`
            },
            isOriginal: false,
            priority,
            role
          })
        }
      }
    }

    // Step 3: Apply chronological Cooldown, Repetitive Motion, and Consecutive Spam guards
    // Sort all candidates by chronological scene start time
    const sortedEntries = Array.from(candidates.values())
      .filter((e) => sceneMap.has(e.sceneIndex))
      .sort((a, b) => {
        const sA = sceneMap.get(a.sceneIndex)!
        const sB = sceneMap.get(b.sceneIndex)!
        return sA.startTime - sB.startTime
      })

    const finalCues = new Map<number, HealthSfxCuePlan>()
    let lastCueTime = -999
    let lastStrongCueTime = -999
    const recentTypes: HealthSfxType[] = []

    for (const entry of sortedEntries) {
      if (finalCues.size >= maxSfxScenes) {
        break
      }

      const scene = sceneMap.get(entry.sceneIndex)!
      const cueTime = scene.startTime + entry.cue.relativeStart
      const isStrong = STRONG_SFX_TYPES.has(entry.cue.type)

      // Gap check (Section 38: 4-5s general gap, 10-12s accent gap)
      if (cueTime - lastCueTime < 4.5) {
        continue
      }
      if (isStrong && cueTime - lastStrongCueTime < 10.0) {
        continue
      }

      let chosenType = entry.cue.type

      // Section 91: Consecutive identical spam guard (No > 2 identical in a row)
      const len = recentTypes.length
      if (len >= 2 && recentTypes[len - 1] === chosenType && recentTypes[len - 2] === chosenType) {
        // Vary or suppress
        if (chosenType === 'soft-whoosh') {
          chosenType = 'air-swish'
        } else if (chosenType === 'air-swish') {
          chosenType = 'soft-pulse'
        } else {
          // Suppress 3rd identical
          continue
        }
      }

      // Check camera push-in whoosh repetition (Section 39)
      if (chosenType === 'soft-whoosh' && scene.motionPreset === 'subtle-push-in') {
        const lastType = recentTypes[recentTypes.length - 1]
        if (lastType === 'soft-whoosh') {
          continue
        }
      }

      finalCues.set(entry.sceneIndex, {
        ...entry.cue,
        type: chosenType
      })

      lastCueTime = cueTime
      if (STRONG_SFX_TYPES.has(chosenType)) {
        lastStrongCueTime = cueTime
      }
      recentTypes.push(chosenType)
    }

    const densityPercent = Math.round((finalCues.size / scenes.length) * 100)
    logger.info(
      `[RetentionSFX] planned=${finalCues.size} existingHealth=${existingCues.size} retentionAdded=${finalCues.size - existingCues.size >= 0 ? finalCues.size - existingCues.size : 0} density=${densityPercent}%`
    )

    return finalCues
  }
}
