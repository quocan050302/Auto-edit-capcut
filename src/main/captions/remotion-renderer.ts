/**
 * remotion-renderer.ts
 *
 * Thay thế ass-generator.ts — render lớp caption overlay qua Remotion/Chromium.
 *
 * Output: file .mp4 H264, nền xanh lá #00FF00 (green screen).
 * FFmpeg dùng filter colorkey=0x00ff00 để xoá nền xanh và overlay lên video gốc.
 * Tỏ́t hơn WebM+alpha vì không phụ thuộc codec alpha support của Chromium headless.
 *
 * NOTE về giấy phép: Remotion dùng "Remotion License" — miễn phí cho cá nhân/team nhỏ.
 * Kiểm tra https://remotion.dev/license trước khi dùng cho mục đích thương mại.
 */

import * as path from 'path'
import * as fs from 'fs'
import { bundle } from '@remotion/bundler'
import { renderMedia, selectComposition, makeCancelSignal } from '@remotion/renderer'
import { logger } from '../logger'
import type { CaptionPlan, VisualGrammarDecision } from '../../../shared/types'
import type { ProofVisual } from '../retention/retention-types'
import type { OpeningRetentionEvent } from '../retention/opening-retention-types'
import { computeResourceLimits } from '../render-cache/render-resource-manager'
import { loadRenderPreferences } from '../render-cache/render-preferences'
import { bitrateForCrf } from '../render-cache/video-encoder'
import { RenderCancelledError } from '../render-cache/ffmpeg-process'

// Cache bundle URL để tránh re-bundle mỗi lần render
let cachedBundleUrl: string | null = null

/**
 * Lấy (hoặc tạo mới) Remotion bundle URL.
 * Bundle compile chạy trong worker của @remotion/bundler (Webpack).
 */
async function getBundle(onProgress?: (pct: number) => void): Promise<string> {
  if (cachedBundleUrl) {
    logger.info('[RemotionRenderer] Using bundle cache')
    return cachedBundleUrl
  }

  logger.info('[RemotionRenderer] Bundling Remotion composition...')

  const entryPoint = path.join(__dirname, '../../src/remotion/index.ts')

  cachedBundleUrl = await bundle({
    entryPoint,
    onProgress: (progress) => {
      onProgress?.(progress)
      logger.debug(`[RemotionRenderer] Bundle: ${progress}%`)
    },
  })

  logger.info(`[RemotionRenderer] Bundle xong: ${cachedBundleUrl}`)
  return cachedBundleUrl
}

export interface RemotionRenderOptions {
  captionPlan: CaptionPlan
  proofVisuals?: ProofVisual[]          // optional — absent = caption-only (backward compat)
  visualGrammar?: VisualGrammarDecision[] // optional Visual Scene Grammar
  openingEvents?: OpeningRetentionEvent[] // optional Opening Retention Composer events
  videoDurationInSeconds: number
  outputPath: string        // vd: assets/captions/overlay.webm
  fps?: number
  resolution?: { width: number; height: number }
  onBundleProgress?: (pct: number) => void
  onRenderProgress?: (pct: number) => void
  // ── Resource / resume controls (optional — safe defaults from the Balanced profile) ──
  /** Inclusive absolute frame range of the full composition to render. */
  frameRange?: [number, number]
  concurrency?: number
  offthreadVideoThreads?: number
  mediaCacheSizeInBytes?: number
  offthreadVideoCacheSizeInBytes?: number
  /** 'disable' (default, current quality) or 'if-possible' (experimental Apple HW). */
  hardwareAcceleration?: 'disable' | 'if-possible'
  signal?: AbortSignal
}

/**
 * renderCaptionsOverlay — render toàn bộ caption plan thành 1 file WebM alpha.
 *
 * @param options - cấu hình render
 * @throws nếu Remotion bundle/render thất bại
 */
export async function renderCaptionsOverlay(options: RemotionRenderOptions): Promise<{ hardwareFallback: boolean }> {
  const {
    captionPlan,
    proofVisuals,
    visualGrammar,
    openingEvents,
    videoDurationInSeconds,
    outputPath,
    fps = 30,
    resolution = { width: 1920, height: 1080 },
    onBundleProgress,
    onRenderProgress,
  } = options

  if (options.signal?.aborted) throw new RenderCancelledError()

  // Tạo thư mục output nếu chưa có
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  // 1. Bundle
  const bundleUrl = await getBundle(onBundleProgress)

  // 2. Chọn composition với metadata override
  const durationInFrames = Math.ceil(videoDurationInSeconds * fps)

  // Resource limits — never let Remotion size caches from half the machine's RAM
  const defaults = computeResourceLimits(loadRenderPreferences().resourceProfile)
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? defaults.remotionConcurrency))
  const offthreadVideoThreads = Math.max(1, Math.floor(options.offthreadVideoThreads ?? defaults.offthreadVideoThreads))
  const mediaCacheSizeInBytes = options.mediaCacheSizeInBytes ?? defaults.mediaCacheSizeInBytes
  const offthreadVideoCacheSizeInBytes = options.offthreadVideoCacheSizeInBytes ?? defaults.offthreadVideoCacheSizeInBytes
  const hardwareAcceleration = options.hardwareAcceleration === 'if-possible' && process.platform === 'darwin'
    ? 'if-possible'
    : 'disable'

  logger.info(`[RemotionRenderer] Render ${durationInFrames} frames (${videoDurationInSeconds}s @ ${fps}fps)` +
    (options.frameRange ? ` range=${options.frameRange[0]}-${options.frameRange[1]}` : ''))
  logger.info(`[RemotionRenderer] Resolution: ${resolution.width}x${resolution.height}`)
  logger.info(`[RemotionRenderer] Phrases: ${captionPlan?.phrases?.length ?? 0}`)
  logger.info(`[RemotionRenderer] ProofVisuals: ${proofVisuals?.length ?? 0}`)
  logger.info(`[RemotionRenderer] VisualGrammar: ${visualGrammar?.length ?? 0}`)
  logger.info(
    `[RemotionRenderer] concurrency=${concurrency} offthreadThreads=${offthreadVideoThreads} ` +
    `mediaCache=${Math.round(mediaCacheSizeInBytes / 1048576)}MB offthreadCache=${Math.round(offthreadVideoCacheSizeInBytes / 1048576)}MB hw=${hardwareAcceleration}`
  )

  const inputProps = {
    captionPlan: captionPlan ?? { enabled: true, activeRanges: [], phrases: [] },
    proofVisuals: proofVisuals ?? [],
    visualGrammar: visualGrammar ?? [],
    openingEvents: openingEvents ?? []
  }


  const composition = await selectComposition({
    serveUrl: bundleUrl,
    id: 'CaptionsOverlay',
    inputProps,
  })

  const runOnce = async (hw: 'disable' | 'if-possible'): Promise<void> => {
    const { cancelSignal, cancel } = makeCancelSignal()
    const onAbort = (): void => cancel()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      // 3. Render sang H264 MP4 — green screen, không cần alpha
      await renderMedia({
        composition: {
          ...composition,
          durationInFrames,
          fps,
          width: resolution.width,
          height: resolution.height,
        },
        serveUrl: bundleUrl,
        codec: 'h264',
        outputLocation: outputPath,
        inputProps,
        frameRange: options.frameRange ?? null,
        concurrency,
        offthreadVideoThreads,
        mediaCacheSizeInBytes,
        offthreadVideoCacheSizeInBytes,
        hardwareAcceleration: hw,
        // Hardware encoders do not support CRF — use an equivalent bitrate instead
        ...(hw === 'if-possible'
          ? { videoBitrate: String(bitrateForCrf(resolution.width, resolution.height, fps, 18)) }
          : {}),
        cancelSignal,
        onProgress: ({ progress }) => {
          const pct = Math.round(progress * 100)
          onRenderProgress?.(progress)
          logger.debug(`[RemotionRenderer] Render: ${pct}%`)
        },
      })
    } catch (err) {
      if (options.signal?.aborted) throw new RenderCancelledError()
      throw err
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  let hardwareFallback = false
  if (hardwareAcceleration === 'if-possible') {
    try {
      await runOnce('if-possible')
    } catch (err) {
      if (options.signal?.aborted) throw err
      logger.warn(`[RemotionRenderer] Hardware-accelerated render failed, retrying with software: ${String(err)}`)
      hardwareFallback = true
      await runOnce('disable')
    }
  } else {
    await runOnce('disable')
  }

  logger.info(`[RemotionRenderer] Overlay complete: ${outputPath}`)
  return { hardwareFallback }
}

/**
 * Xoá bundle cache — dùng khi cần force re-bundle (vd: sau khi update components).
 */
export function clearBundleCache(): void {
  cachedBundleUrl = null
  logger.info('[RemotionRenderer] Bundle cache cleared')
}
