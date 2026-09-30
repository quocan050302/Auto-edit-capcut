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
import { normalizeApiKey } from "../utils/api-key"

import {
  getStockCandidatesForProject,
  selectCandidateForScene,
  approveCandidateForScene,
  calculateStoryboardSummary
} from "../production-intelligence/storyboard-service"
import {
  loadProductionSettings,
  saveProductionSettings
} from "../production-intelligence/production-settings"
import {
  getClaimLedgerPath,
  updateClaimStatus,
  addEvidenceSource,
  linkSourceToClaim,
  unlinkSourceFromClaim,
  exportClaimManifests
} from "../production-intelligence/claim-evidence-ledger"
import { loadVisualTruthStore } from "../production-intelligence/visual-truth-reranker"
import { readJsonSafe, atomicWriteJson } from "../production-intelligence/json-store"
import type {
  ProductionIntelligenceSettings,
  ClaimEvidenceLedger,
  EvidenceSource,
  ClaimVerificationStatus
} from "../../../shared/types"

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
        const geminiApiKey = normalizeApiKey(config.geminiApiKey ?? "")
        if (geminiApiKey) {
          const result = await runContextAwareStockEngine(
            {
              projectDir: params.projectDir,
              pexelsApiKey: config.pexelsApiKey ?? "",
              pixabayApiKey: config.pixabayApiKey,
              preferredAspectRatio: "16:9",
              apiKey: geminiApiKey,
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
      const geminiKey = normalizeApiKey(config.geminiApiKey ?? "")

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
          apiKey: geminiKey,
          model: config.preferredModel ?? "gemini-3.5-flash",
          scriptText, transcript,
          forceRegenerate: params.forceRegenerate ?? false,
          onProgress: sendProgress
        })

        let warning: string | undefined
        if (ctx.modelUsed.includes("fallback") || ctx.modelUsed.includes("algorithmic")) {
          if (!geminiKey) {
            warning = "Đã phân tích bối cảnh theo thuật toán kịch bản. Thêm Gemini API key trong Cài đặt để có phân tích AI chi tiết hơn."
          } else {
            warning = "Gemini AI tạm thời quá tải hoặc không phản hồi. Đã tự động tạo bối cảnh từ kịch bản để bạn tiếp tục làm việc."
          }
        }

        return { success: true, context: ctx, warning }
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

  // ── Production Intelligence: Storyboard Candidates ──────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.STOCK_CANDIDATES_GET,
    (_event, params: { projectDir: string; sceneIndex?: number }) => {
      return getStockCandidatesForProject(params.projectDir, params.sceneIndex)
    }
  )


  ipcMain.handle(
    IPC_CHANNELS.STOCK_CANDIDATE_SELECT,
    async (_event, params: { projectDir: string; sceneIndex: number; candidateId: string }) => {
      return selectCandidateForScene(params.projectDir, params.sceneIndex, params.candidateId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.STOCK_CANDIDATE_APPROVE,
    (_event, params: { projectDir: string; sceneIndex: number; candidateId?: string }) => {
      return approveCandidateForScene(params.projectDir, params.sceneIndex, params.candidateId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.STOCK_STORYBOARD_SUMMARY_GET,
    (_event, projectDir: string) => {
      return calculateStoryboardSummary(projectDir)
    }
  )

  // ── Production Intelligence: Settings ───────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.PRODUCTION_SETTINGS_GET,
    (_event, projectDir?: string) => {
      return loadProductionSettings(projectDir)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PRODUCTION_SETTINGS_SET,
    (_event, params: { projectDir?: string; settings: Partial<ProductionIntelligenceSettings> }) => {
      return saveProductionSettings(params.projectDir, params.settings)
    }
  )

  // ── Production Intelligence: Claim & Evidence Ledger ────────────────────────
  ipcMain.handle(IPC_CHANNELS.CLAIM_GET_LEDGER, (_event, projectDir: string) => {
    try {
      const ledgerPath = getClaimLedgerPath(projectDir)
      return readJsonSafe<ClaimEvidenceLedger>(ledgerPath, null as unknown as ClaimEvidenceLedger)
    } catch (err) {
      logger.error(`[ClaimIPC] Failed to load claim ledger: ${String(err)}`)
      return null
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.CLAIM_UPDATE_STATUS,
    (_event, params: { projectDir: string; claimId: string; status: ClaimVerificationStatus; warningText?: string }) => {
      return updateClaimStatus(params.projectDir, params.claimId, params.status, params.warningText)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLAIM_ADD_SOURCE,
    (_event, params: { projectDir: string; source: Omit<EvidenceSource, 'id'> }) => {
      return addEvidenceSource(params.projectDir, params.source)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLAIM_REMOVE_SOURCE,
    (_event, params: { projectDir: string; sourceId: string }) => {
      try {
        const ledgerPath = getClaimLedgerPath(params.projectDir)
        const ledger = readJsonSafe<ClaimEvidenceLedger>(ledgerPath, null as unknown as ClaimEvidenceLedger)
        if (!ledger) return { success: false, error: 'Ledger not found' }

        ledger.sources = ledger.sources.filter((s) => s.id !== params.sourceId)
        for (const claim of ledger.claims) {
          claim.evidenceSourceIds = claim.evidenceSourceIds.filter((id) => id !== params.sourceId)
          if (claim.evidenceSourceIds.length === 0 && claim.verificationStatus === 'VERIFIED') {
            claim.verificationStatus = 'UNSOURCED'
          }
        }
        atomicWriteJson(ledgerPath, ledger)
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLAIM_LINK_SOURCE,
    (_event, params: { projectDir: string; claimId: string; sourceId: string; newStatus?: ClaimVerificationStatus }) => {
      return linkSourceToClaim(params.projectDir, params.claimId, params.sourceId, params.newStatus)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLAIM_UNLINK_SOURCE,
    (_event, params: { projectDir: string; claimId: string; sourceId: string }) => {
      return unlinkSourceFromClaim(params.projectDir, params.claimId, params.sourceId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLAIM_EXPORT_MANIFESTS,
    (_event, params: { projectDir: string; exportDir?: string }) => {
      return exportClaimManifests(params.projectDir, params.exportDir)
    }
  )

  // ── Production Intelligence: Visual Truth Reranker ─────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.VISUAL_TRUTH_GET_DATA,
    (_event, projectDir: string) => {
      try {
        return loadVisualTruthStore(projectDir)
      } catch (err) {
        logger.error(`[VisualTruthIPC] Failed to load visual truth data: ${String(err)}`)
        return null
      }
    }
  )
}

