/**
 * Automated Unit Tests for Flow Image Concurrency Pool & Post-Processing
 * (src/main/visual-mix/flow-image-pool.ts & visual-mix-cache.ts)
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  runFlowImagePool,
  AsyncSemaphore,
  mapWithConcurrency
} from '../src/main/visual-mix/flow-image-pool'
import {
  loadGeneratedAssetsManifest,
  recordVisualAssetQueued
} from '../src/main/visual-mix/visual-mix-cache'
import { VisualMixScenePlan, GeneratedVisualAssetRecord } from '../shared/types'

let passed = 0
let failed = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
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

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING FLOW IMAGE CONCURRENCY POOL TESTS')
  console.log('==================================================\n')

  // 1. Sliding Window Concurrency with mapWithConcurrency
  await it('1. mapWithConcurrency enforces max concurrency = 6 sliding window without chunk stall', async () => {
    let currentActive = 0
    let maxObservedActive = 0
    const startTimes: number[] = []

    const items = Array.from({ length: 18 }, (_, i) => i + 1)
    const results = await mapWithConcurrency(items, 6, async (item) => {
      currentActive++
      if (currentActive > maxObservedActive) {
        maxObservedActive = currentActive
      }
      startTimes.push(Date.now())

      // Item 2 finishes quickly, item 1 finishes slowly
      const delayMs = item === 1 ? 80 : 20
      await new Promise((resolve) => setTimeout(resolve, delayMs))

      currentActive--
      return item * 10
    })

    assert.strictEqual(maxObservedActive, 6, 'Max active workers must strictly equal 6')
    assert.strictEqual(currentActive, 0, 'All workers must finish cleanly')
    assert.strictEqual(results.length, 18)
    assert.strictEqual(results[0], 10)
    assert.strictEqual(results[17], 180)
  })

  // 2. Post-processing semaphore concurrency = 2
  await it('2. AsyncSemaphore enforces postProcessConcurrency = 2 strictly', async () => {
    const sem = new AsyncSemaphore(2)
    let activePostProcess = 0
    let maxPostProcess = 0

    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      await sem.acquire()
      try {
        activePostProcess++
        if (activePostProcess > maxPostProcess) {
          maxPostProcess = activePostProcess
        }
        await new Promise((resolve) => setTimeout(resolve, 15))
      } finally {
        activePostProcess--
        sem.release()
      }
    })

    await Promise.all(tasks.map((t) => t()))
    assert.strictEqual(maxPostProcess, 2, 'Max post process concurrency must strictly be 2')
    assert.strictEqual(activePostProcess, 0)
  })

  // 3. Mock GoogleFlowClient test with runFlowImagePool
  await it('3. runFlowImagePool enforces max 6 generation requests, count=1 per prompt, and falls back on error', async () => {
    const testDir = path.join(__dirname, '..', 'tmp-test-pool-run')
    const analysisDir = path.join(testDir, 'analysis')
    fs.mkdirSync(analysisDir, { recursive: true })

    let activeGenerations = 0
    let maxGenerations = 0
    const generatedCounts: number[] = []
    const receivedPrompts: string[] = []

    // Mock GoogleFlowClient
    const mockFlowClient: any = {
      generateImage: async (params: { prompt: string; count: number }) => {
        activeGenerations++
        if (activeGenerations > maxGenerations) {
          maxGenerations = activeGenerations
        }
        generatedCounts.push(params.count)
        receivedPrompts.push(params.prompt)

        // Wait so initial concurrent batch ramps up
        await new Promise((resolve) => setTimeout(resolve, 60))

        // Fail scene 4 intentionally to verify stock fallback isolation
        if (params.prompt.includes('scene_4')) {
          activeGenerations--
          throw new Error('Flow mock permanent generation failure')
        }

        activeGenerations--
        return {
          mediaId: `media-${params.prompt.slice(0, 10)}`,
          flowProjectId: 'proj-1'
        }
      },
      exportImage: async (params: { destinationPath: string }) => {
        const dest = params.destinationPath
        const destDir = path.dirname(dest)
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
        // 1920x1080 valid PNG header
        const pngHeader = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
          0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
          0x00, 0x00, 0x07, 0x80, 0x00, 0x00, 0x04, 0x38, // 1920 x 1080
          0x08, 0x02, 0x00, 0x00, 0x00
        ])
        fs.writeFileSync(dest, pngHeader)
        return {
          localPath: dest,
          width: 1920,
          height: 1080
        }
      }
    }

    // 10 AI scenes
    const scenePlans: VisualMixScenePlan[] = Array.from({ length: 10 }, (_, i) => ({
      sceneIndex: i + 1,
      narration: `Narration for scene_${i + 1}`,
      visualIntent: `Visual intent for scene_${i + 1}`,
      strategy: 'ai-still',
      imagePrompt: `Unique prompt for scene_${i + 1} with horizontal composition`,
      generationHash: `hash_scene_${i + 1}`
    }))

    const progressReports: string[] = []

    const poolResult = await runFlowImagePool({
      projectDir: testDir,
      profile: 'general',
      config: {
        mode: 'custom-mix',
        aiImageRatio: 1,
        stockFootageRatio: 0,
        width: 1920,
        height: 1080,
        motionEnabled: true,
        generationConcurrency: 6,
        postProcessConcurrency: 2
      },
      scenes: scenePlans,
      flowClient: mockFlowClient,
      onProgress: (p) => {
        progressReports.push(p.message)
      }
    })

    // Assertions
    assert.strictEqual(maxGenerations, 6, 'Active generation requests must never exceed 6')
    assert.ok(generatedCounts.every((c) => c === 1), 'Every request must specify count === 1')
    const uniquePrompts = new Set(receivedPrompts)
    assert.strictEqual(uniquePrompts.size, 10, 'All 10 unique scenes were requested')
    assert.strictEqual(receivedPrompts.length, 11, 'Scene 4 had 2 total attempts (initial + 1 retry per Section 46) before falling back')

    // Scene 4 failed and fell back to stock
    assert.strictEqual(poolResult.failedCount, 1)
    assert.strictEqual(poolResult.completedCount, 9)
    assert.strictEqual(poolResult.fallbackStockIndices.length, 1)
    assert.strictEqual(poolResult.fallbackStockIndices[0], 4)

    // Progress updates were emitted monotonically
    assert.ok(progressReports.length > 0)
    assert.ok(progressReports.some((m) => m.includes('complete')))

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  // 4. Manifest Concurrency & Atomic Writes (No Lost Updates)
  await it('4. Concurrent recordVisualAssetQueued prevents race conditions and preserves all records', async () => {
    const testDir = path.join(__dirname, '..', 'tmp-test-race-manifest')
    const analysisDir = path.join(testDir, 'analysis')
    fs.mkdirSync(analysisDir, { recursive: true })

    const totalRecords = 20
    const writes = Array.from({ length: totalRecords }, (_, i) => {
      const record: GeneratedVisualAssetRecord = {
        sceneIndex: i + 1,
        profile: 'general',
        strategy: 'ai-still',
        promptHash: `hash_${i + 1}`,
        prompt: `prompt_${i + 1}`,
        status: 'completed',
        mediaId: `media_${i + 1}`,
        outputPath: `assets/generated/general/S000${i + 1}_test.png`,
        width: 1920,
        height: 1080,
        generatedAt: new Date().toISOString()
      }
      return recordVisualAssetQueued(testDir, record)
    })

    await Promise.all(writes)

    const loaded = loadGeneratedAssetsManifest(testDir, 'general')
    assert.strictEqual(
      Object.keys(loaded.scenes).length,
      totalRecords,
      `Manifest must retain all ${totalRecords} completed scenes without lost updates`
    )

    for (let i = 1; i <= totalRecords; i++) {
      assert.ok(loaded.scenes[String(i)], `Scene ${i} must exist in manifest`)
      assert.strictEqual(loaded.scenes[String(i)].promptHash, `hash_${i}`)
    }

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  // 5. AbortSignal cleanly stops launching new tasks
  await it('5. AbortSignal stops launching remaining items immediately', async () => {
    const abortCtrl = new AbortController()
    let executedCount = 0

    const items = Array.from({ length: 15 }, (_, i) => i + 1)
    const task = mapWithConcurrency(
      items,
      3,
      async (item) => {
        executedCount++
        if (item === 2) {
          abortCtrl.abort()
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        return item
      },
      abortCtrl.signal
    )

    try {
      await task
    } catch {
      // Expected abort rejection
    }
    assert.ok(executedCount < 15, `Executed count ${executedCount} should be significantly less than 15`)
  })

  console.log(`\nFlow Image Concurrency Pool Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests()
