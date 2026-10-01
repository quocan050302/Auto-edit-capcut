import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerFsHandlers } from './ipc/fs.ipc'
import { registerProjectHandlers } from './ipc/project.ipc'
import { registerMediaHandlers } from './ipc/media.ipc'
import { registerTranscribeHandlers } from './ipc/transcribe.ipc'
import { registerPlannerHandlers } from './ipc/planner.ipc'
import { registerRenderHandlers } from './ipc/render.ipc'
import { registerStockHandlers } from './ipc/stock.ipc'
import { registerAudioHandlers } from './ipc/audio.ipc'
import { registerCaptionHandlers } from './ipc/captions.ipc'
import { registerPipelineHandlers } from './ipc/pipeline.ipc'
import { registerResearchHandlers } from './ipc/research.ipc'
import { researchSidecar } from './research/research-sidecar'
import { pipelineOrchestrator } from './pipeline/pipeline-orchestrator'
import { logger } from './logger'

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    logger.info('Main window shown')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.videofactory.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Register all IPC handlers
  registerFsHandlers(ipcMain)
  registerProjectHandlers(ipcMain)
  registerMediaHandlers(ipcMain)
  registerTranscribeHandlers(ipcMain)
  registerPlannerHandlers(ipcMain)
  registerRenderHandlers(ipcMain)
  registerStockHandlers(ipcMain)
  registerAudioHandlers(ipcMain)
  registerCaptionHandlers(ipcMain)
  registerPipelineHandlers(ipcMain)
  registerResearchHandlers(ipcMain)

  // Asynchronously launch YouTube Research sidecar (non-blocking, failures do NOT crash app)
  researchSidecar.start().catch((err) => {
    logger.warn('[ResearchSidecar] Non-blocking startup error:', err)
  })

  const mainWindow = createWindow()

  // Window control IPC
  ipcMain.on('window:minimize', () => mainWindow.minimize())
  ipcMain.on('window:maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow.close())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  logger.info('Long-Form AI Video Factory started', { version: app.getVersion() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  pipelineOrchestrator.handleAppQuit()
  researchSidecar.stop().catch(() => {})
})

process.on('uncaughtException', (error) => {
  logger.error('[App] Uncaught exception:', error)
  try {
    pipelineOrchestrator.handleAppQuit()
    researchSidecar.stop().catch(() => {})
  } catch {
    /* ignore */
  }
})

process.on('unhandledRejection', (reason) => {
  logger.error('[App] Unhandled rejection:', reason)
})

