/**
 * captions.ipc.ts
 *
 * IPC handlers cho Dynamic Kinetic Captions Engine:
 *  - generate-plan: Gọi caption-planner (Gemini + fallback)
 *  - get-plan: Load caption-plan.json đã có
 *  - update-phrase: Sửa 1 phrase từ UI
 *  - toggle-range: Bật/tắt 1 activeRange
 *  - regenerate-ass: Tạo lại file .ass sau khi chỉnh sửa
 *  - preview-render: Render nhanh 5-10s có caption
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import { IpcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'
import { generateCaptionPlan, loadCaptionPlan, saveCaptionPlan } from '../captions/caption-planner'
import { generateAssFile } from '../captions/ass-generator'
import { logger } from '../logger'
import type { CaptionPlan, CaptionPhrase, CaptionActiveRange } from '../../../shared/types'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')


function ffmpegRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    const stderr: string[] = []
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-3).join('')}`))
    })
    proc.on('error', reject)
  })
}

export function registerCaptionHandlers(ipcMain: IpcMain): void {

  // ── generate-plan ──────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CAPTIONS_GENERATE_PLAN, async (event, params: {
    projectDir: string
    forceRegenerate?: boolean
    model?: string
  }) => {
    const win = BrowserWindow.fromWebContents(event.sender)

    const sendProgress = (msg: string, pct: number): void => {
      win?.webContents.send(IPC_CHANNELS.CAPTIONS_PROGRESS, { message: msg, progress: pct })
    }

    try {
      // Lấy Gemini API key từ config
      const configPath = path.join(os.homedir(), '.auto-edit-config.json')
      let apiKey = ''
      if (fs.existsSync(configPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
          apiKey = cfg.geminiApiKey ?? ''
        } catch { /* ignore */ }
      }

      // Fallback: lấy từ env
      if (!apiKey) apiKey = process.env.GEMINI_API_KEY ?? ''

      const plan = await generateCaptionPlan({
        projectDir: params.projectDir,
        apiKey,
        model: params.model,
        forceRegenerate: params.forceRegenerate ?? false,
        onProgress: sendProgress
      })

      return { success: true, plan }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[CaptionsIPC] generate-plan lỗi: ${msg}`)
      return { success: false, error: msg }
    }
  })

  // ── get-plan ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CAPTIONS_GET_PLAN, async (_event, projectDir: string) => {
    try {
      const plan = loadCaptionPlan(projectDir)
      return { success: true, plan }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── update-phrase ──────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CAPTIONS_UPDATE_PHRASE, async (_event, params: {
    projectDir: string
    phraseId: string
    updates: Partial<CaptionPhrase>
  }) => {
    try {
      const plan = loadCaptionPlan(params.projectDir)
      if (!plan) return { success: false, error: 'Chưa có caption-plan.json' }

      const idx = plan.phrases.findIndex(p => p.id === params.phraseId)
      if (idx === -1) return { success: false, error: `Không tìm thấy phrase id=${params.phraseId}` }

      plan.phrases[idx] = { ...plan.phrases[idx], ...params.updates }
      saveCaptionPlan(params.projectDir, plan)

      logger.info(`[CaptionsIPC] Đã cập nhật phrase ${params.phraseId}`)
      return { success: true, plan }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── toggle-range ───────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CAPTIONS_TOGGLE_RANGE, async (_event, params: {
    projectDir: string
    rangeIndex: number
    enabled: boolean
    captionEnabled?: boolean  // toggle tổng toàn plan
  }) => {
    try {
      const plan = loadCaptionPlan(params.projectDir)
      if (!plan) return { success: false, error: 'Chưa có caption-plan.json' }

      // Toggle tổng
      if (params.captionEnabled !== undefined) {
        plan.enabled = params.captionEnabled
      }

      // Toggle cụ thể 1 range (bằng cách remove khỏi activeRanges)
      if (params.rangeIndex >= 0 && params.rangeIndex < plan.activeRanges.length) {
        const range = plan.activeRanges[params.rangeIndex] as CaptionActiveRange & { disabled?: boolean }
        range.disabled = !params.enabled
      }

      saveCaptionPlan(params.projectDir, plan)
      return { success: true, plan }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── regenerate-ass ─────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CAPTIONS_REGENERATE_ASS, async (_event, params: {
    projectDir: string
  }) => {
    try {
      const plan = loadCaptionPlan(params.projectDir)
      if (!plan) return { success: false, error: 'Chưa có caption-plan.json' }

      const assPath = path.join(params.projectDir, 'assets', 'captions', 'captions.ass')
      const fontsDir = path.join(__dirname, '..', '..', '..', 'assets', 'fonts')
      generateAssFile(plan, assPath, fontsDir)

      logger.info(`[CaptionsIPC] Đã tạo lại file .ass: ${assPath}`)
      return { success: true, assPath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── preview-render ─────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CAPTIONS_PREVIEW_RENDER, async (event, params: {
    projectDir: string
    startTime: number
    endTime: number
  }) => {
    const win = BrowserWindow.fromWebContents(event.sender)

    const sendProgress = (msg: string, pct: number): void => {
      win?.webContents.send(IPC_CHANNELS.CAPTIONS_PROGRESS, { message: msg, progress: pct })
    }

    try {
      const plan = loadCaptionPlan(params.projectDir)
      if (!plan) return { success: false, error: 'Chưa có caption-plan.json' }

      // Tìm video output hiện có
      const outputDir = path.join(params.projectDir, 'output')
      const possibleVideos = ['final_output.mp4', 'preview_source.mp4']
      let sourceVideo: string | null = null
      for (const v of possibleVideos) {
        const vp = path.join(outputDir, v)
        if (fs.existsSync(vp)) { sourceVideo = vp; break }
      }

      // Fallback: tìm raw_video nếu chưa có final output
      if (!sourceVideo) {
        const tmpRaw = path.join(os.tmpdir(), `auto-edit-render-${Buffer.from(params.projectDir).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`, 'raw_video.mp4')
        if (fs.existsSync(tmpRaw)) sourceVideo = tmpRaw
      }

      if (!sourceVideo) {
        return { success: false, error: 'Chưa có video source để preview — render video trước' }
      }

      sendProgress('Đang cắt đoạn preview...', 0.1)

      // Cắt đoạn ngắn để preview
      const previewDir = path.join(params.projectDir, 'output', '_preview_tmp')
      fs.mkdirSync(previewDir, { recursive: true })

      const clipPath = path.join(previewDir, 'preview_clip.mp4')
      const duration = Math.min(params.endTime - params.startTime, 15)  // max 15s

      await ffmpegRun([
        '-y',
        '-ss', String(params.startTime),
        '-i', sourceVideo,
        '-t', String(duration),
        '-c', 'copy',
        clipPath
      ])

      sendProgress('Đang burn captions vào preview...', 0.50)

      // Lọc phrases trong khoảng preview, chỉnh lại thời gian tương đối
      const previewPhrases = plan.phrases
        .filter(p => p.startTime >= params.startTime && p.endTime <= params.endTime + 1)
        .map(p => ({
          ...p,
          startTime: p.startTime - params.startTime,
          endTime: p.endTime - params.startTime
        }))

      const previewPlan: CaptionPlan = {
        ...plan,
        phrases: previewPhrases
      }

      const assPath = path.join(previewDir, 'preview_captions.ass')
      const fontsDir = path.join(__dirname, '..', '..', '..', 'assets', 'fonts')
      generateAssFile(previewPlan, assPath, fontsDir)

      const previewOutput = path.join(previewDir, 'preview_captioned.mp4')
      const assFilterPath = process.platform === 'win32'
        ? assPath.replace(/\\/g, '/').replace(/:/g, '\\:')
        : assPath.replace(/:/g, '\\:')

      await ffmpegRun([
        '-y',
        '-i', clipPath,
        '-vf', `ass='${assFilterPath}':fontsdir='${fontsDir}'`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
        '-c:a', 'copy',
        previewOutput
      ])

      sendProgress('Preview xong!', 1.0)
      logger.info(`[CaptionsIPC] Preview render: ${previewOutput}`)
      return { success: true, previewPath: previewOutput }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[CaptionsIPC] preview-render lỗi: ${msg}`)
      return { success: false, error: msg }
    }
  })
}
