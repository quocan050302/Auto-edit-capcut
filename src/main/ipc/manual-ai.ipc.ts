import { BrowserWindow, dialog, IpcMain, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC_CHANNELS } from '../../../shared/types'
import type { ManualAiImportMapping, ManualAiStatus } from '../../../shared/types'
import { logger } from '../logger'
import { normalizeProjectDir } from '../pipeline/pipeline-state'
import { MANUAL_AI_SUPPORTED_EXTENSIONS, getManualAiPromptTxtPath } from '../visual-mix/manual-ai/manual-ai-types'
import { readManualAiPromptText } from '../visual-mix/manual-ai/manual-ai-prompt-pack'
import { commitManualAiImport, planManualAiImport } from '../visual-mix/manual-ai/manual-ai-importer'
import { manualAiAssetGate } from '../visual-mix/manual-ai/manual-ai-gate'
import {
  getManualAiStatus,
  broadcastManualAiStatus
} from '../visual-mix/manual-ai/manual-ai-broadcaster'

export { getManualAiStatus, broadcastManualAiStatus }

function listImagesInFolder(folder: string): string[] {
  try {
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((d) => d.isFile() && MANUAL_AI_SUPPORTED_EXTENSIONS.includes(path.extname(d.name).toLowerCase()))
      .map((d) => path.join(folder, d.name))
  } catch {
    return []
  }
}

export function registerManualAiHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.MANUAL_AI_GET_STATUS, async (_event, params: { projectDir: string }) => {
    try {
      if (!params?.projectDir) return null
      const norm = normalizeProjectDir(params.projectDir)
      logger.debug(`[ManualAI:GetStatus] projectDir=${norm}`)
      return getManualAiStatus(norm)
    } catch (err) {
      logger.error(`[ManualAI-IPC] GetStatus failed: ${String(err)}`)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.MANUAL_AI_GET_PROMPT_TEXT, async (_event, params: { projectDir: string }) => {
    try {
      if (!params?.projectDir) return { success: false, error: 'projectDir is required.' }
      const norm = normalizeProjectDir(params.projectDir)
      const text = readManualAiPromptText(norm)
      if (text === null) return { success: false, error: 'No prompt pack exists yet.' }
      return { success: true, text }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.MANUAL_AI_EXPORT_TXT, async (_event, params: { projectDir: string }) => {
    try {
      if (!params?.projectDir) return { success: false, error: 'projectDir is required.' }
      const norm = normalizeProjectDir(params.projectDir)
      const text = readManualAiPromptText(norm)
      if (text === null) return { success: false, error: 'No prompt pack exists yet.' }

      const opts = {
        title: 'Export AI image prompts',
        defaultPath: path.join(norm, 'manual-ai-prompts.txt'),
        filters: [{ name: 'Text', extensions: ['txt'] }]
      }
      const win = BrowserWindow.getFocusedWindow()
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { success: false, canceled: true }
      // Exact conceptual format: one prompt line, ONE blank line, next prompt line (UTF-8, no markdown).
      fs.writeFileSync(res.filePath, text + '\n', 'utf-8')
      return { success: true, filePath: res.filePath }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.MANUAL_AI_OPEN_PROMPT_FILE, async (_event, params: { projectDir: string }) => {
    try {
      if (!params?.projectDir) return { success: false, error: 'projectDir is required.' }
      const norm = normalizeProjectDir(params.projectDir)
      const txt = getManualAiPromptTxtPath(norm)
      if (!fs.existsSync(txt)) return { success: false, error: 'Prompt file does not exist yet.' }
      const openError = await shell.openPath(txt)
      if (openError) {
        shell.showItemInFolder(txt)
      }
      return { success: true, filePath: txt }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.MANUAL_AI_SELECT_IMAGES,
    async (_event, params: { mode: 'files' | 'folder' }) => {
      try {
        const folder = params?.mode === 'folder'
        const opts: Electron.OpenDialogOptions = folder
          ? { title: 'Select the folder with your AI images', properties: ['openDirectory'] }
          : {
              title: 'Select AI images',
              properties: ['openFile', 'multiSelections'],
              filters: [
                {
                  name: 'Images',
                  extensions: MANUAL_AI_SUPPORTED_EXTENSIONS.map((e) => e.replace('.', ''))
                }
              ]
            }
        const win = BrowserWindow.getFocusedWindow()
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (res.canceled || res.filePaths.length === 0) return { success: true, filePaths: [], canceled: true }
        const filePaths = folder ? listImagesInFolder(res.filePaths[0]) : res.filePaths
        return { success: true, filePaths }
      } catch (err) {
        return { success: false, filePaths: [], error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MANUAL_AI_PLAN_IMPORT,
    async (_event, params: { projectDir: string; filePaths: string[]; replaceExisting?: boolean }) => {
      try {
        if (!params?.projectDir || !Array.isArray(params.filePaths)) {
          return { success: false, error: 'projectDir and filePaths are required.' }
        }
        const norm = normalizeProjectDir(params.projectDir)
        const plan = planManualAiImport({
          projectDir: norm,
          filePaths: params.filePaths,
          replaceExisting: params.replaceExisting
        })
        return { success: true, plan }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MANUAL_AI_COMMIT_IMPORT,
    async (
      _event,
      params: {
        projectDir: string
        mappings: ManualAiImportMapping[]
        replaceExisting?: boolean
        allowLowResolution?: boolean
      }
    ) => {
      try {
        if (!params?.projectDir || !Array.isArray(params.mappings)) {
          return { success: false, error: 'projectDir and mappings are required.' }
        }
        const norm = normalizeProjectDir(params.projectDir)
        const result = await commitManualAiImport({
          projectDir: norm,
          mappings: params.mappings,
          replaceExisting: params.replaceExisting,
          allowLowResolution: params.allowLowResolution
        })
        broadcastManualAiStatus(norm, result.status)
        return { success: true, result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ManualAI-IPC] Commit failed: ${msg}`)
        // Wake any waiter anyway so a half-written import is re-evaluated.
        manualAiAssetGate.notify(params?.projectDir ? normalizeProjectDir(params.projectDir) : '')
        return { success: false, error: msg }
      }
    }
  )
}
