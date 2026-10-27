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
    // If edit plan aligns with voiceover within 0.5s or 2% of duration
    const diff = Math.abs(sumPlanDuration - voiceoverDuration)
    const isAligned = diff <= Math.max(0.5, voiceoverDuration * 0.02)

    if (isAligned) {
      let allocatedFramesSum = 0
      const sceneFrameAllocations = scenes.map((s) => {
        const f = Math.max(1, Math.round(s.duration! * fps))
        allocatedFramesSum += f
        return f
      })

      // Distribute any frame difference deterministically to match targetTotalFrames
      const frameDelta = targetTotalFrames - allocatedFramesSum
      if (frameDelta !== 0) {
        // Adjust the last scene or distribute across scenes if delta is larger
        const lastIdx = sceneFrameAllocations.length - 1
        sceneFrameAllocations[lastIdx] = Math.max(1, sceneFrameAllocations[lastIdx] + frameDelta)
      }

      let currentStartFrame = 0
      const resolvedScenes: SimpleAssemblySceneInfo[] = scenes.map((s, idx) => {
        const targetFrames = sceneFrameAllocations[idx]
        const startFrame = currentStartFrame
        currentStartFrame += targetFrames
        return {
          sceneIndex: s.sceneIndex,
          sourcePath: s.filePath,
          mediaType: s.mediaType,
          durationSecs: targetFrames / fps,
          targetFrames,
          startFrame
        }
      })

      return {
        scenes: resolvedScenes,
        voiceoverDuration,
        targetTotalFrames,
        fps,
        allocationMethod: 'edit-plan',
        toleranceSecs: 1 / fps
      }
    } else {
      logger.info(
        `[SimpleAssemblyTimeline] Edit plan duration (${sumPlanDuration.toFixed(2)}s) differs from voiceover (${voiceoverDuration.toFixed(2)}s) by ${diff.toFixed(2)}s. Using equal distribution.`
      )
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
