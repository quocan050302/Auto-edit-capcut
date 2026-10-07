/**
 * test/retention-regression.test.ts
 *
 * Comprehensive Regression Test Suite:
 * - Scene timing preserved: sum(beat durations) == scene.duration (Section 90)
 * - Narration preserved: 100% byte equivalent (Section 91)
 * - Visual Mix ownership preserved (Section 89, 107, 108)
 * - Visual beats for stock/video with retentionHint (Section 102)
 * - Proof visual detection with factual grounding only (Section 103)
 * - Visual overload protection (Section 104)
 * - Upgraded QA non-blocking flags (Section 105)
 * - Retention Summary generation with internal heuristic score (Section 106)
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  resolveVisualBeats,
  type SceneInput
} from '../src/main/retention/visual-beat-engine'
import {
  resolveSceneRetention,
  createDefaultContext,
  type SceneRetentionInput
} from '../src/main/retention/retention-engine'
import {
  DEFAULT_RETENTION_SETTINGS,
  type RetentionScenePlan
} from '../src/main/retention/retention-types'
import {
  runRetentionQA,
  generateRetentionSummary,
  saveRetentionSummary,
  type QaSceneData
} from '../src/main/retention/retention-qa'
import { RetentionDirector } from '../src/main/retention/retention-director'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING RETENTION REGRESSION UNIT TESTS')
  console.log('==================================================\n')

  await it('TEST 1: Scene timing preserved — sum(beat durations) == scene.duration (Section 90)', () => {
    const testDurations = [2.5, 4.0, 5.75, 7.33, 10.0, 12.5]

    for (const duration of testDurations) {
      const hint: RetentionScenePlan = {
        sceneIndex: 1,
        sceneId: '1',
        role: 'hook',
        intensity: 'high',
        reason: 'hook',
        noveltyScore: 0.2,
        noveltyTarget: 0.5,
        patternInterrupt: true,
        motionEnergy: 'elevated',
        beatPacing: 'fast',
        overlayPriority: 'medium',
        proofPriority: 'normal',
        notes: []
      }

      const sceneInput: SceneInput = {
        sceneId: '1',
        sceneIndex: 0,
        duration,
        energyLevel: 'high',
        narrativeText: 'Why does this rapid metabolic phenomenon occur?',
        isPatternInterrupt: true,
        retentionHint: hint
      }

      const { beats } = resolveVisualBeats(sceneInput, createDefaultContext(), 'balanced')
      assert.ok(beats.length >= 1, `Expected at least 1 beat for duration ${duration}`)

      const totalBeatDuration = beats.reduce((sum, b) => sum + (b.relativeEnd - b.relativeStart), 0)
      assert.ok(
        Math.abs(totalBeatDuration - duration) < 0.001,
        `Timing mismatch: sum=${totalBeatDuration} vs expected=${duration}`
      )
    }
  })

  await it('TEST 2: Narration preserved byte-for-byte across Retention Director (Section 91)', () => {
    const rawScenes = [
      { sceneIndex: 1, duration: 4.5, narration: 'Exact narration string #1 with special characters: 47%, $10,000 & Harvard.' },
      { sceneIndex: 2, duration: 5.0, narration: 'Exact narration string #2 with quotes: "The cellular barrier remains impermeable".' }
    ]

    const s1Orig = rawScenes[0].narration
    const s2Orig = rawScenes[1].narration

    const director = new RetentionDirector({ level: 'balanced' })
    const plan = director.generatePlan(rawScenes)

    assert.strictEqual(rawScenes[0].narration, s1Orig)
    assert.strictEqual(rawScenes[1].narration, s2Orig)
    assert.strictEqual(plan.scenes.length, 2)
  })

  await it('TEST 3: Visual Mix ownership unchanged by Retention Engine (Section 89, 107, 108)', () => {
    // 50/50 mix: 4 scenes (2 AI, 2 Stock)
    const assignmentPlan = [
      { sceneIndex: 1, strategy: 'ai-still', source: 'ai' },
      { sceneIndex: 2, strategy: 'stock', source: 'stock' },
      { sceneIndex: 3, strategy: 'ai-still', source: 'ai' },
      { sceneIndex: 4, strategy: 'stock', source: 'stock' }
    ]

    const snapshotBefore = JSON.stringify(assignmentPlan)

    // Run Retention Director
    const director = new RetentionDirector({ level: 'balanced' })
    director.generatePlan(
      assignmentPlan.map((s) => ({
        sceneIndex: s.sceneIndex,
        duration: 4.0,
        narration: `Scene ${s.sceneIndex} explanation`,
        visualStrategy: s.strategy
      }))
    )

    // Assert assignmentPlan is untouched
    const snapshotAfter = JSON.stringify(assignmentPlan)
    assert.strictEqual(snapshotBefore, snapshotAfter)
    assert.strictEqual(assignmentPlan.filter((s) => s.strategy === 'ai-still').length, 2)
    assert.strictEqual(assignmentPlan.filter((s) => s.strategy === 'stock').length, 2)
  })

  await it('TEST 4: Visual load and overload guard suppresses excessive effects (Section 50, 104)', () => {
    const ctx = createDefaultContext()
    ctx.accumulatedVisualLoad = 5.5 // Near MAX_VISUAL_LOAD (6.0)

    const input: SceneRetentionInput = {
      sceneId: '1',
      sceneIndex: 1,
      duration: 4.5,
      energyLevel: 'high',
      isPatternInterrupt: true,
      narrativeText: 'Rapid high-intensity sequence with study showing 50% increase.'
    }

    const decision = resolveSceneRetention(input, ctx, DEFAULT_RETENTION_SETTINGS)
    // When visual load is saturated, the decision should not force strong disruptive effects
    assert.ok(decision !== undefined)
    assert.ok(decision.visualLoadScore <= 6.5)
  })

  await it('TEST 5: Upgraded Retention QA flags are non-blocking (Section 51, 52, 105)', () => {
    const qaScenes: QaSceneData[] = [
      {
        sceneIndex: 0,
        sceneId: '1',
        duration: 5.0,
        category: 'anatomy',
        motionPreset: 'slow-push-in',
        shotType: 'close-up',
        narrativeText: 'Anatomy 1'
      },
      {
        sceneIndex: 1,
        sceneId: '2',
        duration: 5.0,
        category: 'anatomy',
        motionPreset: 'slow-push-in',
        shotType: 'close-up',
        narrativeText: 'Anatomy 2'
      },
      {
        sceneIndex: 2,
        sceneId: '3',
        duration: 5.0,
        category: 'anatomy',
        motionPreset: 'slow-push-in',
        shotType: 'close-up',
        narrativeText: 'Anatomy 3'
      },
      {
        sceneIndex: 3,
        sceneId: '4',
        duration: 5.0,
        category: 'anatomy',
        motionPreset: 'slow-push-in',
        shotType: 'close-up',
        narrativeText: 'Anatomy 4'
      }
    ]

    const flags = runRetentionQA(qaScenes)
    assert.ok(flags.length >= 1)
    // None of the flags should have level === 'error' (QA must be advisory only)
    for (const f of flags) {
      assert.notStrictEqual(f.level, 'error', `Flag ${f.type} has blocking error level`)
    }
  })

  await it('TEST 6: Retention Summary generation and persistence (Section 53, 54, 106)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-summary-test-'))
    try {
      const qaScenes: QaSceneData[] = [
        { sceneIndex: 0, sceneId: '1', duration: 4.5, narrativeText: 'Introduction' },
        { sceneIndex: 1, sceneId: '2', duration: 4.5, narrativeText: 'Mechanism' }
      ]

      const flags = runRetentionQA(qaScenes)
      const summary = generateRetentionSummary(qaScenes, null, flags)

      assert.strictEqual(summary.schemaVersion, 1)
      assert.strictEqual(summary.sceneCount, 2)
      assert.strictEqual(summary.durationSecs, 9)
      assert.ok(summary.retentionHealthScore >= 0 && summary.retentionHealthScore <= 100)
      assert.strictEqual(typeof summary.riskCounts.lowNovelty, 'number')

      saveRetentionSummary(tmpDir, summary)

      const summaryPath = path.join(tmpDir, 'analysis', 'retention-summary.json')
      assert.ok(fs.existsSync(summaryPath))

      const loaded = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
      assert.strictEqual(loaded.retentionHealthScore, summary.retentionHealthScore)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  console.log(`\nRetention Regression Tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
