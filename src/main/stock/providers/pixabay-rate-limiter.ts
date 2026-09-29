/**
 * pixabay-rate-limiter.ts — Global Pixabay Request Scheduler, Cache, and Circuit Breaker.
 * Enforces concurrency=1, 850ms spacing, rate-limit header parsing, queue pause,
 * 24h response caching, and in-flight request deduplication.
 */

import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../logger'
import type { StockSearchResult } from '../../../../shared/types'
import { normalizeStockQueryKey } from '../query-sanitizer'

export interface PixabayRateLimitState {
  remaining: number | null
  limit: number | null
  resetAt: number | null
  pausedUntil: number
  consecutive429: number
}

export interface PixabayCacheEntry {
  createdAt: string
  expiresAt: string
  results: StockSearchResult[]
}

export type PixabayCacheStore = Record<string, PixabayCacheEntry>

const MIN_INTERVAL_MS = 850
const DEFAULT_429_WAIT_SECS = 60
const MAX_RETRIES_AFTER_RESET = 2
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const EMPTY_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour for empty results

// Global State (Singleton across process)
const state: PixabayRateLimitState = {
  remaining: null,
  limit: null,
  resetAt: null,
  pausedUntil: 0,
  consecutive429: 0
}

let lastRequestEndTime = 0
let queuePromise: Promise<unknown> = Promise.resolve()

// In-flight deduplication map: key -> Promise<StockSearchResult[]>
const inFlightRequests = new Map<string, Promise<StockSearchResult[]>>()

// Active project directory for cache file location
let activeProjectDir: string | null = null

export function setPixabayProjectDir(projectDir: string): void {
  activeProjectDir = projectDir
}

export function isPixabayPaused(): boolean {
  return Date.now() < state.pausedUntil
}

export function getPixabayPauseRemainingSecs(): number {
  const diff = state.pausedUntil - Date.now()
  return diff > 0 ? Math.ceil(diff / 1000) : 0
}

export function resetPixabayLimiterState(): void {
  state.remaining = null
  state.limit = null
  state.resetAt = null
  state.pausedUntil = 0
  state.consecutive429 = 0
  lastRequestEndTime = 0
  queuePromise = Promise.resolve()
  inFlightRequests.clear()
}

export function getPixabayState(): Readonly<PixabayRateLimitState> {
  return { ...state }
}

/**
 * Parses Pixabay rate limit headers defensively.
 */
export function parseRateLimitHeaders(headers: Headers): {
  retryAfterSecs: number | null
  limit: number | null
  remaining: number | null
  resetSecs: number | null
} {
  const retryAfterHeader = headers.get('retry-after')
  const limitHeader = headers.get('x-ratelimit-limit')
  const remainingHeader = headers.get('x-ratelimit-remaining')
  const resetHeader = headers.get('x-ratelimit-reset')

  let retryAfterSecs: number | null = null
  if (retryAfterHeader) {
    const val = parseFloat(retryAfterHeader)
    if (!isNaN(val) && val > 0) {
      retryAfterSecs = val
    }
  }

  let limit: number | null = null
  if (limitHeader) {
    const val = parseInt(limitHeader, 10)
    if (!isNaN(val) && val >= 0) limit = val
  }

  let remaining: number | null = null
  if (remainingHeader) {
    const val = parseInt(remainingHeader, 10)
    if (!isNaN(val) && val >= 0) remaining = val
  }

  let resetSecs: number | null = null
  if (resetHeader) {
    const val = parseFloat(resetHeader)
    if (!isNaN(val) && val > 0) {
      resetSecs = val
    }
  }

  return { retryAfterSecs, limit, remaining, resetSecs }
}

/**
 * Schedules an operation through the global single-concurrency queue.
 */
export function schedulePixabayRequest<T>(
  task: (attemptInfo: { requestNumber: number; totalRequests: number }) => Promise<T>
): Promise<T | null> {
  const run = async (): Promise<T | null> => {
    let attempt = 0
    const maxAttempts = 1 + MAX_RETRIES_AFTER_RESET

    while (attempt < maxAttempts) {
      attempt++

      // 1. Check if provider is currently paused
      if (Date.now() < state.pausedUntil) {
        const waitMs = state.pausedUntil - Date.now()
        logger.info(`[Pixabay] Provider paused due to rate limit - waiting ${(waitMs / 1000).toFixed(1)}s before request ${attempt}/${maxAttempts}`)
        await new Promise((r) => setTimeout(r, waitMs))
        logger.info(`[Pixabay] Provider resumed after rate-limit reset.`)
      }

      // 2. Enforce minimum interval (850ms spacing)
      const now = Date.now()
      const elapsedSinceLast = now - lastRequestEndTime
      if (elapsedSinceLast < MIN_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsedSinceLast))
      }

      try {
        const result = await task({ requestNumber: attempt, totalRequests: maxAttempts })
        lastRequestEndTime = Date.now()

        const anyResult = result as any
        const response: Response | undefined =
          anyResult?.response instanceof Response
            ? anyResult.response
            : anyResult instanceof Response
              ? anyResult
              : undefined

        if (response) {
          const parsedHeaders = parseRateLimitHeaders(response.headers)
          state.remaining = parsedHeaders.remaining
          state.limit = parsedHeaders.limit

          if (response.status === 429) {
            state.consecutive429++

            // Calculate wait duration: Retry-After -> X-RateLimit-Reset -> 60s
            let waitSecs = DEFAULT_429_WAIT_SECS
            if (parsedHeaders.retryAfterSecs && parsedHeaders.retryAfterSecs > 0) {
              waitSecs = parsedHeaders.retryAfterSecs
            } else if (parsedHeaders.resetSecs && parsedHeaders.resetSecs > 0) {
              waitSecs = parsedHeaders.resetSecs
            }

            // Add jitter 250..1500ms
            const jitterMs = Math.floor(Math.random() * 1250) + 250
            const totalWaitMs = Math.round(waitSecs * 1000) + jitterMs
            state.pausedUntil = Date.now() + totalWaitMs

            logger.warn(
              `[Pixabay] Rate limit reached (status 429, request ${attempt}/${maxAttempts}). Pausing provider for ${(totalWaitMs / 1000).toFixed(1)}s.`
            )

            if (attempt >= maxAttempts) {
              logger.warn(`[Pixabay] Rate limit persisted. Skipping Pixabay for this scene.`)
              return null
            }

            // Loop will pause on next iteration at check #1
            continue
          }
        }

        // Success
        state.consecutive429 = 0
        return result
      } catch (err: unknown) {
        lastRequestEndTime = Date.now()
        logger.error(`[Pixabay] Request execution error: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    }

    return null
  }

  // Queue execution
  const nextPromise = queuePromise.then(run, run)
  queuePromise = nextPromise
  return nextPromise
}

// ─── 24h Response Cache Management ──────────────────────────────────────────

function getCacheFilePath(): string | null {
  if (activeProjectDir) {
    const stockDir = path.join(activeProjectDir, 'assets', 'stock')
    return path.join(stockDir, '.pixabay-search-cache.json')
  }
  return path.join(process.cwd(), '.pixabay-search-cache.json')
}

export function loadPixabayCache(): PixabayCacheStore {
  const filePath = getCacheFilePath()
  if (!filePath || !fs.existsSync(filePath)) {
    return {}
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim()
    if (!raw) return {}
    return JSON.parse(raw) as PixabayCacheStore
  } catch {
    return {}
  }
}

export function savePixabayCache(store: PixabayCacheStore): void {
  const filePath = getCacheFilePath()
  if (!filePath) return

  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const tmpPath = `${filePath}.tmp.${Date.now()}`
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8')

    try {
      fs.renameSync(tmpPath, filePath)
    } catch {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
      fs.renameSync(tmpPath, filePath)
    }
  } catch (err) {
    logger.warn(`[PixabayCache] Failed to persist cache: ${String(err)}`)
  }
}

export function buildPixabayCacheKey(params: {
  mediaType: 'video' | 'photo'
  query: string
  orientation: string
  perPage: number
}): string {
  const normQ = normalizeStockQueryKey(params.query)
  return `${params.mediaType}:${params.orientation}:${params.perPage}:${normQ}`
}

export function makePixabayCacheKey(
  mediaType: 'video' | 'photo',
  query: string,
  orientation: string,
  perPage: number
): string {
  return buildPixabayCacheKey({ mediaType, query, orientation, perPage })
}

export function redactApiKeyFromUrl(url: string): string {
  return url.replace(/key=[^&]+/gi, 'key=[REDACTED]')
}

export function writePixabayCache(key: string, results: StockSearchResult[], projectDir?: string): void {
  if (projectDir) activeProjectDir = projectDir
  setCachedPixabayResults(key, results)
}

export function readPixabayCache(key: string, projectDir?: string): StockSearchResult[] | null {
  if (projectDir) activeProjectDir = projectDir
  return getCachedPixabayResults(key)
}

export function isCacheValid(entry: PixabayCacheEntry): boolean {
  if (!entry || !entry.expiresAt) return false
  return new Date(entry.expiresAt).getTime() > Date.now()
}

export function getCachedPixabayResults(key: string): StockSearchResult[] | null {
  const store = loadPixabayCache()
  const entry = store[key]
  if (!entry) return null

  const now = new Date().toISOString()
  if (entry.expiresAt && entry.expiresAt < now) {
    delete store[key]
    savePixabayCache(store)
    return null
  }

  return entry.results
}

export function setCachedPixabayResults(key: string, results: StockSearchResult[]): void {
  const store = loadPixabayCache()
  const now = Date.now()
  const ttl = results.length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS

  store[key] = {
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    results
  }

  savePixabayCache(store)
}

// ─── In-Flight Deduplication ────────────────────────────────────────────────

export function executeWithInFlightDedup(
  arg1: string,
  arg2: any,
  arg3?: any,
  arg4?: any,
  arg5?: any
): Promise<StockSearchResult[]> {
  let key: string
  let fetcher: () => Promise<StockSearchResult[]>

  if (typeof arg2 === 'function') {
    key = arg1
    fetcher = arg2
  } else {
    key = buildPixabayCacheKey({
      mediaType: arg1 as 'video' | 'photo',
      query: arg2,
      orientation: arg3,
      perPage: arg4
    })
    fetcher = arg5
  }

  const existing = inFlightRequests.get(key)
  if (existing) {
    return existing
  }

  const promise = (async () => {
    try {
      return await fetcher()
    } finally {
      inFlightRequests.delete(key)
    }
  })()

  inFlightRequests.set(key, promise)
  return promise
}
