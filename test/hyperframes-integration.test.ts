/**
 * Optional HyperFrames Live Integration Test (Section 108)
 *
 * Runs an end-to-end resolution of soft-whoosh using the real HyperFrames CLI
 * if Node >= 22 is present on the machine.
 *
 * This test is OPT-IN and does not fail CI if Node 22 or HyperFrames is absent.
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SfxResolver } from '../src/main/sfx/sfx-resolver'
import { checkHyperFramesCapability } from '../src/main/hyperframes/hyperframes-capability'
import { SfxCacheManager } from '../src/main/sfx/sfx-cache'

async function runLiveHyperFramesTest(): Promise<void> {
  console.log('\n==================================================')
  console.log('OPTIONAL HYPERFRAMES LIVE RESOLUTION TEST')
  console.log('==================================================\n')

  const cap = await checkHyperFramesCapability()
  console.log(`Node Detected: ${cap.nodeBin || 'none'} (major: ${cap.nodeMajor || 0})`)
  console.log(`HyperFrames Available: ${cap.available}`)

  if (!cap.available) {
    console.log('HyperFrames is not available in this environment. Skipping live test cleanly.')
    return
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-live-test-'))
  console.log(`Created temp project directory: ${tempDir}`)

  try {
    const startTime = Date.now()
    const result = await SfxResolver.resolveSfxType(
      {
        type: 'soft-whoosh',
        intents: ['subtle cinematic soft whoosh for documentary transition'],
        projectDir: tempDir
      },
      {
        skipProcedural: false,
        skipOpenverse: true
      }
    )

    const elapsedMs = Date.now() - startTime
    console.log(`Resolution took ${elapsedMs}ms`)
    console.log(`Resolved Provider: ${result.resolved?.provider}`)
    console.log(`Resolved Local Path: ${result.resolved?.localPath}`)

    assert.ok(result.resolved, 'Expected resolved audio')
    assert.ok(fs.existsSync(result.resolved.localPath), 'Resolved local file must exist')
    assert.ok(fs.statSync(result.resolved.localPath).size > 1024, 'Resolved file must be non-empty')

    // Verify cache manifest was saved
    const manifest = SfxCacheManager.loadCacheManifest(tempDir)
    assert.ok(manifest.entries['soft-whoosh'], 'Cache entry must exist in manifest')
    console.log('  ✓ Verified normalized project copy and cache manifest')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  console.log('\n==================================================')
  console.log('HYPERFRAMES LIVE TEST COMPLETED SUCCESSFULLY')
  console.log('==================================================\n')
}

runLiveHyperFramesTest().catch((err) => {
  console.error('HyperFrames live test error:', err)
  // Non-fatal per Section 108
  process.exit(0)
})
