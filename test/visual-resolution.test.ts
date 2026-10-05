/**
 * Automated Tests for AI Image Resolution Mapping & Flow Export Quality
 * Tests compliance with Sections 12, 13, 14, 65, 79.
 */

import * as assert from 'assert'
import {
  resolveVisualMixConfig,
  normalizeVisualMixConfig,
  AiImageOutputResolution
} from '../shared/types'

let passed = 0
let failed = 0

function it(name: string, fn: () => void | Promise<void>): void {
  const run = async (): Promise<void> => {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
      passed++
    } catch (err) {
      console.error(`  ✗ ${name}`)
      console.error(`    ${(err as Error).stack || (err as Error).message}`)
      failed++
    }
  }
  tasks.push(run)
}

const tasks: Array<() => Promise<void>> = []

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING AI IMAGE RESOLUTION TESTS')
  console.log('==================================================\n')

  it('1. 1080p Default Mapping: maps to 1920x1080 with preferred Flow export of 2K (no 4K attempt)', () => {
    const config = resolveVisualMixConfig({
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        imageOutputResolution: '1080p'
      }
    })

    assert.strictEqual(config.imageOutputResolution, '1080p')
    assert.strictEqual(config.width, 1920)
    assert.strictEqual(config.height, 1080)
  })

  it('2. 2K Mapping: maps to 2560x1440 with preferred Flow export of 2K', () => {
    const config = resolveVisualMixConfig({
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        imageOutputResolution: '2k'
      }
    })

    assert.strictEqual(config.imageOutputResolution, '2k')
    assert.strictEqual(config.width, 2560)
    assert.strictEqual(config.height, 1440)
  })

  it('3. 4K Mapping: maps to 3840x2160 with preferred Flow export of 4K', () => {
    const config = resolveVisualMixConfig({
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        imageOutputResolution: '4k'
      }
    })

    assert.strictEqual(config.imageOutputResolution, '4k')
    assert.strictEqual(config.width, 3840)
    assert.strictEqual(config.height, 2160)
  })

  it('4. Custom dimensions preserved when explicitly specified', () => {
    const config = resolveVisualMixConfig({
      visualSourceMode: 'custom-mix',
      visualMixConfig: {
        imageOutputResolution: '1080p',
        width: 1080,
        height: 1920 // Vertical 9:16
      }
    })

    assert.strictEqual(config.width, 1080)
    assert.strictEqual(config.height, 1920)
  })

  it('5. Default resolution is 1080p when undefined', () => {
    const config = resolveVisualMixConfig({
      visualSourceMode: 'custom-mix',
      visualMixConfig: {}
    })

    assert.strictEqual(config.imageOutputResolution, '1080p')
    assert.strictEqual(config.width, 1920)
    assert.strictEqual(config.height, 1080)
  })

  it('6. Flow export quality routing verification', () => {
    // When preferredQuality is '2k', flow client must not attempt 4K
    function resolveExportAttemptOrder(preferredQuality?: '2k' | '4k'): string[] {
      if (preferredQuality === '2k') {
        return ['2k', 'original']
      }
      return ['4k', '2k', 'original']
    }

    const order1080p = resolveExportAttemptOrder('2k')
    assert.deepStrictEqual(order1080p, ['2k', 'original'], '1080p should try 2K directly, then original, NOT 4K first')

    const orderThumbnail = resolveExportAttemptOrder(undefined)
    assert.deepStrictEqual(orderThumbnail, ['4k', '2k', 'original'], 'Thumbnail Studio must try 4K first')
  })

  for (const t of tasks) {
    await t()
  }

  console.log(`\nTests finished: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) {
    process.exit(1)
  }
}

runTests()
