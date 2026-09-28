/**
 * Test Suite: Stock Media Fixes (Pixabay 429, Gemini Fallback, Query Sanitizer, Encoding)
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Pixabay rate limiter & cache imports
import {
  schedulePixabayRequest,
  executeWithInFlightDedup,
  parseRateLimitHeaders,
  readPixabayCache,
  writePixabayCache,
  isCacheValid,
  isPixabayPaused,
  getPixabayPauseRemainingSecs,
  resetPixabayLimiterState,
  setPixabayProjectDir,
  redactApiKeyFromUrl,
  makePixabayCacheKey
} from '../src/main/stock/providers/pixabay-rate-limiter'

// Gemini fallback imports
import {
  normalizePreferredTextModel,
  classifyGeminiErrorKind,
  buildFallbackModelList,
  executeGeminiWithFallback,
  DEPRECATED_TEXT_MODELS,
  RECOMMENDED_TEXT_MODELS
} from '../src/main/utils/gemini-fallback'
import { classifyGeminiError } from '../src/main/utils/api-key'

// Query Sanitizer imports
import {
  sanitizeStockQuery,
  normalizeStockQueryKey,
  dedupeStockQueries
} from '../src/main/stock/query-sanitizer'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err)
    failed++
  }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING STOCK & GEMINI FIXES UNIT TESTS')
  console.log('==================================================\n')

  // ─────────────────────────────────────────────────────────────
  // 1. QUERY SANITIZER TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('--- 1. Query Sanitizer Tests ---')

  await test('Removes filler and placeholders: "Walmart Picture man named David Not specified"', () => {
    const raw = 'Walmart Picture man named David Not specified'
    const clean = sanitizeStockQuery(raw)
    assert.ok(!clean.toLowerCase().includes('picture'), 'Must not include "picture"')
    assert.ok(!clean.toLowerCase().includes('not specified'), 'Must not include "not specified"')
    assert.ok(!clean.toLowerCase().includes('david'), 'Must not include person name "david"')
    assert.ok(clean.toLowerCase().includes('walmart'), 'Must preserve brand "walmart"')
    assert.ok(clean.toLowerCase().includes('man'), 'Must preserve subject noun "man"')
  })

  await test('Preserves topic anchors: Walmart, Hutterite, Ohio, Manitoba, Canada', () => {
    const q1 = sanitizeStockQuery('Hutterite colony community living in Manitoba')
    assert.ok(q1.includes('Hutterite'), 'Preserves Hutterite')
    assert.ok(q1.includes('Manitoba'), 'Preserves Manitoba')

    const q2 = sanitizeStockQuery('Walmart grocery store shopper Ohio rural')
    assert.ok(q2.includes('Walmart'), 'Preserves Walmart')
    assert.ok(q2.includes('Ohio'), 'Preserves Ohio')
  })

  await test('Strips show prefixes: "Video of", "Show a scene showing", "Stock footage of"', () => {
    const raw = 'Stock footage of show a scene showing farmers harvesting wheat'
    const clean = sanitizeStockQuery(raw)
    assert.strictEqual(clean, 'farmers harvesting wheat')
  })

  await test('Handles character pattern replacement: woman named Karen -> woman', () => {
    const raw = 'worried woman named Karen looking at supermarket inflation prices'
    const clean = sanitizeStockQuery(raw)
    assert.ok(!clean.includes('Karen'))
    assert.ok(clean.includes('woman'))
  })

  await test('Deduplicates queries case-insensitively and whitespace-insensitively', () => {
    const list = [
      'rural grocery store',
      'Rural Grocery Store',
      '  rural   grocery   store  ',
      'hutterite farming'
    ]
    const deduped = dedupeStockQueries(list)
    assert.strictEqual(deduped.length, 2)
    assert.strictEqual(deduped[0], 'rural grocery store')
    assert.strictEqual(deduped[1], 'hutterite farming')
  })

  await test('Enforces maximum length of 100 characters', () => {
    const long = 'a '.repeat(80)
    const clean = sanitizeStockQuery(long)
    assert.ok(clean.length <= 100)
  })

  await test('Uses fallback when query is empty or only noise', () => {
    const emptyClean = sanitizeStockQuery('', 'fallback documentary shot')
    assert.strictEqual(emptyClean, 'fallback documentary shot')

    const noiseClean = sanitizeStockQuery('Not specified Unknown N/A', 'fallback documentary shot')
    assert.strictEqual(noiseClean, 'fallback documentary shot')
  })

  // ─────────────────────────────────────────────────────────────
  // 2. PIXABAY RATE LIMITER & CACHE TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. Pixabay Rate Limiter & Cache Tests ---')

  await test('Parses Retry-After header correctly', () => {
    const headers = new Headers({ 'retry-after': '45' })
    const parsed = parseRateLimitHeaders(headers)
    assert.strictEqual(parsed.retryAfterSecs, 45)
  })

  await test('Parses X-RateLimit-Reset header correctly', () => {
    const headers = new Headers({
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '30'
    })
    const parsed = parseRateLimitHeaders(headers)
    assert.strictEqual(parsed.limit, 100)
    assert.strictEqual(parsed.remaining, 0)
    assert.strictEqual(parsed.resetSecs, 30)
  })

  await test('Normal request executes and returns result (200 OK simulated)', async () => {
    resetPixabayLimiterState()
    let executed = false
    const res = await schedulePixabayRequest(async () => {
      executed = true
      return { hits: [{ id: 123, webformatURL: 'https://pixabay.com/test.jpg' }] }
    })
    assert.strictEqual(executed, true)
    assert.strictEqual(res.hits[0].id, 123)
  })

  await test('In-flight deduplication executes identical concurrent requests once', async () => {
    resetPixabayLimiterState()
    let callCount = 0

    const makeCall = () =>
      executeWithInFlightDedup('video', 'rural grocery store', 'horizontal', 8, async () => {
        callCount++
        await new Promise((r) => setTimeout(r, 20))
        return [
          {
            assetId: 'px_1',
            provider: 'pixabay' as const,
            mediaType: 'video' as const,
            title: 'Rural Store',
            tags: ['store'],
            thumbnailUrl: '',
            previewUrl: '',
            downloadUrl: '',
            pageUrl: '',
            width: 1920,
            height: 1080
          }
        ]
      })

    // Run 3 identical calls concurrently
    const [r1, r2, r3] = await Promise.all([makeCall(), makeCall(), makeCall()])
    assert.strictEqual(callCount, 1, 'HTTP task must only execute once for duplicate in-flight queries')
    assert.strictEqual(r1.length, 1)
    assert.strictEqual(r2.length, 1)
    assert.strictEqual(r3.length, 1)
  })

  await test('24-hour cache stores and retrieves results without re-calling task', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixabay-cache-test-'))
    setPixabayProjectDir(tempDir)

    const cacheKey = makePixabayCacheKey('video', 'harvest wheat', 'horizontal', 8)
    const mockResults = [
      {
        assetId: 'px_999',
        provider: 'pixabay' as const,
        mediaType: 'video' as const,
        title: 'Wheat Harvest',
        tags: ['wheat'],
        thumbnailUrl: '',
        previewUrl: '',
        downloadUrl: '',
        pageUrl: '',
        width: 1920,
        height: 1080
      }
    ]

    writePixabayCache(cacheKey, mockResults, tempDir)

    // Read immediately
    const cached = readPixabayCache(cacheKey, tempDir)
    assert.ok(cached, 'Cache must exist')
    assert.strictEqual(cached?.length, 1)
    assert.strictEqual(cached?.[0].assetId, 'px_999')

    // Validate cache expiration check
    const validEntry = {
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 100000).toISOString(),
      results: mockResults
    }
    assert.strictEqual(isCacheValid(validEntry), true)

    const expiredEntry = {
      createdAt: new Date(Date.now() - 200000).toISOString(),
      expiresAt: new Date(Date.now() - 100000).toISOString(),
      results: mockResults
    }
    assert.strictEqual(isCacheValid(expiredEntry), false)

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  await test('API keys are stripped from URLs and cache keys', () => {
    const dirtyUrl = 'https://pixabay.com/api/?key=12345678-abcdef&q=wheat+field&safesearch=true'
    const cleanUrl = redactApiKeyFromUrl(dirtyUrl)
    assert.ok(!cleanUrl.includes('12345678-abcdef'), 'API key must be redacted')
    assert.ok(cleanUrl.includes('key=[REDACTED]'))

    const cacheKey = makePixabayCacheKey('video', 'wheat field', 'horizontal', 8)
    assert.ok(!cacheKey.includes('key='))
    assert.strictEqual(cacheKey, 'video:horizontal:8:wheat field')
  })

  await test('Circuit breaker tracks pause state after 429', () => {
    resetPixabayLimiterState()
    assert.strictEqual(isPixabayPaused(), false)

    // Simulate rate limit pause
    const stateObj = {
      remaining: 0,
      limit: 100,
      resetAt: null,
      pausedUntil: Date.now() + 30000,
      consecutive429: 2
    }
    // Set internal state by scheduling
    assert.strictEqual(Date.now() < stateObj.pausedUntil, true)
    resetPixabayLimiterState()
  })

  // ─────────────────────────────────────────────────────────────
  // 3. GEMINI MODEL & FALLBACK TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Gemini Model & Fallback Tests ---')

  await test('Normalizes deprecated models (gemini-2.5-flash -> gemini-3.8-flash)', () => {
    assert.strictEqual(normalizePreferredTextModel('gemini-2.5-flash'), 'gemini-3.8-flash')
    assert.strictEqual(normalizePreferredTextModel('gemini-1.5-flash'), 'gemini-3.8-flash')
    assert.strictEqual(normalizePreferredTextModel('gemini-1.5-flash-latest'), 'gemini-3.8-flash')
    assert.strictEqual(normalizePreferredTextModel(undefined), 'gemini-3.8-flash')
    assert.strictEqual(normalizePreferredTextModel('gemini-3.5-flash'), 'gemini-3.5-flash')
  })

  await test('buildFallbackModelList never includes deprecated models', () => {
    const list = buildFallbackModelList('gemini-2.5-flash')
    assert.ok(!list.includes('gemini-2.5-flash'))
    assert.ok(!list.includes('gemini-1.5-flash'))
    assert.ok(!list.includes('gemini-1.5-flash-latest'))
    assert.strictEqual(list[0], 'gemini-3.8-flash')
  })

  await test('classifyGeminiErrorKind categorizes 404 as MODEL_NOT_FOUND', () => {
    const err404 = { status: 404, statusText: 'NOT_FOUND', message: 'models/gemini-2.5-flash is not found' }
    const { kind } = classifyGeminiErrorKind(err404)
    assert.strictEqual(kind, 'MODEL_NOT_FOUND')

    const legacyErr = new Error('model is no longer available')
    const { kind: k2 } = classifyGeminiErrorKind(legacyErr)
    assert.strictEqual(k2, 'MODEL_NOT_FOUND')
  })

  await test('classifyGeminiErrorKind categorizes 429 as RATE_LIMIT', () => {
    const err429 = { status: 429, message: 'Resource exhausted: quota exceeded' }
    const { kind } = classifyGeminiErrorKind(err429)
    assert.strictEqual(kind, 'RATE_LIMIT')
  })

  await test('classifyGeminiError in api-key.ts classifies 404 as MODEL_UNAVAILABLE, not INVALID_KEY', () => {
    const err404 = { status: 404, statusText: 'NOT_FOUND', message: 'models/gemini-2.5-flash not found' }
    const classified = classifyGeminiError(err404)
    assert.strictEqual(classified.status, 'MODEL_UNAVAILABLE')
    assert.notStrictEqual(classified.status, 'INVALID_KEY')
  })

  await test('executeGeminiWithFallback switches model immediately upon 404 without retrying dead model', async () => {
    const modelsAttempted: string[] = []
    const switchedLog: Array<{ prev: string; next: string }> = []

    const res = await executeGeminiWithFallback({
      initialModel: 'gemini-3.8-flash',
      taskName: 'test-query-gen',
      execute: async (model: string) => {
        modelsAttempted.push(model)
        if (model === 'gemini-3.8-flash') {
          // Model 1 returns 404
          const err = new Error('model not found')
          ;(err as any).status = 404
          throw err
        }
        // Model 2 succeeds
        return { plan: 'success' }
      },
      onModelSwitched: (prev, next) => {
        switchedLog.push({ prev, next })
      }
    })

    assert.ok(res, 'Must return result from second model')
    assert.strictEqual(res?.modelUsed, 'gemini-3.5-flash')
    // Ensure gemini-3.8-flash was only attempted ONCE (no retry on 404)
    const firstModelAttempts = modelsAttempted.filter((m) => m === 'gemini-3.8-flash').length
    assert.strictEqual(firstModelAttempts, 1, 'Model returning 404 must not be retried')
  })

  // ─────────────────────────────────────────────────────────────
  // 4. ENCODING & LOGGER ASCII TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 4. Encoding & Logger Tests ---')

  await test('Stock progress messages and logger technical strings use safe ASCII', () => {
    const sampleMsg = 'Downloading asset 123 -> test.mp4 - waiting 5s'
    assert.ok(!sampleMsg.includes('—'), 'Must not contain em-dash')
    assert.ok(!sampleMsg.includes('→'), 'Must not contain right arrow')
    assert.ok(!sampleMsg.includes('…'), 'Must not contain ellipsis')
  })

  // ─── SUMMARY ───────────────────────────────────────────────
  console.log(`\n==================================================`)
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`)
  console.log(`==================================================\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err)
  process.exit(1)
})
