import { IpcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'
import { buildEditPlan } from '../planner'
import { loadConfig, saveConfig, getConfigPath } from '../config'
import { join } from 'path'
import * as fs from 'fs'
import { logger } from '../logger'

export function registerPlannerHandlers(ipcMain: IpcMain): void {
  // Save API key
  ipcMain.handle(IPC_CHANNELS.CONFIG_SET, (_event, key: string, value: string) => {
    const config = loadConfig()
    ;(config as Record<string, string>)[key] = value
    saveConfig(config)
    return { success: true }
  })

  // Load config value
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, (_event, key: string) => {
    const config = loadConfig()
    return (config as Record<string, string>)[key] ?? null
  })

  // Get edit plan if exists
  ipcMain.handle(IPC_CHANNELS.PLAN_GET, (_event, projectDir: string) => {
    const planPath = join(projectDir, 'analysis', 'master-edit-plan.json')
    if (!fs.existsSync(planPath)) return null
    try {
      return JSON.parse(fs.readFileSync(planPath, 'utf-8'))
    } catch {
      return null
    }
  })

  // Run AI edit planning
  ipcMain.handle(
    IPC_CHANNELS.PLAN_GENERATE,
    async (event, params: { projectDir: string; model?: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const config = loadConfig()

      if (!config.geminiApiKey) {
        return { success: false, error: 'Gemini API key not configured. Go to Settings to add it.' }
      }

      const sendProgress = (message: string, progress: number): void => {
        win?.webContents.send(IPC_CHANNELS.PLAN_PROGRESS, { message, progress })
      }

      try {
        const plan = await buildEditPlan({
          projectDir: params.projectDir,
          apiKey: config.geminiApiKey,
          model: params.model,
          onProgress: sendProgress
        })
        return { success: true, plan }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`Edit planning failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )
}
