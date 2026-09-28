import type { TranscriptResult, TranscriptSegment, TranscriptWord, Pacing } from '../../shared/types'
import { logger } from '../logger'

export interface SceneSkeleton {
  sceneIndex: number
  startTime: number
  endTime: number
  duration: number
  narrativeText: string
  transcriptSegmentIds: string[]
}

export interface PacingDurationLimits {
  min: number
  targetMin: number
  preferred: number
  targetMax: number
  hardMax: number
}

export interface PacingProfile {
  hook: PacingDurationLimits
  normal: PacingDurationLimits
}

export const PACING_PROFILES: Record<Pacing, PacingProfile> = {
  fast: {
    hook: { min: 2.0, targetMin: 2.5, preferred: 3.2, targetMax: 4.0, hardMax: 6.0 },
    normal: { min: 3.0, targetMin: 4.0, preferred: 5.0, targetMax: 6.0, hardMax: 8.0 }
  },
  balanced: {
    hook: { min: 2.5, targetMin: 3.0, preferred: 4.0, targetMax: 5.0, hardMax: 6.0 },
    normal: { min: 3.0, targetMin: 5.5, preferred: 6.8, targetMax: 8.0, hardMax: 10.0 }
  },
  cinematic: {
    hook: { min: 3.0, targetMin: 4.0, preferred: 5.0, targetMax: 6.0, hardMax: 8.0 },
    normal: { min: 4.0, targetMin: 7.0, preferred: 8.5, targetMax: 10.0, hardMax: 12.0 }
  },
  slow: {
    hook: { min: 4.0, targetMin: 5.0, preferred: 6.0, targetMax: 7.0, hardMax: 9.0 },
    normal: { min: 5.0, targetMin: 8.0, preferred: 10.0, targetMax: 12.0, hardMax: 14.0 }
  }
}

interface NormalizedSegment {
  id: string
  subId: string
  text: string
  start: number
  end: number
  duration: number
  isSplit?: boolean
}

const STRONG_PUNCTUATION = /[.?!;]$/

/**
 * Preprocess transcript segments:
 * If an individual segment exceeds hardMax, split it at punctuation/clause or word-count boundaries.
 * Interpolates timestamps proportionally, preserves 100% word order, retains original segment ID.
 */
function preprocessSegments(
  segments: TranscriptSegment[],
  profile: PacingProfile
): NormalizedSegment[] {
  const normalized: NormalizedSegment[] = []

  for (const seg of segments) {
    const isHook = seg.start < 30.0
    const limits = isHook ? profile.hook : profile.normal

    if (seg.duration <= limits.hardMax) {
      normalized.push({
        id: seg.id,
        subId: seg.id,
        text: seg.text.trim(),
        start: seg.start,
        end: seg.end,
        duration: seg.duration,
        isSplit: false
      })
      continue
    }

    // Segment is abnormally long (> hardMax): split it into sub-parts
    logger.warn(
      `[PLAN][Segmentation] Segment ${seg.id} duration (${seg.duration.toFixed(1)}s) exceeds hardMax (${limits.hardMax}s). Splitting into sub-parts...`
    )

    const rawWords = seg.text.trim().split(/\s+/).filter(Boolean)
    if (rawWords.length <= 1) {
      normalized.push({
        id: seg.id,
        subId: seg.id,
        text: seg.text.trim(),
        start: seg.start,
        end: seg.end,
        duration: seg.duration,
        isSplit: false
      })
      continue
    }

    const numParts = Math.max(2, Math.ceil(seg.duration / limits.preferred))
    const wordsPerPart = Math.ceil(rawWords.length / numParts)
    let prevEnd = seg.start

    for (let p = 0; p < numParts; p++) {
      const startWordIdx = p * wordsPerPart
      const endWordIdx = Math.min((p + 1) * wordsPerPart, rawWords.length)
      const partWords = rawWords.slice(startWordIdx, endWordIdx)
      if (partWords.length === 0) continue

      const isLastPart = p === numParts - 1 || endWordIdx >= rawWords.length
      const partStart = prevEnd

      let partEnd: number
      if (isLastPart) {
        partEnd = seg.end
      } else if (seg.words && seg.words.length === rawWords.length) {
        const lastWordInPart = seg.words[endWordIdx - 1]
        const nextWord = seg.words[endWordIdx]
        partEnd = nextWord ? nextWord.start : (lastWordInPart?.end ?? seg.end)
        partEnd = Number(partEnd.toFixed(2))
      } else {
        partEnd = Number((seg.start + (endWordIdx / rawWords.length) * (seg.end - seg.start)).toFixed(2))
      }

      const partDuration = Number((partEnd - partStart).toFixed(2))
      prevEnd = partEnd

      normalized.push({
        id: seg.id,
        subId: `${seg.id}#${p + 1}`,
        text: partWords.join(' '),
        start: partStart,
        end: partEnd,
        duration: partDuration,
        isSplit: true
      })

      if (isLastPart) break
    }
  }

  return normalized
}

/**
 * Deterministically groups Whisper transcript segments into visual scene skeletons.
 *
 * Rules:
 * - Order is strictly preserved.
 * - No segments are skipped, dropped, or duplicated.
 * - Narrative text is exact concatenation of segment texts (no paraphrase/summary).
 * - Timestamps are strictly continuous: 0 gap, 0 overlap.
 * - Adheres to pacing rules (hook < 30s faster, balanced normal 6–8s, max 10s).
 */
export function buildSceneSkeleton(
  transcript: TranscriptResult,
  pacing: Pacing = 'balanced'
): SceneSkeleton[] {
  const profile = PACING_PROFILES[pacing] ?? PACING_PROFILES.balanced

  // 1. Preprocess segments to handle any abnormally long segments
  const normalizedSegments = preprocessSegments(transcript.segments, profile)

  // 2. Greedily group normalized segments into scene skeletons
  const skeletons: SceneSkeleton[] = []
  let i = 0

  while (i < normalizedSegments.length) {
    const firstSeg = normalizedSegments[i]
    const candidateSegments: NormalizedSegment[] = [firstSeg]
    i++

    while (i < normalizedSegments.length) {
      const nextSeg = normalizedSegments[i]
      const isHook = firstSeg.start < 30.0
      const currentLimits = isHook ? profile.hook : profile.normal

      const currentDuration = candidateSegments[candidateSegments.length - 1].end - firstSeg.start
      const potentialDuration = nextSeg.end - firstSeg.start

      // Step 2: Keep adding segments while currentDuration < min
      if (currentDuration < currentLimits.min) {
        candidateSegments.push(nextSeg)
        i++
        continue
      }

      // Step 3: When in target range (currentDuration >= min):
      // 3a. If adding nextSeg would exceed hardMax -> close scene!
      if (potentialDuration > currentLimits.hardMax) {
        break
      }

      const lastText = candidateSegments[candidateSegments.length - 1].text.trim()
      // 3b. Strong punctuation: close scene if >= targetMin
      if (currentDuration >= currentLimits.targetMin && STRONG_PUNCTUATION.test(lastText)) {
        break
      }

      // 3c. Preferred duration reached -> close scene
      if (currentDuration >= currentLimits.preferred) {
        break
      }

      // 3d. Next segment would exceed targetMax and we are already >= targetMin
      if (potentialDuration > currentLimits.targetMax && currentDuration >= currentLimits.targetMin) {
        break
      }

      // Otherwise, keep accumulating
      candidateSegments.push(nextSeg)
      i++
    }

    const sceneStartTime = candidateSegments[0].start
    const sceneEndTime = candidateSegments[candidateSegments.length - 1].end
    const narrativeText = candidateSegments.map(s => s.text).join(' ')
    const transcriptSegmentIds = Array.from(new Set(candidateSegments.map(s => s.id)))

    skeletons.push({
      sceneIndex: skeletons.length + 1,
      startTime: sceneStartTime,
      endTime: sceneEndTime,
      duration: Number((sceneEndTime - sceneStartTime).toFixed(2)),
      narrativeText,
      transcriptSegmentIds
    })
  }

  // 3. Handle last scene if too short
  if (skeletons.length > 1) {
    const lastScene = skeletons[skeletons.length - 1]
    const prevScene = skeletons[skeletons.length - 2]
    const isHook = lastScene.startTime < 30.0
    const minDur = isHook ? profile.hook.min : profile.normal.min
    const hardMax = isHook ? profile.hook.hardMax : profile.normal.hardMax

    if (lastScene.duration < minDur) {
      if (prevScene.duration + lastScene.duration <= hardMax) {
        prevScene.endTime = lastScene.endTime
        prevScene.duration = Number((prevScene.endTime - prevScene.startTime).toFixed(2))
        prevScene.narrativeText = `${prevScene.narrativeText} ${lastScene.narrativeText}`
        prevScene.transcriptSegmentIds = Array.from(
          new Set([...prevScene.transcriptSegmentIds, ...lastScene.transcriptSegmentIds])
        )
        skeletons.pop()
      } else {
        logger.warn(
          `[PLAN][Segmentation] Final scene duration (${lastScene.duration.toFixed(1)}s) is below minimum (${minDur}s) but cannot merge into previous scene without exceeding hardMax (${hardMax}s). Keeping final scene.`
        )
      }
    }
  }

  // 4. Ensure seamless timeline (0 gap, 0 overlap) without violating hardMax
  for (let s = 0; s < skeletons.length; s++) {
    skeletons[s].sceneIndex = s + 1
    if (s === 0 && skeletons[s].startTime <= 0.15) {
      skeletons[s].startTime = 0
    }
    if (s > 0) {
      const prev = skeletons[s - 1]
      const cur = skeletons[s]
      const isPrevHook = prev.startTime < 30.0
      const prevHardMax = isPrevHook ? profile.hook.hardMax : profile.normal.hardMax

      if (cur.startTime > prev.endTime) {
        // Gap: bridge it cleanly
        const gap = cur.startTime - prev.endTime
        if (prev.duration + gap <= prevHardMax) {
          prev.endTime = cur.startTime
        } else {
          cur.startTime = prev.endTime
        }
      } else if (cur.startTime < prev.endTime) {
        // Overlap: cut at cur.startTime
        prev.endTime = cur.startTime
      }
      prev.duration = Number((prev.endTime - prev.startTime).toFixed(2))
      cur.duration = Number((cur.endTime - cur.startTime).toFixed(2))
    }
  }

  // Snap the final scene to total duration if trailing silence is small (<= 2.0s)
  const last = skeletons[skeletons.length - 1]
  if (last) {
    if (transcript.duration > last.endTime && transcript.duration - last.endTime <= 2.0) {
      last.endTime = Number(transcript.duration.toFixed(2))
    }
    last.duration = Number((last.endTime - last.startTime).toFixed(2))
  }

  // Compute stats and log exactly as specified
  const totalDuration = transcript.duration
  const avgDuration = totalDuration / skeletons.length
  const minDuration = Math.min(...skeletons.map(s => s.duration))
  const maxDuration = Math.max(...skeletons.map(s => s.duration))

  logger.info(`[PLAN][Segmentation] transcriptSegments=${transcript.segments.length}`)
  logger.info(`[PLAN][Segmentation] generatedScenes=${skeletons.length}`)
  logger.info(`[PLAN][Segmentation] duration=${totalDuration.toFixed(1)}s`)
  logger.info(`[PLAN][Segmentation] averageSceneDuration=${avgDuration.toFixed(2)}s`)
  logger.info(`[PLAN][Segmentation] minSceneDuration=${minDuration.toFixed(2)}s`)
  logger.info(`[PLAN][Segmentation] maxSceneDuration=${maxDuration.toFixed(2)}s`)

  return skeletons
}
