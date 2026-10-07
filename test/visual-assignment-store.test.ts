/**
 * Automated Tests for VisualAssignmentStore
 * Tests compliance with Sections 27, 28, 29, 64 (concurrency safety, atomic writes, AI protection).
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { VisualAssignmentStore } from '../src/main/visual-mix/visual-assignment-store'
import { StockSceneAssignment } from '../shared/types'

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

function createTempProjectDir(): string {
  const dir = path.join(os.tmpdir(), `vam_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true })
  return dir
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING VISUAL ASSIGNMENT STORE TESTS')
  console.log('==================================================\n')

  it('1. Basic Store operations: set, get, getAll, delete, and flushAtomic to disk', async () => {
    const projectDir = createTempProjectDir()
    const store = new VisualAssignmentStore(projectDir)

    const assignment1: StockSceneAssignment = {
      sceneId: 'scene_1',
      sceneIndex: 1,
      narrationText: 'Scene 1 narration',
      startTime: 0,
      endTime: 5,
      visualIntent: 'Intent 1',
      searchQueries: ['query 1'],
      usedQuery: 'query 1',
      score: 90,
      locked: false,
      manualOverride: false,
      status: 'assigned',
      asset: {
        assetId: 'flow_123',
        provider: 'google-flow',
        mediaType: 'photo',
        localPath: path.join(projectDir, 'scene_1.png'),
        thumbnailUrl: '',
        downloadUrl: '',
        creator: 'Flow',
        searchQuery: 'prompt',
        downloadedAt: new Date().toISOString(),
        fileSizeBytes: 1024
      }
    }

    store.set(1, assignment1)
    assert.strictEqual(store.get(1)?.asset?.provider, 'google-flow')
    assert.strictEqual(store.getAll().length, 1)

    await store.flushAtomic()

    // Verify written to disk at analysis/stock-assignments.json
    const diskPath = path.join(projectDir, 'analysis', 'stock-assignments.json')
    assert.ok(fs.existsSync(diskPath), 'File must exist on disk')

    const diskData: StockSceneAssignment[] = JSON.parse(fs.readFileSync(diskPath, 'utf-8'))
    assert.strictEqual(diskData.length, 1)
    assert.strictEqual(diskData[0].sceneIndex, 1)
    assert.strictEqual(diskData[0].asset?.provider, 'google-flow')

    // Clean up
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('2. Protection against stock overwriting valid Google Flow assignments (Section 29)', async () => {
    const projectDir = createTempProjectDir()
    const store = new VisualAssignmentStore(projectDir)

    // Mock existing generated image file
    const localImgPath = path.join(projectDir, 'scene_3.png')
    fs.writeFileSync(localImgPath, 'fake image data')

    const aiAssignment: StockSceneAssignment = {
      sceneId: 'scene_3',
      sceneIndex: 3,
      narrationText: 'Scene 3 medical narration',
      startTime: 10,
      endTime: 15,
      visualIntent: 'Heart anatomy',
      searchQueries: [],
      usedQuery: 'AI Medical Still',
      score: 95,
      locked: true,
      manualOverride: false,
      status: 'assigned',
      asset: {
        assetId: 'flow_heart',
        provider: 'google-flow',
        mediaType: 'photo',
        localPath: localImgPath,
        thumbnailUrl: '',
        downloadUrl: '',
        creator: 'Google Flow AI',
        searchQuery: 'heart anatomy',
        downloadedAt: new Date().toISOString(),
        fileSizeBytes: 5000
      }
    }

    store.set(3, aiAssignment)
    await store.flushAtomic()

    // Attempt to overwrite with a stock assignment
    const stockAttempt: StockSceneAssignment = {
      sceneId: 'scene_3',
      sceneIndex: 3,
      narrationText: 'Scene 3 medical narration',
      startTime: 10,
      endTime: 15,
      visualIntent: 'Heart anatomy',
      searchQueries: ['heart'],
      usedQuery: 'heart',
      score: 80,
      locked: false,
      manualOverride: false,
      status: 'assigned',
      asset: {
        assetId: 'pexels_12345',
        provider: 'pexels',
        mediaType: 'video',
        localPath: '/tmp/video.mp4',
        thumbnailUrl: '',
        downloadUrl: '',
        creator: 'Pexels Creator',
        searchQuery: 'heart',
        downloadedAt: new Date().toISOString(),
        fileSizeBytes: 20000
      }
    }

    // store.set should reject or preserve the valid Google Flow assignment
    store.set(3, stockAttempt)
    const current = store.get(3)
    assert.strictEqual(
      current?.asset?.provider,
      'google-flow',
      'Valid Google Flow assignment must be protected from stock overwrite'
    )

    // Clean up
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('3. Assignment Concurrency Test (Section 64): concurrent writes do not lose assignments', async () => {
    const projectDir = createTempProjectDir()
    const store = new VisualAssignmentStore(projectDir)

    // Concurrently write 50 AI assignments and 50 stock assignments
    const promises: Array<Promise<void>> = []

    for (let i = 1; i <= 50; i++) {
      promises.push((async () => {
        store.set(i, {
          sceneId: `scene_${i}`,
          sceneIndex: i,
          narrationText: `AI scene ${i}`,
          startTime: (i - 1) * 5,
          endTime: i * 5,
          visualIntent: 'AI Still',
          searchQueries: [],
          usedQuery: 'AI Still',
          score: 95,
          locked: false,
          manualOverride: false,
          status: 'assigned',
          asset: {
            assetId: `flow_${i}`,
            provider: 'google-flow',
            mediaType: 'photo',
            localPath: `/fake/path/${i}.png`,
            thumbnailUrl: '',
            downloadUrl: '',
            creator: 'Google Flow',
            searchQuery: 'prompt',
            downloadedAt: new Date().toISOString(),
            fileSizeBytes: 1000
          }
        })
        await store.flushAtomic()
      })())
    }

    for (let i = 51; i <= 100; i++) {
      promises.push((async () => {
        store.set(i, {
          sceneId: `scene_${i}`,
          sceneIndex: i,
          narrationText: `Stock scene ${i}`,
          startTime: (i - 1) * 5,
          endTime: i * 5,
          visualIntent: 'Stock',
          searchQueries: [],
          usedQuery: 'stock',
          score: 85,
          locked: false,
          manualOverride: false,
          status: 'assigned',
          asset: {
            assetId: `pexels_${i}`,
            provider: 'pexels',
            mediaType: 'video',
            localPath: `/fake/path/${i}.mp4`,
            thumbnailUrl: '',
            downloadUrl: '',
            creator: 'Pexels',
            searchQuery: 'footage',
            downloadedAt: new Date().toISOString(),
            fileSizeBytes: 5000
          }
        })
        await store.flushAtomic()
      })())
    }

    await Promise.all(promises)
    await store.flushAtomic()

    // Assert total assignment count is exactly 100 (no lost writes)
    const diskPath = path.join(projectDir, 'analysis', 'stock-assignments.json')
    const diskData: StockSceneAssignment[] = JSON.parse(fs.readFileSync(diskPath, 'utf-8'))
    assert.strictEqual(diskData.length, 100, 'Total assignments on disk must be exactly 100')
    assert.strictEqual(store.getAll().length, 100, 'Total in-memory assignments must be 100')

    // Clean up
    fs.rmSync(projectDir, { recursive: true, force: true })
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
