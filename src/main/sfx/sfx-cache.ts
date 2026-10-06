import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import type { HealthSfxType } from '../../shared/types'
import type {
  HealthSfxCacheEntry,
  HealthSfxCacheManifest,
  ResolvedSfx,
  SfxProvider
} from './sfx-types'

export class SfxCacheManager {
  public static getCachePath(projectDir: string): string {
    return path.join(projectDir, 'analysis', 'health-sfx-cache.json')
  }

  public static getAudioDir(projectDir: string): string {
    return path.join(projectDir, 'assets', 'audio', 'health-sfx')
  }

  /**
   * Loads the cache manifest with full backward compatibility for schema v1.
   * If entries lack provider/metadata fields from earlier versions, they still load cleanly.
   */
  public static loadCacheManifest(projectDir: string): HealthSfxCacheManifest {
    const p = this.getCachePath(projectDir)
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
        return {
          schemaVersion: raw.schemaVersion || 1,
          updatedAt: raw.updatedAt || new Date().toISOString(),
          entries: raw.entries || {}
        }
      } catch (err) {
        logger.warn(`[SfxCache] Corrupted cache at ${p}, recreating: ${err}`)
      }
    }
    return {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      entries: {}
    }
  }

  /**
   * Atomically saves cache manifest using a temporary file.
   */
  public static saveCacheManifest(projectDir: string, manifest: HealthSfxCacheManifest): void {
    const p = this.getCachePath(projectDir)
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    manifest.updatedAt = new Date().toISOString()
    const tmp = `${p}.tmp.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8')
    fs.renameSync(tmp, p)
  }

  /**
   * Retrieves a cached SFX if the file exists and is valid.
   * Cleans up broken cache entries on miss.
   */
  public static getCachedSfx(projectDir: string, type: HealthSfxType): ResolvedSfx | null {
    if (type === 'none') return null

    const manifest = this.loadCacheManifest(projectDir)
    const entry = manifest.entries[type]
    if (!entry) return null

    // Validate that the local file actually exists and is non-empty
    if (!entry.localPath || !fs.existsSync(entry.localPath)) {
      logger.debug(`[SfxCache] Missing file for cached type=${type} at ${entry.localPath}`)
      delete manifest.entries[type]
      this.saveCacheManifest(projectDir, manifest)
      return null
    }

    try {
      const stat = fs.statSync(entry.localPath)
      if (stat.size < 512) {
        logger.debug(`[SfxCache] Cached file too small (${stat.size} bytes) for type=${type}`)
        delete manifest.entries[type]
        this.saveCacheManifest(projectDir, manifest)
        return null
      }
    } catch {
      return null
    }

    // Determine provider — legacy entries without provider default to 'openverse' or 'cache'
    const provider: SfxProvider = entry.provider || (entry.generated ? 'procedural' : 'openverse')

    return {
      type,
      provider: 'cache',
      localPath: entry.localPath,
      durationSecs: entry.durationSecs || 1.0,
      sourceId: entry.assetId,
      sourceLabel: entry.sourceLabel || `Cached (${provider})`,
      creator: entry.creator || (provider === 'procedural' ? 'Local Procedural SFX' : 'Cached SFX'),
      license: entry.license || 'Project Cache',
      sourceUrl: entry.pageUrl || entry.sourceUrl,
      generated: entry.generated ?? (provider === 'procedural')
    }
  }

  /**
   * Stores a successfully resolved SFX into the project cache manifest.
   */
  public static recordCachedSfx(projectDir: string, resolved: ResolvedSfx): void {
    const manifest = this.loadCacheManifest(projectDir)
    const entry: HealthSfxCacheEntry = {
      assetId: resolved.sourceId || `${resolved.provider}-${resolved.type}`,
      sfxType: resolved.type,
      query: resolved.type,
      localPath: resolved.localPath,
      license: resolved.license || 'Internal Asset',
      creator: resolved.creator || resolved.sourceLabel || 'SFX Engine',
      pageUrl: resolved.sourceUrl || '',
      downloadedAt: new Date().toISOString(),
      provider: resolved.provider,
      sourceLabel: resolved.sourceLabel,
      sourceUrl: resolved.sourceUrl,
      durationSecs: resolved.durationSecs,
      generated: resolved.generated
    }

    manifest.entries[resolved.type] = entry
    this.saveCacheManifest(projectDir, manifest)
    logger.debug(`[SfxCache] Saved cache entry for type=${resolved.type} provider=${resolved.provider}`)
  }
}
