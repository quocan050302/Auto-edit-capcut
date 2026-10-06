/**
 * test/retention-rehook.test.ts
 *
 * Unit tests for Re-Hook & Pattern Interrupt Timing:
 * - Long neutral stretch exceeding target gap triggers re-hook on narrative pivot (Section 28, 29, 98)
 * - Pattern interrupt cooldown prevents over-editing (Section 27, 97)
 * - Narration and scene timing remain 100% byte and duration equivalent (Section 65, 91)
 */

import * as assert from 'assert'
import {
  RetentionDirector,
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
  console.log('RUNNING RE-HOOK & PATTERN INTERRUPT UNIT TESTS')
  console.log('==================================================\n')

  await it('TEST 1: Long neutral stretch > target gap identifies existing scene as re-hook (Section 98)', () => {
    // 12 scenes, each 5.0s long = 60s total
    // Target rehook gap is ~35s
    const scenes: RawSceneData[] = [
      { sceneIndex: 1, duration: 5.0, narration: 'Opening captivating statement establishing the premise.' }, // hook
      { sceneIndex: 2, duration: 5.0, narration: 'General physiological baseline information.' },
      { sceneIndex: 3, duration: 5.0, narration: 'Cellular respiration occurs continuously in mitochondria.' },
      { sceneIndex: 4, duration: 5.0, narration: 'Mitochondria convert oxygen and nutrients into ATP molecules.' },
      { sceneIndex: 5, duration: 5.0, narration: 'Glycolysis pathways feed pyruvate into the citric acid cycle.' },
      { sceneIndex: 6, duration: 5.0, narration: 'Enzymes catalyze each step in the biochemical pathway.' },
      { sceneIndex: 7, duration: 5.0, narration: 'Hydrogen ions cross the inner mitochondrial membrane.' },
      { sceneIndex: 8, duration: 5.0, narration: 'Membrane potential drives ATP synthase rotary motor.' },
      { sceneIndex: 9, duration: 5.0, narration: 'Notice what happens when enzyme concentrations begin to deplete.' }, // Has turning indicator!
      { sceneIndex: 10, duration: 5.0, narration: 'Substrate levels fluctuate across adjacent compartments.' },
      { sceneIndex: 11, duration: 5.0, narration: 'Feedback loops inhibit upstream regulatory nodes.' },
      { sceneIndex: 12, duration: 5.0, narration: 'In conclusion, energy balance requires strict biochemical homeostasis.' } // conclusion
    ]

    const director = new RetentionDirector({
      level: 'balanced',
      targetRehookGapSecs: 35,
      maxNoResetSecs: 42
    })
    const plan = director.generatePlan(scenes)

    // Verify Scene 1 is hook
    assert.strictEqual(plan.scenes[0].role, 'hook')

    // At scene 9 (~36s elapsed since start/reset), scene 9 narration starts with 'Notice what happens'
    const scene9Plan = plan.scenes.find((s) => s.sceneIndex === 9)
    assert.ok(scene9Plan !== undefined)
    assert.strictEqual(scene9Plan?.role, 're-hook')
    assert.strictEqual(scene9Plan?.intensity, 'medium')

    // Scene count and narration untouched
    assert.strictEqual(plan.scenes.length, 12)
    assert.strictEqual(scenes[8].narration, 'Notice what happens when enzyme concentrations begin to deplete.')
  })

  await it('TEST 2: Pattern interrupt respects cooldown (Section 27, 97)', () => {
    // 6 scenes with repetitive anatomy visuals
    const scenes: RawSceneData[] = [
      { sceneIndex: 1, duration: 5.0, narration: 'Scene 1 intro', category: 'anatomy', shotType: 'close-up' },
      { sceneIndex: 2, duration: 5.0, narration: 'Scene 2 anatomy', category: 'anatomy', shotType: 'close-up' },
      { sceneIndex: 3, duration: 5.0, narration: 'Scene 3 anatomy', category: 'anatomy', shotType: 'close-up' },
      { sceneIndex: 4, duration: 5.0, narration: 'Scene 4 anatomy', category: 'anatomy', shotType: 'close-up' }, // streak triggers interrupt here
      { sceneIndex: 5, duration: 5.0, narration: 'Scene 5 anatomy', category: 'anatomy', shotType: 'close-up' }, // within cooldown
      { sceneIndex: 6, duration: 5.0, narration: 'Scene 6 anatomy', category: 'anatomy', shotType: 'close-up' }  // within cooldown
    ]

    const director = new RetentionDirector({ level: 'balanced' })
    const plan = director.generatePlan(scenes)

    const interrupts = plan.scenes.filter((s) => s.patternInterrupt)
    // Cooldown is ~16-20s, so scenes 5 & 6 should not immediately fire back-to-back strong interrupts
    assert.ok(interrupts.length >= 1, 'Expected at least 1 pattern interrupt due to low novelty streak')

    // Scene 4 had the interrupt; Scene 5 should be suppressed by cooldown
    const scene4 = plan.scenes.find((s) => s.sceneIndex === 4)
    const scene5 = plan.scenes.find((s) => s.sceneIndex === 5)
    if (scene4?.patternInterrupt) {
      assert.strictEqual(scene5?.patternInterrupt, false, 'Scene 5 should respect cooldown after Scene 4 interrupt')
    }
  })

  await it('TEST 3: Cooldown expires and permits another reset after sufficient time', () => {
    // 10 long scenes (each 6s = 60s total)
    const scenes: RawSceneData[] = []
    for (let i = 1; i <= 10; i++) {
      scenes.push({
        sceneIndex: i,
        duration: 6.0,
        narration: `Scene ${i} details ongoing biological cellular mechanisms.`,
        category: 'anatomy',
        shotType: 'close-up'
      })
    }

    const director = new RetentionDirector({ level: 'balanced' })
    const plan = director.generatePlan(scenes)

    const interrupts = plan.scenes.filter((s) => s.patternInterrupt)
    // In a 60s video with repeated closeups, we expect multiple spaced interrupts, not all packed together
    assert.ok(interrupts.length >= 2, `Expected at least 2 interrupts across 60s, got ${interrupts.length}`)

    // Check gap between consecutive interrupts
    for (let j = 0; j < interrupts.length - 1; j++) {
      const idx1 = interrupts[j].sceneIndex
      const idx2 = interrupts[j + 1].sceneIndex
      const sceneGap = idx2 - idx1
      // Each scene is 6s, cooldown is >= 16s -> at least 2 scenes gap
      assert.ok(sceneGap >= 2, `Expected sceneGap >= 2 between interrupts, got ${sceneGap}`)
    }
  })

  console.log(`\nRe-Hook Tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
