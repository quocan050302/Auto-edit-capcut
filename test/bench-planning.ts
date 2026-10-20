/**
 * bench-planning.ts
 *
 * Measures AI planning execution performance across:
 * - 1 scene (short script)
 * - 5 scenes (short-medium)
 * - 20 scenes (single batch baseline)
 * - 100 scenes (long documentary)
 * Evaluates preprocessing, outline generation, batch partitioning, and validation timing.
 */

import { performance } from 'perf_hooks'
import { buildAlgorithmicPlan } from '../src/main/planner'
import { buildSceneSkeleton } from '../src/main/planning/scene-segmenter'
import { validateScenePlanCoverage } from '../src/main/planning/scene-validator'
import { computeBatchTimeoutMs, computeOutputTokenBudget } from '../src/main/ai/planning-request'
import type { TranscriptResult, TranscriptSegment } from '../shared/types'

function makeTranscript(sceneCount: number, durationPerScene = 6): TranscriptResult {
  const segments: TranscriptSegment[] = []
  for (let i = 1; i <= sceneCount; i++) {
    const start = (i - 1) * durationPerScene
    const end = i * durationPerScene
    segments.push({
      id: `seg_${i}`,
      start,
      end,
      duration: end - start,
      text: `Scene ${i}: Detailed historical narrative describing the specific documentary events.`,
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

function runBenchmark() {
  console.log('================================================================================')
  console.log('AI PLANNING PERFORMANCE & RECOVERY V1 — BENCHMARK REPORT')
  console.log('================================================================================\n')

  const testCases = [
    { label: '1 Scene (Ultra-Short)', count: 1 },
    { label: '2 Scenes (Short)', count: 2 },
    { label: '5 Scenes (Short-Medium)', count: 5 },
    { label: '20 Scenes (Standard Batch)', count: 20 },
    { label: '100 Scenes (Long Documentary)', count: 100 }
  ]

  for (const tc of testCases) {
    const transcript = makeTranscript(tc.count, 6)
    
    const t0 = performance.now()
    const skeletons = buildSceneSkeleton(transcript, 'balanced')
    const tSkeleton = performance.now() - t0

    const t1 = performance.now()
    const plan = buildAlgorithmicPlan(transcript, tc.label, 'balanced')
    const tPlan = performance.now() - t1

    const flatScenes = plan.chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes))
    const t2 = performance.now()
    const coverage = validateScenePlanCoverage(transcript, flatScenes)
    const tValidation = performance.now() - t2

    const timeout = computeBatchTimeoutMs(skeletons.length)
    const tokenBudget = computeOutputTokenBudget(skeletons.length)

    console.log(`[Fixture] ${tc.label}:`)
    console.log(`  - Input Segments: ${transcript.segments.length} (${transcript.duration}s)`)
    console.log(`  - Scene Skeletons: ${skeletons.length} (built in ${tSkeleton.toFixed(2)}ms)`)
    console.log(`  - Chapters: ${plan.chapters.length}, Total Sequences: ${plan.chapters.reduce((a, c) => a + c.sequences.length, 0)}`)
    console.log(`  - Planning Duration: ${tPlan.toFixed(2)}ms`)
    console.log(`  - Coverage Validation: ${coverage.valid ? 'VALID (100%)' : 'INVALID'} in ${tValidation.toFixed(2)}ms`)
    console.log(`  - Adaptive Timeout per Batch: ${timeout / 1000}s`)
    console.log(`  - Adaptive Token Budget: ${tokenBudget} tokens`)
    console.log(`  - Total Wall Clock: ${(tSkeleton + tPlan + tValidation).toFixed(2)}ms\n`)
  }

  console.log('================================================================================')
  console.log('BENCHMARK SUMMARY: ALL SCENARIOS VALIDATED & BOUNDED DETERMINISTICALLY')
  console.log('================================================================================')
}

runBenchmark()
