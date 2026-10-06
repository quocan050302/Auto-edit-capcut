/**
 * test/retention-motion.test.ts
 *
 * Unit tests for Retention-Aware AI Motion Decorator:
 * - Fallback: without RetentionScenePlan, returns base motion unchanged (Section 100)
 * - Motion novelty: prevents >2 consecutive identical motion presets, switching to supported alternate (Section 101)
 * - Role-based motion hints (hook, mechanism, proof, payoff, bridge) (Section 37)
 * - Preserving HealthMotionSpec object integrity
 */

import * as assert from 'assert'
import {
  applyRetentionMotionHint,
  pickAlternativePreset
} from '../src/main/retention/retention-motion'
import type { HealthMotionPreset, HealthMotionSpec } from '../shared/types'
import type { RetentionScenePlan } from '../src/main/retention/retention-types'

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
  console.log('RUNNING RETENTION MOTION DECORATOR UNIT TESTS')
  console.log('==================================================\n')

  await it('TEST 1: Fallback — missing RetentionScenePlan returns baseMotion unchanged (Section 100)', () => {
    // String preset fallback
    const resString = applyRetentionMotionHint('push-in-center', undefined, ['push-in-center'])
    assert.strictEqual(resString, 'push-in-center')

    // Object spec fallback
    const spec: HealthMotionSpec = {
      preset: 'slow-push-in',
      intensity: 'subtle',
      focalPoint: { x: 0.5, y: 0.5 }
    }
    const resObj = applyRetentionMotionHint(spec, undefined, ['slow-push-in'])
    assert.deepStrictEqual(resObj, spec)
  })

  await it('TEST 2: Motion novelty — 3 consecutive identical presets switch third to safe alternate (Section 101)', () => {
    const hint: RetentionScenePlan = {
      sceneIndex: 3,
      sceneId: '3',
      role: 'setup',
      intensity: 'medium',
      reason: 'standard',
      noveltyScore: 0.3,
      noveltyTarget: 0.5,
      patternInterrupt: false,
      motionEnergy: 'normal',
      beatPacing: 'normal',
      overlayPriority: 'none',
      proofPriority: 'normal',
      notes: []
    }

    // Previous 2 scenes both used 'push-in-center'
    const recentHistory = ['push-in-center', 'push-in-center']
    const result = applyRetentionMotionHint('push-in-center', hint, recentHistory)

    // The third should NOT be 'push-in-center'
    assert.notStrictEqual(result, 'push-in-center')

    // Result must be a supported safe alternative
    const validPresets: HealthMotionPreset[] = [
      'slow-push-in',
      'push-in-left',
      'push-in-right',
      'pan-left',
      'pan-right',
      'micro-drift',
      'slow-push-out',
      'still-hold'
    ]
    const presetName = typeof result === 'object' ? (result as HealthMotionSpec).preset : result
    assert.ok(validPresets.includes(presetName as HealthMotionPreset), `Invalid preset: ${presetName}`)
  })

  await it('TEST 3: Role-based preset adjustments (Section 37)', () => {
    const base = 'push-in-center'

    // Proof scene prefers calm still-hold
    const proofHint: RetentionScenePlan = {
      sceneIndex: 5,
      sceneId: '5',
      role: 'proof',
      intensity: 'high',
      reason: 'data presentation',
      noveltyScore: 0.6,
      noveltyTarget: 0.5,
      patternInterrupt: false,
      motionEnergy: 'calm',
      beatPacing: 'slow',
      overlayPriority: 'high',
      proofPriority: 'high',
      notes: []
    }
    const proofMotion = applyRetentionMotionHint(base, proofHint, [])
    assert.strictEqual(proofMotion, 'still-hold')

    // Mechanism scene prefers directional pan
    const mechanismHint: RetentionScenePlan = {
      ...proofHint,
      sceneIndex: 6,
      sceneId: '6',
      role: 'mechanism',
      motionEnergy: 'normal'
    }
    const mechMotion = applyRetentionMotionHint(base, mechanismHint, [])
    assert.strictEqual(mechMotion, 'pan-left')

    // Payoff scene prefers slow-push-in for controlled reveal
    const payoffHint: RetentionScenePlan = {
      ...proofHint,
      sceneIndex: 7,
      sceneId: '7',
      role: 'payoff',
      motionEnergy: 'normal'
    }
    const payoffMotion = applyRetentionMotionHint(base, payoffHint, [])
    assert.strictEqual(payoffMotion, 'slow-push-in')
  })

  await it('TEST 4: HealthMotionSpec object structure and intensity adaptation', () => {
    const spec: HealthMotionSpec = {
      preset: 'push-in-center',
      intensity: 'subtle',
      focalPoint: { x: 0.5, y: 0.4 }
    }

    const elevatedHint: RetentionScenePlan = {
      sceneIndex: 1,
      sceneId: '1',
      role: 'hook',
      intensity: 'high',
      reason: 'strong hook',
      noveltyScore: 1.0,
      noveltyTarget: 0.5,
      patternInterrupt: true,
      motionEnergy: 'elevated',
      beatPacing: 'fast',
      overlayPriority: 'medium',
      proofPriority: 'normal',
      notes: []
    }

    const res = applyRetentionMotionHint(spec, elevatedHint, []) as HealthMotionSpec
    assert.strictEqual(typeof res, 'object')
    assert.strictEqual(res.intensity, 'medium') // Promoted from subtle to medium for elevated hook
    assert.deepStrictEqual(res.focalPoint, { x: 0.5, y: 0.4 }) // Retained original focalPoint
  })

  console.log(`\nRetention Motion Tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
