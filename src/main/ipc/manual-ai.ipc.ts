import { BrowserWindow, dialog, IpcMain, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC_CHANNELS } from '../../../shared/types'
import type { ManualAiImportMapping, ManualAiStatus } from '../../../shared/types'
import { logger } from '../logger'
import { normalizeProjectDir } from '../pipeline/pipeline-state'
import {
  MANUAL_AI_SUPPORTED_EXTENSIONS,
  MANUAL_AI_VIDEO_EXTENSIONS,
  MANUAL_AI_MIXED_EXTENSIONS,
  getManualAiPromptTxtPath
} from '../visual-mix/manual-ai/manual-ai-types'
import { readManualAiPromptText, loadManualAiPromptPack } from '../visual-mix/manual-ai/manual-ai-prompt-pack'
import { commitManualAiImport, naturalCompare, planManualAiImport } from '../visual-mix/manual-ai/manual-ai-importer'
import {
  ensureManualAiVideoPromptPack,
  formatManualAiVideoPromptText
} from '../visual-mix/manual-ai/manual-ai-video-prompt-pack'
import { buildOpeningEnhancedCopyText } from '../visual-mix/manual-ai/manual-ai-opening-hook-copy'
import {
  listMixedMediaInFolder,
  countMixedMedia,
  MAX_MIXED_FOLDER_DEPTH
} from '../visual-mix/manual-ai/manual-ai-mixed-media'
import { manualAiAssetGate } from '../visual-mix/manual-ai/manual-ai-gate'
import {
  getManualAiStatus,
  broadcastManualAiStatus
} from '../visual-mix/manual-ai/manual-ai-broadcaster'

export { getManualAiStatus, broadcastManualAiStatus, listMixedMediaInFolder }

export const MAX_DISCOVERED_VIDEOS = 250
export const MAX_VIDEO_FOLDER_DEPTH = 3

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

/**
 * Bounded recursive discovery of video files up to maxDepth.
 * Skips symlinks and hidden directories. Sorts deterministically using naturalCompare.
 * Implements a safety limit of MAX_DISCOVERED_VIDEOS (250).
 */
export function listVideosInFolder(
  folder: string,
  maxDepth = MAX_VIDEO_FOLDER_DEPTH,
  warningsOut?: string[]
): string[] {
  if (!fs.existsSync(folder)) {
    throw new Error(`Folder does not exist: ${folder}`)
  }
  const rootStat = fs.statSync(folder)
  if (!rootStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${folder}`)
  }

  const discovered: string[] = []
  let hitLimit = false

  function traverse(currentDir: string, currentDepth: number): void {
    if (hitLimit || currentDepth > maxDepth) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch (err) {
      const msg = `Unable to read directory: ${currentDir} (${err instanceof Error ? err.message : String(err)})`
      logger.warn(`[ManualAI:VideoFolder] ${msg}`)
      warningsOut?.push(msg)
      return
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue

      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        if (currentDepth < maxDepth) {
          traverse(fullPath, currentDepth + 1)
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (MANUAL_AI_VIDEO_EXTENSIONS.includes(ext)) {
          if (discovered.length >= MAX_DISCOVERED_VIDEOS) {
            hitLimit = true
            const limitMsg = `Discovered video files reached safety limit of ${MAX_DISCOVERED_VIDEOS}. Extra files omitted.`
            logger.warn(`[ManualAI:VideoFolder] ${limitMsg}`)
            warningsOut?.push(limitMsg)
            break
          }
          discovered.push(fullPath)
        }
      }
    }
  }

  traverse(folder, 0)
  return discovered.sort((a, b) => {
    const baseCmp = naturalCompare(path.basename(a), path.basename(b))
    return baseCmp !== 0 ? baseCmp : naturalCompare(a, b)
  })
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

      const pack = loadManualAiPromptPack(norm)
      if (!pack || !pack.scenes || pack.scenes.length === 0) {
        return { success: true, text }
      }

      const enhancedText = buildOpeningEnhancedCopyText({
        mode: 'image',
        projectDir: norm,
        baseEntries: pack.scenes.map((s) => ({ sceneIndex: s.sceneIndex, prompt: s.prompt }))
      })

      return { success: true, text: enhancedText }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.MANUAL_AI_GET_VIDEO_PROMPT_TEXT, async (_event, params: { projectDir: string }) => {
    try {
      if (!params?.projectDir) return { success: false, error: 'projectDir is required.' }
      const norm = normalizeProjectDir(params.projectDir)
      logger.info(`[ManualAI:VideoPrompt] Generating video prompt text for projectDir=${norm}`)
      const pack = ensureManualAiVideoPromptPack(norm)

      const enhancedText = buildOpeningEnhancedCopyText({
        mode: 'video',
        projectDir: norm,
        baseEntries: pack.scenes.map((s) => ({ sceneIndex: s.sceneIndex, prompt: s.prompt }))
      })

      logger.info(`[ManualAI:VideoPrompt] Successfully generated ${pack.scenes.length} video prompts with opening visual hooks`)
      return { success: true, text: enhancedText }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[ManualAI:VideoPrompt] Get video prompt text failed: ${msg}`)
      return { success: false, error: msg }
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

  // Separate picker: leaves MANUAL_AI_SELECT_IMAGES and its original filters unchanged.
  ipcMain.handle(IPC_CHANNELS.MANUAL_AI_SELECT_VIDEOS, async (_event, params: { mode: 'files' | 'folder' }) => {
    try {
      const folder = params?.mode === 'folder'
      const opts: Electron.OpenDialogOptions = folder
        ? { title: 'Select the folder with your AI videos', properties: ['openDirectory'] }
        : {
            title: 'Select AI videos',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Videos', extensions: MANUAL_AI_VIDEO_EXTENSIONS.map((e) => e.slice(1)) }]
          }
      const win = BrowserWindow.getFocusedWindow()
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (res.canceled || res.filePaths.length === 0) return { success: true, filePaths: [], canceled: true }

      if (folder) {
        const warnings: string[] = []
        const folderPath = res.filePaths[0]
        const filePaths = listVideosInFolder(folderPath, MAX_VIDEO_FOLDER_DEPTH, warnings)
        logger.info(`[ManualAI:VideoFolder] Discovered ${filePaths.length} videos in ${folderPath}`)
        return {
          success: true,
          filePaths,
          folderPath,
          discoveredCount: filePaths.length,
          warnings: warnings.length > 0 ? warnings : undefined
        }
      }

      return {
        success: true,
        filePaths: res.filePaths,
        discoveredCount: res.filePaths.length
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[ManualAI:VideoFolder] Select videos failed: ${msg}`)
      return { success: false, filePaths: [], error: msg }
    }
  })

  // Mixed media picker: leaves MANUAL_AI_SELECT_IMAGES and MANUAL_AI_SELECT_VIDEOS unchanged.
  ipcMain.handle(IPC_CHANNELS.MANUAL_AI_SELECT_MIXED, async (_event, params: { mode: 'files' | 'folder' }) => {
    try {
      const folder = params?.mode === 'folder'
      const opts: Electron.OpenDialogOptions = folder
        ? { title: 'Select the folder with your AI images and videos', properties: ['openDirectory'] }
        : {
            title: 'Select AI images and videos',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Media (Images & Videos)', extensions: MANUAL_AI_MIXED_EXTENSIONS.map((e) => e.slice(1)) }]
          }
      const win = BrowserWindow.getFocusedWindow()
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (res.canceled || res.filePaths.length === 0) return { success: true, filePaths: [], canceled: true }

      if (folder) {
        const warnings: string[] = []
        const folderPath = res.filePaths[0]
        const filePaths = listMixedMediaInFolder(folderPath, MAX_MIXED_FOLDER_DEPTH, warnings)
        const { imageCount, videoCount } = countMixedMedia(filePaths)
        logger.info(`[ManualAI:MixedFolder] Discovered ${filePaths.length} media files (${imageCount} images, ${videoCount} videos) in ${folderPath}`)
        return {
          success: true,
          filePaths,
          folderPath,
          discoveredCount: filePaths.length,
          imageCount,
          videoCount,
          warnings: warnings.length > 0 ? warnings : undefined
        }
      }

      const { imageCount, videoCount } = countMixedMedia(res.filePaths)
      return {
        success: true,
        filePaths: res.filePaths,
        discoveredCount: res.filePaths.length,
        imageCount,
        videoCount
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[ManualAI:MixedFolder] Select mixed media failed: ${msg}`)
      return { success: false, filePaths: [], error: msg }
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.MANUAL_AI_PLAN_IMPORT,
    async (_event, params: { projectDir: string; filePaths: string[]; replaceExisting?: boolean; mediaType?: 'video' | 'mixed' }) => {
      try {
        if (!params?.projectDir || !Array.isArray(params.filePaths)) {
          return { success: false, error: 'projectDir and filePaths are required.' }
        }
        const norm = normalizeProjectDir(params.projectDir)
        const plan = planManualAiImport({
          projectDir: norm,
          filePaths: params.filePaths,
          replaceExisting: params.replaceExisting,
          mediaType: params.mediaType
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
