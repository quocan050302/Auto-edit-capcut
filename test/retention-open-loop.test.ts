/**
 * test/retention-open-loop.test.ts
 *
 * Unit tests for Open Loop & Payoff Tracking:
 * - Detection of explicit questions and teaser phrases (Section 13, 93)
 * - Payoff matching via signal phrases and keyword overlap (Section 15, 93)
 * - False positive protection: factual statements do NOT create loops (Section 94)
 * - avoidSpoiler marking on intermediate scenes between loop and payoff (Section 16)
 * - Preserving narration without modifying or injecting script (Section 13, 65)
 */

import * as assert from 'assert'
import {
  detectOpenLoops,
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
  console.log('RUNNING OPEN LOOP & PAYOFF UNIT TESTS')
  console.log('==================================================\n')

  await it('TEST 1: Scene 3 question resolved at Scene 14 (Section 93)', () => {
    const scenes: RawSceneData[] = []
    for (let i = 1; i <= 20; i++) {
      let narration = `Scene ${i} details general physiological background information.`
      if (i === 3) {
        narration = 'Why does this happen at night?'
      } else if (i === 14) {
        narration = 'The reason is that at night, cellular repair mechanisms shift into overdrive.'
      }

      scenes.push({
        sceneIndex: i,
        duration: 4.0,
        narration,
        visualIntent: `Visual context ${i}`
      })
    }

    // Preserve original narration check (Section 91, 93)
    const originalScene3Text = scenes[2].narration
    const originalScene14Text = scenes[13].narration

    const loops = detectOpenLoops(scenes)
    assert.strictEqual(loops.length, 1)

    const loop = loops[0]
    assert.strictEqual(loop.openedAtSceneIndex, 3)
    assert.strictEqual(loop.payoffSceneIndex, 14)
    assert.strictEqual(loop.status, 'resolved')
    assert.ok(loop.confidence >= 0.8)

    // Ensure narration strings were not modified in place
    assert.strictEqual(scenes[2].narration, originalScene3Text)
    assert.strictEqual(scenes[13].narration, originalScene14Text)
  })

  await it('TEST 2: No false open loop on factual declarations (Section 94)', () => {
    const factualScenes: RawSceneData[] = [
      {
        sceneIndex: 1,
        duration: 4.0,
        narration: 'The kidneys filter blood through approximately one million microscopic nephrons.'
      },
      {
        sceneIndex: 2,
        duration: 4.5,
        narration: 'Every day, over 200 quarts of fluid are processed by the renal cortex.'
      },
      {
        sceneIndex: 3,
        duration: 5.0,
        narration: 'Normal blood pressure maintains glomerular filtration rate effectively.'
      },
      {
        sceneIndex: 4,
        duration: 4.0,
        narration: 'Electrolytes such as sodium and potassium remain balanced across cell membranes.'
      }
    ]

    const loops = detectOpenLoops(factualScenes)
    assert.strictEqual(loops.length, 0, `Expected 0 loops, detected ${loops.length}`)
  })

  await it('TEST 3: Avoid spoiler is applied only to intermediate scenes (Section 16)', () => {
    const scenes: RawSceneData[] = [
      { sceneIndex: 1, duration: 4.0, narration: 'Welcome to this comprehensive physiological documentary.' },
      { sceneIndex: 2, duration: 4.0, narration: 'What happens next when cellular energy is completely drained?' }, // Open loop at 2
      { sceneIndex: 3, duration: 4.0, narration: 'Mitochondrial activity decreases throughout the tissue.' },
      { sceneIndex: 4, duration: 4.0, narration: 'Lactic acid begins accumulating rapidly.' },
      { sceneIndex: 5, duration: 4.0, narration: 'The reason this happens is due to sudden anaerobic shift.' }, // Payoff at 5
      { sceneIndex: 6, duration: 4.0, narration: 'Ultimately, restoration occurs once oxygen returns.' }
    ]

    const director = new RetentionDirector({ level: 'balanced' })
    const plan = director.generatePlan(scenes)

    const s1 = plan.scenes.find((s) => s.sceneIndex === 1)
    const s2 = plan.scenes.find((s) => s.sceneIndex === 2)
    const s3 = plan.scenes.find((s) => s.sceneIndex === 3)
    const s4 = plan.scenes.find((s) => s.sceneIndex === 4)
    const s5 = plan.scenes.find((s) => s.sceneIndex === 5)
    const s6 = plan.scenes.find((s) => s.sceneIndex === 6)

    assert.strictEqual(s1?.avoidSpoiler, false)
    assert.strictEqual(s2?.avoidSpoiler, false) // The question scene itself
    assert.strictEqual(s3?.avoidSpoiler, true) // Intermediate scene 3
    assert.strictEqual(s4?.avoidSpoiler, true) // Intermediate scene 4
    assert.strictEqual(s5?.avoidSpoiler, false) // The payoff itself reveals the answer
    assert.strictEqual(s6?.avoidSpoiler, false) // Subsequent scene
  })

  await it('TEST 4: Teaser phrase triggers open loop with high confidence', () => {
    const scenes: RawSceneData[] = [
      {
        sceneIndex: 1,
        duration: 5.0,
        narration: 'Most people believe diet is the only contributor, but there is another reason entirely.'
      },
      {
        sceneIndex: 2,
        duration: 4.0,
        narration: 'Clinical surveys consistently show surprising variance across age groups.'
      },
      {
        sceneIndex: 3,
        duration: 5.0,
        narration: 'This happens because chronic sleep fragmentation disrupts metabolic hormonal rhythms.'
      }
    ]

    const loops = detectOpenLoops(scenes)
    assert.ok(loops.length >= 1)
    const teaserLoop = loops.find((l) => l.openedAtSceneIndex === 1)
    assert.ok(teaserLoop !== undefined)
    assert.strictEqual(teaserLoop?.payoffSceneIndex, 3)
  })

  console.log(`\nOpen Loop Tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
