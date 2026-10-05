/**
 * Automated Tests for Visual Mix Input Binding & Ratio Source-of-Truth
 * Tests compliance with Sections 3, 4, 5, 6, 7, 8, 9, 10, 11, 58, 59, 60, 61, 62, 74, 75, 76.
 */

import * as assert from 'assert'
import {
  resolveVisualMixConfig,
  normalizeVisualMixConfig,
  ProjectInputs,
  VisualMixConfig
} from '../shared/types'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { MasterEditPlan, MasterScene } from '../shared/types'

let passed = 0
let failed = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).stack || (err as Error).message}`)
    failed++
  }
}

function createMockMasterPlan(sceneCount: number): MasterEditPlan {
  const scenes: MasterScene[] = Array.from({ length: sceneCount }, (_, idx) => ({
    sceneId: `scene_${idx + 1}`,
    sequenceId: 'seq_1',
    chapterId: 'chap_1',
    scriptSegmentId: `seg_${idx + 1}`,
    start: idx * 5,
    end: (idx + 1) * 5,
    duration: 5,
    narrationText: idx % 2 === 0
      ? `Cellular mechanism and internal organ physiology explanation ${idx + 1}.`
      : `Person walking through a park in real life lifestyle activity ${idx + 1}.`,
    visualIntent: idx % 2 === 0 ? 'Internal biological process' : 'Real life stock footage',
    transitionAfter: 'none'
  }))

  return {
    schemaVersion: 1,
    chapters: [],
    sequences: [],
    scenes
  }
}

function runTests(): void {
  console.log('\n==================================================')
  console.log('RUNNING VISUAL MIX INPUT BINDING TESTS')
  console.log('==================================================\n')

  it('1. 100/0 Input: resolves exactly to aiImageRatio=1, stockFootageRatio=0 without 80/20 override', () => {
    const inputs: ProjectInputs = {
      contentType: 'health',
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        aiImageRatio: 1.0,
        stockFootageRatio: 0.0,
        imageOutputResolution: '1080p'
      }
    }

    const resolved = resolveVisualMixConfig(inputs)
    assert.strictEqual(resolved.mode, 'custom-mix')
    assert.strictEqual(resolved.aiImageRatio, 1.0, 'AI ratio must be 1.0')
    assert.strictEqual(resolved.stockFootageRatio, 0.0, 'Stock ratio must be 0.0')
    assert.strictEqual(resolved.imageOutputResolution, '1080p')
  })

  it('2. Zero-value audit: stockFootageRatio=0 or aiImageRatio=0 are not overwritten by || fallback', () => {
    // 100% Stock, 0% AI
    const allStockInputs: ProjectInputs = {
      contentType: 'health',
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        aiImageRatio: 0,
        stockFootageRatio: 1.0
      }
    }
    const resolvedStock = resolveVisualMixConfig(allStockInputs)
    assert.strictEqual(resolvedStock.aiImageRatio, 0, 'aiImageRatio 0 must not become 0.8')
    assert.strictEqual(resolvedStock.stockFootageRatio, 1.0)

    // 100% AI, 0% Stock
    const allAiInputs: ProjectInputs = {
      contentType: 'health',
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        aiImageRatio: 1.0,
        stockFootageRatio: 0
      }
    }
    const resolvedAi = resolveVisualMixConfig(allAiInputs)
    assert.strictEqual(resolvedAi.stockFootageRatio, 0, 'stockFootageRatio 0 must not become 0.2')
    assert.strictEqual(resolvedAi.aiImageRatio, 1.0)
  })

  it('3. Health profile does not silently force 80/20 when 30/70 is chosen', () => {
    const inputs: ProjectInputs = {
      contentType: 'health',
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        aiImageRatio: 0.3,
        stockFootageRatio: 0.7,
        imageOutputResolution: '2k'
      }
    }
    const resolved = resolveVisualMixConfig(inputs)
    assert.strictEqual(resolved.aiImageRatio, 0.3)
    assert.strictEqual(resolved.stockFootageRatio, 0.7)
    assert.strictEqual(resolved.imageOutputResolution, '2k')
  })

  it('4. Plan exactness: 100 scenes with 100/0 produces 100 AI and 0 Stock scenes (disjoint sets)', () => {
    const planner = new VisualMixPlanner()
    const masterPlan = createMockMasterPlan(100)
    const mixConfig: VisualMixConfig = {
      mode: 'custom-mix',
      aiImageRatio: 1.0,
      stockFootageRatio: 0.0,
      imageOutputResolution: '1080p',
      width: 1920,
      height: 1080,
      motionEnabled: true,
      generationConcurrency: 2,
      postProcessConcurrency: 2
    }

    const plan = planner.planVisualMix({
      profile: 'health',
      config: mixConfig,
      masterPlan
    })

    assert.strictEqual(plan.totalScenes, 100)
    assert.strictEqual(plan.targetAiScenes, 100)
    assert.strictEqual(plan.targetStockScenes, 0)
    assert.strictEqual(plan.aiSceneIndices?.length, 100)
    assert.strictEqual(plan.stockSceneIndices?.length, 0)

    // Verify intersection is empty and union is all scenes
    const aiSet = new Set(plan.aiSceneIndices || [])
    const stockSet = new Set(plan.stockSceneIndices || [])
    for (const idx of aiSet) {
      assert.ok(!stockSet.has(idx), `Scene ${idx} must not be in both sets`)
    }
    assert.strictEqual(aiSet.size, 100)
  })

  it('5. Plan exactness: 100 scenes with 80/20 produces 80 AI and 20 Stock scenes', () => {
    const planner = new VisualMixPlanner()
    const masterPlan = createMockMasterPlan(100)
    const mixConfig: VisualMixConfig = {
      mode: 'custom-mix',
      aiImageRatio: 0.8,
      stockFootageRatio: 0.2,
      imageOutputResolution: '1080p',
      width: 1920,
      height: 1080,
      motionEnabled: true,
      generationConcurrency: 2,
      postProcessConcurrency: 2
    }

    const plan = planner.planVisualMix({
      profile: 'health',
      config: mixConfig,
      masterPlan
    })

    assert.strictEqual(plan.totalScenes, 100)
    assert.strictEqual(plan.targetAiScenes, 80)
    assert.strictEqual(plan.targetStockScenes, 20)
    assert.strictEqual(plan.aiSceneIndices?.length, 80)
    assert.strictEqual(plan.stockSceneIndices?.length, 20)

    const aiSet = new Set(plan.aiSceneIndices || [])
    const stockSet = new Set(plan.stockSceneIndices || [])
    for (const idx of aiSet) {
      assert.ok(!stockSet.has(idx), `Scene ${idx} must not be in both sets`)
    }
    assert.strictEqual(aiSet.size + stockSet.size, 100)
  })

  it('6. Plan exactness on odd scene counts (Section 76): round(7 * 0.8) = 6 AI and 1 Stock', () => {
    const planner = new VisualMixPlanner()
    const masterPlan = createMockMasterPlan(7)
    const mixConfig: VisualMixConfig = {
      mode: 'custom-mix',
      aiImageRatio: 0.8,
      stockFootageRatio: 0.2,
      imageOutputResolution: '1080p',
      width: 1920,
      height: 1080,
      motionEnabled: true,
      generationConcurrency: 2,
      postProcessConcurrency: 2
    }

    const plan = planner.planVisualMix({
      profile: 'health',
      config: mixConfig,
      masterPlan
    })

    assert.strictEqual(plan.totalScenes, 7)
    assert.strictEqual(plan.targetAiScenes, 6, 'round(7 * 0.8) must be 6')
    assert.strictEqual(plan.targetStockScenes, 1, '7 - 6 must be 1')
    assert.strictEqual(plan.targetAiScenes + plan.targetStockScenes, 7)
  })

  it('7. Reopen project persistence: serialized visualMixConfig deserializes to exact same values', () => {
    const initialConfig: VisualMixConfig = {
      mode: 'custom-mix',
      aiImageRatio: 0.65,
      stockFootageRatio: 0.35,
      imageOutputResolution: '2k',
      width: 2560,
      height: 1440,
      motionEnabled: true,
      generationConcurrency: 2,
      postProcessConcurrency: 2
    }

    const serialized = JSON.stringify(initialConfig)
    const deserialized: VisualMixConfig = JSON.parse(serialized)

    const resolved = resolveVisualMixConfig({
      visualSourceMode: deserialized.mode,
      visualMixConfig: deserialized
    })

    assert.strictEqual(resolved.aiImageRatio, 0.65)
    assert.strictEqual(resolved.stockFootageRatio, 0.35)
    assert.strictEqual(resolved.imageOutputResolution, '2k')
    assert.strictEqual(resolved.width, 2560)
    assert.strictEqual(resolved.height, 1440)
  })

  it('8. Default + Legacy: remains legacy with aiImageRatio=0 and stockFootageRatio=1', () => {
    const legacyInputs: ProjectInputs = {
      contentType: 'default',
      visualSourceMode: 'legacy'
    }

    const resolved = resolveVisualMixConfig(legacyInputs)
    assert.strictEqual(resolved.mode, 'legacy')
    assert.strictEqual(resolved.aiImageRatio, 0)
    assert.strictEqual(resolved.stockFootageRatio, 1)
  })

  console.log(`\nTests finished: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) {
    process.exit(1)
  }
}

runTests()
