import { IpcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { IPC_CHANNELS } from '../../../shared/types'
import type { StockReviewData, StockAsset, StockSceneAssignment } from '../../../shared/types'
import { loadConfig } from '../config'
import { runStockEngine, replaceSceneAsset } from '../stock/stock-engine'
import { loadAssetsManifest, saveAssetsManifest } from '../stock/downloader'
import { logger } from '../logger'

export function registerStockHandlers(ipcMain: IpcMain): void {

  // ── Run full stock search pipeline ──────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.STOCK_SEARCH_START,
    async (event, params: { projectDir: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const config = loadConfig()

      if (!config.pexelsApiKey && !config.pixabayApiKey) {
        return {
          success: false,
          error: 'No stock API keys configured. Go to Settings → API Providers to add Pexels or Pixabay key.'
        }
      }

      const sendProgress = (message: string, progress: number): void => {
        win?.webContents.send(IPC_CHANNELS.STOCK_SEARCH_PROGRESS, { message, progress })
      }

      try {
        const result = await runStockEngine(
          {
            projectDir: params.projectDir,
            pexelsApiKey: config.pexelsApiKey ?? '',
            pixabayApiKey: config.pixabayApiKey,
            preferredAspectRatio: '16:9'
          },
          sendProgress
        )
        return result
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`Stock engine error: ${msg}`)
        return { success: false, error: msg, totalScenes: 0, assignedScenes: 0, failedScenes: 0, assignments: [] }
      }
    }
  )

  // ── Get review data (assignments + manifest) ─────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.STOCK_REVIEW_GET, (_event, projectDir: string) => {
    const stockDir = join(projectDir, 'assets', 'stock')
    const assignmentsPath = join(projectDir, 'analysis', 'stock-assignments.json')

    let assignments: StockSceneAssignment[] = []
    try {
      if (fs.existsSync(assignmentsPath)) {
        assignments = JSON.parse(fs.readFileSync(assignmentsPath, 'utf-8')) as StockSceneAssignment[]
      }
    } catch { /* ignore */ }

    const manifest = loadAssetsManifest(stockDir)
    const assigned = assignments.filter((a) => a.status === 'assigned').length

    const review: StockReviewData = {
      assignments,
      totalScenes: assignments.length,
      assignedScenes: assigned,
      stockAssetsJson: manifest
    }
    return review
  })

  // ── Replace a single scene ───────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.STOCK_SCENE_REPLACE,
    async (_event, params: { projectDir: string; sceneIndex: number; query: string }) => {
      const config = loadConfig()
      if (!config.pexelsApiKey && !config.pixabayApiKey) {
        throw new Error('No stock API keys configured')
      }
      try {
        const asset = await replaceSceneAsset(
          params.projectDir,
          params.sceneIndex,
          params.query,
          config.pexelsApiKey ?? '',
          config.pixabayApiKey
        )

        // Update assignments file
        const assignmentsPath = join(params.projectDir, 'analysis', 'stock-assignments.json')
        if (fs.existsSync(assignmentsPath)) {
          const assignments: StockSceneAssignment[] = JSON.parse(fs.readFileSync(assignmentsPath, 'utf-8'))
          const idx = assignments.findIndex((a) => a.sceneIndex === params.sceneIndex)
          if (idx >= 0) {
            assignments[idx].asset = asset
            assignments[idx].usedQuery = params.query
            assignments[idx].status = 'assigned'
            fs.writeFileSync(assignmentsPath, JSON.stringify(assignments, null, 2), 'utf-8')
          }
        }

        return { success: true, asset }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // ── Lock a scene (prevent auto-replacement) ──────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.STOCK_SCENE_LOCK,
    (_event, params: { projectDir: string; sceneIndex: number; locked: boolean }) => {
      const assignmentsPath = join(params.projectDir, 'analysis', 'stock-assignments.json')
      if (!fs.existsSync(assignmentsPath)) return { success: false, error: 'No assignments found' }

      const assignments: StockSceneAssignment[] = JSON.parse(fs.readFileSync(assignmentsPath, 'utf-8'))
      const idx = assignments.findIndex((a) => a.sceneIndex === params.sceneIndex)
      if (idx >= 0) {
        assignments[idx].locked = params.locked
        fs.writeFileSync(assignmentsPath, JSON.stringify(assignments, null, 2), 'utf-8')
      }
      return { success: true }
    }
  )

  // ── Upload own media for a scene ─────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.STOCK_SCENE_UPLOAD,
    (_event, params: { projectDir: string; sceneIndex: number; filePath: string }) => {
      if (!fs.existsSync(params.filePath)) {
        return { success: false, error: `File not found: ${params.filePath}` }
      }

      const stockDir = join(params.projectDir, 'assets', 'stock')
      fs.mkdirSync(stockDir, { recursive: true })

      const stat = fs.statSync(params.filePath)
      const asset: StockAsset = {
        assetId: `manual_${params.sceneIndex}_${Date.now()}`,
        provider: 'pexels', // placeholder; not actually from Pexels
        mediaType: params.filePath.match(/\.(mp4|mov|avi|mkv|webm)$/i) ? 'video' : 'photo',
        localPath: params.filePath,
        thumbnailUrl: '',
        downloadUrl: params.filePath,
        creator: 'User',
        searchQuery: 'manual upload',
        downloadedAt: new Date().toISOString(),
        fileSizeBytes: stat.size
      }

      const manifest = loadAssetsManifest(stockDir)
      const updated = manifest.filter((a) => !a.assetId.startsWith(`manual_${params.sceneIndex}_`))
      updated.push(asset)
      saveAssetsManifest(stockDir, updated)

      // Stamp plan
      const planPath = join(params.projectDir, 'analysis', 'master-edit-plan.json')
      if (fs.existsSync(planPath)) {
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
        const allScenes: Array<{ sceneIndex: number; localPath?: string }> = (plan.chapters ?? [])
          .flatMap((ch: { sequences?: Array<{ scenes?: unknown[] }> }) => ch.sequences ?? [])
          .flatMap((seq: { scenes?: Array<{ sceneIndex: number; localPath?: string }> }) => seq.scenes ?? [])
        const scene = allScenes.find((s) => s.sceneIndex === params.sceneIndex)
        if (scene) {
          scene.localPath = params.filePath
          fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')
        }
      }

      // Update assignments
      const assignmentsPath = join(params.projectDir, 'analysis', 'stock-assignments.json')
      if (fs.existsSync(assignmentsPath)) {
        const assignments: StockSceneAssignment[] = JSON.parse(fs.readFileSync(assignmentsPath, 'utf-8'))
        const idx = assignments.findIndex((a) => a.sceneIndex === params.sceneIndex)
        if (idx >= 0) {
          assignments[idx].asset = asset
          assignments[idx].status = 'assigned'
          assignments[idx].manualOverride = true
          assignments[idx].locked = true
          fs.writeFileSync(assignmentsPath, JSON.stringify(assignments, null, 2), 'utf-8')
        }
      }

      return { success: true, asset }
    }
  )
}
