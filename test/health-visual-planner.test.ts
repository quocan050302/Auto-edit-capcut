/**
 * Automated Unit Tests for Health Visual Planner
 * (src/main/health/health-visual-planner.ts)
 */

import * as assert from 'assert'
import {
  HealthVisualPlanner,
  classifyNarrationSemantics,
  generateHealthImagePrompt,
  assignMotionPreset
} from '../src/main/health/health-visual-planner'
import { MasterEditPlan } from '../shared/types'

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
  console.log('RUNNING HEALTH VISUAL PLANNER UNIT TESTS')
  console.log('==================================================\n')

  // TEST 7: Anatomy/mechanism narration receives strong AI suitability
  await it('TEST 7: Anatomy/mechanism narration receives strong AI suitability', () => {
    const anatomy = classifyNarrationSemantics('Inside the liver, hepatocytes filter toxins from the bloodstream.')
    assert.strictEqual(anatomy.category, 'anatomy')
    assert.ok(anatomy.aiSuitabilityScore > anatomy.stockSuitabilityScore)
    assert.ok(anatomy.aiSuitabilityScore >= 80)

    const mechanism = classifyNarrationSemantics('The physiological mechanism involves biochemical pathways, oxidation cascade, and circadian clock regulation.')
    assert.strictEqual(mechanism.category, 'mechanism')
    assert.ok(mechanism.aiSuitabilityScore > mechanism.stockSuitabilityScore)
  })

  // TEST 8: Lifestyle/exercise scene receives strong stock suitability
  await it('TEST 8: Lifestyle/exercise scene receives strong stock suitability', () => {
    const exercise = classifyNarrationSemantics('A person running through the park during early morning exercise.')
    assert.strictEqual(exercise.category, 'exercise')
    assert.ok(exercise.stockSuitabilityScore > exercise.aiSuitabilityScore)
    assert.ok(exercise.stockSuitabilityScore >= 80)

    const lifestyle = classifyNarrationSemantics('A family cooking a fresh dinner in a modern kitchen, smiling and enjoying food.')
    assert.ok(lifestyle.category === 'food' || lifestyle.category === 'lifestyle')
    assert.ok(lifestyle.stockSuitabilityScore > lifestyle.aiSuitabilityScore)
  })

  // TEST 5: Health planner for 10 scenes => exactly 8 AI + 2 stock
  await it('TEST 5: Health planner for 10 scenes targets approximately/exactly 8 AI + 2 stock', () => {
    const planner = new HealthVisualPlanner({ aiRatio: 0.8, stockRatio: 0.2 })
    const scenes: MasterEditPlan['scenes'] = [
      { sceneIndex: 1, startTime: 0, endTime: 5, narration: 'Human liver and internal bile ducts filtering nutrients', visualDescription: 'Liver view' },
      { sceneIndex: 2, startTime: 5, endTime: 10, narration: 'Blood flow transporting red blood cells through coronary arteries', visualDescription: 'Coronary artery' },
      { sceneIndex: 3, startTime: 10, endTime: 15, narration: 'Cellular mitochondria generating ATP energy', visualDescription: 'Mitochondria' },
      { sceneIndex: 4, startTime: 15, endTime: 20, narration: 'A man jogging in the park on a sunny morning', visualDescription: 'Runner in park' },
      { sceneIndex: 5, startTime: 20, endTime: 25, narration: 'Brain synapses firing electrical signals in the cortex', visualDescription: 'Brain synapse' },
      { sceneIndex: 6, startTime: 25, endTime: 30, narration: 'Stomach acid breaking down probiotic capsules', visualDescription: 'Stomach digestion' },
      { sceneIndex: 7, startTime: 30, endTime: 35, narration: 'Kidney nephrons filtering urea and blood plasma', visualDescription: 'Kidney anatomy' },
      { sceneIndex: 8, startTime: 35, endTime: 40, narration: 'Gut microbiome bacteria colonies in the intestinal wall', visualDescription: 'Microbiome bacteria' },
      { sceneIndex: 9, startTime: 40, endTime: 45, narration: 'Chef slicing fresh vegetables and making a healthy salad', visualDescription: 'Kitchen cooking' },
      { sceneIndex: 10, startTime: 45, endTime: 50, narration: 'Insulin signaling cascade inside muscle cells', visualDescription: 'Muscle cells' }
    ]

    const mockPlan: MasterEditPlan = {
      id: 'test-plan',
      version: '1.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalDuration: 50,
      scenes
    }

    const plan = planner.createPlan(mockPlan)
    assert.strictEqual(plan.totalScenes, 10)
    assert.strictEqual(plan.targetAiScenes, 8)
    assert.strictEqual(plan.targetStockScenes, 2)

    const aiScenes = plan.scenes.filter((s) => s.strategy === 'ai-still')
    const stockScenes = plan.scenes.filter((s) => s.strategy === 'stock')

    assert.strictEqual(aiScenes.length, 8)
    assert.strictEqual(stockScenes.length, 2)

    // Verify scene 4 and scene 9 were selected for stock because of high stock affinity
    const s4 = plan.scenes.find((s) => s.sceneIndex === 4)
    const s9 = plan.scenes.find((s) => s.sceneIndex === 9)
    assert.strictEqual(s4?.strategy, 'stock')
    assert.strictEqual(s9?.strategy, 'stock')
  })

  // TEST 6: Health planner is deterministic
  await it('TEST 6: Health planner is deterministic (same input produces exact same allocation)', () => {
    const planner = new HealthVisualPlanner()
    const scenes: MasterEditPlan['scenes'] = [
      { sceneIndex: 1, startTime: 0, endTime: 5, narration: 'Brain neurons firing', visualDescription: 'Brain' },
      { sceneIndex: 2, startTime: 5, endTime: 10, narration: 'Person drinking fresh water', visualDescription: 'Drinking' },
      { sceneIndex: 3, startTime: 10, endTime: 15, narration: 'Heart pumping oxygenated blood', visualDescription: 'Heart' },
      { sceneIndex: 4, startTime: 15, endTime: 20, narration: 'Person sleeping peacefully in bed', visualDescription: 'Sleep' },
      { sceneIndex: 5, startTime: 20, endTime: 25, narration: 'Liver enzyme breakdown', visualDescription: 'Liver' }
    ]
    const mockPlan: MasterEditPlan = {
      id: 'test-plan',
      version: '1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      totalDuration: 25,
      scenes
    }

    const planA = planner.createPlan(mockPlan)
    const planB = planner.createPlan(mockPlan)

    assert.deepStrictEqual(
      planA.scenes.map((s) => ({ index: s.sceneIndex, strategy: s.strategy, prompt: s.imagePrompt })),
      planB.scenes.map((s) => ({ index: s.sceneIndex, strategy: s.strategy, prompt: s.imagePrompt }))
    )
  })

  // PROMPT GENERATION SAFETY RULES
  await it('AI Image prompt generation enforces negative constraints (no text, no labels, 16:9)', () => {
    const prompt = generateHealthImagePrompt(
      'Anatomy of the human heart showing ventricles and valves',
      'Cardiac cross section',
      'anatomy'
    )
    assert.ok(prompt.includes('16:9 horizontal composition'))
    assert.ok(prompt.includes('no text'))
    assert.ok(prompt.includes('no labels'))
    assert.ok(prompt.includes('no watermark'))
    assert.ok(prompt.includes('no logo'))
    assert.ok(!prompt.includes('fake charts'))
  })

  // DETERMINISTIC MOTION PRESET ASSIGNMENT
  await it('assignMotionPreset assigns deterministic presets based on category and sceneIndex', () => {
    const preset1 = assignMotionPreset('anatomy', 1)
    const preset2 = assignMotionPreset('anatomy', 2)
    const preset3 = assignMotionPreset('mechanism', 1)
    const preset4 = assignMotionPreset('mechanism', 2)
    const preset5 = assignMotionPreset('conceptual', 1)
    const preset6 = assignMotionPreset('conceptual', 2)

    assert.strictEqual(preset1, 'slow-push-in')
    assert.strictEqual(preset2, 'slow-push-in')
    assert.strictEqual(preset3, 'micro-drift')
    assert.strictEqual(preset4, 'slow-push-in')
    assert.strictEqual(preset5, 'pan-right')
    assert.strictEqual(preset6, 'pan-left')
  })

  // HEALTH MOTION SPEC & REPORT VERIFICATION
  await it('HealthVisualPlanner creates rich HealthMotionSpec and motion distribution report', () => {
    const planner = new HealthVisualPlanner()
    const scenes: MasterEditPlan['scenes'] = [
      { sceneIndex: 1, startTime: 0, endTime: 4, narration: 'Human heart pumping blood through valves', visualDescription: 'Heart anatomy' },
      { sceneIndex: 2, startTime: 4, endTime: 8, narration: 'Liver filtering glucose into glycogen storage', visualDescription: 'Liver' },
      { sceneIndex: 3, startTime: 8, endTime: 12, narration: 'Cellular signals traveling up to brain cortex', visualDescription: 'Neurons' },
      { sceneIndex: 4, startTime: 12, endTime: 16, narration: 'Digestive enzyme breaking down food downward', visualDescription: 'Stomach digestion' }
    ]
    const plan = planner.createPlan({
      id: 'motion-test-plan',
      version: '1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      totalDuration: 16,
      scenes
    })

    const aiScenes = plan.scenes.filter((s) => s.strategy === 'ai-still')
    assert.ok(aiScenes.length > 0)
    for (const s of aiScenes) {
      assert.ok(s.motion, `Scene ${s.sceneIndex} must have a motion spec`)
      assert.ok(s.motion.preset, `Scene ${s.sceneIndex} must have a motion preset`)
      assert.ok(s.motion.intensity, `Scene ${s.sceneIndex} must have an intensity`)
      assert.ok(typeof s.motion.focusX === 'number')
      assert.ok(typeof s.motion.focusY === 'number')
      assert.ok(typeof s.motion.zoomEnd === 'number')
      // Backward compatibility: motionPreset string must still match spec.preset
      assert.strictEqual(s.motionPreset, s.motion.preset)
    }

    if (plan.report) {
      assert.strictEqual(plan.report.totalAiScenes, aiScenes.length)
      assert.ok(plan.report.maxConsecutiveSameMotion <= 2)
    }
  })

  console.log(`\nPlanner Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch((e) => {
  console.error(e)
  process.exit(1)
})
