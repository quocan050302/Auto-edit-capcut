/**
 * Pexels API provider
 * Docs: https://www.pexels.com/api/documentation/
 */

import type { StockSearchResult } from '../../../../shared/types'
import { logger } from '../../logger'

const PEXELS_BASE = 'https://api.pexels.com'

// ─── Rate-limit aware fetch ───────────────────────────────────────────────────

async function pexelsFetch(url: string, apiKey: string, attempt = 0): Promise<Response> {
  const res = await fetch(url, {
    headers: { Authorization: apiKey }
  })

  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? 5) || 5
    const delay = Math.max(retryAfter, Math.pow(2, attempt) * 3) * 1000
    logger.warn(`[Pexels] 429 rate-limited — waiting ${delay / 1000}s (attempt ${attempt + 1}/3)`)
    await new Promise((r) => setTimeout(r, delay))
    return pexelsFetch(url, apiKey, attempt + 1)
  }

  return res
}

// ─── Video search ─────────────────────────────────────────────────────────────

export async function pexelsSearchVideos(
  query: string,
  apiKey: string,
  perPage = 8,
  orientation: 'landscape' | 'portrait' | 'square' = 'landscape'
): Promise<StockSearchResult[]> {
  const url =
    `${PEXELS_BASE}/videos/search?` +
    `query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orientation}`

  let res: Response
  try {
    res = await pexelsFetch(url, apiKey)
  } catch (err) {
    logger.error(`[Pexels] Network error searching videos: ${err}`)
    return []
  }

  if (!res.ok) {
    logger.warn(`[Pexels] Video search returned ${res.status} for query "${query}"`)
    return []
  }

  interface PexelsVideoFile {
    quality: string
    file_type: string
    link: string
    width: number
    height: number
  }
  interface PexelsVideo {
    id: number
    url: string
    duration: number
    width: number
    height: number
    user: { name: string; url: string }
    image: string
    video_files: PexelsVideoFile[]
  }
  interface PexelsVideoResponse {
    videos: PexelsVideo[]
  }

  const data = (await res.json()) as PexelsVideoResponse

  return (data.videos ?? []).map((v) => {
    const files = (v.video_files ?? []).sort((a, b) => {
      const qualityOrder: Record<string, number> = { hd: 3, sd: 2, hls: 1 }
      return (qualityOrder[b.quality] ?? 0) - (qualityOrder[a.quality] ?? 0)
    })
    const best = files[0] ?? { link: '', width: v.width, height: v.height }

    return {
      assetId: `pexels_v_${v.id}`,
      provider: 'pexels' as const,
      mediaType: 'video' as const,
      title: `Pexels video ${v.id}`,
      tags: [],
      thumbnailUrl: v.image ?? '',
      previewUrl: v.image ?? '',
      downloadUrl: best.link,
      width: best.width ?? v.width,
      height: best.height ?? v.height,
      durationSecs: v.duration,
      creator: v.user?.name ?? 'Unknown',
      creatorUrl: v.user?.url,
      pageUrl: v.url
    } satisfies StockSearchResult
  })
}

// ─── Photo search ─────────────────────────────────────────────────────────────

export async function pexelsSearchPhotos(
  query: string,
  apiKey: string,
  perPage = 8,
  orientation: 'landscape' | 'portrait' | 'square' = 'landscape'
): Promise<StockSearchResult[]> {
  const url =
    `${PEXELS_BASE}/v1/search?` +
    `query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orientation}`

  let res: Response
  try {
    res = await pexelsFetch(url, apiKey)
  } catch (err) {
    logger.error(`[Pexels] Network error searching photos: ${err}`)
    return []
  }

  if (!res.ok) {
    logger.warn(`[Pexels] Photo search returned ${res.status} for query "${query}"`)
    return []
  }

  interface PexelsPhotoSrc {
    original: string
    large2x: string
    large: string
  }
  interface PexelsPhoto {
    id: number
    url: string
    width: number
    height: number
    photographer: string
    photographer_url: string
    src: PexelsPhotoSrc
    alt: string
  }
  interface PexelsPhotoResponse {
    photos: PexelsPhoto[]
  }

  const data = (await res.json()) as PexelsPhotoResponse

  return (data.photos ?? []).map((p) => ({
    assetId: `pexels_p_${p.id}`,
    provider: 'pexels' as const,
    mediaType: 'photo' as const,
    title: p.alt || `Pexels photo ${p.id}`,
    tags: [],
    thumbnailUrl: p.src?.large ?? p.src?.original ?? '',
    previewUrl: p.src?.large ?? '',
    downloadUrl: p.src?.original ?? p.src?.large2x ?? '',
    width: p.width,
    height: p.height,
    creator: p.photographer ?? 'Unknown',
    creatorUrl: p.photographer_url,
    pageUrl: p.url
  } satisfies StockSearchResult))
}
