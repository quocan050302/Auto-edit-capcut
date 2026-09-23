import { IpcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'
import { renderVideo } from '../renderer'
import { logger } from '../logger'

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
        const result = await renderVideo({
          ...params,
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
