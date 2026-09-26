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
import { renderMedia, selectComposition } from '@remotion/renderer'
import { logger } from '../logger'
import type { CaptionPlan } from '../../../shared/types'

// Cache bundle URL để tránh re-bundle mỗi lần render
let cachedBundleUrl: string | null = null

/**
 * Lấy (hoặc tạo mới) Remotion bundle URL.
 * Bundle compile chạy trong worker của @remotion/bundler (Webpack).
 */
async function getBundle(onProgress?: (pct: number) => void): Promise<string> {
  if (cachedBundleUrl) {
    logger.info('[RemotionRenderer] Dùng bundle cache')
    return cachedBundleUrl
  }

  logger.info('[RemotionRenderer] Đang bundle Remotion composition...')

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
  videoDurationInSeconds: number
  outputPath: string        // vd: assets/captions/overlay.webm
  fps?: number
  resolution?: { width: number; height: number }
  onBundleProgress?: (pct: number) => void
  onRenderProgress?: (pct: number) => void
}

/**
 * renderCaptionsOverlay — render toàn bộ caption plan thành 1 file WebM alpha.
 *
 * @param options - cấu hình render
 * @throws nếu Remotion bundle/render thất bại
 */
export async function renderCaptionsOverlay(options: RemotionRenderOptions): Promise<void> {
  const {
    captionPlan,
    videoDurationInSeconds,
    outputPath,
    fps = 30,
    resolution = { width: 1920, height: 1080 },
    onBundleProgress,
    onRenderProgress,
  } = options

  // Tạo thư mục output nếu chưa có
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  // 1. Bundle
  const bundleUrl = await getBundle(onBundleProgress)

  // 2. Chọn composition với metadata override
  const durationInFrames = Math.ceil(videoDurationInSeconds * fps)

  logger.info(`[RemotionRenderer] Render ${durationInFrames} frames (${videoDurationInSeconds}s @ ${fps}fps)`)
  logger.info(`[RemotionRenderer] Resolution: ${resolution.width}×${resolution.height}`)
  logger.info(`[RemotionRenderer] Phrases: ${captionPlan.phrases.length}`)

  const composition = await selectComposition({
    serveUrl: bundleUrl,
    id: 'CaptionsOverlay',
    inputProps: { captionPlan },
  })

  // 3. Render sang WebM VP8 + yuva420p (alpha channel thật sự)
  await renderMedia({
    composition: {
      ...composition,
      durationInFrames,
      fps,
      width: resolution.width,
      height: resolution.height,
    },
    serveUrl: bundleUrl,
    codec: 'h264',              // H264 MP4 — không cần alpha, dùng green screen
    // Không cần pixelFormat/imageFormat — mặc định yuv420p là đủ
    outputLocation: outputPath,
    inputProps: { captionPlan },
    onProgress: ({ progress }) => {
      const pct = Math.round(progress * 100)
      onRenderProgress?.(progress)
      logger.debug(`[RemotionRenderer] Render: ${pct}%`)
    },
  })

  logger.info(`[RemotionRenderer] Overlay xong: ${outputPath}`)
}

/**
 * Xoá bundle cache — dùng khi cần force re-bundle (vd: sau khi update components).
 */
export function clearBundleCache(): void {
  cachedBundleUrl = null
  logger.info('[RemotionRenderer] Bundle cache đã xoá')
}
