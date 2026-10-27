import { IpcMain, BrowserWindow, dialog } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'
import { logger } from '../logger'
import { simpleAssemblyController } from '../simple-assembly/simple-assembly-controller'
import {
  loadProductionModeSettings,
  saveProductionModeSettings
} from '../simple-assembly/production-mode-settings'
import type {
  SimpleAssemblyRequest,
  VideoProductionModeSettings
} from '../simple-assembly/simple-assembly-types'

export function registerSimpleAssemblyHandlers(ipcMain: IpcMain): void {
  // ── Start Simple Assembly ──────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.SIMPLE_ASSEMBLY_START,
    async (event, request: SimpleAssemblyRequest) => {
      try {
        if (!request?.projectDir) {
          return { success: false, error: 'projectDir is required for Simple Assembly.' }
        }
        if (!request?.voiceoverPath) {
          return { success: false, error: 'voiceoverPath is required for Simple Assembly.' }
        }

        const win = BrowserWindow.fromWebContents(event.sender)
        const result = await simpleAssemblyController.startAssembly(request, win)
        return result
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[SimpleAssemblyIPC] Start failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ── Cancel Simple Assembly ────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.SIMPLE_ASSEMBLY_CANCEL,
    async (_event, params: { projectDir: string }) => {
      try {
        if (!params?.projectDir) {
          return { success: false, error: 'projectDir is required to cancel assembly.' }
        }
        const ok = simpleAssemblyController.cancelAssembly(params.projectDir)
        return { success: ok }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[SimpleAssemblyIPC] Cancel failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ── Get Simple Assembly Status ────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.SIMPLE_ASSEMBLY_STATUS_GET,
    async (_event, params: { projectDir: string }) => {
      try {
        if (!params?.projectDir) return null
        return simpleAssemblyController.getStatus(params.projectDir)
      } catch (err: unknown) {
        logger.error(`[SimpleAssemblyIPC] GetStatus failed: ${String(err)}`)
        return null
      }
    }
  )

  // ── Select Scene Video Folder ─────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.SIMPLE_ASSEMBLY_SELECT_SCENE_FOLDER,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const res = await dialog.showOpenDialog(win!, {
        title: 'Select Scene Video Folder (Simple Assembly)',
        properties: ['openDirectory']
      })
      if (res.canceled || res.filePaths.length === 0) return null
      return res.filePaths[0]
    }
  )

  // ── Get Production Mode Settings ──────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.PRODUCTION_MODE_SETTINGS_GET,
    async (_event, params: { projectDir: string }) => {
      try {
        const settings = loadProductionModeSettings(params?.projectDir)
        return { success: true, settings }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // ── Update Production Mode Settings ───────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.PRODUCTION_MODE_SETTINGS_UPDATE,
    async (_event, params: { projectDir: string; patch: Partial<VideoProductionModeSettings> }) => {
      try {
        if (!params?.projectDir) {
          return { success: false, error: 'projectDir is required.' }
        }
        const updated = saveProductionModeSettings(params.projectDir, params.patch || {})
        return { success: true, settings: updated }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )
}
