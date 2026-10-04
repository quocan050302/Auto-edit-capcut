/**
 * Automated UI Contract & Integrity Tests for Health Visual Mode
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_HEALTH_CONFIG } from '../src/main/health/health-visual-types'
import { ContentType, StockProvider } from '../shared/types'

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

function runTests(): void {
  console.log('\n==================================================')
  console.log('RUNNING HEALTH VISUAL UI CONTRACT & INTEGRITY TESTS')
  console.log('==================================================\n')

  const inputPagePath = path.join(__dirname, '..', 'src', 'renderer', 'src', 'pages', 'InputPage.tsx')
  const inputPageSource = fs.readFileSync(inputPagePath, 'utf-8')

  // 1. Selector IDs
  it('1. InputPage contains both selectable card IDs (content-type-default, content-type-health)', () => {
    assert.ok(
      inputPageSource.includes('id="content-type-default"'),
      'InputPage must contain id="content-type-default"'
    )
    assert.ok(
      inputPageSource.includes('id="content-type-health"'),
      'InputPage must contain id="content-type-health"'
    )
  })

  // 2. Titles & descriptions
  it('2. InputPage renders accurate titles and descriptions for Default and Health modes', () => {
    assert.ok(inputPageSource.includes('Standard production'))
    assert.ok(inputPageSource.includes('Uses normal planning + stock footage workflow'))
    assert.ok(inputPageSource.includes('Medical explainer'))
    assert.ok(inputPageSource.includes('80% AI visuals + 20% real footage'))
  })

  // 3. Compact Health summary bullets
  it('3. Health mode displays complete 5-point compact summary', () => {
    assert.ok(inputPageSource.includes('80% AI-generated visuals'))
    assert.ok(inputPageSource.includes('20% real footage'))
    assert.ok(inputPageSource.includes('1920×1080 generated stills'))
    assert.ok(inputPageSource.includes('Automatic motion effects'))
    assert.ok(inputPageSource.includes('Google Flow image generation'))
  })

  // 4. FlowKit warning when disconnected
  it('4. Health mode displays FlowKit connection warning when disconnected', () => {
    assert.ok(inputPageSource.includes('Google Flow / FlowKit is not ready'))
    assert.ok(inputPageSource.includes('Open Google Flow in Chrome and ensure the FlowKit extension is connected.'))
  })

  // 5. Default health config constants
  it('5. Default Health configuration matches specification (80/20, 1920x1080, motion enabled)', () => {
    assert.strictEqual(DEFAULT_HEALTH_CONFIG.aiRatio, 0.8)
    assert.strictEqual(DEFAULT_HEALTH_CONFIG.stockRatio, 0.2)
    assert.strictEqual(DEFAULT_HEALTH_CONFIG.width, 1920)
    assert.strictEqual(DEFAULT_HEALTH_CONFIG.height, 1080)
    assert.strictEqual(DEFAULT_HEALTH_CONFIG.motionEnabled, true)
  })

  // 6. ContentType union type
  it('6. ContentType type supports "default" and "health"', () => {
    const defaultType: ContentType = 'default'
    const healthType: ContentType = 'health'
    assert.strictEqual(defaultType, 'default')
    assert.strictEqual(healthType, 'health')
  })

  // 7. StockProvider supports 'google-flow'
  it('7. StockProvider supports "google-flow" alongside pexels and pixabay', () => {
    const flowProvider: StockProvider = 'google-flow'
    assert.strictEqual(flowProvider, 'google-flow')
  })

  console.log(`\nUI Contract Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests()
