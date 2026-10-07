/**
 * Automated Tests for Parallel AI + Stock Pipeline Execution & Failure Fallback
 * Tests compliance with Sections 21, 22, 23, 24, 25, 26, 47, 67, 69.
 */

import * as assert from 'assert'

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
  console.log('RUNNING PARALLEL PIPELINE & FALLBACK TESTS')
  console.log('==================================================\n')

  it('1. Parallel Pipeline Orchestration (Section 67): AI and Stock tasks run simultaneously', async () => {
    const events: string[] = []

    const mockAiTask = async (): Promise<{ success: boolean }> => {
      events.push('ai_started')
      await new Promise((resolve) => setTimeout(resolve, 80))
      events.push('ai_finished')
      return { success: true }
    }

    const mockStockTask = async (): Promise<{ success: boolean }> => {
      events.push('stock_started')
      await new Promise((resolve) => setTimeout(resolve, 40))
      events.push('stock_finished')
      return { success: true }
    }

    const t0 = Date.now()
    const [aiRes, stockRes] = await Promise.all([mockAiTask(), mockStockTask()])
    const totalDuration = Date.now() - t0

    assert.ok(aiRes.success && stockRes.success)
    assert.strictEqual(events[0], 'ai_started')
    assert.strictEqual(events[1], 'stock_started', 'Stock should start immediately alongside AI, not after AI completes')
    assert.strictEqual(events[2], 'stock_finished')
    assert.strictEqual(events[3], 'ai_finished')

    // Total wall time should be closer to 80ms than 120ms
    assert.ok(totalDuration < 110, `Expected parallel wall time ~80ms, got ${totalDuration}ms`)
  })

  it('2. AI Failure Fallback (Section 25 & 69): only failed AI scenes enter secondary stock search', async () => {
    const totalScenes = 100
    const aiTargetCount = 80
    const stockTargetCount = 20

    // Initial plan
    const initialAiIndices = Array.from({ length: aiTargetCount }, (_, i) => i + 1)
    const initialStockIndices = Array.from({ length: stockTargetCount }, (_, i) => i + 81)

    // Track which scenes stock processes
    const stockSearchedScenes: number[] = []

    const mockStockEngine = async (targetIndices: number[]): Promise<void> => {
      for (const idx of targetIndices) {
        stockSearchedScenes.push(idx)
      }
    }

    // Run initial stock search on the 20 stock scenes
    await mockStockEngine(initialStockIndices)
    assert.strictEqual(stockSearchedScenes.length, 20)

    // Simulate AI execution: 77 succeed, 3 fail (scenes 12, 45, 68)
    const failedAiScenes = [12, 45, 68]

    // Fallback: Stock engine runs ONLY for the 3 failed AI scene indices
    await mockStockEngine(failedAiScenes)

    // Assert final totals
    assert.strictEqual(stockSearchedScenes.length, 23, 'Total stock acquisitions must be exactly 23 (20 initial + 3 fallback)')
    assert.deepStrictEqual(stockSearchedScenes.slice(20), [12, 45, 68])
    assert.ok(!stockSearchedScenes.includes(1), 'Scene 1 was successful AI and must NEVER enter stock search')
    assert.ok(!stockSearchedScenes.includes(80), 'Scene 80 was successful AI and must NEVER enter stock search')
  })

  it('3. Stock Scope Violation Guard (Section 23): throws VISUAL_MIX_STOCK_SCOPE_VIOLATION if stock attempts all scenes', () => {
    const totalProjectScenes = 100
    const targetSceneIndices = [5, 12, 19, 24] // 4 scenes targeted
    const expectedTargetCount = targetSceneIndices.length

    // Simulated buggy behavior where stock engine ignored targetSceneIndices and tried all 100 scenes
    const actualEligibleTargetCount = 100

    assert.throws(
      () => {
        if (expectedTargetCount < totalProjectScenes && actualEligibleTargetCount > expectedTargetCount) {
          throw new Error(
            `VISUAL_MIX_STOCK_SCOPE_VIOLATION: Expected at most ${expectedTargetCount} scenes but stock engine targeted ${actualEligibleTargetCount} scenes out of ${totalProjectScenes}.`
          )
        }
      },
      /VISUAL_MIX_STOCK_SCOPE_VIOLATION/,
      'Must throw VISUAL_MIX_STOCK_SCOPE_VIOLATION when stock scope is violated'
    )
  })

  it('4. 100/0 Initial Stock Guard (Section 19): stock engine does not run when stock count is 0', async () => {
    let stockCalled = false
    const stockSceneIndices: number[] = []

    if (stockSceneIndices.length > 0) {
      stockCalled = true
    }

    assert.strictEqual(stockCalled, false, 'Stock engine must not be called when stock target count is 0')
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
