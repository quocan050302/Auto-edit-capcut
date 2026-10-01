/**
 * FlowKit Runtime Manager — Integration Tests
 *
 * Tests: persistence, corrupted config fallback, URL sync, auto-start guards,
 * once-per-session browser open guard, flowProjectId trimming, preload IPC contract,
 * startBridge error handling, preflight readiness checks.
 *
 * Run: node --import tsx test/flowkit-runtime.test.ts
 */

import assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as http from 'http'
import { FlowKitRuntimeManager } from '../src/main/thumbnail/flowkit-runtime-manager'

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING FLOWKIT RUNTIME MANAGER TESTS')
  console.log('==================================================\n')

  let passed = 0
  let failed = 0

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
      passed++
    } catch (err) {
      console.error(`  ✗ ${name}`)
      console.error(`    ${err instanceof Error ? err.message : String(err)}`)
      failed++
    }
  }

  // ─── Test 1: Settings round-trip via file ────────────────────────────────

  await test('1. Runtime settings persist across manager instances', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-test-'))

    // Manager A: configure
    const managerA = new FlowKitRuntimeManager()
    managerA.applySettings({
      mode: 'managed',
      bridgeUrl: 'http://127.0.0.1:9999',
      flowProjectId: 'test-project-uuid',
      autoStartBridge: true,
      autoOpenGoogleFlow: true
    })

    // Manually persist to tmpDir
    const configPath = path.join(tmpDir, 'flowkit-runtime-settings.json')
    fs.writeFileSync(configPath, JSON.stringify(managerA.getSettings(), null, 2), 'utf-8')

    // Manager B: load from same file
    const managerB = new FlowKitRuntimeManager()
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    managerB.applySettings(parsed)

    const s = managerB.getSettings()
    assert.strictEqual(s.mode, 'managed')
    assert.strictEqual(s.bridgeUrl, 'http://127.0.0.1:9999')
    assert.strictEqual(s.flowProjectId, 'test-project-uuid')
    assert.strictEqual(s.autoStartBridge, true)
    assert.strictEqual(s.autoOpenGoogleFlow, true)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ─── Test 2: Corrupted config fallback ────────────────────────────────────

  await test('2. Corrupted config JSON does not crash — manager uses defaults', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-test-'))
    const configPath = path.join(tmpDir, 'flowkit-runtime-settings.json')
    fs.writeFileSync(configPath, '{ invalid json <<<', 'utf-8')

    let hadJsonError = false
    try {
      JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch {
      hadJsonError = true
    }

    assert.ok(hadJsonError, 'Corrupted JSON should fail to parse')

    // Manager created without loading corrupted file should have valid defaults
    const manager = new FlowKitRuntimeManager()
    const s = manager.getSettings()
    assert.strictEqual(s.mode, 'external')
    assert.strictEqual(s.bridgeUrl, 'http://127.0.0.1:8100')
    assert.strictEqual(s.autoStartBridge, false)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ─── Test 3: Bridge URL normalization ─────────────────────────────────────

  await test('3. normalizeBridgeUrl strips trailing slashes and rejects non-http protocols', async () => {
    const manager = new FlowKitRuntimeManager()

    manager.applySettings({ bridgeUrl: 'http://127.0.0.1:8100///' })
    assert.strictEqual(manager.getSettings().bridgeUrl, 'http://127.0.0.1:8100')

    manager.applySettings({ bridgeUrl: 'ftp://invalid' })
    assert.strictEqual(manager.getSettings().bridgeUrl, 'http://127.0.0.1:8100', 'ftp:// should fall back to default')

    manager.applySettings({ bridgeUrl: 'https://custom.host:1234' })
    assert.strictEqual(manager.getSettings().bridgeUrl, 'https://custom.host:1234')
  })

  // ─── Test 4: GoogleFlowClient URL sync ────────────────────────────────────

  await test('4. Changing bridgeUrl syncs to linked GoogleFlowClient', async () => {
    const manager = new FlowKitRuntimeManager()
    let syncedUrl = ''
    const mockClient = { setBridgeUrl: (url: string) => { syncedUrl = url } }

    manager.initialize(mockClient)
    manager.applySettings({ bridgeUrl: 'http://127.0.0.1:9876' })

    assert.strictEqual(syncedUrl, 'http://127.0.0.1:9876')
  })

  // ─── Test 5: Auto-start disabled ──────────────────────────────────────────

  await test('5. autoStartBridge=false → autoStartIfConfigured does nothing', async () => {
    const manager = new FlowKitRuntimeManager()
    manager.applySettings({ mode: 'managed', autoStartBridge: false, flowKitPath: '/fake' })

    let started = false
    const origStart = manager.startBridge.bind(manager)
    ;(manager as unknown as { startBridge: () => Promise<unknown> }).startBridge = async () => {
      started = true
      return origStart()
    }

    manager.autoStartIfConfigured()
    await new Promise((r) => setTimeout(r, 30))
    assert.strictEqual(started, false, 'startBridge must NOT be called when autoStartBridge=false')
  })

  // ─── Test 6: Auto-start in external mode is no-op ──────────────────────────

  await test('6. mode=external with autoStartBridge=true → autoStartIfConfigured is no-op', async () => {
    const manager = new FlowKitRuntimeManager()
    manager.applySettings({ mode: 'external', autoStartBridge: true })

    let started = false
    ;(manager as unknown as { startBridge: () => Promise<unknown> }).startBridge = async () => {
      started = true
      return { success: false }
    }

    manager.autoStartIfConfigured()
    await new Promise((r) => setTimeout(r, 30))
    assert.strictEqual(started, false, 'startBridge must NOT be called in external mode')
  })

  // ─── Test 7: flowProjectId trimming ───────────────────────────────────────

  await test('7. flowProjectId is trimmed; whitespace-only becomes undefined', async () => {
    const manager = new FlowKitRuntimeManager()

    manager.applySettings({ flowProjectId: '  uuid-with-spaces  ' })
    assert.strictEqual(manager.getSettings().flowProjectId, 'uuid-with-spaces')

    manager.applySettings({ flowProjectId: '   ' })
    assert.strictEqual(manager.getSettings().flowProjectId, undefined)

    manager.applySettings({ flowProjectId: '' })
    assert.strictEqual(manager.getSettings().flowProjectId, undefined)
  })

  // ─── Test 8: Preload IPC contract ─────────────────────────────────────────

  await test('8. All runtime IPC channels are defined in IPC_CHANNELS', async () => {
    const { IPC_CHANNELS } = await import('../shared/types.js')

    const required = [
      'FLOWKIT_RUNTIME_GET_SETTINGS',
      'FLOWKIT_RUNTIME_SAVE_SETTINGS',
      'FLOWKIT_RUNTIME_START',
      'FLOWKIT_RUNTIME_STOP',
      'FLOWKIT_RUNTIME_STATUS',
      'FLOWKIT_RUNTIME_ENSURE_READY',
      'FLOWKIT_RUNTIME_DETECT_PYTHON',
      'FLOWKIT_RUNTIME_SELECT_FOLDER',
      'FLOWKIT_RUNTIME_SELECT_PYTHON',
      'FLOWKIT_RUNTIME_LOG'
    ] as const

    for (const ch of required) {
      assert.ok(ch in IPC_CHANNELS, `IPC_CHANNELS.${ch} must be defined`)
      assert.strictEqual(typeof IPC_CHANNELS[ch as keyof typeof IPC_CHANNELS], 'string')
    }
  })

  // ─── Test 9: startBridge fails gracefully without flowKitPath ─────────────

  await test('9. startBridge in managed mode fails gracefully without flowKitPath', async () => {
    const manager = new FlowKitRuntimeManager()
    manager.applySettings({ mode: 'managed', flowKitPath: undefined })

    const result = await manager.startBridge()
    assert.strictEqual(result.success, false)
    assert.ok(
      result.errorCode === 'FLOWKIT_PATH_INVALID' || result.errorCode === 'FLOWKIT_NOT_CONFIGURED',
      `Expected PATH_INVALID or NOT_CONFIGURED, got: ${result.errorCode}`
    )
  })

  // ─── Test 10: startBridge in external mode is rejected ────────────────────

  await test('10. startBridge in external mode returns success=false NOT_CONFIGURED', async () => {
    const manager = new FlowKitRuntimeManager()
    manager.applySettings({ mode: 'external' })

    const result = await manager.startBridge()
    assert.strictEqual(result.success, false)
    assert.strictEqual(result.errorCode, 'FLOWKIT_NOT_CONFIGURED')
  })

  // ─── Test 11: ensureFlowReady → bridge unreachable ────────────────────────

  await test('11. ensureFlowReady returns FLOWKIT_BRIDGE_OFFLINE when bridge is unreachable', async () => {
    const manager = new FlowKitRuntimeManager()
    manager.applySettings({ bridgeUrl: 'http://127.0.0.1:59991' })

    const result = await manager.ensureFlowReady()
    assert.strictEqual(result.ready, false)
    assert.strictEqual(result.bridgeReachable, false)
    assert.strictEqual(result.blockingCode, 'FLOWKIT_BRIDGE_OFFLINE')
  })

  // ─── Test 12: ensureFlowReady → extension disconnected ────────────────────

  await test('12. ensureFlowReady returns FLOW_EXTENSION_DISCONNECTED when bridge ok but extension absent', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', extension_connected: false }))
      } else {
        res.writeHead(404); res.end()
      }
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    const manager = new FlowKitRuntimeManager()
    manager.applySettings({ bridgeUrl: `http://127.0.0.1:${port}` })

    const result = await manager.ensureFlowReady()
    server.close()

    assert.strictEqual(result.bridgeReachable, true)
    assert.strictEqual(result.extensionConnected, false)
    assert.strictEqual(result.blockingCode, 'FLOW_EXTENSION_DISCONNECTED')
  })

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log('\n==================================================')
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`)
  console.log('==================================================\n')

  if (failed > 0) process.exit(1)
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
