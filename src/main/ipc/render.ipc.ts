import * as fs from 'fs'
import * as path from 'path'
import { IpcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'
import { renderVideo } from '../renderer'
import { logger } from '../logger'
import { runRenderPreflight } from '../qa/render-preflight'
import { readJsonSafe } from '../production-intelligence/json-store'
import type { CaptionPlan, RenderTransitionSettings, RenderQaReport } from '../../../shared/types'


export function registerRenderHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    IPC_CHANNELS.RENDER_START,
    async (event, params: {
      projectDir: string
      voiceoverPath: string
      outputName?: string
      resolution?: { width: number; height: number }
      fps?: number
      transitionSettings?: RenderTransitionSettings
    }) => {
      const win = BrowserWindow.fromWebContents(event.sender)

      const sendProgress = (p: {
        stage: string
        sceneIndex?: number
        totalScenes?: number
        progress: number
      }): void => {
        win?.webContents.send(IPC_CHANNELS.RENDER_PROGRESS, p)
      }

      try {
        // Load caption plan nếu đã generate (optional — không làm hỏng render nếu không có)
        let captionPlan: CaptionPlan | undefined = undefined
        const captionPlanPath = path.join(params.projectDir, 'analysis', 'caption-plan.json')
        if (fs.existsSync(captionPlanPath)) {
          try {
            const loaded = JSON.parse(fs.readFileSync(captionPlanPath, 'utf-8')) as CaptionPlan
            if (loaded.enabled && loaded.phrases?.length > 0) {
              captionPlan = loaded
              logger.info(`[RenderIPC] Caption plan loaded: ${loaded.phrases.length} phrases, enabled=${loaded.enabled}`)
            } else {
              logger.info(`[RenderIPC] Caption plan exists but disabled or empty (enabled=${loaded.enabled}, phrases=${loaded.phrases?.length ?? 0})`)
            }
          } catch (e) {
            logger.warn(`[RenderIPC] Không đọc được caption-plan.json: ${String(e)}`)
          }
        } else {
          logger.info('[RenderIPC] Không có caption-plan.json — bỏ qua burn captions')
        }

        const result = await renderVideo({
          ...params,
          captionPlan,        // truyền vào renderer — undefined = bỏ qua burn step
          onProgress: sendProgress
        })
        return { success: true, result }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`Render failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ── Preflight QA ────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.RENDER_PREFLIGHT_RUN,
    async (event, params: { projectDir: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      win?.webContents.send(IPC_CHANNELS.RENDER_QA_PROGRESS, {
        stage: 'preflight',
        progress: 0.2,
        message: 'Running preflight checks...'
      })

      let captionPlan: CaptionPlan | undefined = undefined
      const captionPlanPath = path.join(params.projectDir, 'analysis', 'caption-plan.json')
      if (fs.existsSync(captionPlanPath)) {
        try {
          captionPlan = JSON.parse(fs.readFileSync(captionPlanPath, 'utf-8'))
        } catch { /* ignore */ }
      }

      let voiceoverPath: string | undefined
      try {
        const stateFile = fs.existsSync(path.join(params.projectDir, 'project-state.json'))
          ? path.join(params.projectDir, 'project-state.json')
          : path.join(params.projectDir, 'project.json')
        if (fs.existsSync(stateFile)) {
          const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
          voiceoverPath = st?.inputs?.voiceoverPath
        }
      } catch { /* ignore */ }

      const report = await runRenderPreflight({
        projectDir: params.projectDir,
        voiceoverPath,
        captionPlan
      })

      win?.webContents.send(IPC_CHANNELS.RENDER_QA_PROGRESS, {
        stage: 'preflight',
        progress: 1.0,
        message: `Preflight completed: ${report.status}`
      })

      return report
    }
  )

  // ── QA Report Get ───────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.RENDER_QA_GET,
    (_event, params: { projectDir: string }) => {
      const qaPath = path.join(params.projectDir, 'analysis', 'render-qa.json')
      const preflightPath = path.join(params.projectDir, 'analysis', 'render-preflight.json')
      if (fs.existsSync(qaPath)) {
        return readJsonSafe<RenderQaReport | null>(qaPath, null)
      }
      if (fs.existsSync(preflightPath)) {
        return readJsonSafe<RenderQaReport | null>(preflightPath, null)
      }
      return null
    }
  )
}

