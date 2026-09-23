import { IpcMain, dialog, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'

export function registerFsHandlers(ipcMain: IpcMain): void {
  // Open file dialog
  ipcMain.handle(
    IPC_CHANNELS.SELECT_FILE,
    async (
      _event,
      options: {
        title: string
        filters?: Electron.FileFilter[]
        defaultPath?: string
      }
    ) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return null

      const result = await dialog.showOpenDialog(win, {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters || [],
        properties: ['openFile']
      })

      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )

  // Open folder dialog
  ipcMain.handle(
    IPC_CHANNELS.SELECT_FOLDER,
    async (
      _event,
      options: {
        title: string
        defaultPath?: string
      }
    ) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return null

      const result = await dialog.showOpenDialog(win, {
        title: options.title,
        defaultPath: options.defaultPath,
        properties: ['openDirectory']
      })

      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )
}
