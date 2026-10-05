import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../logger'
import { googleFlowClient, GoogleFlowClient } from '../thumbnail/google-flow-client'
import { probeImageFileDimensions } from '../thumbnail/utils/image-probe'
import { normalizeImageTo1080p } from '../health/health-image-generator'
import type {
  VisualMixScenePlan,
  VisualMixConfig,
  VisualMixProfile,
  GeneratedVisualAssetRecord
} from '../../../shared/types'
import { recordVisualAssetQueued } from './visual-mix-cache'

export interface GenerationPoolItem {
  scene: VisualMixScenePlan
  config: VisualMixConfig
  profile: VisualMixProfile
  projectDir: string
}

export interface GenerationItemResult {
  sceneIndex: number
  success: boolean
  assetPath?: string
  fallbackToStock?: boolean
  cached?: boolean
  reason?: string
}

export interface PoolProgressStats {
  total: number
  cached: number
  queued: number
  generating: number
  postProcessing: number
  completed: number
  fallbackStock: number
}

export type PoolProgressCallback = (
  message: string,
  progress: number,
  stats: PoolProgressStats
) => void

/**
 * Reusable sliding concurrency worker pool.
 * Guarantees true sliding-window execution: as soon as one slot completes,
 * the next item starts immediately.
 * Results preserve original input array order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  if (items.length === 0) return []

  const maxWorkers = Math.max(1, Math.min(concurrency, items.length))
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  return new Promise<R[]>((resolve, reject) => {
    let active = 0
    let rejected = false

    const launchNext = (): void => {
      if (rejected) return

      if (signal?.aborted) {
        rejected = true
        reject(new Error('Operation cancelled by AbortSignal.'))
        return
      }

      if (nextIndex >= items.length) {
        if (active === 0) {
          resolve(results)
        }
        return
      }

      const currentIndex = nextIndex++
      const item = items[currentIndex]
      active++

      worker(item, currentIndex)
        .then((res) => {
          results[currentIndex] = res
          active--
          launchNext()
        })
        .catch((err) => {
          rejected = true
          reject(err)
        })
    }

    for (let i = 0; i < maxWorkers; i++) {
      launchNext()
    }
  })
}

/**
 * Semaphore queue for bounding concurrent tasks (e.g. max 2 post-processing jobs).
 */
export class AsyncSemaphore {
  private currentRunning = 0
  private maxConcurrency: number
  private queue: Array<() => void> = []

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency
  }

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

  public get activeCount(): number {
    return this.currentRunning
  }
}

export class FlowImagePool {
  private client: GoogleFlowClient
  private postProcessSemaphore: AsyncSemaphore

  constructor(client?: GoogleFlowClient, postProcessConcurrency = 2) {
    this.client = client || googleFlowClient
    this.postProcessSemaphore = new AsyncSemaphore(postProcessConcurrency)
  }

  /**
   * Executes continuous sliding generation for uncached scenes.
   * Generation max concurrency = 6.
   * Post-processing (FFmpeg export & normalize) max concurrency = 2.
   */
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
    let postProcessingCount = 0

    const updateProgress = (message: string): void => {
      const finished = completedCount + fallbackCount
      const progress = total > 0 ? finished / total : 1.0
      const stats: PoolProgressStats = {
        total,
        cached: 0,
        queued: Math.max(0, total - finished - generatingCount - postProcessingCount),
        generating: generatingCount,
        postProcessing: postProcessingCount,
        completed: completedCount,
        fallbackStock: fallbackCount
      }
      onProgress?.(message, progress, stats)
    }

    const generationConcurrency = items[0]?.config.generationConcurrency ?? 6

    const results = await mapWithConcurrency<GenerationPoolItem, GenerationItemResult>(
      items,
      generationConcurrency,
      async (item) => {
        if (signal?.aborted) {
          return {
            sceneIndex: item.scene.sceneIndex,
            success: false,
            fallbackToStock: true,
            reason: 'Pipeline execution was cancelled.'
          }
        }

        generatingCount++
        updateProgress(
          `Generating AI visual for Scene ${item.scene.sceneIndex} (${generatingCount} generating)...`
        )

        let genResult: { mediaId: string; projectId: string; fifeUrl?: string } | null = null
        const caller = item.profile === 'health' ? 'health-visuals' : 'general-visuals'

        // 1. Generation phase (concurrency cap = 6) with bounded retry
        let lastError: Error | null = null
        const maxRetries = 2

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (signal?.aborted) break
          try {
            if (attempt > 0) {
              logger.warn(
                `[FlowImagePool] Scene ${item.scene.sceneIndex} retry attempt ${attempt}/${maxRetries}...`
              )
              await new Promise((r) => setTimeout(r, 2000 * attempt))
            }

            genResult = await this.client.generateImage({
              prompt: item.scene.imagePrompt || '',
              projectId: '',
              imageModel: 'GEM_PIX_2',
              aspectRatio: '16:9',
              count: 1, // Strictly 1 per scene prompt
              optionId: String(item.scene.sceneIndex) as any,
              caller
            } as any)

            break
          } catch (err: unknown) {
            lastError = err instanceof Error ? err : new Error(String(err))
            const msg = lastError.message
            // Rate limit / cooldown backoff
            if (msg.includes('FLOW_RATE_LIMITED') || msg.includes('429')) {
              logger.warn(`[FlowImagePool] Scene ${item.scene.sceneIndex} rate limited, backing off...`)
              await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)))
            } else if (msg.includes('FLOW_EXTENSION_DISCONNECTED') || msg.includes('FLOW_RECAPTCHA_FAILED')) {
              // Terminal error for this job
              break
            }
          }
        }

        generatingCount--

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

        // 2. Post-processing phase: export + normalize (concurrency cap = 2 via semaphore)
        postProcessingCount++
        updateProgress(
          `Exporting & normalizing Scene ${item.scene.sceneIndex} (${postProcessingCount} processing)...`
        )

        const releasePostProcess = await this.postProcessSemaphore.acquire()
        let tempExportPath: string | null = null

        try {
          if (signal?.aborted) {
            throw new Error('Pipeline execution was cancelled.')
          }

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

          tempExportPath = path.join(
            assetsFolder,
            `.tmp_export_${item.scene.sceneIndex}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
          )

          const exportResult = await this.client.exportImage({
            mediaId: genResult.mediaId,
            projectId: genResult.projectId,
            destinationPath: tempExportPath,
            fallbackToOriginalUrl: genResult.fifeUrl,
            quality: '4k'
          })

          // Quality gate check: width >= 1920 && height >= 1080
          const dims = probeImageFileDimensions(tempExportPath)
          const effectiveWidth = dims?.width || exportResult.width
          const effectiveHeight = dims?.height || exportResult.height

          if (effectiveWidth < 1920 || effectiveHeight < 1080) {
            logger.warn(
              `[FlowImagePool] Scene ${item.scene.sceneIndex} quality gate failed: ${effectiveWidth}x${effectiveHeight} < 1920x1080. Not upscaling; falling back to stock.`
            )
            if (fs.existsSync(tempExportPath)) {
              try { fs.unlinkSync(tempExportPath) } catch { /* ignore */ }
            }
            fallbackCount++
            const reason = `Resolution ${effectiveWidth}x${effectiveHeight} below 1920x1080 quality gate`

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

          // Normalize to target dimensions (1920x1080 PNG)
          const targetWidth = item.config.width || 1920
          const targetHeight = item.config.height || 1080
          if (effectiveWidth === targetWidth && effectiveHeight === targetHeight) {
            const destDir = path.dirname(finalAssetPath)
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
            fs.copyFileSync(tempExportPath, finalAssetPath)
          } else {
            await normalizeImageTo1080p(tempExportPath, finalAssetPath, targetWidth, targetHeight)
          }

          if (fs.existsSync(tempExportPath)) {
            try { fs.unlinkSync(tempExportPath) } catch { /* ignore */ }
          }

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
            width: targetWidth,
            height: targetHeight,
            motionPreset: item.scene.motionPreset,
            generatedAt: new Date().toISOString()
          })

          completedCount++
          updateProgress(`AI visual completed for Scene ${item.scene.sceneIndex}`)

          return {
            sceneIndex: item.scene.sceneIndex,
            success: true,
            assetPath: finalAssetPath
          }
        } catch (postErr) {
          if (tempExportPath && fs.existsSync(tempExportPath)) {
            try { fs.unlinkSync(tempExportPath) } catch { /* ignore */ }
          }
          fallbackCount++
          const reason = postErr instanceof Error ? postErr.message : String(postErr)
          logger.warn(`[FlowImagePool] Post-processing failed for scene ${item.scene.sceneIndex}: ${reason}`)

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
          postProcessingCount--
          releasePostProcess()
        }
      },
      signal
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
  const pool = new FlowImagePool(params.flowClient, params.config.postProcessConcurrency)
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
