/**
 * Automated Unit Tests for Health Motion Director & Smooth Motion Engine
 * (src/main/health/health-motion-director.ts, src/main/health/health-motion.ts)
 */

import * as assert from 'assert'
import { HealthMotionDirector } from '../src/main/health/health-motion-director'
import { buildHealthMotionFilter } from '../src/main/health/health-motion'
import type { HealthMotionPreset, HealthVisualCategory } from '../shared/types'

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
  console.log('RUNNING HEALTH MOTION DIRECTOR UNIT TESTS')
  console.log('==================================================\n')

  // TEST A: Anatomy scenes no longer all receive slow-push-in
  await it('TEST A: Anatomy scenes receive diverse presets instead of static slow-push-in', () => {
    const presets: HealthMotionPreset[] = []
    const categories: HealthVisualCategory[] = ['anatomy', 'anatomy', 'anatomy', 'anatomy', 'anatomy', 'anatomy']
    const narrations = [
      'The liver situated on the right side filters blood.',
      'Spleen and stomach on the left side of the upper abdomen.',
      'The cardiac muscle contracts rhythmically.',
      'Cross section of kidney nephrons and glomerulus.',
      'Overall human anatomy showing vital organs.',
      'Cerebral cortex neurons in the left hemisphere.'
    ]

    const recent: HealthMotionPreset[] = []
    for (let i = 0; i < categories.length; i++) {
      const spec = HealthMotionDirector.planSceneMotion({
        sceneIndex: i + 1,
        category: categories[i],
        narration: narrations[i],
        duration: 4.5,
        recentPresets: recent
      })
      presets.push(spec.preset)
      recent.push(spec.preset)
    }

    // Verify there are multiple distinct presets used (not all slow-push-in)
    const distinct = new Set(presets)
    assert.ok(distinct.size >= 3, `Expected at least 3 distinct presets, got ${distinct.size}: ${[...distinct].join(', ')}`)
    assert.ok(!presets.every((p) => p === 'slow-push-in' || p === 'push-in-center'))
  })

  // TEST B: No preset repeats more than 2 consecutive AI scenes
  await it('TEST B: No preset repeats more than 2 consecutive AI scenes', () => {
    const recent: HealthMotionPreset[] = []
    let maxConsecutive = 0
    let currConsecutive = 0
    let lastPreset = ''

    for (let i = 1; i <= 20; i++) {
      const spec = HealthMotionDirector.planSceneMotion({
        sceneIndex: i,
        category: 'anatomy',
        narration: `Anatomy scene ${i} general medical overview`,
        duration: 4.0,
        recentPresets: recent
      })

      if (spec.preset === lastPreset) {
        currConsecutive++
      } else {
        lastPreset = spec.preset
        currConsecutive = 1
      }

      if (currConsecutive > maxConsecutive) {
        maxConsecutive = currConsecutive
      }

      recent.push(spec.preset)
    }

    assert.ok(
      maxConsecutive <= 2,
      `Expected max consecutive same preset <= 2, but observed ${maxConsecutive}`
    )
  })

  // TEST C: Motion planning is deterministic
  await it('TEST C: Motion planning is deterministic for identical input', () => {
    const input = {
      sceneIndex: 7,
      category: 'mechanism' as const,
      narration: 'Glucose molecules entering cellular receptors',
      duration: 3.5,
      recentPresets: ['push-in-center' as const, 'pan-left' as const]
    }

    const res1 = HealthMotionDirector.planSceneMotion(input)
    const res2 = HealthMotionDirector.planSceneMotion(input)

    assert.deepStrictEqual(res1, res2)
  })

  // TEST D: Short scene receives low motion intensity
  await it('TEST D: Short scene (< 2.5s) receives very-subtle intensity and constrained zoom', () => {
    const spec = HealthMotionDirector.planSceneMotion({
      sceneIndex: 3,
      category: 'anatomy',
      narration: 'Quick glimpse of liver cells',
      duration: 1.8
    })

    assert.strictEqual(spec.intensity, 'very-subtle')
    assert.ok(spec.zoomEnd <= 1.035, `zoomEnd should be <= 1.035, got ${spec.zoomEnd}`)
  })

  // TEST E: Heart/pulse narration can select gentle-pulse
  await it('TEST E: Heart/pulse narration selects gentle-pulse', () => {
    const spec = HealthMotionDirector.planSceneMotion({
      sceneIndex: 1,
      category: 'anatomy',
      narration: 'The heart pumps with a steady arterial pulse and regular rhythm.',
      duration: 4.0
    })

    assert.strictEqual(spec.preset, 'gentle-pulse')
    assert.strictEqual(spec.intensity, 'subtle')
  })

  // TEST F: Digestive/downward mechanism can choose pan-down
  await it('TEST F: Digestive/downward mechanism chooses pan-down or downward drift', () => {
    const spec = HealthMotionDirector.planSceneMotion({
      sceneIndex: 2,
      category: 'mechanism',
      narration: 'Your digestive system moves food downward into the stomach and intestinal tract.',
      duration: 4.2
    })

    assert.ok(
      spec.preset === 'pan-down' || spec.preset.includes('down'),
      `Expected downward preset, got ${spec.preset}`
    )
  })

  // TEST G: Blood flow / directional narration gets appropriate direction
  await it('TEST G: Blood flow / directional narration receives smooth pan or directional drift', () => {
    const spec = HealthMotionDirector.planSceneMotion({
      sceneIndex: 4,
      category: 'mechanism',
      narration: 'Bloodstream flow transports red blood cells and oxygen through arteries.',
      duration: 5.0
    })

    assert.ok(
      spec.preset.startsWith('pan-') || spec.preset.startsWith('drift-'),
      `Expected directional pan or drift, got ${spec.preset}`
    )
  })

  // TEST H: micro-drift old jitter preset is no longer used by Director
  await it('TEST H: micro-drift old jitter preset is not generated by HealthMotionDirector', () => {
    const allPresets: HealthMotionPreset[] = []
    const recent: HealthMotionPreset[] = []

    for (let i = 1; i <= 30; i++) {
      const spec = HealthMotionDirector.planSceneMotion({
        sceneIndex: i,
        category: (i % 2 === 0 ? 'anatomy' : 'mechanism') as HealthVisualCategory,
        narration: `Medical description for scene ${i}`,
        duration: 4.0,
        recentPresets: recent
      })
      allPresets.push(spec.preset)
      recent.push(spec.preset)
    }

    assert.ok(
      !allPresets.includes('micro-drift'),
      'Old jitter preset "micro-drift" should not be selected by HealthMotionDirector'
    )
  })

  // TEST I: All generated motion filters contain no random expressions
  await it('TEST I: All generated motion filters contain no random expressions', () => {
    const presets: HealthMotionPreset[] = [
      'push-in-center',
      'push-in-left',
      'push-in-right',
      'push-out-center',
      'pan-left',
      'pan-right',
      'pan-up',
      'pan-down',
      'drift-up-left',
      'drift-up-right',
      'drift-down-left',
      'drift-down-right',
      'focus-left',
      'focus-right',
      'gentle-pulse',
      'still-hold'
    ]

    for (const p of presets) {
      const filter = buildHealthMotionFilter(p, 1920, 1080, 4.0, 30)
      assert.ok(!filter.includes('random'), `Filter for ${p} must not contain random`)
      assert.ok(!filter.includes('rand('), `Filter for ${p} must not contain rand(`)
      assert.ok(filter.includes('zoompan='), `Filter for ${p} must be a zoompan filter`)
    }
  })

  // TEST J: All motion filters render output at requested resolution
  await it('TEST J: All motion filters configure requested resolution output', () => {
    const filter1080 = buildHealthMotionFilter('push-in-center', 1920, 1080, 4.0, 30)
    assert.ok(filter1080.includes('s=1920x1080'))

    const filterCustom = buildHealthMotionFilter('pan-right', 1280, 720, 3.0, 30)
    assert.ok(filterCustom.includes('s=1280x720'))
  })

  console.log(`\nMotion Director Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch((e) => {
  console.error(e)
  process.exit(1)
})
