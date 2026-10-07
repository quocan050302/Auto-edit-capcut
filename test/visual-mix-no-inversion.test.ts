/**
 * Regression Tests: Visual Mix Does Not Invert AI and Stock Ratios (Section 27, 28, 77)
 */

import * as assert from 'assert'
import {
  normalizeVisualMixConfig,
  resolveVisualMixConfig,
  VisualMixConfig
} from '../shared/types'
import { VisualMixPlanner } from '../src/main/visual-mix/visual-mix-planner'
import { HealthVisualPlanner, RawSceneData } from '../src/main/health/health-visual-planner'

let passed = 0
let failed = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err)
    failed++
  }
}

function generateMockScenes(count: number, medical = false): RawSceneData[] {
  return Array.from({ length: count }, (_, i) => ({
    sceneIndex: i + 1,
    sceneId: `scene_${i + 1}`,
    narrativeText: medical
      ? i % 2 === 0
        ? `Scene ${i + 1}: Insulin triggers liver cellular glucose absorption in blood vessels.`
        : `Scene ${i + 1}: The patient walks outside in the fresh morning air and exercises.`
      : i % 2 === 0
        ? `Scene ${i + 1}: Ancient Roman legions march across the northern empire frontier.`
        : `Scene ${i + 1}: Crowds of citizens gathered in the market square talking and trading.`,
    visualIntent: medical
      ? i % 2 === 0
        ? '3D biological animation of cellular glucose receptor'
        : 'Person walking in city park under sunlight'
      : i % 2 === 0
        ? 'Cinematic historical reconstruction of Roman legions'
        : 'Real footage of city market and bustling people',
    startTime: i * 5,
    endTime: (i + 1) * 5,
    duration: 5,
    searchQueries: [`scene_${i + 1}_query`]
  }))
}

function runTests(): void {
  console.log('\n==================================================')
  console.log('RUNNING VISUAL MIX NO-INVERSION REGRESSION TESTS')
  console.log('==================================================\n')

  // SECTION 77 MANDATORY REGRESSION TEST: visual-mix-does-not-invert-ai-and-stock-ratios
  it('visual-mix-does-not-invert-ai-and-stock-ratios: 80% AI / 20% Stock allocates exactly 80 AI and 20 Stock', () => {
    const rawScenes = generateMockScenes(100, false)
    const config: VisualMixConfig = {
      mode: 'custom-mix',
      aiImageRatio: 0.8,
      stockFootageRatio: 0.2,
      imageOutputResolution: '1080p',
      motionEnabled: true,
      requestedGenerationConcurrency: 2,
      exportConcurrency: 2,
      normalizeConcurrency: 2,
      stockSearchConcurrency: 4,
      stockDownloadConcurrency: 3
    }

    const plan = VisualMixPlanner.buildPlan({
      projectDir: '',
      rawScenes,
      config,
      profile: 'general'
    })

    const aiScenes = plan.scenes.filter((s) => s.strategy === 'ai-still')
    const stockScenes = plan.scenes.filter((s) => s.strategy === 'stock')

    // HARD ASSERTIONS AGAINST RATIO INVERSION (Section 28 & 77)
    assert.strictEqual(plan.targetAiScenes, 80, 'targetAiScenes must be 80')
    assert.strictEqual(plan.targetStockScenes, 20, 'targetStockScenes must be 20')
    assert.strictEqual(aiScenes.length, 80, 'AI scenes count must be exactly 80 (not 20)')
    assert.strictEqual(stockScenes.length, 20, 'Stock scenes count must be exactly 20 (not 80)')
    assert.strictEqual(plan.aiSceneIndices?.length, 80)
    assert.strictEqual(plan.stockSceneIndices?.length, 20)

    // Invariant check: AI must NOT equal 20 and Stock must NOT equal 80
    assert.notStrictEqual(aiScenes.length, 20, 'CRITICAL: Ratios were inverted! AI is 20 instead of 80')
    assert.notStrictEqual(stockScenes.length, 80, 'CRITICAL: Ratios were inverted! Stock is 80 instead of 20')
  })

  // Exact Ownership Invariants (Section 27)
  it('Exact Ownership Invariant: AI + Stock = totalScenes, disjoint intersection, full union', () => {
    const rawScenes = generateMockScenes(50, false)
    const config = normalizeVisualMixConfig({
      mode: 'custom-mix',
      aiImageRatio: 0.7,
      stockFootageRatio: 0.3
    })

    const plan = VisualMixPlanner.buildPlan({
      projectDir: '',
      rawScenes,
      config,
      profile: 'general'
    })

    const aiIndices = new Set(plan.aiSceneIndices || [])
    const stockIndices = new Set(plan.stockSceneIndices || [])

    // 1. Sum equals total
    assert.strictEqual(aiIndices.size + stockIndices.size, 50)

    // 2. Intersection is empty (AI ∩ Stock = ∅)
    for (const idx of aiIndices) {
      assert.strictEqual(stockIndices.has(idx), false, `Scene ${idx} appears in both AI and Stock sets`)
    }

    // 3. Union covers all scenes (AI ∪ Stock = {1..50})
    for (let i = 1; i <= 50; i++) {
      assert.ok(aiIndices.has(i) || stockIndices.has(i), `Scene ${i} is missing an owner`)
    }
  })

  // Health Profile preserves 20/80 without forcing 80/20 (Section 72 & 73)
  it('Health 20/80: Health script preserves AI=20 Stock=80 and does NOT force 80/20', () => {
    const rawScenes = generateMockScenes(100, true)
    const config = normalizeVisualMixConfig({
      mode: 'custom-mix',
      aiImageRatio: 0.2,
      stockFootageRatio: 0.8
    })

    const plan = VisualMixPlanner.buildPlan({
      projectDir: '',
      rawScenes,
      config,
      profile: 'health'
    })

    const aiScenes = plan.scenes.filter((s) => s.strategy === 'ai-still')
    const stockScenes = plan.scenes.filter((s) => s.strategy === 'stock')

    assert.strictEqual(plan.targetAiScenes, 20, 'Health must not override AI target to 80')
    assert.strictEqual(plan.targetStockScenes, 80, 'Health must not override Stock target to 20')
    assert.strictEqual(aiScenes.length, 20)
    assert.strictEqual(stockScenes.length, 80)
  })

  // 100/0 Hard Test (Section 32 & 71)
  it('100/0 Hard Test: 100 scenes with AI=100 Stock=0 produces 100 AI and 0 Stock', () => {
    const rawScenes = generateMockScenes(100, true)
    const config = normalizeVisualMixConfig({
      mode: 'custom-mix',
      aiImageRatio: 1.0,
      stockFootageRatio: 0.0
    })

    const plan = VisualMixPlanner.buildPlan({
      projectDir: '',
      rawScenes,
      config,
      profile: 'health'
    })

    assert.strictEqual(plan.targetAiScenes, 100)
    assert.strictEqual(plan.targetStockScenes, 0)
    assert.strictEqual(plan.aiSceneIndices?.length, 100)
    assert.strictEqual(plan.stockSceneIndices?.length, 0)
  })

  // 0/100 Hard Test (Section 33)
  it('0/100 Hard Test: 100 scenes with AI=0 Stock=100 produces 0 AI and 100 Stock', () => {
    const rawScenes = generateMockScenes(100, false)
    const config = normalizeVisualMixConfig({
      mode: 'custom-mix',
      aiImageRatio: 0.0,
      stockFootageRatio: 1.0
    })

    const plan = VisualMixPlanner.buildPlan({
      projectDir: '',
      rawScenes,
      config,
      profile: 'general'
    })

    assert.strictEqual(plan.targetAiScenes, 0)
    assert.strictEqual(plan.targetStockScenes, 100)
    assert.strictEqual(plan.aiSceneIndices?.length, 0)
    assert.strictEqual(plan.stockSceneIndices?.length, 100)
  })

  // Default Workflow Legacy Path (Section 1, 10, 68)
  it('Default Workflow: Visual Source = legacy always resolves to 0 AI and 1 Stock', () => {
    const resolved = resolveVisualMixConfig({
      visualSourceMode: 'legacy',
      contentType: 'default'
    })

    assert.strictEqual(resolved.mode, 'legacy')
    assert.strictEqual(resolved.aiImageRatio, 0)
    assert.strictEqual(resolved.stockFootageRatio, 1)
  })

  // Auto Detect does not change user mix ratio (Section 73)
  it('Auto Detect does NOT alter user mix ratio (40/60 remains 40/60 whether health or general)', () => {
    const config4060 = normalizeVisualMixConfig({
      mode: 'custom-mix',
      aiImageRatio: 0.4,
      stockFootageRatio: 0.6
    })

    const rawScenes = generateMockScenes(10, true)

    // With profile === 'health'
    const planHealth = VisualMixPlanner.buildPlan({
      projectDir: '',
      rawScenes,
      config: config4060,
      profile: 'health'
    })
    assert.strictEqual(planHealth.targetAiScenes, 4)
    assert.strictEqual(planHealth.targetStockScenes, 6)

    // With profile === 'general'
    const planGeneral = VisualMixPlanner.buildPlan({
      projectDir: '',
      rawScenes,
      config: config4060,
      profile: 'general'
    })
    assert.strictEqual(planGeneral.targetAiScenes, 4)
    assert.strictEqual(planGeneral.targetStockScenes, 6)
  })

  console.log(`\nVisual Mix No-Inversion Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests()
