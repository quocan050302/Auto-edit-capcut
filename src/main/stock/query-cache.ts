/**
 * Disk-backed query cache for stock media search results.
 * Prevents duplicate API calls for identical queries within the same project run.
 */

import { join } from 'path'
import * as fs from 'fs'
import type { StockSearchResult } from '../../../shared/types'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface CacheEntry {
  results: StockSearchResult[]
  cachedAt: number
}

interface CacheFile {
  [normalizedQuery: string]: CacheEntry
}

export class QueryCache {
  private cachePath: string
  private data: CacheFile = {}
  private dirty = false

  constructor(cacheDir: string) {
    fs.mkdirSync(cacheDir, { recursive: true })
    this.cachePath = join(cacheDir, '.query-cache.json')
    this.load()
  }

  /** Normalize a query so "wood working", "Wood Working" and "woodworking" are similar keys */
  static normalize(query: string): string {
    return query
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9 ]/g, '')
  }

  private load(): void {
    try {
      if (fs.existsSync(this.cachePath)) {
        this.data = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8')) as CacheFile
      }
    } catch {
      this.data = {}
    }
  }

  save(): void {
    if (!this.dirty) return
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify(this.data, null, 2), 'utf-8')
      this.dirty = false
    } catch {
      // non-fatal
    }
  }

  get(query: string): StockSearchResult[] | null {
    const key = QueryCache.normalize(query)
    const entry = this.data[key]
    if (!entry) return null
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      delete this.data[key]
      this.dirty = true
      return null
    }
    return entry.results
  }

  set(query: string, results: StockSearchResult[]): void {
    const key = QueryCache.normalize(query)
    this.data[key] = { results, cachedAt: Date.now() }
    this.dirty = true
  }

  size(): number {
    return Object.keys(this.data).length
  }
}
