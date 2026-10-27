import { probeMedia } from '../render-cache/ffmpeg-process'
import { logger } from '../logger'
import type { SimpleAssemblySceneInput, SimpleAssemblySceneInfo } from './simple-assembly-types'

export interface TimelineResolutionResult {
  scenes: SimpleAssemblySceneInfo[]
  voiceoverDuration: number
  targetTotalFrames: number
  fps: number
  allocationMethod: 'edit-plan' | 'equal-distribution'
  toleranceSecs: number
}

/**
 * Resolves frame-accurate, drift-free scene durations synchronized to the voiceover timeline.
 * Guaranteed:
 *  - Sum of scene frames equals targetTotalFrames exactly.
 *  - Rounding remainders are distributed deterministically across scenes without accumulating fractional drift.
 *  - Master edit plan timings are honored when available and aligned with voiceover.
 *  - Equal distribution fallback is used cleanly when no edit plan timings exist.
 */
export async function resolveAssemblyTimeline(params: {
  scenes: SimpleAssemblySceneInput[]
  voiceoverPath: string
  fps: number
  signal?: AbortSignal
}): Promise<TimelineResolutionResult> {
  const { scenes, voiceoverPath, fps, signal } = params

  if (scenes.length === 0) {
    throw new Error('Cannot resolve timeline for zero scenes.')
  }

  // 1. Authoritative voiceover probe
  const probe = await probeMedia(voiceoverPath, { signal })
  if (!probe || !probe.duration || probe.duration <= 0) {
    throw new Error(`Failed to probe voiceover audio at ${voiceoverPath}. Ensure file exists and contains a valid audio stream.`)
  }

  const voiceoverDuration = probe.duration
  const targetTotalFrames = Math.max(1, Math.round(voiceoverDuration * fps))
  const numScenes = scenes.length

  logger.info(
    `[SimpleAssemblyTimeline] Probed voiceover: duration=${voiceoverDuration.toFixed(3)}s targetFrames=${targetTotalFrames} (fps=${fps}) scenes=${numScenes}`
  )

  // 2. Check Priority 1: Edit plan timings
  const hasPlanTimings = scenes.every((s) => typeof s.duration === 'number' && s.duration > 0)
  if (hasPlanTimings) {
    const sumPlanDuration = scenes.reduce((acc, s) => acc + s.duration!, 0)
    if (sumPlanDuration > 0) {
      const diff = Math.abs(sumPlanDuration - voiceoverDuration)
      if (diff > Math.max(10, voiceoverDuration * 0.3)) {
        logger.warn(
          `[SimpleAssemblyTimeline] Noticeable planned duration discrepancy: planned ${sumPlanDuration.toFixed(2)}s vs voiceover ${voiceoverDuration.toFixed(2)}s. Proportionally aligning scenes to voiceover.`
        )
      } else {
        logger.info(
          `[SimpleAssemblyTimeline] Using edit plan scene timings (sum=${sumPlanDuration.toFixed(2)}s, voiceover=${voiceoverDuration.toFixed(2)}s, diff=${diff.toFixed(2)}s)`
        )
      }

      // Proportional frame allocation preserving scene ratios
      const rawAllocations = scenes.map((s, idx) => {
        const ratio = s.duration! / sumPlanDuration
        const idealFrames = targetTotalFrames * ratio
        const baseFrames = Math.max(1, Math.floor(idealFrames))
        const fractional = idealFrames - baseFrames
        return { idx, scene: s, baseFrames, fractional }
      })

      const currentAllocated = rawAllocations.reduce((acc, item) => acc + item.baseFrames, 0)
      const remainder = targetTotalFrames - currentAllocated

      // Distribute frame remainders deterministically to scenes with highest fractional parts
      if (remainder > 0) {
        const sortedByFractional = [...rawAllocations].sort((a, b) => b.fractional - a.fractional)
        for (let i = 0; i < remainder && i < sortedByFractional.length; i++) {
          sortedByFractional[i].baseFrames += 1
        }
      } else if (remainder < 0) {
        const sortedByLargest = [...rawAllocations].sort((a, b) => b.baseFrames - a.baseFrames)
        for (let i = 0; i < Math.abs(remainder) && i < sortedByLargest.length; i++) {
          if (sortedByLargest[i].baseFrames > 1) {
            sortedByLargest[i].baseFrames -= 1
          }
        }
      }

      let currentStartFrame = 0
      const resolvedScenes: SimpleAssemblySceneInfo[] = rawAllocations.map((item) => {
        const targetFrames = item.baseFrames
        const startFrame = currentStartFrame
        currentStartFrame += targetFrames
        return {
          sceneIndex: item.scene.sceneIndex,
          sourcePath: item.scene.filePath,
          mediaType: item.scene.mediaType,
          durationSecs: targetFrames / fps,
          targetFrames,
          startFrame
        }
      })

      // Final invariant check: sum(sceneFrames) === targetTotalFrames
      const totalAllocated = resolvedScenes.reduce((acc, s) => acc + s.targetFrames, 0)
      if (totalAllocated !== targetTotalFrames) {
        const delta = targetTotalFrames - totalAllocated
        resolvedScenes[resolvedScenes.length - 1].targetFrames += delta
        resolvedScenes[resolvedScenes.length - 1].durationSecs =
          resolvedScenes[resolvedScenes.length - 1].targetFrames / fps
      }

      return {
        scenes: resolvedScenes,
        voiceoverDuration,
        targetTotalFrames,
        fps,
        allocationMethod: 'edit-plan',
        toleranceSecs: 1 / fps
      }
    }
  }

  // 3. Priority 3: Deterministic Equal Distribution
  // Target total frames divided evenly across scenes
  const baseFrames = Math.floor(targetTotalFrames / numScenes)
  const remainder = targetTotalFrames % numScenes

  let currentStartFrame = 0
  const resolvedScenes: SimpleAssemblySceneInfo[] = scenes.map((s, idx) => {
    // Deterministically allocate 1 extra frame to the first 'remainder' scenes
    const sceneFrames = Math.max(1, baseFrames + (idx < remainder ? 1 : 0))
    const startFrame = currentStartFrame
    currentStartFrame += sceneFrames

    return {
      sceneIndex: s.sceneIndex,
      sourcePath: s.filePath,
      mediaType: s.mediaType,
      durationSecs: sceneFrames / fps,
      targetFrames: sceneFrames,
      startFrame
    }
  })

  // Final invariant check
  const totalAllocatedFrames = resolvedScenes.reduce((a, s) => a + s.targetFrames, 0)
  if (totalAllocatedFrames !== targetTotalFrames) {
    // Should never happen due to remainder allocation, but guard unconditionally
    const adjust = targetTotalFrames - totalAllocatedFrames
    resolvedScenes[resolvedScenes.length - 1].targetFrames += adjust
    resolvedScenes[resolvedScenes.length - 1].durationSecs =
      resolvedScenes[resolvedScenes.length - 1].targetFrames / fps
  }

  logger.info(
    `[SimpleAssemblyTimeline] Equal distribution complete: ${resolvedScenes.length} scenes, baseFrames=${baseFrames}, remainder=${remainder}, sumFrames=${targetTotalFrames}`
  )

  return {
    scenes: resolvedScenes,
    voiceoverDuration,
    targetTotalFrames,
    fps,
    allocationMethod: 'equal-distribution',
    toleranceSecs: 1 / fps
  }
}
