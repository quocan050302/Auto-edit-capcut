/**
 * Automated UI Contract & Integrity Tests for Health Visual Mode (Section 67)
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

  // 1. Simple Mode must NOT render visible Content Type selector (Section 4 & 67)
  it('1. Simple Mode does NOT contain visible Content Type selector (content-type-default / content-type-health)', () => {
    assert.strictEqual(
      inputPageSource.includes('id="content-type-default"'),
      false,
      'Simple Mode must NOT contain id="content-type-default"'
    )
    assert.strictEqual(
      inputPageSource.includes('id="content-type-health"'),
      false,
      'Simple Mode must NOT contain id="content-type-health"'
    )
  })

  // 2. Simple Mode must NOT render Health Visual Mode summary panel (Section 4 & 67)
  it('2. Simple Mode does NOT contain Health Visual Mode summary panel', () => {
    assert.strictEqual(
      inputPageSource.includes('content-type-summary'),
      false,
      'Simple Mode must NOT render content-type-summary panel'
    )
    assert.strictEqual(
      inputPageSource.includes('Health Visual Mode</span>'),
      false,
      'Simple Mode must NOT render Health Visual Mode title badge'
    )
  })

  // 3. Visual Source selection remains prominent (Section 9)
  it('3. Visual Source selection remains prominent with Default Workflow and Custom Mix', () => {
    assert.ok(inputPageSource.includes('Visual Source'))
    assert.ok(inputPageSource.includes('Default Workflow'))
    assert.ok(inputPageSource.includes('Custom Mix'))
  })

  // 4. Advanced Mode provides optional Content Profile override (Section 7)
  it('4. Advanced Mode provides optional Content Profile override (Auto Detect, General, Health)', () => {
    assert.ok(inputPageSource.includes('id="content-profile-auto-adv"'))
    assert.ok(inputPageSource.includes('id="content-profile-general-adv"'))
    assert.ok(inputPageSource.includes('id="content-profile-health-adv"'))
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
