/**
 * Pixabay API provider
 * Docs: https://pixabay.com/api/docs/
 */

import type { StockSearchResult } from '../../../../shared/types'
import { logger } from '../../logger'

const PIXABAY_BASE = 'https://pixabay.com/api'

// ─── Rate-limit aware fetch ───────────────────────────────────────────────────

async function pixabayFetch(url: string, attempt = 0): Promise<Response> {
  const res = await fetch(url)

  if (res.status === 429 && attempt < 3) {
    const delay = Math.pow(2, attempt) * 4000
    logger.warn(`[Pixabay] 429 rate-limited — waiting ${delay / 1000}s (attempt ${attempt + 1}/3)`)
    await new Promise((r) => setTimeout(r, delay))
    return pixabayFetch(url, attempt + 1)
  }

  return res
}

// ─── Video search ─────────────────────────────────────────────────────────────

export async function pixabaySearchVideos(
  query: string,
  apiKey: string,
  perPage = 8,
  orientation: 'horizontal' | 'vertical' | 'all' = 'horizontal'
): Promise<StockSearchResult[]> {
  const url =
    `${PIXABAY_BASE}/videos/?` +
    `key=${apiKey}&q=${encodeURIComponent(query)}&per_page=${perPage}&video_type=all&orientation=${orientation}`

  let res: Response
  try {
    res = await pixabayFetch(url)
  } catch (err) {
    logger.error(`[Pixabay] Network error searching videos: ${err}`)
    return []
  }

  if (!res.ok) {
    logger.warn(`[Pixabay] Video search returned ${res.status} for query "${query}"`)
    return []
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

  const data = (await res.json()) as PixabayVideoResponse

  return (data.hits ?? []).map((v) => {
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
}

// ─── Photo search ─────────────────────────────────────────────────────────────

export async function pixabaySearchPhotos(
  query: string,
  apiKey: string,
  perPage = 8,
  orientation: 'horizontal' | 'vertical' | 'all' = 'horizontal'
): Promise<StockSearchResult[]> {
  const url =
    `${PIXABAY_BASE}/?` +
    `key=${apiKey}&q=${encodeURIComponent(query)}&per_page=${perPage}&image_type=photo&orientation=${orientation}`

  let res: Response
  try {
    res = await pixabayFetch(url)
  } catch (err) {
    logger.error(`[Pixabay] Network error searching photos: ${err}`)
    return []
  }

  if (!res.ok) {
    logger.warn(`[Pixabay] Photo search returned ${res.status} for query "${query}"`)
    return []
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

  const data = (await res.json()) as PixabayPhotoResponse

  return (data.hits ?? []).map((p) => ({
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
}
