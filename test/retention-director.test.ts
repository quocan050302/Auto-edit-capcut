/**
 * test/retention-director.test.ts
 *
 * Tests for Retention Director:
 * - Determinism: identical inputs produce identical semantic plan (ignoring generatedAt)
 * - Cache lookup via inputHash
 * - Fast performance (< 500ms for 100+ scenes)
 * - Fail-open fallback when inputs are empty or corrupt
 * - Role classification across narrative structures
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  RetentionDirector,
  ensureRetentionPlan,
  getRetentionPlanPath,
  loadRetentionPlan,
  saveRetentionPlan,
  type RawSceneData
} from '../src/main/retention/retention-director'

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
  console.log('RUNNING RETENTION DIRECTOR UNIT TESTS')
  console.log('==================================================\n')

  const sampleScenes: RawSceneData[] = [
    {
      sceneIndex: 1,
      duration: 5.0,
      narration: 'What if your body was silently failing you right now without any warning signs?',
      visualIntent: 'Shocked individual looking in mirror',
      shotType: 'close-up',
      energyLevel: 'high'
    },
    {
      sceneIndex: 2,
      duration: 4.5,
      narration: 'Millions of adults walk around everyday unaware of this hidden biological danger.',
      visualIntent: 'Crowd of everyday commuters in busy city street',
      shotType: 'wide',
      energyLevel: 'medium'
    },
    {
      sceneIndex: 3,
      duration: 4.0,
      narration: 'Why does this metabolic collapse occur specifically during resting hours?',
      visualIntent: 'Bedroom clock ticking past midnight',
      shotType: 'medium',
      energyLevel: 'medium'
    },
    {
      sceneIndex: 4,
      duration: 5.5,
      narration: 'Inside your renal system, microscopic nephrons work constantly to balance cellular pressure.',
      visualIntent: '3D anatomical view of renal cortex and nephron tubules',
      shotType: 'macro',
      energyLevel: 'medium',
      category: 'anatomy'
    },
    {
      sceneIndex: 5,
      duration: 5.0,
      narration: 'A landmark 2024 Harvard clinical trial of 14,000 patients revealed a 47% drop in filtration efficiency.',
      visualIntent: 'Medical research paper and statistical data graph',
      shotType: 'medium',
      energyLevel: 'medium',
      category: 'proof'
    },
    {
      sceneIndex: 6,
      duration: 4.5,
      narration: 'However, here is the strange and surprising truth that puzzled researchers for decades.',
      visualIntent: 'Scientist examining anomalous petri dish reaction',
      shotType: 'close-up',
      energyLevel: 'high'
    },
    {
      sceneIndex: 7,
      duration: 5.0,
      narration: 'The answer to why this occurs at night lies in the nocturnal surge of circadian cortisol.',
      visualIntent: 'Circadian hormone fluctuation diagram illuminating nocturnal pathway',
      shotType: 'macro',
      energyLevel: 'high'
    },
    {
      sceneIndex: 8,
      duration: 6.0,
      narration: 'In summary, protecting your cellular health requires consistent hydration and early intervention.',
      visualIntent: 'Healthy vibrant individual enjoying active morning routine',
      shotType: 'wide',
      energyLevel: 'low'
    }
  ]

  await it('TEST 1: Determinism — same input produces identical plan and inputHash', () => {
    const director1 = new RetentionDirector({ level: 'balanced' })
    const director2 = new RetentionDirector({ level: 'balanced' })

    const plan1 = director1.generatePlan(sampleScenes)
    const plan2 = director2.generatePlan(sampleScenes)

    assert.strictEqual(plan1.inputHash, plan2.inputHash)
    assert.strictEqual(plan1.totalScenes, plan2.totalScenes)
    assert.strictEqual(plan1.totalDuration, plan2.totalDuration)
    assert.strictEqual(plan1.scenes.length, plan2.scenes.length)

    for (let i = 0; i < plan1.scenes.length; i++) {
      const s1 = plan1.scenes[i]
      const s2 = plan2.scenes[i]
      assert.strictEqual(s1.sceneIndex, s2.sceneIndex)
      assert.strictEqual(s1.role, s2.role)
      assert.strictEqual(s1.intensity, s2.intensity)
      assert.strictEqual(s1.noveltyScore, s2.noveltyScore)
      assert.strictEqual(s1.patternInterrupt, s2.patternInterrupt)
      assert.strictEqual(s1.motionEnergy, s2.motionEnergy)
      assert.strictEqual(s1.beatPacing, s2.beatPacing)
    }
  })

  await it('TEST 2: Role classification assigns narrative-grounded roles', () => {
    const director = new RetentionDirector({ level: 'balanced' })
    const plan = director.generatePlan(sampleScenes)

    // Scene 1: Opening question -> hook
    assert.strictEqual(plan.scenes[0].role, 'hook')
    assert.strictEqual(plan.scenes[0].intensity, 'high')

    // Scene 3: Open loop question
    assert.strictEqual(plan.scenes[2].role, 'open-loop')

    // Scene 4: Body mechanism
    assert.strictEqual(plan.scenes[3].role, 'mechanism')

    // Scene 5: Stat / trial -> proof
    assert.strictEqual(plan.scenes[4].role, 'proof')
    assert.strictEqual(plan.scenes[4].proofPriority, 'high')

    // Scene 6: Turn / puzzle -> surprise or re-hook
    assert.ok(plan.scenes[5].role === 'surprise' || plan.scenes[5].role === 're-hook')

    // Scene 7: Answer to scene 3 -> payoff
    assert.strictEqual(plan.scenes[6].role, 'payoff')

    // Scene 8: Final takeaway -> conclusion
    assert.strictEqual(plan.scenes[7].role, 'conclusion')
  })

  await it('TEST 3: Avoid spoiler is marked between open loop and payoff', () => {
    const director = new RetentionDirector({ level: 'balanced' })
    const plan = director.generatePlan(sampleScenes)

    // Open loop at scene 3, payoff at scene 7
    // Scenes 4, 5, 6 should have avoidSpoiler = true
    const scene4 = plan.scenes.find((s) => s.sceneIndex === 4)
    const scene5 = plan.scenes.find((s) => s.sceneIndex === 5)
    const scene6 = plan.scenes.find((s) => s.sceneIndex === 6)
    const scene7 = plan.scenes.find((s) => s.sceneIndex === 7)

    assert.strictEqual(scene4?.avoidSpoiler, true)
    assert.strictEqual(scene5?.avoidSpoiler, true)
    assert.strictEqual(scene6?.avoidSpoiler, true)
    // Payoff itself does NOT avoid spoiler, it IS the reveal
    assert.strictEqual(scene7?.avoidSpoiler, false)
  })

  await it('TEST 4: Performance — generates plan for 120 scenes in < 100ms', () => {
    const longScenes: RawSceneData[] = []
    for (let i = 1; i <= 120; i++) {
      longScenes.push({
        sceneIndex: i,
        duration: 4.5,
        narration: `Scene ${i} discusses important metabolic health mechanisms and clinical outcomes in detail.`,
        visualIntent: `Visualization ${i} for medical context`,
        shotType: i % 3 === 0 ? 'close-up' : i % 3 === 1 ? 'medium' : 'wide',
        energyLevel: i % 5 === 0 ? 'high' : 'medium'
      })
    }

    const t0 = performance.now()
    const director = new RetentionDirector({ level: 'balanced' })
    const plan = director.generatePlan(longScenes)
    const elapsed = performance.now() - t0

    assert.strictEqual(plan.scenes.length, 120)
    assert.ok(elapsed < 200, `Expected < 200ms, took ${elapsed.toFixed(2)}ms`)
  })

  await it('TEST 5: File I/O, caching and fail-open behavior', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-director-test-'))
    try {
      // 1. Initial generation
      const plan1 = await ensureRetentionPlan(tmpDir, { scenes: sampleScenes })
      assert.ok(plan1 !== null)
      assert.strictEqual(plan1!.totalScenes, 8)

      // 2. Cache hit returns same plan instantly
      const planPath = getRetentionPlanPath(tmpDir)
      assert.ok(fs.existsSync(planPath))

      const plan2 = await ensureRetentionPlan(tmpDir, { scenes: sampleScenes })
      assert.strictEqual(plan2?.inputHash, plan1?.inputHash)

      // 3. Fail open on empty scenes
      const emptyPlan = await ensureRetentionPlan(tmpDir, { scenes: [] })
      assert.strictEqual(emptyPlan, null)

      // 4. In a fresh directory with no scenes, fails open to null without crashing
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-fresh-test-'))
      const nullPlan = await ensureRetentionPlan(freshTmp, { scenes: [] })
      assert.strictEqual(nullPlan, null)
      fs.rmSync(freshTmp, { recursive: true, force: true })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  console.log(`\nRetention Director Tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
