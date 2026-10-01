import assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ThumbnailAutoTrigger } from '../src/main/thumbnail/thumbnail-auto-trigger'
import { saveProjectThumbnailSettings } from '../src/main/thumbnail/thumbnail-settings-manager'
import { loadThumbnailJobState } from '../src/main/thumbnail/thumbnail-state'

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING THUMBNAIL AUTO-TRIGGER UNIT TESTS')
  console.log('==================================================\n')

  let passed = 0
  let failed = 0

  function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      const res = fn()
      if (res instanceof Promise) {
        return res
          .then(() => {
            console.log(`  ✓ ${name}`)
            passed++
          })
          .catch((err) => {
            console.error(`  ✗ ${name}`)
            console.error(err)
            failed++
          })
      } else {
        console.log(`  ✓ ${name}`)
        passed++
        return Promise.resolve()
      }
    } catch (err) {
      console.error(`  ✗ ${name}`)
      console.error(err)
      failed++
      return Promise.resolve()
    }
  }

  function setupTestDir(prefix: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const scriptPath = path.join(dir, 'script.txt')
    fs.writeFileSync(scriptPath, 'Full script text content for video.')
    const renderPath = path.join(dir, 'output', 'final_video.mp4')
    fs.mkdirSync(path.dirname(renderPath), { recursive: true })
    fs.writeFileSync(renderPath, 'fake-mp4-data')
    return { dir, scriptPath, renderPath }
  }

  await test('1. Skips trigger when automation is disabled in project settings', async () => {
    const { dir, renderPath } = setupTestDir('trigger-test-1-')
    await saveProjectThumbnailSettings(dir, {
      enabled: false,
      autoGenerateAfterRender: false,
      variantCount: 5,
      outputLanguage: 'en-US',
      provider: 'google-flow',
      imageModel: 'GEM_PIX_2',
      outputQuality: '4k'
    })

    const trigger = new ThumbnailAutoTrigger()
    const triggered = await trigger.startIfEligible({
      projectDir: dir,
      renderOutputPath: renderPath
    })

    assert.strictEqual(triggered, false, 'Should not trigger when disabled')
    const state = loadThumbnailJobState(dir)
    assert.strictEqual(state, null, 'No job state should be created')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('2. Sets status to needs-attention without throwing when template is not selected', async () => {
    const { dir, renderPath } = setupTestDir('trigger-test-2-')
    await saveProjectThumbnailSettings(dir, {
      enabled: true,
      autoGenerateAfterRender: true,
      // No template selected!
      variantCount: 5,
      outputLanguage: 'en-US',
      provider: 'google-flow',
      imageModel: 'GEM_PIX_2',
      outputQuality: '4k'
    })

    const trigger = new ThumbnailAutoTrigger()
    const triggered = await trigger.startIfEligible({
      projectDir: dir,
      renderOutputPath: renderPath
    })

    assert.strictEqual(triggered, false)
    const state = loadThumbnailJobState(dir)
    assert.ok(state, 'Job state should be saved')
    assert.strictEqual(state.status, 'needs-attention')
    assert.ok(state.warnings.some((w) => w.includes('No master prompt template selected')))

    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('3. Prevents duplicate jobs for identical render output and template snapshot (idempotency)', async () => {
    const { dir, renderPath } = setupTestDir('trigger-test-3-')
    await saveProjectThumbnailSettings(dir, {
      enabled: true,
      autoGenerateAfterRender: true,
      selectedTemplateId: 'test-template',
      templateSnapshot: 'Snapshot with {{SCRIPT}}',
      templateSnapshotHash: 'hash-template-snap',
      variantCount: 5,
      outputLanguage: 'en-US',
      provider: 'google-flow',
      imageModel: 'GEM_PIX_2',
      outputQuality: '4k'
    })

    const trigger = new ThumbnailAutoTrigger()
    const firstCall = await trigger.startIfEligible({
      projectDir: dir,
      renderOutputPath: renderPath
    })
    assert.strictEqual(firstCall, true, 'First trigger should succeed')

    // Immediate second call with identical parameters (simulating double trigger from pipeline + IPC)
    const secondCall = await trigger.startIfEligible({
      projectDir: dir,
      renderOutputPath: renderPath
    })
    assert.strictEqual(secondCall, false, 'Second trigger with same key must be rejected by idempotency')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('4. Guaranteed non-blocking resilience: never throws error even with corrupt or missing inputs', async () => {
    const trigger = new ThumbnailAutoTrigger()
    // Intentionally pass nonexistent path
    const res = await trigger.startIfEligible({
      projectDir: 'Z:\\nonexistent\\invalid\\path\\that\\does\\not\\exist',
      renderOutputPath: 'Z:\\invalid.mp4'
    })
    assert.strictEqual(res, false, 'Should return false safely without throwing exception')
  })

  console.log('\n==================================================')
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`)
  console.log('==================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
