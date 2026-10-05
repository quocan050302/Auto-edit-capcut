import { app, BrowserWindow, ipcMain, shell, protocol, net } from 'electron'
import { join, normalize } from 'path'
import { pathToFileURL } from 'url'
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
import { registerThumbnailHandlers } from './ipc/thumbnail.ipc'
import { pipelineOrchestrator } from './pipeline/pipeline-orchestrator'
import { thumbnailOrchestrator } from './thumbnail/thumbnail-orchestrator'
import { flowkitRuntimeManager } from './thumbnail/flowkit-runtime-manager'
import { googleFlowClient } from './thumbnail/google-flow-client'
import { logger } from './logger'
import { renderJobCoordinator } from './render-cache/render-job-coordinator'
import {
  getLiveRenderProcessCount,
  getLiveRenderProcessPids,
  terminateAllRenderProcesses
} from './render-cache/ffmpeg-process'

// Initialize FlowKit Runtime Manager with persisted settings BEFORE IPC is registered.
// This ensures any UI startup health checks use the correct saved bridge URL.
flowkitRuntimeManager.initialize(googleFlowClient)

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

  // ── Register safe local-file protocol for renderer image access ──────────
  // Usage: <img src="app-media:///absolute/path/to/file.png" />
  // Serves any file path prefixed with app-media:///. This avoids the CSP
  // restriction on raw file:// URLs while keeping webSecurity enabled.
  protocol.handle('app-media', (request) => {
    // Strip the protocol prefix to get the absolute path
    // e.g. app-media:///Users/foo/bar.png → /Users/foo/bar.png
    const rawPath = request.url.slice('app-media://'.length)
    const decoded = decodeURIComponent(rawPath)
    const normalized = normalize(decoded)
    return net.fetch(pathToFileURL(normalized).href)
  })

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
  registerThumbnailHandlers(ipcMain)

  // Asynchronously launch YouTube Research sidecar (non-blocking, failures do NOT crash app)
  researchSidecar.start().catch((err) => {
    logger.warn('[ResearchSidecar] Non-blocking startup error:', err)
  })

  const mainWindow = createWindow()

  // Auto-start FlowKit bridge in background if configured (non-blocking)
  flowkitRuntimeManager.autoStartIfConfigured()

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

let renderShutdownStarted = false

app.on('before-quit', (event) => {
  pipelineOrchestrator.handleAppQuit()
  researchSidecar.markAppQuitting()
  researchSidecar.stop().catch((error) => {
    logger.warn('[ResearchSidecar] Failed to stop during app quit:', error)
  })
  thumbnailOrchestrator.handleAppQuit()
  flowkitRuntimeManager.handleAppQuit()

  // Resumable Render Engine V2: stop render jobs as "app-closed" (interrupted, not
  // cancelled), flush manifests and terminate FFmpeg/Remotion before quitting.
  if (!renderShutdownStarted && (renderJobCoordinator.hasAnyActive() || getLiveRenderProcessCount() > 0)) {
    renderShutdownStarted = true
    event.preventDefault()
    void (async () => {
      try {
        await renderJobCoordinator.abortAll('app-closed', 4000)
        await terminateAllRenderProcesses(1500)
      } catch (err) {
        logger.warn(`[App] Render shutdown error: ${String(err)}`)
      } finally {
        app.quit()
      }
    })()
  }
})

process.on('exit', () => {
  // Last resort: never leave an FFmpeg child running after the app is gone
  for (const pid of getLiveRenderProcessPids()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

process.on('uncaughtException', (error) => {
  logger.error('[App] Uncaught exception:', error)
  try {
    pipelineOrchestrator.handleAppQuit()
    thumbnailOrchestrator.handleAppQuit()
    flowkitRuntimeManager.handleAppQuit()
    researchSidecar.markAppQuitting()
    researchSidecar.stop().catch(() => {})
  } catch {
    /* ignore */
  }
})

process.on('unhandledRejection', (reason) => {
  logger.error('[App] Unhandled rejection:', reason)
})

