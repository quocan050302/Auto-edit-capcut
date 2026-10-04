import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { probeImageFileDimensions } from '../thumbnail/utils/image-probe'
import type {
  HealthGeneratedAssetsManifest,
  HealthGeneratedAssetRecord,
  HealthVisualConfig
} from './health-visual-types'
import { HEALTH_SCHEMA_VERSION, DEFAULT_HEALTH_CONFIG } from './health-visual-types'

export function getHealthManifestPath(projectDir: string): string {
  return path.join(projectDir, 'analysis', 'health-generated-assets.json')
}

export function computeHealthConfigHash(config?: HealthVisualConfig): string {
  const merged = { ...DEFAULT_HEALTH_CONFIG, ...config }
  return crypto.createHash('md5').update(JSON.stringify(merged)).digest('hex')
}

export function computeHealthGenerationHash(
  sceneIndex: number,
  narration: string,
  visualIntent: string,
  imagePrompt: string,
  config?: HealthVisualConfig
): string {
  const width = config?.width ?? DEFAULT_HEALTH_CONFIG.width
  const height = config?.height ?? DEFAULT_HEALTH_CONFIG.height
  const payload = [
    String(sceneIndex),
    (narration || '').trim().toLowerCase(),
    (visualIntent || '').trim().toLowerCase(),
    (imagePrompt || '').trim(),
    `${width}x${height}`,
    'GEM_PIX_2',
    'health'
  ].join('||')

  return crypto.createHash('sha256').update(payload).digest('hex')
}

export function computeHealthMotionHash(plan: { scenes?: Array<{ sceneIndex: number; category: string; motionPreset?: string; motion?: { preset: string; intensity: string; zoomEnd: number }; sfxCue?: { type: string; volumeDb: number } }> }): string {
  const parts = (plan.scenes || []).map((s) => {
    const motionStr = s.motion ? `${s.motion.preset}:${s.motion.intensity}:${s.motion.zoomEnd}` : s.motionPreset || 'none'
    const sfxStr = s.sfxCue ? `${s.sfxCue.type}:${s.sfxCue.volumeDb}` : 'none'
    return `${s.sceneIndex}:${s.category}:${motionStr}:${sfxStr}`
  })
  return crypto.createHash('sha256').update(parts.join('||')).digest('hex')
}

export function loadHealthGeneratedManifest(projectDir: string): HealthGeneratedAssetsManifest {
  const manifestPath = getHealthManifestPath(projectDir)
  if (fs.existsSync(manifestPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      if (data && typeof data === 'object' && data.scenes) {
        return data as HealthGeneratedAssetsManifest
      }
    } catch (err) {
      logger.warn(`[HealthVisualCache] Failed to parse ${manifestPath}: ${err}`)
    }
  }

  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    configHash: computeHealthConfigHash(),
    scenes: {}
  }
}

export function saveHealthGeneratedManifest(
  projectDir: string,
  manifest: HealthGeneratedAssetsManifest
): void {
  const manifestPath = getHealthManifestPath(projectDir)
  const dir = path.dirname(manifestPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  manifest.updatedAt = new Date().toISOString()
  const tmpPath = `${manifestPath}.tmp.${Date.now()}`
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8')
  fs.renameSync(tmpPath, manifestPath)
}

export function getCachedHealthAsset(
  projectDir: string,
  sceneIndex: number,
  expectedHash: string
): HealthGeneratedAssetRecord | null {
  const manifest = loadHealthGeneratedManifest(projectDir)
  const record = manifest.scenes[String(sceneIndex)]

  if (!record || record.status !== 'completed' || !record.outputPath) {
    return null
  }

  // Hash match check
  if (record.promptHash !== expectedHash) {
    logger.info(`[HealthVisual] Scene ${sceneIndex}: prompt hash mismatch, invalidating cache`)
    return null
  }

  // Disk & quality gate verification
  const fullPath = path.isAbsolute(record.outputPath)
    ? record.outputPath
    : path.join(projectDir, record.outputPath)

  if (!fs.existsSync(fullPath)) {
    logger.info(`[HealthVisual] Scene ${sceneIndex}: cached file not found on disk: ${fullPath}`)
    return null
  }

  try {
    const stat = fs.statSync(fullPath)
    if (stat.size === 0) {
      return null
    }

    const dims = probeImageFileDimensions(fullPath)
    if (!dims || dims.width < 1920 || dims.height < 1080) {
      logger.warn(
        `[HealthVisual] Scene ${sceneIndex}: cached image does not satisfy 1920x1080 requirement (${dims?.width}x${dims?.height})`
      )
      return null
    }

    return record
  } catch (err) {
    logger.warn(`[HealthVisualCache] Error checking cached file ${fullPath}: ${err}`)
    return null
  }
}

export function recordHealthAsset(
  projectDir: string,
  record: HealthGeneratedAssetRecord
): void {
  const manifest = loadHealthGeneratedManifest(projectDir)
  manifest.scenes[String(record.sceneIndex)] = record
  saveHealthGeneratedManifest(projectDir, manifest)
}

export function recordHealthFallbackStock(
  projectDir: string,
  sceneIndex: number,
  promptHash: string,
  reason: string
): void {
  const manifest = loadHealthGeneratedManifest(projectDir)
  manifest.scenes[String(sceneIndex)] = {
    sceneIndex,
    strategy: 'stock',
    promptHash,
    status: 'fallback-stock',
    error: reason,
    generatedAt: new Date().toISOString()
  }
  saveHealthGeneratedManifest(projectDir, manifest)
}
