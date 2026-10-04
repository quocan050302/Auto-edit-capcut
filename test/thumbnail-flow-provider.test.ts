/**
 * Unit Test Suite for:
 * Google Flow Provider & Client (src/main/thumbnail/google-flow-client.ts)
 * Uses a lightweight Node HTTP mock server.
 */

import * as assert from 'assert'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { GoogleFlowClient } from '../src/main/thumbnail/google-flow-client'

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

// 1x1 valid PNG binary buffer
const MOCK_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING GOOGLE FLOW CONNECTOR UNIT TESTS')
  console.log('==================================================\n')

  let server: http.Server | null = null
  let serverPort = 8123
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = () => {}

  const startMockServer = (): Promise<number> => {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => handler(req, res))
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as { port: number }
        serverPort = addr.port
        resolve(serverPort)
      })
    })
  }

  const stopMockServer = (): Promise<void> => {
    return new Promise((resolve) => {
      if (server) {
        server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  const port = await startMockServer()
  const mockBaseUrl = `http://127.0.0.1:${port}`
  const client = new GoogleFlowClient(mockBaseUrl)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-test-'))

  await it('1. Health check returns healthy when extension and credits are ready', async () => {
    handler = (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', version: '1.3.1', extension_connected: true }))
      } else if (req.url === '/api/flow/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ connected: true, flow_project_id: 'proj-123' }))
      } else if (req.url === '/api/providers/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify([{ name: 'flow', available: true, capabilities: { generate_image: true } }]))
      } else if (req.url === '/api/flow/credits') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 200, data: { userPaygateTier: 'PAYGATE_TIER_ONE' } }))
      } else {
        res.writeHead(404)
        res.end()
      }
    }

    const health = await client.checkHealth()
    assert.strictEqual(health.reachable, true)
    assert.strictEqual(health.extensionConnected, true)
    assert.strictEqual(health.signedIn, true)
    assert.strictEqual(health.supportsImageGeneration, true)
    assert.strictEqual(health.requestedExportQuality, '4k')
  })

  await it('2. Health check reports unreachable when server is offline', async () => {
    const deadClient = new GoogleFlowClient('http://127.0.0.1:59999')
    const health = await deadClient.checkHealth()
    assert.strictEqual(health.reachable, false)
    assert.ok(health.message?.includes('unreachable'))
  })

  await it('3. Health check detects extension disconnected', async () => {
    handler = (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', extension_connected: false }))
      } else if (req.url === '/api/flow/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ connected: false }))
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Extension not connected' }))
      }
    }

    const health = await client.checkHealth()
    assert.strictEqual(health.reachable, true)
    assert.strictEqual(health.extensionConnected, false)
    assert.ok(health.message?.includes('disconnected'))
  })

  await it('4. Successfully generates an image and extracts mediaId', async () => {
    handler = (req, res) => {
      if (req.url === '/api/flow/generate-image') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            media: [
              {
                name: 'media-uuid-12345',
                image: {
                  generatedImage: {
                    mediaId: 'media-uuid-12345',
                    fifeUrl: 'https://images.google.com/sample.jpg'
                  }
                }
              }
            ],
            project_id: 'flow-proj-abc'
          })
        )
      }
    }

    const result = await client.generateImage({
      prompt: 'American grocery store aisle with shoppers',
      candidateId: 'cand-1',
      optionId: 'A'
    })

    assert.strictEqual(result.mediaId, 'media-uuid-12345')
    assert.strictEqual(result.projectId, 'flow-proj-abc')
    assert.strictEqual(result.fifeUrl, 'https://images.google.com/sample.jpg')
  })

  await it('5. Client throws FLOW_RATE_LIMITED on 429 (orchestrator owns retry, not client)', async () => {
    let callCount = 0
    handler = (req, res) => {
      if (req.url === '/api/flow/generate-image') {
        callCount++
        res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Rate limited by Google Flow' }))
      }
    }

    let errorCode = ''
    try {
      await client.generateImage({
        prompt: 'Pantry canned goods',
        candidateId: 'cand-2',
        optionId: 'B'
      })
      assert.fail('Should have thrown on 429')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      errorCode = msg.startsWith('FLOW_RATE_LIMITED') ? 'FLOW_RATE_LIMITED' : msg
    }

    // Client makes exactly ONE request and throws — orchestrator handles retry
    assert.strictEqual(callCount, 1, 'Client should make exactly 1 request (no internal retry)')
    assert.strictEqual(errorCode, 'FLOW_RATE_LIMITED', 'Should throw FLOW_RATE_LIMITED for orchestrator to handle')
  })

  await it('6. Fails immediately without infinite retry on 400 invalid argument', async () => {
    let callCount = 0
    handler = (req, res) => {
      if (req.url === '/api/flow/generate-image') {
        callCount++
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid argument: diacritics without language hint' }))
      }
    }

    let errorThrown = false
    try {
      await client.generateImage({
        prompt: 'Bad prompt',
        candidateId: 'cand-3',
        optionId: 'C'
      })
    } catch (e) {
      errorThrown = true
      assert.ok((e as Error).message.includes('FLOW_GENERATION_FAILED'))
      assert.ok((e as Error).message.includes('invalid argument'))
    }

    assert.ok(errorThrown, 'Must throw FLOW_GENERATION_FAILED')
    assert.strictEqual(callCount, 1, 'Should NOT retry 400 invalid argument')
  })

  await it('7. Exports 4K image and probe returns actual dimensions', async () => {
    const dest = path.join(tmpDir, 'test-4k.png')
    handler = (req, res) => {
      if (req.url === '/api/flow/export-image') {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'X-Flow-Image-Quality': '4k'
        })
        res.end(MOCK_PNG_BUFFER)
      }
    }

    const exportRes = await client.exportImage({
      mediaId: 'media-uuid-12345',
      quality: '4k',
      destinationPath: dest
    })

    assert.strictEqual(exportRes.actualQuality, 'native-4k')
    assert.strictEqual(exportRes.width, 1)
    assert.strictEqual(exportRes.height, 1)
    assert.ok(fs.existsSync(dest))
    assert.ok(fs.statSync(dest).size > 0)
  })

  await it('8. Falls back to 2K export if 4K is plan-gated', async () => {
    const dest = path.join(tmpDir, 'test-fallback-2k.png')
    let attempts: string[] = []

    handler = (req, res) => {
      if (req.url === '/api/flow/export-image') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const parsed = JSON.parse(body)
          attempts.push(parsed.quality)
          if (parsed.quality === '4k') {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: '4K upscale is plan-gated on your Flow tier' }))
          } else {
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'X-Flow-Image-Quality': '2k'
            })
            res.end(MOCK_PNG_BUFFER)
          }
        })
      }
    }

    const exportRes = await client.exportImage({
      mediaId: 'media-uuid-gated',
      quality: '4k',
      destinationPath: dest
    })

    assert.strictEqual(exportRes.actualQuality, '2k-fallback')
    assert.strictEqual(exportRes.is4kPlanGated, true)
    assert.deepStrictEqual(attempts, ['4k', '2k'])
  })

  // Cleanup
  await stopMockServer()
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n==================================================`)
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`)
  console.log(`==================================================\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
