import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { probeImageFileDimensions } from '../thumbnail/utils/image-probe'
import type {
  GeneratedVisualAssetsManifest,
  GeneratedVisualAssetRecord,
  VisualMixProfile,
  VisualMixConfig
} from '../../../shared/types'
import { VISUAL_MIX_SCHEMA_VERSION } from './visual-mix-types'
import {
  loadHealthGeneratedManifest,
  saveHealthGeneratedManifest
} from '../health/health-visual-cache'

export function getGeneralManifestPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'generated-visual-assets.json')
}

export function computeGenerationHash(params: {
  sceneIndex: number
  narration: string
  visualIntent: string
  imagePrompt: string
  profile: VisualMixProfile
  width?: number
  height?: number
  imageModel?: string
}): string {
  const width = params.width ?? 1920
  const height = params.height ?? 1080
  const imageModel = params.imageModel ?? 'GEM_PIX_2'

  const payload = [
    String(params.sceneIndex),
    (params.narration || '').trim().toLowerCase(),
    (params.visualIntent || '').trim().toLowerCase(),
    (params.imagePrompt || '').trim(),
    `${width}x${height}`,
    imageModel,
    params.profile
  ].join('||')

  return crypto.createHash('sha256').update(payload).digest('hex')
}

/**
 * Serialized write queue for manifest saving across concurrent workers.
 * Prevents race conditions and lost updates.
 */
class ManifestWriteQueue {
  private queue = Promise.resolve()

  public enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        try {
          const res = await fn()
          resolve(res)
        } catch (err) {
          reject(err)
        }
      })
    })
  }
}

const manifestWriteQueue = new ManifestWriteQueue()

export function loadGeneratedAssetsManifest(
  projectDir: string,
  profile: VisualMixProfile
): GeneratedVisualAssetsManifest {
  // If health profile, check if legacy health manifest exists first
  if (profile === 'health') {
    const healthManifest = loadHealthGeneratedManifest(projectDir)
    if (Object.keys(healthManifest.scenes).length > 0) {
      const records: Record<string, GeneratedVisualAssetRecord> = {}
      for (const [k, v] of Object.entries(healthManifest.scenes)) {
        records[k] = {
          ...v,
          profile: 'health'
        }
      }
      return {
        schemaVersion: VISUAL_MIX_SCHEMA_VERSION,
        updatedAt: healthManifest.updatedAt,
        configHash: healthManifest.configHash,
        profile: 'health',
        scenes: records
      }
    }
  }

  const manifestPath = getGeneralManifestPath(projectDir)
  if (fs.existsSync(manifestPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      if (data && typeof data === 'object' && data.scenes) {
        return data as GeneratedVisualAssetsManifest
      }
    } catch (err) {
      logger.warn(`[VisualMixCache] Failed to parse ${manifestPath}: ${err}`)
    }
  }

  return {
    schemaVersion: VISUAL_MIX_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    configHash: 'initial',
    profile,
    scenes: {}
  }
}

export function saveGeneratedAssetsManifestAtomic(
  projectDir: string,
  manifest: GeneratedVisualAssetsManifest
): void {
  manifest.updatedAt = new Date().toISOString()
  const manifestPath = getGeneralManifestPath(projectDir)
  const dir = path.dirname(manifestPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const tmpPath = `${manifestPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8')
  fs.renameSync(tmpPath, manifestPath)

  // Also sync to legacy health manifest if profile is health
  if (manifest.profile === 'health') {
    try {
      const healthScenes: Record<string, any> = {}
      for (const [k, v] of Object.entries(manifest.scenes)) {
        healthScenes[k] = {
          sceneIndex: v.sceneIndex,
          strategy: v.strategy,
          promptHash: v.promptHash,
          prompt: v.prompt,
          status: v.status,
          mediaId: v.mediaId,
          flowProjectId: v.flowProjectId,
          outputPath: v.outputPath,
          width: v.width,
          height: v.height,
          motionPreset: v.motionPreset,
          generatedAt: v.generatedAt,
          error: v.error
        }
      }
      saveHealthGeneratedManifest(projectDir, {
        schemaVersion: 1,
        updatedAt: manifest.updatedAt,
        configHash: manifest.configHash,
        scenes: healthScenes
      })
    } catch {
      /* ignore legacy sync errors */
    }
  }
}

export async function saveGeneratedAssetsManifestQueued(
  projectDir: string,
  manifest: GeneratedVisualAssetsManifest
): Promise<void> {
  return manifestWriteQueue.enqueue(() =>
    saveGeneratedAssetsManifestAtomic(projectDir, manifest)
  )
}

/**
 * Checks cache for a specific scene asset.
 * Validates hash, existence on disk, and 1920x1080 dimensions.
 */
export function getCachedVisualAsset(
  projectDir: string,
  sceneIndex: number,
  expectedHash: string,
  profile: VisualMixProfile
): GeneratedVisualAssetRecord | null {
  const manifest = loadGeneratedAssetsManifest(projectDir, profile)
  const record = manifest.scenes[String(sceneIndex)]

  if (!record || record.status !== 'completed' || !record.outputPath) {
    return null
  }

  if (record.promptHash !== expectedHash) {
    logger.info(`[VisualMixCache] Scene ${sceneIndex}: prompt hash mismatch, invalidating cache`)
    return null
  }

  const fullPath = path.isAbsolute(record.outputPath)
    ? record.outputPath
    : path.join(projectDir, record.outputPath)

  if (!fs.existsSync(fullPath)) {
    logger.info(`[VisualMixCache] Scene ${sceneIndex}: cached file not found on disk: ${fullPath}`)
    return null
  }

  try {
    const stat = fs.statSync(fullPath)
    if (stat.size === 0) return null

    const dims = probeImageFileDimensions(fullPath)
    if (!dims || dims.width < 1920 || dims.height < 1080) {
      logger.warn(
        `[VisualMixCache] Scene ${sceneIndex}: cached image does not satisfy 1920x1080 (${dims?.width}x${dims?.height})`
      )
      return null
    }

    return record
  } catch (err) {
    logger.warn(`[VisualMixCache] Error checking cached file ${fullPath}: ${err}`)
    return null
  }
}

/**
 * Thread-safe recording of a visual asset into the manifest using write queue.
 */
export async function recordVisualAssetQueued(
  projectDir: string,
  record: GeneratedVisualAssetRecord
): Promise<void> {
  return manifestWriteQueue.enqueue(() => {
    const manifest = loadGeneratedAssetsManifest(projectDir, record.profile)
    manifest.scenes[String(record.sceneIndex)] = record
    saveGeneratedAssetsManifestAtomic(projectDir, manifest)
  })
}

/**
 * Synchronous version for simple/single-threaded callers.
 */
export function recordVisualAssetSync(
  projectDir: string,
  record: GeneratedVisualAssetRecord
): void {
  const manifest = loadGeneratedAssetsManifest(projectDir, record.profile)
  manifest.scenes[String(record.sceneIndex)] = record
  saveGeneratedAssetsManifestAtomic(projectDir, manifest)
}

export function getGeneratedAssetPath(
  projectDir: string,
  profile: VisualMixProfile,
  sceneIndex: number,
  hash: string
): string {
  const sub = profile === 'health' ? 'health' : 'general'
  const pad = String(sceneIndex).padStart(4, '0')
  return path.join(projectDir, 'assets', 'generated', sub, `S${pad}_${hash}.png`)
}

export class VisualMixCache {
  constructor(
    private projectDir: string,
    private profile: VisualMixProfile
  ) {}

  public getRecord(sceneIndex: number): GeneratedVisualAssetRecord | undefined {
    const m = loadGeneratedAssetsManifest(this.projectDir, this.profile)
    return m.scenes[String(sceneIndex)]
  }

  public static getAssetPath(
    projectDir: string,
    profile: VisualMixProfile,
    sceneIndex: number,
    hash: string
  ): string {
    return getGeneratedAssetPath(projectDir, profile, sceneIndex, hash)
  }
}
