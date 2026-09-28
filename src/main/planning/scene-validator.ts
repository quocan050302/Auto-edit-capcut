import type { TranscriptResult } from '../../shared/types'
import type { ScenePlan } from '../planner'
import { logger } from '../logger'

export interface CoverageValidationResult {
  valid: boolean
  totalScenes: number
  totalSegments: number
  coveredSegmentsCount: number
  missingSegmentIds: string[]
  duplicateSegmentIds: string[]
  errors: string[]
  warnings: string[]
}

/**
 * Validates transcript coverage, timeline integrity, and metadata completeness
 * of the generated scene plan according to documentary editing rules.
 */
export function validateScenePlanCoverage(
  transcript: TranscriptResult,
  scenes: ScenePlan[]
): CoverageValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // 1. Scene count check
  if (!scenes || scenes.length === 0) {
    errors.push('Scene plan is empty (0 scenes).')
    return {
      valid: false,
      totalScenes: 0,
      totalSegments: transcript.segments.length,
      coveredSegmentsCount: 0,
      missingSegmentIds: transcript.segments.map((s) => s.id),
      duplicateSegmentIds: [],
      errors,
      warnings
    }
  }

  // 2. sceneIndex uniqueness
  const sceneIndices = scenes.map((s) => s.sceneIndex)
  const uniqueIndices = new Set(sceneIndices)
  if (uniqueIndices.size !== sceneIndices.length) {
    errors.push(`Duplicate sceneIndex detected: ${sceneIndices.length} scenes but only ${uniqueIndices.size} unique indices.`)
  }

  // 3. Timeline progression, gap, and overlap
  const TIMELINE_TOLERANCE = 0.15

  // First scene start
  const expectedStart = transcript.segments[0]?.start ?? 0
  if (scenes[0].startTime > expectedStart + TIMELINE_TOLERANCE) {
    errors.push(
      `First scene startTime (${scenes[0].startTime}s) does not match transcript start (${expectedStart}s).`
    )
  }

  // Last scene end
  const expectedEnd = transcript.duration
  if (Math.abs(scenes[scenes.length - 1].endTime - expectedEnd) > 0.25) {
    warnings.push(
      `Last scene endTime (${scenes[scenes.length - 1].endTime}s) differs from transcript duration (${expectedEnd}s) by more than 0.25s.`
    )
  }

  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i]

    // Check duration math
    const expectedDur = Number((sc.endTime - sc.startTime).toFixed(2))
    if (Math.abs(sc.duration - expectedDur) > 0.05) {
      errors.push(
        `Scene ${sc.sceneIndex}: duration (${sc.duration}) does not match endTime - startTime (${expectedDur}).`
      )
    }

    // Check non-empty narrative text
    if (!sc.narrativeText || sc.narrativeText.trim().length === 0) {
      errors.push(`Scene ${sc.sceneIndex}: narrativeText is empty.`)
    }

    // Check non-empty visualIntent
    if (!sc.visualIntent || sc.visualIntent.trim().length === 0) {
      warnings.push(`Scene ${sc.sceneIndex}: visualIntent is empty.`)
    }

    // Check searchQueries (at least 3 queries)
    if (!sc.searchQueries || sc.searchQueries.filter((q) => q.trim().length >= 2).length < 3) {
      warnings.push(`Scene ${sc.sceneIndex}: searchQueries has fewer than 3 valid queries.`)
    }

    // Check timeline order with next scene
    if (i < scenes.length - 1) {
      const nextSc = scenes[i + 1]

      if (nextSc.startTime < sc.startTime) {
        errors.push(
          `Timeline reversal: Scene ${nextSc.sceneIndex} starts at ${nextSc.startTime}s before Scene ${sc.sceneIndex} at ${sc.startTime}s.`
        )
      }

      // Gap check
      const gap = nextSc.startTime - sc.endTime
      if (gap > TIMELINE_TOLERANCE) {
        errors.push(
          `Significant timeline gap (${gap.toFixed(2)}s) between Scene ${sc.sceneIndex} (end ${sc.endTime}s) and Scene ${nextSc.sceneIndex} (start ${nextSc.startTime}s).`
        )
      }

      // Overlap check
      const overlap = sc.endTime - nextSc.startTime
      if (overlap > TIMELINE_TOLERANCE) {
        errors.push(
          `Significant timeline overlap (${overlap.toFixed(2)}s) between Scene ${sc.sceneIndex} (end ${sc.endTime}s) and Scene ${nextSc.sceneIndex} (start ${nextSc.startTime}s).`
        )
      }
    }
  }

  // 4. Transcript segment coverage
  const allTranscriptSegmentIds = new Set(transcript.segments.map((s) => s.id))
  const sceneSegmentIdUsage = new Map<string, number>()

  for (const sc of scenes) {
    for (const segId of sc.transcriptSegmentIds || []) {
      sceneSegmentIdUsage.set(segId, (sceneSegmentIdUsage.get(segId) ?? 0) + 1)
    }
  }

  const missingSegmentIds: string[] = []
  for (const id of allTranscriptSegmentIds) {
    if (!sceneSegmentIdUsage.has(id)) {
      missingSegmentIds.push(id)
    }
  }

  const duplicateSegmentIds: string[] = []
  for (const [id, count] of sceneSegmentIdUsage.entries()) {
    if (count > 1) {
      // Check if this segment was intentionally split because its duration exceeded hardMax
      const originalSeg = transcript.segments.find((s) => s.id === id)
      if (originalSeg && originalSeg.duration <= 10.0) {
        duplicateSegmentIds.push(id)
      }
    }
  }

  if (missingSegmentIds.length > 0) {
    errors.push(
      `Missing transcript segments (${missingSegmentIds.length}/${transcript.segments.length}): ${missingSegmentIds.slice(0, 10).join(', ')}${missingSegmentIds.length > 10 ? '...' : ''}`
    )
  }

  if (duplicateSegmentIds.length > 0) {
    errors.push(
      `Unexpected duplicate transcript segments: ${duplicateSegmentIds.slice(0, 10).join(', ')}${duplicateSegmentIds.length > 10 ? '...' : ''}`
    )
  }

  const coveredSegmentsCount = allTranscriptSegmentIds.size - missingSegmentIds.length
  const valid = errors.length === 0

  logger.info(
    `[PLAN][Coverage] valid=${valid} coveredSegments=${coveredSegmentsCount}/${allTranscriptSegmentIds.size} totalScenes=${scenes.length} errors=${errors.length} warnings=${warnings.length}`
  )

  return {
    valid,
    totalScenes: scenes.length,
    totalSegments: allTranscriptSegmentIds.size,
    coveredSegmentsCount,
    missingSegmentIds,
    duplicateSegmentIds,
    errors,
    warnings
  }
}
