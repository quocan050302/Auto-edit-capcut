/**
 * Automated Unit Tests for Visual Mix Config & State
 * (shared/types.ts & src/main/pipeline/pipeline-state.ts)
 */

import * as assert from 'assert'
import {
  DEFAULT_VISUAL_MIX_CONFIG,
  HEALTH_RECOMMENDED_VISUAL_MIX_CONFIG,
  GENERAL_RECOMMENDED_CUSTOM_MIX_CONFIG,
  normalizeVisualMixConfig,
  resolveVisualMixConfig,
  VisualMixConfig,
  ProjectInputs
} from '../shared/types'
import { determineInvalidatedStages } from '../src/main/pipeline/pipeline-state'

let passed = 0
let failed = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function runTests(): void {
  console.log('\n==================================================')
  console.log('RUNNING VISUAL MIX CONFIG & RESOLUTION TESTS')
  console.log('==================================================\n')

  // 1. Ratio Normalization
  it('1. normalizeVisualMixConfig ensures aiImageRatio + stockFootageRatio === 1', () => {
    const normalized = normalizeVisualMixConfig({
      mode: 'custom-mix',
      aiImageRatio: 0.7,
      stockFootageRatio: 0.3
    })
    assert.strictEqual(normalized.aiImageRatio, 0.7)
    assert.strictEqual(normalized.stockFootageRatio, 0.3)
    assert.strictEqual(Math.round((normalized.aiImageRatio + normalized.stockFootageRatio) * 1000) / 1000, 1)
  })

  it('2. normalizeVisualMixConfig handles unbalanced ratios and normalizes cleanly', () => {
    const unbal = normalizeVisualMixConfig({
      mode: 'custom-mix',
      aiImageRatio: 0.75,
      stockFootageRatio: 0.1 // sum != 1
    })
    assert.strictEqual(unbal.aiImageRatio, 0.882)
    assert.strictEqual(unbal.stockFootageRatio, 0.118)
    assert.strictEqual(Math.round((unbal.aiImageRatio + unbal.stockFootageRatio) * 1000) / 1000, 1)
  })

  it('3. normalizeVisualMixConfig clamps negative and overflowing ratios', () => {
    const clampedOver = normalizeVisualMixConfig({
      mode: 'custom-mix',
      aiImageRatio: 1.5,
      stockFootageRatio: 0
    })
    assert.strictEqual(clampedOver.aiImageRatio, 1)
    assert.strictEqual(clampedOver.stockFootageRatio, 0)

    const clampedUnder = normalizeVisualMixConfig({
      mode: 'custom-mix',
      aiImageRatio: -0.2,
      stockFootageRatio: 1
    })
    assert.strictEqual(clampedUnder.aiImageRatio, 0)
    assert.strictEqual(clampedUnder.stockFootageRatio, 1)
  })

  it('4. normalizeVisualMixConfig forces 0 AI / 1 Stock in legacy mode', () => {
    const legacy = normalizeVisualMixConfig({
      mode: 'legacy',
      aiImageRatio: 0.8,
      stockFootageRatio: 0.2
    })
    assert.strictEqual(legacy.mode, 'legacy')
    assert.strictEqual(legacy.aiImageRatio, 0)
    assert.strictEqual(legacy.stockFootageRatio, 1)
  })

  it('5. Default configs match specification', () => {
    assert.strictEqual(DEFAULT_VISUAL_MIX_CONFIG.mode, 'legacy')
    assert.strictEqual(DEFAULT_VISUAL_MIX_CONFIG.aiImageRatio, 0)
    assert.strictEqual(DEFAULT_VISUAL_MIX_CONFIG.stockFootageRatio, 1)
    assert.strictEqual(DEFAULT_VISUAL_MIX_CONFIG.generationConcurrency, 6)
    assert.strictEqual(DEFAULT_VISUAL_MIX_CONFIG.postProcessConcurrency, 2)

    assert.strictEqual(HEALTH_RECOMMENDED_VISUAL_MIX_CONFIG.mode, 'custom-mix')
    assert.strictEqual(HEALTH_RECOMMENDED_VISUAL_MIX_CONFIG.aiImageRatio, 0.8)
    assert.strictEqual(HEALTH_RECOMMENDED_VISUAL_MIX_CONFIG.stockFootageRatio, 0.2)

    assert.strictEqual(GENERAL_RECOMMENDED_CUSTOM_MIX_CONFIG.mode, 'custom-mix')
    assert.strictEqual(GENERAL_RECOMMENDED_CUSTOM_MIX_CONFIG.aiImageRatio, 0.5)
    assert.strictEqual(GENERAL_RECOMMENDED_CUSTOM_MIX_CONFIG.stockFootageRatio, 0.5)
  })

  // 2. Resolution & Backward Compatibility
  it('6. Old project with no visualSourceMode or config resolves to Legacy', () => {
    const resolved = resolveVisualMixConfig({
      contentType: 'default'
    })
    assert.strictEqual(resolved.mode, 'legacy')
    assert.strictEqual(resolved.aiImageRatio, 0)
    assert.strictEqual(resolved.stockFootageRatio, 1)
  })

  it('7. Health with legacy mode explicitly returns legacy (no Flow required)', () => {
    const resolved = resolveVisualMixConfig({
      contentType: 'health',
      visualSourceMode: 'legacy'
    })
    assert.strictEqual(resolved.mode, 'legacy')
    assert.strictEqual(resolved.aiImageRatio, 0)
    assert.strictEqual(resolved.stockFootageRatio, 1)
  })

  it('8. Health with custom-mix but no ratio config resolves to 80/20 default', () => {
    const resolved = resolveVisualMixConfig({
      contentType: 'health',
      visualSourceMode: 'custom-mix'
    })
    assert.strictEqual(resolved.mode, 'custom-mix')
    assert.strictEqual(resolved.aiImageRatio, 0.8)
    assert.strictEqual(resolved.stockFootageRatio, 0.2)
  })

  it('9. Health preserves user custom ratio (e.g. 60/40) across project reload', () => {
    const resolved = resolveVisualMixConfig({
      contentType: 'health',
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        mode: 'custom-mix',
        aiImageRatio: 0.6,
        stockFootageRatio: 0.4,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      }
    })
    assert.strictEqual(resolved.aiImageRatio, 0.6)
    assert.strictEqual(resolved.stockFootageRatio, 0.4)
  })

  it('10. General profile with custom-mix preserves user custom ratio (70/30)', () => {
    const resolved = resolveVisualMixConfig({
      contentType: 'default',
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        mode: 'custom-mix',
        aiImageRatio: 0.7,
        stockFootageRatio: 0.3,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      }
    })
    assert.strictEqual(resolved.mode, 'custom-mix')
    assert.strictEqual(resolved.aiImageRatio, 0.7)
    assert.strictEqual(resolved.stockFootageRatio, 0.3)
  })

  it('11. 100/0 and 0/100 edge cases resolve cleanly', () => {
    const allAi = resolveVisualMixConfig({
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        mode: 'custom-mix',
        aiImageRatio: 1,
        stockFootageRatio: 0,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      }
    })
    assert.strictEqual(allAi.aiImageRatio, 1)
    assert.strictEqual(allAi.stockFootageRatio, 0)

    const allStock = resolveVisualMixConfig({
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        mode: 'custom-mix',
        aiImageRatio: 0,
        stockFootageRatio: 1,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      }
    })
    assert.strictEqual(allStock.aiImageRatio, 0)
    assert.strictEqual(allStock.stockFootageRatio, 1)
  })

  // 3. Stage Invalidation
  it('12. Changing visual mix ratio invalidates downstream stages but preserves transcribing & captions', () => {
    const fp = {
      scriptPath: 'script.txt',
      scriptHash: 'abc',
      voiceoverPath: 'voice.mp3',
      voiceoverSize: 100,
      voiceoverMtimeMs: 12345
    }
    const oldOptions = {
      projectDir: 'D:/test-proj',
      scriptPath: 'script.txt',
      voiceoverPath: 'voice.mp3',
      visualSourceMode: 'custom-mix' as const,
      visualMixConfig: {
        mode: 'custom-mix' as const,
        aiImageRatio: 0.8,
        stockFootageRatio: 0.2,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      }
    }
    const oldState = {
      schemaVersion: 1,
      version: 1,
      runId: 'run-1',
      projectDir: 'D:/test-proj',
      currentStage: 'idle' as const,
      overallStatus: 'idle' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inputFingerprint: fp,
      options: oldOptions,
      stages: {},
      warnings: [],
      fatalErrors: []
    }
    const newOptions = {
      ...oldOptions,
      visualMixConfig: {
        ...oldOptions.visualMixConfig,
        aiImageRatio: 0.6,
        stockFootageRatio: 0.4
      }
    }

    const invalidated = determineInvalidatedStages(oldState as any, newOptions as any, fp)
    assert.ok(invalidated.includes('stock-search'), 'Must invalidate stock-search')
    assert.ok(invalidated.includes('preflight'), 'Must invalidate preflight')
    assert.ok(invalidated.includes('rendering'), 'Must invalidate rendering')
    assert.ok(invalidated.includes('postflight'), 'Must invalidate postflight')
    assert.ok(!invalidated.includes('transcribing'), 'Must NOT invalidate transcribing')
    assert.ok(!invalidated.includes('captions'), 'Must NOT invalidate captions')
  })

  it('13. Switching from legacy to custom-mix invalidates stock-search downstream', () => {
    const fp = {
      scriptPath: 'script.txt',
      scriptHash: 'abc',
      voiceoverPath: 'voice.mp3',
      voiceoverSize: 100,
      voiceoverMtimeMs: 12345
    }
    const oldOptions = {
      projectDir: 'D:/test-proj',
      scriptPath: 'script.txt',
      voiceoverPath: 'voice.mp3',
      visualSourceMode: 'legacy' as const
    }
    const oldState = {
      schemaVersion: 1,
      version: 1,
      runId: 'run-1',
      projectDir: 'D:/test-proj',
      currentStage: 'idle' as const,
      overallStatus: 'idle' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inputFingerprint: fp,
      options: oldOptions,
      stages: {},
      warnings: [],
      fatalErrors: []
    }
    const newOptions = {
      ...oldOptions,
      visualSourceMode: 'custom-mix' as const
    }

    const invalidated = determineInvalidatedStages(oldState as any, newOptions as any, fp)
    assert.ok(invalidated.includes('stock-search'))
    assert.ok(invalidated.includes('rendering'))
  })

  console.log(`\nVisual Mix Config Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests()
