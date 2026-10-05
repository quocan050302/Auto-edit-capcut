import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { googleFlowClient, GoogleFlowClient } from '../thumbnail/google-flow-client'
import { probeImageFileDimensions } from '../thumbnail/utils/image-probe'
import { normalizeImageTo1080p } from '../health/health-image-generator'
import type {
  VisualMixScenePlan,
  VisualMixConfig,
  VisualMixProfile
} from '../../../shared/types'
import { recordVisualAssetQueued } from './visual-mix-cache'

export interface GenerationPoolItem {
  scene: VisualMixScenePlan
  config: VisualMixConfig
  profile: VisualMixProfile
  projectDir: string
}

export interface GenerationItemPerformance {
  generateMs: number
  exportMs: number
  normalizeMs: number
  totalMs: number
}

export interface GenerationItemResult {
  sceneIndex: number
  success: boolean
  assetPath?: string
  fallbackToStock?: boolean
  cached?: boolean
  reason?: string
  performance?: GenerationItemPerformance
}

export interface PoolProgressStats {
  total: number
  cached: number
  queued: number
  generating: number
  exporting: number
  normalizing: number
  completed: number
  fallbackStock: number
}

export type PoolProgressCallback = (
  message: string,
  progress: number,
  stats: PoolProgressStats
) => void

/**
 * Reusable async counting semaphore.
 */
export class AsyncSemaphore {
  private currentRunning = 0
  private queue: Array<() => void> = []

  constructor(public maxConcurrency: number) {}

  public async acquire(): Promise<() => void> {
    if (this.currentRunning < this.maxConcurrency) {
      this.currentRunning++
      let released = false
      return () => {
        if (!released) {
          released = true
          this.currentRunning--
          const next = this.queue.shift()
          if (next) next()
        }
      }
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.currentRunning++
        let released = false
        resolve(() => {
          if (!released) {
            released = true
            this.currentRunning--
            const next = this.queue.shift()
            if (next) next()
          }
        })
      })
    })
  }

  public release(): void {
    if (this.currentRunning > 0) {
      this.currentRunning--
      const next = this.queue.shift()
      if (next) next()
    }
  }

  public async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  public get activeCount(): number {
    return this.currentRunning
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const semaphore = new AsyncSemaphore(concurrency)
  return Promise.all(
    items.map((item, idx) =>
      semaphore.run(async () => {
        if (signal?.aborted) {
          throw new Error('Aborted')
        }
        return fn(item, idx)
      })
    )
  )
}

/**
 * AI Conveyor Worker Pool (Section 44).
 * Separates Generation, Export, and Normalization into decoupled conveyor stages.
 * Releases Generation worker slot immediately upon receiving mediaId, allowing the next
 * image prompt to generate while export and normalization proceed concurrently.
 */
export class FlowImagePool {
  private client: GoogleFlowClient

  constructor(client?: GoogleFlowClient) {
    this.client = client || googleFlowClient
  }

  public async processBatch(
    items: GenerationPoolItem[],
    onProgress?: PoolProgressCallback,
    signal?: AbortSignal
  ): Promise<GenerationItemResult[]> {
    if (items.length === 0) return []

    const total = items.length
    let completedCount = 0
    let fallbackCount = 0
    let generatingCount = 0
    let exportingCount = 0
    let normalizingCount = 0

    const updateProgress = (message: string): void => {
      const finished = completedCount + fallbackCount
      const progress = total > 0 ? finished / total : 1.0
      const stats: PoolProgressStats = {
        total,
        cached: 0,
        queued: Math.max(0, total - finished - generatingCount - exportingCount - normalizingCount),
        generating: generatingCount,
        exporting: exportingCount,
        normalizing: normalizingCount,
        completed: completedCount,
        fallbackStock: fallbackCount
      }
      onProgress?.(message, progress, stats)
    }

    // 1. FlowKit Throttling & Effective Concurrency (Section 42 & 43)
    let flowThrottle: { maxConcurrent?: number; minIntervalS?: number; cooldownActive?: boolean } | null = null
    if (typeof this.client.getFlowThrottle === 'function') {
      try {
        flowThrottle = await this.client.getFlowThrottle()
      } catch {
        /* ignore */
      }
    }

    const requestedGen =
      items[0]?.config.requestedGenerationConcurrency ??
      items[0]?.config.generationConcurrency ??
      2
    const flowMax = flowThrottle?.maxConcurrent !== undefined ? flowThrottle.maxConcurrent : requestedGen
    const effectiveGenConcurrency = Math.max(
      1,
      Math.min(requestedGen, flowMax)
    )

    const exportConcurrency = Math.max(1, items[0]?.config.exportConcurrency ?? 2)
    const normalizeConcurrency = Math.max(1, items[0]?.config.normalizeConcurrency ?? 2)

    logger.info(
      `[FlowImagePool] Conveyor initialized: effectiveGenConcurrency=${effectiveGenConcurrency} (requested=${requestedGen}, flowKitMax=${flowThrottle?.maxConcurrent ?? 'unthrottled'}), exportConcurrency=${exportConcurrency}, normalizeConcurrency=${normalizeConcurrency}`
    )

    const genSemaphore = new AsyncSemaphore(effectiveGenConcurrency)
    const expSemaphore = new AsyncSemaphore(exportConcurrency)
    const normSemaphore = new AsyncSemaphore(normalizeConcurrency)

    // Rate limiter tracking for minIntervalS
    let lastGenLaunchTime = 0

    // Process all items concurrently across the 3 conveyor stages
    const results: GenerationItemResult[] = await Promise.all(
      items.map(async (item) => {
        if (signal?.aborted) {
          return {
            sceneIndex: item.scene.sceneIndex,
            success: false,
            fallbackToStock: true,
            reason: 'Pipeline execution was cancelled.'
          }
        }

        const tStart = Date.now()
        let tGenEnd = tStart
        let tExpEnd = tStart
        let tNormEnd = tStart

        // ══════════════════════════════════════════════════════════════
        // STAGE 1: GENERATION (bounded by genSemaphore)
        // ══════════════════════════════════════════════════════════════
        const releaseGen = await genSemaphore.acquire()
        generatingCount++
        updateProgress(`Generating Scene ${item.scene.sceneIndex}...`)

        let genResult: { mediaId: string; projectId: string; fifeUrl?: string } | null = null
        const caller = item.profile === 'health' ? 'health-visuals' : 'general-visuals'
        let lastError: Error | null = null
        const maxRetries = 1 // 2 total attempts: initial + 1 retry (Section 46)

        try {
          // FlowKit rate limit gap
          const now = Date.now()
          const minGapMs = flowThrottle?.minIntervalS ? flowThrottle.minIntervalS * 1000 : 0
          const timeSinceLast = now - lastGenLaunchTime
          if (timeSinceLast < minGapMs) {
            await new Promise((r) => setTimeout(r, minGapMs - timeSinceLast))
          }
          lastGenLaunchTime = Date.now()

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (signal?.aborted) break
            try {
              if (attempt > 0) {
                logger.warn(
                  `[FlowImagePool] Scene ${item.scene.sceneIndex} retry attempt ${attempt}/${maxRetries}...`
                )
                await new Promise((r) => setTimeout(r, 2500 * attempt))
              }

              genResult = await this.client.generateImage({
                prompt: item.scene.imagePrompt || '',
                projectId: '',
                imageModel: 'GEM_PIX_2',
                aspectRatio: '16:9',
                count: 1,
                optionId: String(item.scene.sceneIndex) as any,
                caller
              } as any)

              break
            } catch (err: unknown) {
              lastError = err instanceof Error ? err : new Error(String(err))
              const msg = lastError.message
              if (msg.includes('FLOW_RATE_LIMITED') || msg.includes('429')) {
                logger.warn(`[FlowImagePool] Scene ${item.scene.sceneIndex} rate limited, backing off...`)
                await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)))
              } else if (
                msg.includes('FLOW_EXTENSION_DISCONNECTED') ||
                msg.includes('FLOW_RECAPTCHA_FAILED')
              ) {
                break
              }
            }
          }
        } finally {
          tGenEnd = Date.now()
          generatingCount--
          // CRITICAL REQUIREMENT (Section 44): Release generation slot as soon as mediaId is obtained!
          releaseGen()
        }

        if (!genResult || !genResult.mediaId) {
          fallbackCount++
          const reason = lastError ? lastError.message : 'Generation failed without mediaId'
          logger.warn(`[FlowImagePool] Scene ${item.scene.sceneIndex} failed generation: ${reason}`)
          updateProgress(`Scene ${item.scene.sceneIndex} failed, falling back to stock...`)

          await recordVisualAssetQueued(item.projectDir, {
            sceneIndex: item.scene.sceneIndex,
            strategy: 'stock',
            profile: item.profile,
            promptHash: item.scene.generationHash || 'hash',
            status: 'fallback-stock',
            error: reason,
            generatedAt: new Date().toISOString()
          })

          return {
            sceneIndex: item.scene.sceneIndex,
            success: false,
            fallbackToStock: true,
            reason
          }
        }

        // ══════════════════════════════════════════════════════════════
        // STAGE 2: EXPORT (bounded by expSemaphore, concurrency = 2)
        // ══════════════════════════════════════════════════════════════
        const releaseExp = await expSemaphore.acquire()
        exportingCount++
        updateProgress(`Exporting Scene ${item.scene.sceneIndex}...`)

        const assetsFolder =
          item.profile === 'health'
            ? path.join(item.projectDir, 'assets', 'generated', 'health')
            : path.join(item.projectDir, 'assets', 'generated', 'general')

        if (!fs.existsSync(assetsFolder)) {
          fs.mkdirSync(assetsFolder, { recursive: true })
        }

        const sceneIdStr = `S${String(item.scene.sceneIndex).padStart(4, '0')}`
        const hashPrefix = (item.scene.generationHash || 'hash').slice(0, 8)
        const finalFilename = `${sceneIdStr}_${hashPrefix}.png`
        const finalAssetPath = path.join(assetsFolder, finalFilename)

        const tempExportPath = path.join(
          assetsFolder,
          `.tmp_export_${item.scene.sceneIndex}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
        )

        const targetRes = item.config.imageOutputResolution || '1080p'
        const exportQuality: '2k' | '4k' = targetRes === '4k' ? '4k' : '2k'

        let exportSuccess = false
        let effectiveWidth = 1920
        let effectiveHeight = 1080

        try {
          if (signal?.aborted) {
            throw new Error('Pipeline execution was cancelled.')
          }

          const exportResult = await this.client.exportImage({
            mediaId: genResult.mediaId,
            projectId: genResult.projectId,
            destinationPath: tempExportPath,
            fallbackToOriginalUrl: genResult.fifeUrl,
            quality: exportQuality,
            preferredQuality: exportQuality
          })

          const dims = probeImageFileDimensions(tempExportPath)
          effectiveWidth = dims?.width || exportResult.width
          effectiveHeight = dims?.height || exportResult.height

          // Section 13: For 1080p, do NOT upscale low-res originals (< 1920x1080)
          if (effectiveWidth < 1920 || effectiveHeight < 1080) {
            logger.warn(
              `[FlowImagePool] Scene ${item.scene.sceneIndex} quality gate failed: ${effectiveWidth}x${effectiveHeight} < 1920x1080. Not upscaling; falling back to stock.`
            )
            if (fs.existsSync(tempExportPath)) {
              try { fs.unlinkSync(tempExportPath) } catch { /* ignore */ }
            }
            fallbackCount++
            const reason = `Resolution ${effectiveWidth}x${effectiveHeight} below quality gate`

            await recordVisualAssetQueued(item.projectDir, {
              sceneIndex: item.scene.sceneIndex,
              strategy: 'stock',
              profile: item.profile,
              promptHash: item.scene.generationHash || 'hash',
              status: 'fallback-stock',
              error: reason,
              generatedAt: new Date().toISOString()
            })

            return {
              sceneIndex: item.scene.sceneIndex,
              success: false,
              fallbackToStock: true,
              reason
            }
          }

          exportSuccess = true
        } catch (expErr) {
          if (tempExportPath && fs.existsSync(tempExportPath)) {
            try { fs.unlinkSync(tempExportPath) } catch { /* ignore */ }
          }
          fallbackCount++
          const reason = expErr instanceof Error ? expErr.message : String(expErr)
          logger.warn(`[FlowImagePool] Export failed for scene ${item.scene.sceneIndex}: ${reason}`)

          await recordVisualAssetQueued(item.projectDir, {
            sceneIndex: item.scene.sceneIndex,
            strategy: 'stock',
            profile: item.profile,
            promptHash: item.scene.generationHash || 'hash',
            status: 'fallback-stock',
            error: reason,
            generatedAt: new Date().toISOString()
          })

          return {
            sceneIndex: item.scene.sceneIndex,
            success: false,
            fallbackToStock: true,
            reason
          }
        } finally {
          tExpEnd = Date.now()
          exportingCount--
          releaseExp()
        }

        if (!exportSuccess) {
          return {
            sceneIndex: item.scene.sceneIndex,
            success: false,
            fallbackToStock: true,
            reason: 'Export stage failed'
          }
        }

        // ══════════════════════════════════════════════════════════════
        // STAGE 3: NORMALIZATION (bounded by normSemaphore, concurrency = 2)
        // ══════════════════════════════════════════════════════════════
        const releaseNorm = await normSemaphore.acquire()
        normalizingCount++
        updateProgress(`Normalizing Scene ${item.scene.sceneIndex}...`)

        const targetDims =
          targetRes === '4k'
            ? { width: 3840, height: 2160 }
            : targetRes === '2k'
              ? { width: 2560, height: 1440 }
              : { width: 1920, height: 1080 }

        try {
          if (signal?.aborted) {
            throw new Error('Pipeline execution was cancelled.')
          }

          if (effectiveWidth === targetDims.width && effectiveHeight === targetDims.height) {
            const destDir = path.dirname(finalAssetPath)
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
            fs.copyFileSync(tempExportPath, finalAssetPath)
          } else {
            // Downscale via FFmpeg to exact target resolution
            await normalizeImageTo1080p(tempExportPath, finalAssetPath, targetDims.width, targetDims.height)
          }

          if (fs.existsSync(tempExportPath)) {
            try { fs.unlinkSync(tempExportPath) } catch { /* ignore */ }
          }

          tNormEnd = Date.now()

          const genMs = tGenEnd - tStart
          const expMs = tExpEnd - tGenEnd
          const normMs = tNormEnd - tExpEnd
          const totMs = tNormEnd - tStart

          // Performance log (Section 71)
          logger.info(
            `[FlowPerf] Scene ${item.scene.sceneIndex} generate=${genMs}ms export=${expMs}ms normalize=${normMs}ms total=${totMs}ms`
          )

          // Persist record atomically into manifest
          await recordVisualAssetQueued(item.projectDir, {
            sceneIndex: item.scene.sceneIndex,
            strategy: 'ai-still',
            profile: item.profile,
            promptHash: item.scene.generationHash || 'hash',
            prompt: item.scene.imagePrompt,
            status: 'completed',
            mediaId: genResult.mediaId,
            flowProjectId: genResult.projectId,
            outputPath: finalAssetPath,
            width: targetDims.width,
            height: targetDims.height,
            motionPreset: item.scene.motionPreset,
            generatedAt: new Date().toISOString()
          })

          completedCount++
          updateProgress(`AI visual completed for Scene ${item.scene.sceneIndex}`)

          return {
            sceneIndex: item.scene.sceneIndex,
            success: true,
            assetPath: finalAssetPath,
            performance: {
              generateMs: genMs,
              exportMs: expMs,
              normalizeMs: normMs,
              totalMs: totMs
            }
          }
        } catch (normErr) {
          if (tempExportPath && fs.existsSync(tempExportPath)) {
            try { fs.unlinkSync(tempExportPath) } catch { /* ignore */ }
          }
          fallbackCount++
          const reason = normErr instanceof Error ? normErr.message : String(normErr)
          logger.warn(`[FlowImagePool] Normalization failed for scene ${item.scene.sceneIndex}: ${reason}`)

          await recordVisualAssetQueued(item.projectDir, {
            sceneIndex: item.scene.sceneIndex,
            strategy: 'stock',
            profile: item.profile,
            promptHash: item.scene.generationHash || 'hash',
            status: 'fallback-stock',
            error: reason,
            generatedAt: new Date().toISOString()
          })

          return {
            sceneIndex: item.scene.sceneIndex,
            success: false,
            fallbackToStock: true,
            reason
          }
        } finally {
          normalizingCount--
          releaseNorm()
        }
      })
    )

    return results
  }
}

export const flowImagePool = new FlowImagePool()

export async function runFlowImagePool(params: {
  projectDir: string
  profile: VisualMixProfile
  config: VisualMixConfig
  scenes: VisualMixScenePlan[]
  flowClient?: GoogleFlowClient
  onProgress?: (p: { message: string; progress: number }) => void
  signal?: AbortSignal
}): Promise<{
  results: GenerationItemResult[]
  completedCount: number
  failedCount: number
  fallbackStockIndices: number[]
}> {
  const pool = new FlowImagePool(params.flowClient)
  const items: GenerationPoolItem[] = params.scenes.map((scene) => ({
    scene,
    config: params.config,
    profile: params.profile,
    projectDir: params.projectDir
  }))

  const results = await pool.processBatch(
    items,
    (msg, progress) => {
      params.onProgress?.({ message: msg, progress })
    },
    params.signal
  )

  const completedCount = results.filter((r) => r.success).length
  const failedCount = results.filter((r) => !r.success).length
  const fallbackStockIndices = results.filter((r) => r.fallbackToStock).map((r) => r.sceneIndex)

  return {
    results,
    completedCount,
    failedCount,
    fallbackStockIndices
  }
}
