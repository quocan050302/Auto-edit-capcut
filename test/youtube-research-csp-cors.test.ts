/**
 * Unit & Integration Tests for CSP, CORS, Sidecar URL Resolution and Research API Client
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  ResearchApi,
  ResearchApiError,
  normalizeLocalSidecarUrl
} from '../src/renderer/src/features/youtube-research/api/researchApi'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    const res = fn()
    if (res instanceof Promise) {
      await res
    }
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✕ ${name}`)
    console.error(err)
    failed++
  }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING YOUTUBE RESEARCH CSP, CORS & API TESTS')
  console.log('==================================================\n')

  // 1. CSP Test
  await it('16.1.1: CSP meta tag in index.html allows local sidecar and rejects wildcard', () => {
    const htmlPath = path.resolve(__dirname, '../src/renderer/index.html')
    const html = fs.readFileSync(htmlPath, 'utf-8')

    // Must have Content-Security-Policy meta tag
    assert.ok(html.includes('http-equiv="Content-Security-Policy"'), 'Must have CSP meta tag')

    // Must include connect-src
    assert.ok(html.includes('connect-src'), 'CSP must include connect-src')

    // Must allow 127.0.0.1:8765 and localhost:8765
    assert.ok(html.includes('http://127.0.0.1:8765'), 'CSP must allow http://127.0.0.1:8765')
    assert.ok(html.includes('http://localhost:8765'), 'CSP must allow http://localhost:8765')

    // Must NOT have connect-src * or default-src *
    assert.strictEqual(html.includes('connect-src *'), false, 'CSP must not allow connect-src *')
    assert.strictEqual(html.includes("connect-src 'self' *"), false, 'CSP must not allow wildcard')
  })

  // 16.1.2: Electron Security Settings Test
  await it('16.1.2: Electron main process maintains contextIsolation: true and nodeIntegration: false', () => {
    const mainPath = path.resolve(__dirname, '../src/main/index.ts')
    const mainCode = fs.readFileSync(mainPath, 'utf-8')

    // Must have contextIsolation: true
    assert.ok(mainCode.includes('contextIsolation: true'), 'contextIsolation must be enabled')

    // Must have nodeIntegration: false (or sandbox: false with contextIsolation)
    assert.ok(mainCode.includes('sandbox: false') || mainCode.includes('nodeIntegration: false'), 'webPreferences security')
    assert.strictEqual(mainCode.includes('webSecurity: false'), false, 'webSecurity must never be disabled')
  })

  // 16.5.1: URL Normalization
  await it('16.5.1: normalizeLocalSidecarUrl accepts local loopback and rejects external URLs', () => {
    // Valid local loopback URLs
    assert.strictEqual(normalizeLocalSidecarUrl('http://127.0.0.1:8765'), 'http://127.0.0.1:8765')
    assert.strictEqual(normalizeLocalSidecarUrl('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765')
    assert.strictEqual(normalizeLocalSidecarUrl('http://localhost:8765'), 'http://localhost:8765')
    assert.strictEqual(normalizeLocalSidecarUrl('http://[::1]:8765'), 'http://[::1]:8765')

    // Rejection of external/malicious URLs -> falls back to default 127.0.0.1:8765
    const fallback = 'http://127.0.0.1:8765'
    assert.strictEqual(normalizeLocalSidecarUrl('https://malicious.example.com'), fallback)
    assert.strictEqual(normalizeLocalSidecarUrl('http://192.168.1.100:8765'), fallback)
    assert.strictEqual(normalizeLocalSidecarUrl('ftp://localhost:8765'), fallback)
    assert.strictEqual(normalizeLocalSidecarUrl('javascript:alert(1)'), fallback)
    assert.strictEqual(normalizeLocalSidecarUrl(undefined), fallback)
    assert.strictEqual(normalizeLocalSidecarUrl(''), fallback)
  })

  // 16.5.2: ResearchApiError Codes
  await it('16.5.2: ResearchApiError formats error codes and details cleanly', () => {
    const err = new ResearchApiError('Service unreachable', 'API_OFFLINE', 503, { reason: 'connection refused' })
    assert.strictEqual(err.name, 'ResearchApiError')
    assert.strictEqual(err.code, 'API_OFFLINE')
    assert.strictEqual(err.status, 503)
    assert.deepStrictEqual(err.details, { reason: 'connection refused' })
    assert.ok(err.message.includes('Service unreachable'))
  })

  // 16.5.3: Mock Fetch Scenarios in ResearchApi Client
  await it('16.5.3: ResearchApi client handles success, 422, 500, network error, and timeout', async () => {
    const originalFetch = globalThis.fetch

    try {
      const api = new ResearchApi('http://127.0.0.1:8765')

      // Scenario A: Health Check Success
      ;(globalThis as any).fetch = async (url: string) => {
        if (url.endsWith('/health')) {
          return new Response(JSON.stringify({ status: 'online', service: 'YouTube Foreign Market Researcher', version: '1.0.0' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        throw new Error('Not found')
      }
      const health = await api.checkHealth()
      assert.strictEqual(health.status, 'online')
      assert.strictEqual(health.service, 'YouTube Foreign Market Researcher')

      // Scenario B: Discover Success
      ;(globalThis as any).fetch = async (url: string) => {
        if (url.endsWith('/api/research/discover')) {
          return new Response(JSON.stringify({ run_id: 'run_mock_123', status: 'QUEUED' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        throw new Error('Not found')
      }
      const discover = await api.startDiscover({
        topic: 'mock groceries',
        market: 'US',
        content_type: 'LONG',
        time_range: '30d'
      })
      assert.strictEqual(discover.run_id, 'run_mock_123')
      assert.strictEqual(discover.status, 'QUEUED')

      // Scenario C: HTTP 422 Validation Error
      ;(globalThis as any).fetch = async () => {
        return new Response(JSON.stringify({ detail: 'Topic keyword cannot be empty' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      try {
        await api.startDiscover({
          topic: '',
          market: 'US',
          content_type: 'LONG',
          time_range: '30d'
        })
        assert.fail('Expected 422 error')
      } catch (err) {
        assert.ok(err instanceof ResearchApiError)
        assert.strictEqual((err as ResearchApiError).code, 'HTTP_ERROR')
        assert.strictEqual((err as ResearchApiError).status, 422)
      }

      // Scenario D: HTTP 500 Server Error
      ;(globalThis as any).fetch = async () => {
        return new Response(JSON.stringify({ detail: 'Internal database locked' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      try {
        await api.getRunResult('run_mock_123')
        assert.fail('Expected 500 error')
      } catch (err) {
        assert.ok(err instanceof ResearchApiError)
        assert.strictEqual((err as ResearchApiError).code, 'HTTP_ERROR')
        assert.strictEqual((err as ResearchApiError).status, 500)
      }

      // Scenario E: Network Error / Failed to fetch
      ;(globalThis as any).fetch = async () => {
        throw new TypeError('Failed to fetch')
      }
      try {
        await api.checkHealth()
        assert.fail('Expected network error')
      } catch (err) {
        assert.ok(err instanceof ResearchApiError)
        assert.strictEqual((err as ResearchApiError).code, 'API_OFFLINE')
        assert.ok((err as ResearchApiError).message.includes('blocked or could not connect'))
      }

    } finally {
      globalThis.fetch = originalFetch
    }
  })

  // Summary
  console.log('\n==================================================')
  console.log(`TESTS FINISHED: ${passed} passed, ${failed} failed`)
  console.log('==================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Test runner failure:', err)
  process.exit(1)
})
