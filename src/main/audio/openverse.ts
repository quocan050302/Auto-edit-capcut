/**
 * Openverse API client — searches Creative Commons licensed audio tracks.
 * Uses Node.js https module (reliable inside Electron main process).
 * Docs: https://api.openverse.org/v1/
 *
 * No API key required for basic usage (rate-limited at 100 req/day per IP).
 * Registration gives 5000 req/day via client_credentials.
 */

import * as https from 'https'
import type { AudioSearchResult } from '../../../shared/types'
import { logger } from '../logger'

const OV_HOST = 'api.openverse.org'

interface OpenverseAudioItem {
  id: string
  title: string
  creator?: string
  creator_url?: string
  url: string
  thumbnail?: string
  duration?: number
  tags: Array<{ name: string }>
  license: string
  license_url?: string
  license_version?: string
  foreign_landing_url: string
  filetype?: string
}

interface OpenverseResponse {
  result_count: number
  results: OpenverseAudioItem[]
}

// ─── Core HTTPS helper (works inside Electron main process) ───────────────────

function httpsGet<T>(url: string, headers: Record<string, string>, timeoutMs = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (d: Buffer) => chunks.push(d))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`))
            return
          }
          try {
            resolve(JSON.parse(body) as T)
          } catch {
            reject(new Error(`JSON parse error: ${body.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Request timed out after ${timeoutMs}ms`))
    })
    req.on('error', (err) => reject(new Error(`Request error: ${err.message}`)))
    req.end()
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search Openverse for CC-licensed audio tracks.
 * Returns empty array (never throws) so callers can try fallback queries.
 */
export async function openverseSearchAudio(
  query: string,
  category?: 'music' | 'sound_effects',
  limit = 6,
  accessToken?: string
): Promise<AudioSearchResult[]> {
  const params: Record<string, string> = {
    q: query,
    page_size: String(Math.min(limit, 20)),
    license_type: 'commercial',
    mature: 'false'
  }
  if (category) params.category = category

  const qs = new URLSearchParams(params)
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'VideoFactory/1.0 (AI video editor)'
  }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  const url = `https://${OV_HOST}/v1/audio/?${qs.toString()}`
  logger.info(`[Openverse] ${category ?? 'any'} search: "${query}"`)

  let data: OpenverseResponse
  try {
    data = await httpsGet<OpenverseResponse>(url, headers, 12000)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`[Openverse] Search "${query}" failed: ${msg}`)
    return []
  }

  logger.info(`[Openverse] "${query}" → ${data.result_count ?? 0} results`)

  return (data.results ?? []).map((item): AudioSearchResult => ({
    assetId: item.id,
    provider: 'openverse',
    audioType: category === 'sound_effects' ? 'sfx' : 'music',
    title: item.title ?? 'Unknown',
    creator: item.creator ?? 'Unknown',
    creatorUrl: item.creator_url,
    downloadUrl: item.url,
    thumbnailUrl: item.thumbnail ?? '',
    durationSecs: item.duration ?? 0,
    tags: item.tags?.map((t) => t.name) ?? [],
    license: item.license,
    licenseUrl:
      item.license_url ??
      `https://creativecommons.org/licenses/${item.license}/${item.license_version ?? '4.0'}/`,
    pageUrl: item.foreign_landing_url,
    filetype: item.filetype ?? 'mp3',
    searchQuery: query
  }))
}

/**
 * Obtain a client-credentials access token for Openverse.
 * Only needed if you registered an application for higher rate limits.
 */
export async function getOpenverseToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  }).toString()

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: OV_HOST,
        path: '/v1/auth_tokens/token/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (d: Buffer) => chunks.push(d))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString()) as {
              access_token?: string
            }
            if (parsed.access_token) resolve(parsed.access_token)
            else reject(new Error('No access_token in response'))
          } catch {
            reject(new Error('Failed to parse token response'))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Auth timeout'))
    })
    req.write(body)
    req.end()
  })
}
