import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { logger } from '../logger'
import { googleFlowClient, GoogleFlowClient } from '../thumbnail/google-flow-client'
import { flowkitRuntimeManager } from '../thumbnail/flowkit-runtime-manager'
import { probeImageFileDimensions } from '../thumbnail/utils/image-probe'
import type {
  HealthVisualScenePlan,
  HealthVisualConfig
} from './health-visual-types'
import { DEFAULT_HEALTH_CONFIG } from './health-visual-types'
import {
  getCachedHealthAsset,
  recordHealthAsset,
  recordHealthFallbackStock
} from './health-visual-cache'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegPath: string = require('ffmpeg-static')

function ffmpegRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    const stderr: string[] = []
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-5).join('')}`))
    })
    proc.on('error', reject)
  })
}

/**
 * Normalizes an image to exact 1920x1080 PNG using center crop and scale to fill.
 * Guaranteed no distortion and sets SAR=1.
 */
export async function normalizeImageTo1080p(
  sourcePath: string,
  destPath: string,
  width = 1920,
  height = 1080
): Promise<void> {
  const destDir = path.dirname(destPath)
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true })
  }

  const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`
  await ffmpegRun(['-y', '-i', sourcePath, '-vf', vf, destPath])
}

export interface HealthGenerationResult {
  success: boolean
  assetPath?: string
  fallbackToStock?: boolean
  reason?: string
}

export class HealthImageGenerator {
  private client: GoogleFlowClient

  constructor(client?: GoogleFlowClient) {
    this.client = client || googleFlowClient
  }

  /**
   * Preflight check to verify FlowKit bridge and Google Flow connection.
   * Throws an actionable error if Flow is not ready for image generation.
   */
  public async ensureReadiness(): Promise<{ ready: boolean; error?: string }> {
    try {
      const readiness = await flowkitRuntimeManager.ensureFlowReady(this.client.getBridgeUrl())
      if (!readiness.ready) {
        let msg = readiness.message || 'FlowKit is not ready.'
        if (!readiness.bridgeReachable) {
          msg = `Health mode requires Google Flow image generation, but FlowKit is not ready. FlowKit bridge is unreachable at ${this.client.getBridgeUrl()}. Ensure FlowKit is running.`
        } else if (!readiness.extensionConnected) {
          msg = 'Health mode requires Google Flow image generation, but Chrome extension is disconnected. Open Google Flow in Chrome and reconnect the FlowKit extension.'
        } else if (!readiness.flowConnected) {
          msg = 'Health mode requires Google Flow image generation, but Google Flow is not signed in. Open Google Flow in Chrome and log in.'
        }
        return { ready: false, error: msg }
      }

      const health = await this.client.checkHealth()
      if (!health.reachable || !health.extensionConnected) {
        return {
          ready: false,
          error: health.message || 'FlowKit is not reachable or Chrome extension is disconnected.'
        }
      }

      return { ready: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ready: false,
        error: `Health mode requires Google Flow image generation, but FlowKit is not ready (${msg}). Open Google Flow in Chrome and reconnect the FlowKit extension.`
      }
    }
  }

  /**
   * Generates or reuses a single Health AI still scene asset.
   * Guarantees exact 1920x1080 output and strict quality gating.
   */
  public async generateSceneAsset(
    projectDir: string,
    scene: HealthVisualScenePlan,
    config?: HealthVisualConfig
  ): Promise<HealthGenerationResult> {
    const width = config?.width ?? DEFAULT_HEALTH_CONFIG.width
    const height = config?.height ?? DEFAULT_HEALTH_CONFIG.height
    const hash = scene.generationHash || 'default_hash'

    // 1. Check cache first
    const cached = getCachedHealthAsset(projectDir, scene.sceneIndex, hash)
    if (cached && cached.outputPath) {
      logger.info(`[HealthVisual] Scene ${scene.sceneIndex}: reusing cached AI still`)
      return {
        success: true,
        assetPath: cached.outputPath
      }
    }

    // 2. Prepare permanent destination
    const healthAssetsDir = path.join(projectDir, 'assets', 'generated', 'health')
    if (!fs.existsSync(healthAssetsDir)) {
      fs.mkdirSync(healthAssetsDir, { recursive: true })
    }

    const sceneIdStr = `S${String(scene.sceneIndex).padStart(4, '0')}`
    const finalFilename = `${sceneIdStr}_${hash.slice(0, 8)}.png`
    const finalAssetPath = path.join(healthAssetsDir, finalFilename)

    // Check if target file already exists and satisfies dimensions
    if (fs.existsSync(finalAssetPath)) {
      const dims = probeImageFileDimensions(finalAssetPath)
      if (dims && dims.width === width && dims.height === height) {
        logger.info(`[HealthVisual] Scene ${scene.sceneIndex}: found valid existing file ${finalFilename}`)
        recordHealthAsset(projectDir, {
          sceneIndex: scene.sceneIndex,
          strategy: 'ai-still',
          promptHash: hash,
          prompt: scene.imagePrompt,
          status: 'completed',
          outputPath: finalAssetPath,
          width,
          height,
          motionPreset: scene.motionPreset,
          generatedAt: new Date().toISOString()
        })
        return {
          success: true,
          assetPath: finalAssetPath
        }
      }
    }

    // 3. Generate via Google Flow with bounded retry
    logger.info(`[HealthVisual] Scene ${scene.sceneIndex} generating via Google Flow...`)

    let lastError: Error | null = null
    const maxRetries = 2
    let tempExportPath: string | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logger.warn(`[HealthVisual] Scene ${scene.sceneIndex} retry attempt ${attempt}/${maxRetries}...`)
          await new Promise((r) => setTimeout(r, 2000 * attempt))
        }

        const genResult = await this.client.generateImage({
          prompt: scene.imagePrompt || '',
          projectId: '',
          imageModel: 'GEM_PIX_2',
          aspectRatio: '16:9',
          count: 1,
          optionId: String(scene.sceneIndex)
        })

        // Export at 4k/2k
        tempExportPath = path.join(
          healthAssetsDir,
          `.tmp_export_${scene.sceneIndex}_${Date.now()}.png`
        )

        const exportResult = await this.client.exportImage({
          mediaId: genResult.mediaId,
          projectId: genResult.projectId,
          destinationPath: tempExportPath,
          fallbackToOriginalUrl: genResult.fifeUrl
        })

        logger.info(
          `[HealthVisual] Scene ${scene.sceneIndex} exported ${exportResult.width}x${exportResult.height} (${exportResult.actualQuality})`
        )

        // 4. Quality gate: width >= 1920 and height >= 1080 BEFORE normalization
        const dims = probeImageFileDimensions(tempExportPath)
        const effectiveWidth = dims?.width || exportResult.width
        const effectiveHeight = dims?.height || exportResult.height

        if (effectiveWidth < 1920 || effectiveHeight < 1080) {
          logger.warn(
            `[HealthVisual] Scene ${scene.sceneIndex} quality gate failed: resolution ${effectiveWidth}x${effectiveHeight} is smaller than required 1920x1080. Not upscaling; falling back to stock.`
          )
          if (fs.existsSync(tempExportPath)) {
            try { fs.unlinkSync(tempExportPath) } catch { /* ignore */ }
          }
          recordHealthFallbackStock(
            projectDir,
            scene.sceneIndex,
            hash,
            `Exported resolution ${effectiveWidth}x${effectiveHeight} below 1920x1080 minimum`
          )
          return {
            success: false,
            fallbackToStock: true,
            reason: `Resolution ${effectiveWidth}x${effectiveHeight} below quality gate`
          }
        }

        // 5. Normalize to exact 1920x1080 PNG
        await normalizeImageTo1080p(tempExportPath, finalAssetPath, width, height)
        logger.info(`[HealthVisual] Scene ${scene.sceneIndex} normalized -> ${width}x${height}`)

        // Delete temporary export file
        if (fs.existsSync(tempExportPath)) {
          try { fs.unlinkSync(tempExportPath) } catch { /* ignore */ }
        }

        // 6. Record asset in persistent manifest
        recordHealthAsset(projectDir, {
          sceneIndex: scene.sceneIndex,
          strategy: 'ai-still',
          promptHash: hash,
          prompt: scene.imagePrompt,
          status: 'completed',
          mediaId: genResult.mediaId,
          flowProjectId: genResult.projectId,
          outputPath: finalAssetPath,
          width,
          height,
          motionPreset: scene.motionPreset,
          generatedAt: new Date().toISOString()
        })

        logger.info(`[HealthVisual] Scene ${scene.sceneIndex} cached`)

        return {
          success: true,
          assetPath: finalAssetPath
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        logger.warn(`[HealthVisual] Scene ${scene.sceneIndex} generation error: ${lastError.message}`)
        if (tempExportPath && fs.existsSync(tempExportPath)) {
          try { fs.unlinkSync(tempExportPath) } catch { /* ignore */ }
        }
      }
    }

    // Ultimate failure: fallback to stock
    const failReason = lastError?.message || 'Google Flow image generation failed'
    logger.warn(`[HealthVisual] Scene ${scene.sceneIndex} Flow generation failed, falling back to stock (${failReason})`)

    recordHealthFallbackStock(projectDir, scene.sceneIndex, hash, failReason)

    return {
      success: false,
      fallbackToStock: true,
      reason: failReason
    }
  }
}

export const healthImageGenerator = new HealthImageGenerator()
