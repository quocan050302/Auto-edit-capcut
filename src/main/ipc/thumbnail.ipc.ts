import { IpcMain, shell, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC_CHANNELS } from '../../../shared/types'
import { thumbnailTemplateStore } from '../thumbnail/thumbnail-template-store'
import {
  loadProjectThumbnailSettings,
  saveProjectThumbnailSettings
} from '../thumbnail/thumbnail-settings-manager'
import { thumbnailOrchestrator } from '../thumbnail/thumbnail-orchestrator'
import { thumbnailPlanner } from '../thumbnail/thumbnail-planner'
import { googleFlowProvider, GoogleFlowProvider } from '../thumbnail/providers/google-flow-provider'
import { GoogleFlowClient } from '../thumbnail/google-flow-client'
import { flowkitRuntimeManager } from '../thumbnail/flowkit-runtime-manager'
import { logger } from '../logger'
import type {
  ThumbnailPromptTemplate,
  ProjectThumbnailSettings,
  ThumbnailProviderHealth,
  ThumbnailPlan,
  ThumbnailJobState,
  ThumbnailCandidate
} from '../../../shared/types'

export function registerThumbnailHandlers(ipcMain: IpcMain): void {
  // ─── Thumbnail Template Store IPC ──────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_TEMPLATE_LIST,
    async (): Promise<{ success: boolean; templates?: ThumbnailPromptTemplate[]; error?: string }> => {
      try {
        const templates = await thumbnailTemplateStore.getAll()
        return { success: true, templates }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Failed to list templates: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_TEMPLATE_CREATE,
    async (
      _event,
      data: {
        name: string
        description?: string
        category: string
        promptText: string
        isDefault?: boolean
      }
    ): Promise<{ success: boolean; template?: ThumbnailPromptTemplate; error?: string }> => {
      try {
        const template = await thumbnailTemplateStore.create(data)
        return { success: true, template }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Failed to create template: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_TEMPLATE_UPDATE,
    async (
      _event,
      params: {
        id: string
        updates: {
          name?: string
          description?: string
          category?: string
          promptText?: string
          isDefault?: boolean
        }
      }
    ): Promise<{ success: boolean; template?: ThumbnailPromptTemplate; error?: string }> => {
      try {
        const template = await thumbnailTemplateStore.update(params.id, params.updates)
        return { success: true, template }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Failed to update template: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_TEMPLATE_DUPLICATE,
    async (
      _event,
      params: { id: string; newName?: string }
    ): Promise<{ success: boolean; template?: ThumbnailPromptTemplate; error?: string }> => {
      try {
        const template = await thumbnailTemplateStore.duplicate(params.id, params.newName)
        return { success: true, template }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Failed to duplicate template: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_TEMPLATE_DELETE,
    async (
      _event,
      params: { id: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const success = await thumbnailTemplateStore.delete(params.id)
        return { success }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Failed to delete template: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_TEMPLATE_IMPORT,
    async (
      event,
      params?: { jsonContent?: string }
    ): Promise<{ success: boolean; importedCount?: number; importedTemplates?: ThumbnailPromptTemplate[]; error?: string }> => {
      try {
        let content = params?.jsonContent
        if (!content) {
          const win = BrowserWindow.fromWebContents(event.sender)
          const result = await dialog.showOpenDialog(win || undefined, {
            title: 'Import Thumbnail Templates',
            filters: [{ name: 'JSON Files', extensions: ['json'] }],
            properties: ['openFile']
          })
          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: 'Import cancelled' }
          }
          content = fs.readFileSync(result.filePaths[0], 'utf-8')
        }

        const res = await thumbnailTemplateStore.importFromJson(content)
        return { success: true, importedCount: res.importedCount, importedTemplates: res.importedTemplates }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Import failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_TEMPLATE_EXPORT,
    async (
      event,
      params?: { ids?: string[]; saveToFile?: boolean }
    ): Promise<{ success: boolean; json?: string; filePath?: string; error?: string }> => {
      try {
        const json = await thumbnailTemplateStore.exportToJson(params?.ids)
        if (params?.saveToFile) {
          const win = BrowserWindow.fromWebContents(event.sender)
          const result = await dialog.showSaveDialog(win || undefined, {
            title: 'Export Thumbnail Templates',
            defaultPath: 'thumbnail-templates.json',
            filters: [{ name: 'JSON Files', extensions: ['json'] }]
          })
          if (result.canceled || !result.filePath) {
            return { success: false, error: 'Export cancelled' }
          }
          fs.writeFileSync(result.filePath, json, 'utf-8')
          return { success: true, json, filePath: result.filePath }
        }
        return { success: true, json }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Export failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ─── Settings IPC ──────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_SETTINGS_GET,
    async (
      _event,
      params: { projectDir: string }
    ): Promise<{ success: boolean; settings?: ProjectThumbnailSettings; error?: string }> => {
      try {
        const settings = await loadProjectThumbnailSettings(params.projectDir)
        return { success: true, settings }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_SETTINGS_SAVE,
    async (
      _event,
      params: { projectDir: string; settings: ProjectThumbnailSettings }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        await saveProjectThumbnailSettings(params.projectDir, params.settings)
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // ─── Flow Connector IPC ───────────────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_FLOW_HEALTH,
    async (
      _event,
      params?: { bridgeUrl?: string }
    ): Promise<ThumbnailProviderHealth> => {
      try {
        if (params?.bridgeUrl) {
          const customClient = new GoogleFlowClient(params.bridgeUrl)
          const customProvider = new GoogleFlowProvider(customClient)
          return await customProvider.healthCheck()
        }
        return await googleFlowProvider.healthCheck()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          reachable: false,
          providerAvailable: false,
          extensionConnected: false,
          signedIn: false,
          supportsImageGeneration: false,
          requestedExportQuality: '4k',
          message: msg
        }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_FLOW_OPEN,
    async (): Promise<{ success: boolean; error?: string }> => {
      try {
        // force=true since user explicitly clicked the button
        flowkitRuntimeManager.openGoogleFlow(true)
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // ─── Planner IPC ──────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_PLAN_GENERATE,
    async (
      _event,
      params: {
        projectDir: string
        templateId?: string
        templateSnapshot?: string
        generationRound?: number
        preferredModel?: string
      }
    ): Promise<{ success: boolean; plan?: ThumbnailPlan; error?: string }> => {
      try {
        const plan = await thumbnailPlanner.plan(params)
        return { success: true, plan }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Plan generation failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ─── Job Orchestration IPC ────────────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_JOB_START,
    async (
      _event,
      params: {
        projectDir: string
        templateId?: string
        templateSnapshot?: string
        preferredModel?: string
        generationRound?: number
        forceRestart?: boolean
      }
    ): Promise<{ success: boolean; jobId?: string; state?: ThumbnailJobState; error?: string }> => {
      try {
        const state = await thumbnailOrchestrator.startJob(params)
        return { success: true, jobId: state.jobId, state }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Start job failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_JOB_GET,
    async (
      _event,
      params: { projectDir: string }
    ): Promise<{ success: boolean; state?: ThumbnailJobState | null; error?: string }> => {
      try {
        const state = await thumbnailOrchestrator.getJobState(params.projectDir)
        return { success: true, state }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_JOB_RESUME,
    async (
      _event,
      params: { projectDir: string }
    ): Promise<{ success: boolean; state?: ThumbnailJobState; error?: string }> => {
      try {
        const state = await thumbnailOrchestrator.resumeJob(params.projectDir)
        return { success: true, state }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Resume job failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_JOB_CANCEL,
    async (
      _event,
      params: { projectDir: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const success = await thumbnailOrchestrator.cancelJob(params.projectDir)
        return { success }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_JOB_GENERATE_MORE,
    async (
      _event,
      params: {
        projectDir: string
        templateId?: string
        templateSnapshot?: string
      }
    ): Promise<{ success: boolean; jobId?: string; state?: ThumbnailJobState; error?: string }> => {
      try {
        const state = await thumbnailOrchestrator.generateMore(
          params.projectDir,
          params.templateId,
          params.templateSnapshot
        )
        return { success: true, jobId: state.jobId, state }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Generate More failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ─── Candidate Operations IPC ─────────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_CANDIDATE_RETRY,
    async (
      _event,
      params: { projectDir: string; candidateId: string }
    ): Promise<{ success: boolean; candidate?: ThumbnailCandidate; error?: string }> => {
      try {
        const candidate = await thumbnailOrchestrator.retryCandidate(params.projectDir, params.candidateId)
        return { success: true, candidate }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Retry candidate failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_CANDIDATE_REGENERATE,
    async (
      _event,
      params: { projectDir: string; candidateId: string; customPrompt?: string }
    ): Promise<{ success: boolean; candidate?: ThumbnailCandidate; error?: string }> => {
      try {
        const candidate = await thumbnailOrchestrator.regenerateCandidate(
          params.projectDir,
          params.candidateId,
          params.customPrompt
        )
        return { success: true, candidate }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Regenerate candidate failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_CANDIDATE_EXPORT_4K,
    async (
      _event,
      params: { projectDir: string; candidateId: string }
    ): Promise<{ success: boolean; candidate?: ThumbnailCandidate; error?: string }> => {
      try {
        const candidate = await thumbnailOrchestrator.exportCandidate4k(params.projectDir, params.candidateId)
        return { success: true, candidate }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Export 4k failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_CANDIDATE_SELECT,
    async (
      _event,
      params: { projectDir: string; candidateId: string }
    ): Promise<{ success: boolean; selectedPath?: string; error?: string }> => {
      try {
        const result = thumbnailOrchestrator.selectCandidate(params.projectDir, params.candidateId)
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[ThumbnailIPC] Select candidate failed: ${msg}`)
        return { success: false, error: msg }
      }
    }
  )

  // ─── Folder & External Opener IPC ──────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_OPEN_FOLDER,
    async (
      _event,
      params: { projectDir: string; folderPath?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const target = params.folderPath || path.join(params.projectDir, 'output', 'thumbnails')
        if (fs.existsSync(target)) {
          shell.openPath(target)
          return { success: true }
        } else {
          // If directory does not exist, open project dir or create it
          fs.mkdirSync(target, { recursive: true })
          shell.openPath(target)
          return { success: true }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // Read a local image file and return as base64 data URL.
  // This sidesteps file:// CSP restrictions in the renderer completely.
  ipcMain.handle(
    IPC_CHANNELS.THUMBNAIL_READ_IMAGE,
    async (_event, filePath: string): Promise<{ dataUrl: string } | { error: string }> => {
      try {
        if (!filePath || !fs.existsSync(filePath)) {
          return { error: `File not found: ${filePath}` }
        }
        const buf = fs.readFileSync(filePath)
        const ext = path.extname(filePath).toLowerCase().slice(1)
        const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
        return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ─── FlowKit Runtime Manager IPC ──────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.FLOWKIT_RUNTIME_GET_SETTINGS,
    async (): Promise<{ success: boolean; settings?: ReturnType<typeof flowkitRuntimeManager.getSettings>; error?: string }> => {
      try {
        return { success: true, settings: flowkitRuntimeManager.getSettings() }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FLOWKIT_RUNTIME_SAVE_SETTINGS,
    async (_event, params: Parameters<typeof flowkitRuntimeManager.applySettings>[0]): Promise<{ success: boolean; error?: string }> => {
      try {
        // saveSettings = applySettings + savePersistedSettings (atomic)
        flowkitRuntimeManager.saveSettings(params)
        // Sync the shared GoogleFlowClient URL
        googleFlowProvider.healthCheck(flowkitRuntimeManager.getSettings().bridgeUrl).catch(() => {})
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FLOWKIT_RUNTIME_START,
    async (): Promise<{ success: boolean; error?: string; errorCode?: string }> => {
      try {
        return await flowkitRuntimeManager.startBridge()
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FLOWKIT_RUNTIME_STOP,
    async (): Promise<{ success: boolean }> => {
      flowkitRuntimeManager.stopBridge()
      return { success: true }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FLOWKIT_RUNTIME_STATUS,
    async (): Promise<ReturnType<typeof flowkitRuntimeManager.getStatus>> => {
      return flowkitRuntimeManager.getStatus()
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FLOWKIT_RUNTIME_ENSURE_READY,
    async (_event, params?: { bridgeUrl?: string }): Promise<ReturnType<typeof flowkitRuntimeManager.ensureFlowReady>> => {
      return flowkitRuntimeManager.ensureFlowReady(params?.bridgeUrl)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FLOWKIT_RUNTIME_DETECT_PYTHON,
    async (_event, params?: { flowKitPath?: string }): Promise<{ success: boolean; pythonPath?: string; version?: string; error?: string }> => {
      try {
        const flowKitPath = params?.flowKitPath || flowkitRuntimeManager.getSettings().flowKitPath || ''
        const pythonPath = await flowkitRuntimeManager.resolvePython(flowKitPath)
        if (pythonPath) {
          return { success: true, pythonPath }
        }
        return { success: false, error: 'Python 3.10+ not found in expected locations.' }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FLOWKIT_RUNTIME_SELECT_FOLDER,
    async (event): Promise<{ success: boolean; folderPath?: string; error?: string }> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender)
        const result = await dialog.showOpenDialog(win || undefined, {
          title: 'Select FlowKit Folder',
          properties: ['openDirectory'],
          buttonLabel: 'Select FlowKit Folder'
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: 'Cancelled' }
        }
        const folderPath = result.filePaths[0]
        const agentMain = path.join(folderPath, 'agent', 'main.py')
        if (!fs.existsSync(agentMain)) {
          return { success: false, error: `agent/main.py not found in "${folderPath}". Is this the correct FlowKit folder?` }
        }
        return { success: true, folderPath }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FLOWKIT_RUNTIME_SELECT_PYTHON,
    async (event): Promise<{ success: boolean; pythonPath?: string; error?: string }> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender)
        const result = await dialog.showOpenDialog(win || undefined, {
          title: 'Select Python Executable',
          properties: ['openFile'],
          filters: [
            { name: 'Python Executable', extensions: ['exe', ''] },
            { name: 'All Files', extensions: ['*'] }
          ]
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: 'Cancelled' }
        }
        return { success: true, pythonPath: result.filePaths[0] }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )
}
