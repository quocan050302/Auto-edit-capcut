import * as fs from 'fs'
import * as path from 'path'
import { IpcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'
import { renderVideo } from '../renderer'
import { logger } from '../logger'
import type { CaptionPlan } from '../../../shared/types'

export function registerRenderHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    IPC_CHANNELS.RENDER_START,
    async (event, params: {
      projectDir: string
      voiceoverPath: string
      outputName?: string
      resolution?: { width: number; height: number }
      fps?: number
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
}
