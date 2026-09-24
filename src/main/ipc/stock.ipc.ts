import { IpcMain, BrowserWindow } from "electron"
import { join, basename } from "path"
import * as fs from "fs"
import { IPC_CHANNELS } from "../../../shared/types"
import type { StockReviewData, StockAsset, StockSceneAssignment, GlobalScriptContext } from "../../../shared/types"
import { loadConfig } from "../config"
import { runStockEngine, replaceSceneAsset } from "../stock/stock-engine"
import { runContextAwareStockEngine } from "../stock/context-stock-engine"
import { analyzeGlobalContext, loadGlobalContext, saveGlobalContext } from "../stock/global-context-analyzer"
import { loadAssetsManifest, saveAssetsManifest } from "../stock/downloader"
import { logger } from "../logger"

export function registerStockHandlers(ipcMain: IpcMain): void {

  // ── Run full stock search pipeline (context-aware when API key available) ───
  ipcMain.handle(
    IPC_CHANNELS.STOCK_SEARCH_START,
    async (event, params: { projectDir: string; forceReanalysis?: boolean }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const config = loadConfig()

      if (!config.pexelsApiKey && !config.pixabayApiKey) {
        return {
          success: false,
          error: "No stock API keys configured. Go to Settings to add Pexels or Pixabay key."
        }
      }

      const sendProgress = (message: string, progress: number): void => {
        win?.webContents.send(IPC_CHANNELS.STOCK_SEARCH_PROGRESS, { message, progress })
      }

      try {
        // Use context-aware engine when Gemini API key is present
        if (config.geminiApiKey) {
          const result = await runContextAwareStockEngine(
            {
              projectDir: params.projectDir,
              pexelsApiKey: config.pexelsApiKey ?? "",
              pixabayApiKey: config.pixabayApiKey,
              preferredAspectRatio: "16:9",
              apiKey: config.geminiApiKey,
              forceReanalysis: params.forceReanalysis ?? false
            },
            sendProgress
          )
          return result
        }

        // Legacy engine (no Gemini key)
        const result = await runStockEngine(
          {
            projectDir: params.projectDir,
            pexelsApiKey: config.pexelsApiKey ?? "",
            pixabayApiKey: config.pixabayApiKey,
            preferredAspectRatio: "16:9"
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
          scene.mediaFile = basename(params.filePath)
          scene.mediaType = params.filePath.match(/\.(mp4|mov|avi|mkv|webm)$/i) ? 'video' : 'image'
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

  // ── GlobalScriptContext: analyze -----------------------------------------------
  ipcMain.handle(
    IPC_CHANNELS.STOCK_CONTEXT_ANALYZE,
    async (event, params: { projectDir: string; forceRegenerate?: boolean; scriptPath?: string | null }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const config = loadConfig()
      if (!config.geminiApiKey) return { success: false, error: "Gemini API key required for global context analysis." }

      const sendProgress = (message: string, progress: number): void => {
        win?.webContents.send(IPC_CHANNELS.STOCK_CONTEXT_PROGRESS, { message, progress })
      }

      try {
        const transcriptPath = join(params.projectDir, "analysis", "transcript.json")
        const transcript = fs.existsSync(transcriptPath)
          ? JSON.parse(fs.readFileSync(transcriptPath, "utf-8")) : null

        // Priority 1: scriptPath sent directly from frontend (current UI state)
        let scriptText: string | null = null
        if (params.scriptPath && fs.existsSync(params.scriptPath)) {
          scriptText = fs.readFileSync(params.scriptPath, "utf-8")
          logger.info(`[ContextAnalyze] Reading script from frontend param: ${params.scriptPath}`)
        }

        // Priority 2: fallback to project-state.json
        if (!scriptText) {
          try {
            const stateFile = fs.existsSync(join(params.projectDir, "project-state.json"))
              ? join(params.projectDir, "project-state.json") : join(params.projectDir, "project.json")
            const st = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
            const savedScriptPath = st?.inputs?.scriptPath as string | undefined
            if (savedScriptPath && fs.existsSync(savedScriptPath)) {
              scriptText = fs.readFileSync(savedScriptPath, "utf-8")
              logger.info(`[ContextAnalyze] Reading script from project-state.json: ${savedScriptPath}`)
            }
          } catch { /* ignore */ }
        }

        // Priority 3: use transcript fullText
        if (!scriptText && transcript?.fullText) {
          scriptText = transcript.fullText
          logger.info("[ContextAnalyze] No script file found, using transcript.fullText")
        }

        if (!scriptText && !transcript) {
          return { success: false, error: "No script or transcript found. Please add a script file to the project first." }
        }

        const ctx = await analyzeGlobalContext({
          projectDir: params.projectDir,
          apiKey: config.geminiApiKey,
          scriptText, transcript,
          forceRegenerate: params.forceRegenerate ?? false,
          onProgress: sendProgress
        })
        return { success: true, context: ctx }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )


  // ── GlobalScriptContext: get -----------------------------------------------
  ipcMain.handle(IPC_CHANNELS.STOCK_CONTEXT_GET, (_event, projectDir: string) => {
    const ctx = loadGlobalContext(projectDir)
    return ctx
  })

  // ── GlobalScriptContext: save (user edits) ----------------------------------
  ipcMain.handle(
    IPC_CHANNELS.STOCK_CONTEXT_SAVE,
    (_event, params: { projectDir: string; context: GlobalScriptContext }) => {
      try {
        // Bump version so cache is invalidated
        params.context.version = (params.context.version ?? 0) + 1
        saveGlobalContext(params.projectDir, params.context)
        return { success: true, version: params.context.version }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )
}
