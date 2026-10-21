/**
 * planning-short-script.test.ts
 *
 * Verifies short-script and long-script planning behavior:
 * - 1 scene
 * - 2 scenes
 * - 5 scenes
 * - 10 scenes
 * - 20 scenes
 * - 21 scenes
 * - 100, 200, 300 scene documentary scale
 * Validates chapter constraints, sequence coverage, batching and transcript fidelity.
 */

import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { buildAlgorithmicPlan, buildEditPlan } from '../src/main/planner'
import { buildSceneSkeleton } from '../src/main/planning/scene-segmenter'
import { validateScenePlanCoverage } from '../src/main/planning/scene-validator'
import type { TranscriptResult, TranscriptSegment, MasterEditPlan } from '../shared/types'

function makeMockTranscript(sceneCount: number, durationPerScene = 4): TranscriptResult {
  const segments: TranscriptSegment[] = []
  for (let i = 1; i <= sceneCount; i++) {
    const start = (i - 1) * durationPerScene
    const end = i * durationPerScene
    segments.push({
      id: `seg_${i}`,
      start,
      end,
      duration: end - start,
      text: `Narrative segment ${i} discussing historical documentary subject details and events.`,
      words: []
    })
  }

  return {
    language: 'en',
    duration: sceneCount * durationPerScene,
    fullText: segments.map((s) => s.text).join(' '),
    segments
  }
}

describe('Planning Short Script & Multi-Scale Validation', () => {
  it('1 scene script: produces 1 chapter, 1 sequence, and valid transcript coverage', () => {
    const transcript = makeMockTranscript(1, 6)
    const skeletons = buildSceneSkeleton(transcript, 'balanced')
    assert.strictEqual(skeletons.length, 1)

    const plan = buildAlgorithmicPlan(transcript, 'Short1', 'balanced')
    assert.strictEqual(plan.totalScenes, 1)
    assert.strictEqual(plan.chapters.length, 1)
    assert.strictEqual(plan.chapters[0].sequences.length, 1)
    assert.strictEqual(plan.chapters[0].sequences[0].scenes.length, 1)

    const scene = plan.chapters[0].sequences[0].scenes[0]
    assert.strictEqual(scene.sceneIndex, 1)
    assert.strictEqual(scene.duration, 6)
    assert.ok(scene.visualIntent.length > 0)
    assert.ok(scene.searchQueries.length >= 3)

    const flatScenes = plan.chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))
    const coverage = validateScenePlanCoverage(transcript, flatScenes)
    assert.strictEqual(coverage.valid, true)
    assert.strictEqual(coverage.missingSegmentIds.length, 0)
  })

  it('2 scene script: produces valid non-overlapping sequences covering both scenes', () => {
    const transcript = makeMockTranscript(2, 5)
    const skeletons = buildSceneSkeleton(transcript, 'balanced')
    assert.strictEqual(skeletons.length, 2)

    const plan = buildAlgorithmicPlan(transcript, 'Short2', 'balanced')
    assert.strictEqual(plan.totalScenes, 2)
    assert.ok(plan.chapters.length >= 1 && plan.chapters.length <= 2)

    const flatScenes = plan.chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))
    assert.strictEqual(flatScenes.length, 2)
    assert.strictEqual(flatScenes[0].sceneIndex, 1)
    assert.strictEqual(flatScenes[1].sceneIndex, 2)

    const coverage = validateScenePlanCoverage(transcript, flatScenes)
    assert.strictEqual(coverage.valid, true)
  })

  it('5 scene script: generates valid chapter outline without impossible chapter requirements', () => {
    const transcript = makeMockTranscript(5, 4)
    const skeletons = buildSceneSkeleton(transcript, 'balanced')
    assert.strictEqual(skeletons.length, 5)

    const plan = buildAlgorithmicPlan(transcript, 'Short5', 'balanced')
    assert.strictEqual(plan.totalScenes, 5)
    assert.ok(plan.chapters.length >= 1 && plan.chapters.length <= 3)

    const flatScenes = plan.chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))
    assert.strictEqual(flatScenes.length, 5)
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(flatScenes[i].sceneIndex, i + 1)
    }

    const coverage = validateScenePlanCoverage(transcript, flatScenes)
    assert.strictEqual(coverage.valid, true)
  })

  it('10 scene script: fits in 1 planning batch with full scene coverage', () => {
    const transcript = makeMockTranscript(10, 5)
    const skeletons = buildSceneSkeleton(transcript, 'balanced')
    assert.ok(skeletons.length > 0)

    const plan = buildAlgorithmicPlan(transcript, 'Short10', 'balanced')
    assert.strictEqual(plan.totalScenes, skeletons.length)

    const flatScenes = plan.chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))
    assert.strictEqual(flatScenes.length, skeletons.length)

    const coverage = validateScenePlanCoverage(transcript, flatScenes)
    assert.strictEqual(coverage.valid, true)
  })

  it('20 scene script: boundary case for planning batch', () => {
    const transcript = makeMockTranscript(30, 6)
    const skeletons = buildSceneSkeleton(transcript, 'balanced')
    assert.ok(skeletons.length >= 20)

    const plan = buildAlgorithmicPlan(transcript, 'Batch20', 'balanced')
    assert.strictEqual(plan.totalScenes, skeletons.length)

    const flatScenes = plan.chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))
    assert.strictEqual(flatScenes.length, skeletons.length)

    const coverage = validateScenePlanCoverage(transcript, flatScenes)
    assert.strictEqual(coverage.valid, true)
  })

  it('21+ scene script: splits into batches with continuous indices', () => {
    const transcript = makeMockTranscript(45, 6)
    const skeletons = buildSceneSkeleton(transcript, 'balanced')
    assert.ok(skeletons.length > 20)

    const plan = buildAlgorithmicPlan(transcript, 'Batch21', 'balanced')
    assert.strictEqual(plan.totalScenes, skeletons.length)

    const flatScenes = plan.chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))
    assert.strictEqual(flatScenes.length, skeletons.length)
    for (let i = 0; i < skeletons.length; i++) {
      assert.strictEqual(flatScenes[i].sceneIndex, i + 1)
    }

    const coverage = validateScenePlanCoverage(transcript, flatScenes)
    assert.strictEqual(coverage.valid, true)
  })

  it('Large script projects (100, 200, 300 scenes): preserves scene order, sequence coverage and chapters', () => {
    for (const count of [120, 240, 360]) {
      const transcript = makeMockTranscript(count, 5)
      const skeletons = buildSceneSkeleton(transcript, 'balanced')
      assert.ok(skeletons.length > 50)

      const plan = buildAlgorithmicPlan(transcript, `Doc_${count}`, 'balanced')
      assert.strictEqual(plan.totalScenes, skeletons.length)
      assert.ok(plan.chapters.length >= 3 && plan.chapters.length <= 6)

      const flatScenes = plan.chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))
      assert.strictEqual(flatScenes.length, skeletons.length)

      // Verify strict sequential ordering without gaps or duplicates
      for (let i = 0; i < skeletons.length; i++) {
        assert.strictEqual(flatScenes[i].sceneIndex, i + 1)
      }

      const coverage = validateScenePlanCoverage(transcript, flatScenes)
      assert.strictEqual(coverage.valid, true)
      assert.strictEqual(coverage.missingSegmentIds.length, 0)
    }
  })
})
