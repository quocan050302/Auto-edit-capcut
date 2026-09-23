import { IpcMain, dialog, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types'

function getWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  // Use the window that sent the IPC message — more reliable than getFocusedWindow()
  return BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0] ?? null
}

export function registerFsHandlers(ipcMain: IpcMain): void {
  // Open file dialog
  ipcMain.handle(
    IPC_CHANNELS.SELECT_FILE,
    async (
      event,
      options: {
        title: string
        filters?: Electron.FileFilter[]
        defaultPath?: string
      }
    ) => {
      const win = getWindow(event)
      const dialogOptions: Electron.OpenDialogOptions = {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters || [],
        properties: ['openFile']
      }

      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)

      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )

  // Open folder dialog
  ipcMain.handle(
    IPC_CHANNELS.SELECT_FOLDER,
    async (
      event,
      options: {
        title: string
        defaultPath?: string
      }
    ) => {
      const win = getWindow(event)
      const dialogOptions: Electron.OpenDialogOptions = {
        title: options.title,
        defaultPath: options.defaultPath,
        properties: ['openDirectory']
      }

      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)

      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )
}
