/**
 * Pixabay API provider
 * Docs: https://pixabay.com/api/docs/
 * Upgraded with global rate-limit scheduler, 24h disk caching, in-flight dedup,
 * query sanitization, and API-key-redacted logging.
 */

import type { StockSearchResult } from '../../../../shared/types'
import { logger } from '../../logger'
import { sanitizeStockQuery } from '../query-sanitizer'
import {
  schedulePixabayRequest,
  buildPixabayCacheKey,
  getCachedPixabayResults,
  setCachedPixabayResults,
  executeWithInFlightDedup,
  isPixabayPaused,
  getPixabayPauseRemainingSecs
} from './pixabay-rate-limiter'

const PIXABAY_BASE = 'https://pixabay.com/api'

// ─── Video search ─────────────────────────────────────────────────────────────

export async function pixabaySearchVideos(
  query: string,
  apiKey: string,
  perPage = 8,
  orientation: 'horizontal' | 'vertical' | 'all' = 'horizontal'
): Promise<StockSearchResult[]> {
  const sanitized = sanitizeStockQuery(query)
  if (!sanitized || !apiKey) {
    return []
  }

  const cacheKey = buildPixabayCacheKey({
    mediaType: 'video',
    query: sanitized,
    orientation,
    perPage
  })

  // 1. Check 24-hour persistent cache
  const cached = getCachedPixabayResults(cacheKey)
  if (cached) {
    logger.info(`[Pixabay] Cache hit (video): query="${sanitized}" (${cached.length} results)`)
    return cached
  }

  // 2. In-flight request deduplication
  return executeWithInFlightDedup(cacheKey, async () => {
    // 3. Circuit breaker check: is provider currently paused?
    if (isPixabayPaused()) {
      const waitSecs = getPixabayPauseRemainingSecs()
      logger.info(
        `[Pixabay] Rate limit pause active (${waitSecs}s remaining). Skipping Pixabay video search for "${sanitized}".`
      )
      return []
    }

    const scheduled = await schedulePixabayRequest<StockSearchResult[]>(async (attemptInfo) => {
      logger.info(
        `[Pixabay] video search: query="${sanitized}" perPage=${perPage} orientation=${orientation} (request ${attemptInfo.requestNumber}/${attemptInfo.totalRequests})`
      )

      const url =
        `${PIXABAY_BASE}/videos/?` +
        `key=${apiKey}&q=${encodeURIComponent(sanitized)}&per_page=${perPage}&video_type=all&orientation=${orientation}`

      const response = await fetch(url)

      if (response.status === 429) {
        return { response, data: [] }
      }

      if (!response.ok) {
        logger.warn(`[Pixabay] Video search returned status ${response.status} for query "${sanitized}"`)
        return { response, data: [] }
      }

      interface PixabayVideoSize {
        url: string
        width: number
        height: number
        size: number
      }
      interface PixabayVideoHit {
        id: number
        pageURL: string
        duration: number
        picture_id: string
        tags: string
        user: string
        userImageURL: string
        videos: {
          large: PixabayVideoSize
          medium: PixabayVideoSize
          small: PixabayVideoSize
          tiny: PixabayVideoSize
        }
      }
      interface PixabayVideoResponse {
        hits: PixabayVideoHit[]
      }

      const rawJson = (await response.json()) as PixabayVideoResponse
      const items: StockSearchResult[] = (rawJson.hits ?? []).map((v) => {
        const best = v.videos?.large?.url
          ? v.videos.large
          : v.videos?.medium ?? v.videos?.small
        const thumb = `https://i.vimeocdn.com/video/${v.picture_id}_640x360.jpg`

        return {
          assetId: `pixabay_v_${v.id}`,
          provider: 'pixabay' as const,
          mediaType: 'video' as const,
          title: `Pixabay video ${v.id}`,
          tags: (v.tags ?? '').split(',').map((t: string) => t.trim()),
          thumbnailUrl: thumb,
          previewUrl: thumb,
          downloadUrl: best?.url ?? '',
          width: best?.width ?? 1920,
          height: best?.height ?? 1080,
          durationSecs: v.duration,
          creator: v.user ?? 'Unknown',
          pageUrl: v.pageURL
        } satisfies StockSearchResult
      })

      return { response, data: items }
    })

    const results = scheduled?.data ?? []
    if (results.length > 0 || (scheduled && scheduled.response.ok)) {
      setCachedPixabayResults(cacheKey, results)
    }

    return results
  })
}

// ─── Photo search ─────────────────────────────────────────────────────────────

export async function pixabaySearchPhotos(
  query: string,
  apiKey: string,
  perPage = 8,
  orientation: 'horizontal' | 'vertical' | 'all' = 'horizontal'
): Promise<StockSearchResult[]> {
  const sanitized = sanitizeStockQuery(query)
  if (!sanitized || !apiKey) {
    return []
  }

  const cacheKey = buildPixabayCacheKey({
    mediaType: 'photo',
    query: sanitized,
    orientation,
    perPage
  })

  // 1. Check 24-hour persistent cache
  const cached = getCachedPixabayResults(cacheKey)
  if (cached) {
    logger.info(`[Pixabay] Cache hit (photo): query="${sanitized}" (${cached.length} results)`)
    return cached
  }

  // 2. In-flight request deduplication
  return executeWithInFlightDedup(cacheKey, async () => {
    // 3. Circuit breaker check: is provider currently paused?
    if (isPixabayPaused()) {
      const waitSecs = getPixabayPauseRemainingSecs()
      logger.info(
        `[Pixabay] Rate limit pause active (${waitSecs}s remaining). Skipping Pixabay photo search for "${sanitized}".`
      )
      return []
    }

    const scheduled = await schedulePixabayRequest<StockSearchResult[]>(async (attemptInfo) => {
      logger.info(
        `[Pixabay] photo search: query="${sanitized}" perPage=${perPage} orientation=${orientation} (request ${attemptInfo.requestNumber}/${attemptInfo.totalRequests})`
      )

      const url =
        `${PIXABAY_BASE}/?` +
        `key=${apiKey}&q=${encodeURIComponent(sanitized)}&per_page=${perPage}&image_type=photo&orientation=${orientation}`

      const response = await fetch(url)

      if (response.status === 429) {
        return { response, data: [] }
      }

      if (!response.ok) {
        logger.warn(`[Pixabay] Photo search returned status ${response.status} for query "${sanitized}"`)
        return { response, data: [] }
      }

      interface PixabayPhotoHit {
        id: number
        pageURL: string
        webformatURL: string
        largeImageURL: string
        imageWidth: number
        imageHeight: number
        tags: string
        user: string
      }
      interface PixabayPhotoResponse {
        hits: PixabayPhotoHit[]
      }

      const rawJson = (await response.json()) as PixabayPhotoResponse
      const items: StockSearchResult[] = (rawJson.hits ?? []).map((p) => ({
        assetId: `pixabay_p_${p.id}`,
        provider: 'pixabay' as const,
        mediaType: 'photo' as const,
        title: `Pixabay photo ${p.id}`,
        tags: (p.tags ?? '').split(',').map((t: string) => t.trim()),
        thumbnailUrl: p.webformatURL ?? '',
        previewUrl: p.webformatURL ?? '',
        downloadUrl: p.largeImageURL ?? p.webformatURL ?? '',
        width: p.imageWidth ?? 1920,
        height: p.imageHeight ?? 1080,
        creator: p.user ?? 'Unknown',
        pageUrl: p.pageURL
      } satisfies StockSearchResult))

      return { response, data: items }
    })

    const results = scheduled?.data ?? []
    if (results.length > 0 || (scheduled && scheduled.response.ok)) {
      setCachedPixabayResults(cacheKey, results)
    }

    return results
  })
}
