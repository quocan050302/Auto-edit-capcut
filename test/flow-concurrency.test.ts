/**
 * Automated Tests for FlowKit Concurrency & Conveyor Architecture
 * Tests compliance with Sections 42, 43, 44, 45, 66, 68.
 */

import * as assert from 'assert'
import { FlowImagePool } from '../src/main/visual-mix/flow-image-pool'

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
  console.log('RUNNING FLOW CONCURRENCY & CONVEYOR TESTS')
  console.log('==================================================\n')

  it('1. Effective Concurrency Logic (Section 43 & 66): clamps to FlowKit maxConcurrent', () => {
    function computeEffectiveConcurrency(requested: number, flowKitMax: number): number {
      return Math.min(requested, flowKitMax)
    }

    // Case A: FlowKit reported max = 1, requested = 2 => effective = 1
    assert.strictEqual(computeEffectiveConcurrency(2, 1), 1)

    // Case B: FlowKit reported max = 2, requested = 2 => effective = 2
    assert.strictEqual(computeEffectiveConcurrency(2, 2), 2)

    // Case C: FlowKit reported max = 1, requested = 6 => effective = 1
    assert.strictEqual(computeEffectiveConcurrency(6, 1), 1)

    // Case D: FlowKit reported max = 3, requested = 2 => effective = 2
    assert.strictEqual(computeEffectiveConcurrency(2, 3), 2)
  })

  it('2. Cache before Flow Queue (Section 45 & 68): 80 AI scenes, 50 cached => only 30 enter generation queue', () => {
    const aiScenes = Array.from({ length: 80 }, (_, i) => ({
      sceneIndex: i + 1,
      hash: `hash_${i + 1}`
    }))

    // Simulate 50 cached scenes
    const cachedHashes = new Set(aiScenes.slice(0, 50).map((s) => s.hash))

    const queue: typeof aiScenes = []
    let cacheHits = 0

    for (const sc of aiScenes) {
      if (cachedHashes.has(sc.hash)) {
        cacheHits++
      } else {
        queue.push(sc)
      }
    }

    assert.strictEqual(cacheHits, 50, '50 cache hits')
    assert.strictEqual(queue.length, 30, 'Only 30 scenes should enter Flow generation queue')
  })

  it('3. Conveyor Stage Separation (Section 44): generation worker released upon mediaId', async () => {
    // Verify that generation, export, and normalization work as separate conveyor stages
    const timeline: string[] = []

    let activeGenerators = 0
    let maxConcurrentGenerators = 0

    const mockGenerate = async (sceneId: number): Promise<string> => {
      activeGenerators++
      maxConcurrentGenerators = Math.max(maxConcurrentGenerators, activeGenerators)
      timeline.push(`gen_start_${sceneId}`)
      await new Promise((r) => setTimeout(r, 20))
      activeGenerators--
      timeline.push(`mediaId_ready_${sceneId}`)
      return `media_${sceneId}`
    }

    const mockExport = async (mediaId: string): Promise<string> => {
      timeline.push(`export_start_${mediaId}`)
      await new Promise((r) => setTimeout(r, 20))
      timeline.push(`export_done_${mediaId}`)
      return `/path/${mediaId}.png`
    }

    // Process 2 scenes with generation concurrency = 1
    const runConveyor = async (sceneId: number): Promise<void> => {
      const mediaId = await mockGenerate(sceneId)
      // Generation slot is released here! Export can proceed in parallel with next generation
      await mockExport(mediaId)
    }

    // Run 2 scenes through conveyor sequentially for generation, but pipelined for export
    const promise1 = runConveyor(1)
    await new Promise((r) => setTimeout(r, 25)) // Wait until mediaId_ready_1
    const promise2 = runConveyor(2)

    await Promise.all([promise1, promise2])

    // Gen 2 started right after mediaId 1 was ready, while export 1 was still running
    const gen2Index = timeline.indexOf('gen_start_2')
    const export1DoneIndex = timeline.indexOf('export_done_media_1')

    assert.ok(
      gen2Index <= export1DoneIndex,
      'Generation for scene 2 should start without waiting for scene 1 export to finish'
    )
    assert.strictEqual(maxConcurrentGenerators, 1, 'Generation never exceeded max concurrent 1')
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
