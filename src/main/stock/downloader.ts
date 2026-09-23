/**
 * Downloads a stock asset to disk and tracks it in stock-assets.json.
 */

import { join, extname } from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import type { StockAsset, StockSearchResult } from '../../../shared/types'
import { logger } from '../logger'

const ASSETS_MANIFEST = 'stock-assets.json'

// ─── Load / save manifest ─────────────────────────────────────────────────────

export function loadAssetsManifest(stockDir: string): StockAsset[] {
  const p = join(stockDir, ASSETS_MANIFEST)
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) as StockAsset[]
  } catch { /* fallback */ }
  return []
}

export function saveAssetsManifest(stockDir: string, assets: StockAsset[]): void {
  const p = join(stockDir, ASSETS_MANIFEST)
  fs.writeFileSync(p, JSON.stringify(assets, null, 2), 'utf-8')
}

// ─── HTTP download helper (stream to disk) ────────────────────────────────────

function downloadToFile(url: string, destPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const proto = parsed.protocol === 'https:' ? https : http

    const doRequest = (targetUrl: string, redirectCount = 0): void => {
      if (redirectCount > 5) { reject(new Error('Too many redirects')); return }

      proto.get(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location
          if (!location) { reject(new Error('Redirect without location')); return }
          doRequest(location, redirectCount + 1)
          return
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${targetUrl}`))
          return
        }

        const out = fs.createWriteStream(destPath)
        res.pipe(out)
        out.on('finish', () => {
          const stat = fs.statSync(destPath)
          resolve(stat.size)
        })
        out.on('error', reject)
        res.on('error', reject)
      }).on('error', reject)
    }

    doRequest(url)
  })
}

// ─── Extension helper ─────────────────────────────────────────────────────────

function guessExtension(url: string, mediaType: string): string {
  try {
    const pathname = new URL(url).pathname
    const ext = extname(pathname).toLowerCase()
    if (ext && ext.length > 1 && ext.length < 6) return ext
  } catch { /* ignore */ }
  return mediaType === 'video' ? '.mp4' : '.jpg'
}

// ─── Main download function ───────────────────────────────────────────────────

export async function downloadAsset(
  candidate: StockSearchResult,
  sceneIndex: number,
  searchQuery: string,
  stockDir: string,
  existingManifest: StockAsset[]
): Promise<StockAsset> {
  fs.mkdirSync(stockDir, { recursive: true })

  // Already downloaded?
  const existing = existingManifest.find(
    (a) => a.assetId === candidate.assetId && fs.existsSync(a.localPath)
  )
  if (existing) {
    logger.info(`[Downloader] Reusing cached asset ${candidate.assetId}`)
    return existing
  }

  const ext = guessExtension(candidate.downloadUrl, candidate.mediaType)
  const filename = `S${String(sceneIndex).padStart(3, '0')}_${candidate.provider}_${candidate.assetId}${ext}`
  const destPath = join(stockDir, filename)

  logger.info(`[Downloader] Downloading ${candidate.assetId} → ${filename}`)

  let fileSizeBytes: number | undefined
  try {
    fileSizeBytes = await downloadToFile(candidate.downloadUrl, destPath)
  } catch (err) {
    logger.error(`[Downloader] Failed to download ${candidate.assetId}: ${err}`)
    throw new Error(`Download failed for ${candidate.assetId}: ${err}`)
  }

  const asset: StockAsset = {
    assetId: candidate.assetId,
    provider: candidate.provider,
    mediaType: candidate.mediaType,
    localPath: destPath,
    thumbnailUrl: candidate.thumbnailUrl,
    downloadUrl: candidate.downloadUrl,
    creator: candidate.creator,
    licenseUrl: candidate.licenseUrl,
    searchQuery,
    downloadedAt: new Date().toISOString(),
    fileSizeBytes
  }

  logger.info(`[Downloader] Downloaded ${filename} (${Math.round((fileSizeBytes ?? 0) / 1024)} KB)`)
  return asset
}
