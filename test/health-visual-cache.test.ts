/**
 * Automated Unit Tests for Health Visual Cache & Quality Gate
 * (src/main/health/health-visual-cache.ts)
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  computeHealthGenerationHash,
  computeHealthConfigHash,
  loadHealthGeneratedManifest,
  saveHealthGeneratedManifest,
  getCachedHealthAsset,
  recordHealthAsset
} from '../src/main/health/health-visual-cache'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

/**
 * Creates a minimal valid PNG buffer with specified width and height
 */
function createMockPngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32)
  // PNG signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // IHDR chunk length (13)
  buf.writeUInt32BE(13, 8)
  // IHDR type
  buf.write('IHDR', 12, 'ascii')
  // Width & height
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING HEALTH VISUAL CACHE UNIT TESTS')
  console.log('==================================================\n')

  const testDir = path.join(os.tmpdir(), `health-cache-test-${Date.now()}`)
  fs.mkdirSync(path.join(testDir, 'analysis'), { recursive: true })
  fs.mkdirSync(path.join(testDir, 'assets', 'generated', 'health'), { recursive: true })

  // Cleanup after test
  const cleanup = (): void => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  try {
    // 1. Hash computation
    await it('Computes stable deterministic hashes for prompts and configs', () => {
      const hash1 = computeHealthGenerationHash(1, 'Liver filtration', 'Liver 3D', 'prompt A')
      const hash2 = computeHealthGenerationHash(1, 'Liver filtration', 'Liver 3D', 'prompt A')
      const hash3 = computeHealthGenerationHash(1, 'Liver filtration', 'Liver 3D', 'prompt B')

      assert.strictEqual(hash1, hash2)
      assert.notStrictEqual(hash1, hash3)
      assert.strictEqual(typeof hash1, 'string')
      assert.strictEqual(hash1.length, 64)

      const cfgHash = computeHealthConfigHash({ aiRatio: 0.8 })
      assert.strictEqual(typeof cfgHash, 'string')
    })

    // TEST 9: Completed generated image cache is reused
    await it('TEST 9: Completed generated image cache is reused when file exists and matches hash', () => {
      const hash = computeHealthGenerationHash(1, 'Stomach digestion', 'Stomach', 'Prompt 1')
      const imagePath = path.join(testDir, 'assets', 'generated', 'health', 'S0001_test.png')
      fs.writeFileSync(imagePath, createMockPngBuffer(1920, 1080))

      recordHealthAsset(testDir, {
        sceneIndex: 1,
        strategy: 'ai-still',
        promptHash: hash,
        prompt: 'Prompt 1',
        status: 'completed',
        outputPath: imagePath,
        width: 1920,
        height: 1080,
        motionPreset: 'slow-push-in',
        generatedAt: new Date().toISOString()
      })

      const cached = getCachedHealthAsset(testDir, 1, hash)
      assert.ok(cached !== null)
      assert.strictEqual(cached?.status, 'completed')
      assert.strictEqual(cached?.outputPath, imagePath)
      assert.strictEqual(cached?.width, 1920)
    })

    // TEST 10: Missing cached file regenerates
    await it('TEST 10: Missing cached file returns null to trigger regeneration', () => {
      const hash = computeHealthGenerationHash(2, 'Kidney filter', 'Kidney', 'Prompt 2')
      const nonExistentPath = path.join(testDir, 'assets', 'generated', 'health', 'S0002_missing.png')

      recordHealthAsset(testDir, {
        sceneIndex: 2,
        strategy: 'ai-still',
        promptHash: hash,
        prompt: 'Prompt 2',
        status: 'completed',
        outputPath: nonExistentPath,
        width: 1920,
        height: 1080,
        motionPreset: 'slow-push-in',
        generatedAt: new Date().toISOString()
      })

      const cached = getCachedHealthAsset(testDir, 2, hash)
      assert.strictEqual(cached, null)
    })

    // TEST 11: Hash change invalidates only affected Health visual
    await it('TEST 11: Hash change invalidates only the modified scene', () => {
      const oldHash = computeHealthGenerationHash(3, 'Heart pumping', 'Heart', 'Old Prompt')
      const newHash = computeHealthGenerationHash(3, 'Heart pumping', 'Heart', 'New Prompt Modified')

      const imagePath = path.join(testDir, 'assets', 'generated', 'health', 'S0003_test.png')
      fs.writeFileSync(imagePath, createMockPngBuffer(1920, 1080))

      recordHealthAsset(testDir, {
        sceneIndex: 3,
        strategy: 'ai-still',
        promptHash: oldHash,
        prompt: 'Old Prompt',
        status: 'completed',
        outputPath: imagePath,
        width: 1920,
        height: 1080,
        motionPreset: 'slow-push-in',
        generatedAt: new Date().toISOString()
      })

      // Querying with new hash returns null (invalidated)
      const cachedNew = getCachedHealthAsset(testDir, 3, newHash)
      assert.strictEqual(cachedNew, null)

      // Querying scene 1 still returns cached asset (unaffected)
      const scene1Hash = computeHealthGenerationHash(1, 'Stomach digestion', 'Stomach', 'Prompt 1')
      const cached1 = getCachedHealthAsset(testDir, 1, scene1Hash)
      assert.ok(cached1 !== null)
    })

    // TEST 13: Generated asset < 1920×1080 does not pass premium quality gate
    await it('TEST 13: Generated asset < 1920x1080 (e.g. 1376x768) is rejected by quality gate', () => {
      const hash = computeHealthGenerationHash(4, 'Brain scan', 'Brain', 'Prompt 4')
      const lowResImagePath = path.join(testDir, 'assets', 'generated', 'health', 'S0004_lowres.png')
      // Write low-res PNG (1376x768)
      fs.writeFileSync(lowResImagePath, createMockPngBuffer(1376, 768))

      recordHealthAsset(testDir, {
        sceneIndex: 4,
        strategy: 'ai-still',
        promptHash: hash,
        prompt: 'Prompt 4',
        status: 'completed',
        outputPath: lowResImagePath,
        width: 1376,
        height: 768,
        motionPreset: 'slow-push-in',
        generatedAt: new Date().toISOString()
      })

      const cached = getCachedHealthAsset(testDir, 4, hash)
      assert.strictEqual(cached, null)
    })

    // TEST 18: Manifest persistence & crash recovery
    await it('TEST 18: Manifest persists atomically to survive crash & restart', () => {
      const manifest = loadHealthGeneratedManifest(testDir)
      assert.ok(manifest.scenes['1'] !== undefined)
      assert.strictEqual(manifest.scenes['1'].status, 'completed')

      saveHealthGeneratedManifest(testDir, manifest)
      const reloaded = loadHealthGeneratedManifest(testDir)
      assert.strictEqual(reloaded.scenes['1'].promptHash, manifest.scenes['1'].promptHash)
    })
  } finally {
    cleanup()
  }

  console.log(`\nCache Tests: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch((e) => {
  console.error(e)
  process.exit(1)
})
