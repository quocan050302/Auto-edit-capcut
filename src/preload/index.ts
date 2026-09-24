import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  ProjectState,
  ProjectSettings,
  ProjectInputs,
  ScanResult,
  TranscriptResult,
  StockRunResult,
  StockReviewData,
  StockAsset,
  AudioPlan,
  AudioRunResult,
  GlobalScriptContext
} from '../../shared/types'

const api = {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  },

  selectFile: (options: {
    title: string
    filters?: Electron.FileFilter[]
    defaultPath?: string
  }): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SELECT_FILE, options),

  selectFolder: (options: {
    title: string
    defaultPath?: string
  }): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER, options),

  project: {
    create: (name: string): Promise<{ success: boolean; state?: ProjectState; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, name),

    open: (projectDir: string): Promise<{ success: boolean; state?: ProjectState; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_OPEN, projectDir),

    save: (state: ProjectState): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SAVE, state),

    updateInputs: (
      projectDir: string,
      inputs: Partial<ProjectInputs>
    ): Promise<{ success: boolean; state?: ProjectState; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE_INPUTS, projectDir, inputs),

    updateSettings: (
      projectDir: string,
      settings: Partial<ProjectSettings>
    ): Promise<{ success: boolean; state?: ProjectState; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE_SETTINGS, projectDir, settings),

    getDir: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.GET_PROJECTS_DIR),

    setDir: (newDir: string): Promise<{ success: boolean; projectsDir?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SET_PROJECTS_DIR, newDir)
  },

  media: {
    scan: (params: {
      projectDir: string
      imagesFolder: string | null
      videosFolder: string | null
      musicFolder: string | null
      sfxFolder: string | null
    }): Promise<ScanResult> => ipcRenderer.invoke(IPC_CHANNELS.MEDIA_SCAN, params),

    onScanProgress: (callback: (data: { message: string; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.MEDIA_SCAN_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.MEDIA_SCAN_PROGRESS, handler)
    }
  },

  transcribe: {
    start: (params: {
      projectDir: string
      voiceoverPath: string
      modelName: 'tiny' | 'base' | 'small' | 'medium'
      scriptPath: string | null
    }): Promise<{ success: boolean; transcript?: TranscriptResult; cached?: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.TRANSCRIBE_START, params),

    getTranscript: (projectDir: string): Promise<TranscriptResult | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.TRANSCRIBE_GET, projectDir),

    checkModel: (modelName: string): Promise<{ exists: boolean; path: string; modelsDir: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.TRANSCRIBE_CHECK_MODEL, modelName),

    onProgress: (callback: (data: { message: string; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.TRANSCRIBE_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.TRANSCRIBE_PROGRESS, handler)
    }
  },

  config: {
    get: (key: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET, key),
    set: (key: string, value: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, key, value)
  },

  plan: {
    generate: (params: { projectDir: string; model?: string }): Promise<{ success: boolean; plan?: unknown; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLAN_GENERATE, params),

    get: (projectDir: string): Promise<unknown | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLAN_GET, projectDir),

    onProgress: (callback: (data: { message: string; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.PLAN_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.PLAN_PROGRESS, handler)
    }
  },

  render: {
    start: (params: {
      projectDir: string
      voiceoverPath: string
      outputName?: string
      resolution?: { width: number; height: number }
      fps?: number
    }): Promise<{ success: boolean; result?: unknown; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.RENDER_START, params),

    onProgress: (callback: (data: { stage: string; sceneIndex?: number; totalScenes?: number; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { stage: string; sceneIndex?: number; totalScenes?: number; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.RENDER_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.RENDER_PROGRESS, handler)
    }
  },

  stock: {
    run: (params: { projectDir: string; forceReanalysis?: boolean }): Promise<StockRunResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_SEARCH_START, params),

    getReview: (projectDir: string): Promise<StockReviewData> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_REVIEW_GET, projectDir),

    replaceScene: (params: { projectDir: string; sceneIndex: number; query: string }): Promise<{ success: boolean; asset?: StockAsset; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_SCENE_REPLACE, params),

    lockScene: (params: { projectDir: string; sceneIndex: number; locked: boolean }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_SCENE_LOCK, params),

    uploadOwnMedia: (params: { projectDir: string; sceneIndex: number; filePath: string }): Promise<{ success: boolean; asset?: StockAsset; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_SCENE_UPLOAD, params),

    // Context-Aware Global Script Director
    analyzeContext: (params: { projectDir: string; forceRegenerate?: boolean; scriptPath?: string | null }): Promise<{ success: boolean; context?: GlobalScriptContext; error?: string; warning?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_CONTEXT_ANALYZE, params),

    getContext: (projectDir: string): Promise<GlobalScriptContext | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_CONTEXT_GET, projectDir),

    saveContext: (params: { projectDir: string; context: GlobalScriptContext }): Promise<{ success: boolean; version?: number; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_CONTEXT_SAVE, params),

    onProgress: (callback: (data: { message: string; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.STOCK_SEARCH_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.STOCK_SEARCH_PROGRESS, handler)
    },

    onContextProgress: (callback: (data: { message: string; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.STOCK_CONTEXT_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.STOCK_CONTEXT_PROGRESS, handler)
    }
  },

  getProjectsDir: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.GET_PROJECTS_DIR),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION),

  audio: {
    search: (params: { projectDir: string }): Promise<AudioRunResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_SEARCH_START, params),

    getPlan: (projectDir: string): Promise<AudioPlan | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_PLAN_GET, projectDir),

    savePlan: (params: { projectDir: string; plan: AudioPlan }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_PLAN_SAVE, params),

    approveSection: (params: {
      projectDir: string
      sectionId: string
      approved: boolean
      volumeDb?: number
      fadeInSecs?: number
      fadeOutSecs?: number
    }): Promise<{ success: boolean; plan?: AudioPlan; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_APPROVE_SECTION, params),

    approveSfx: (params: {
      projectDir: string
      sceneIndex: number
      approved: boolean
      volumeDb?: number
    }): Promise<{ success: boolean; plan?: AudioPlan; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_APPROVE_SFX, params),

    downloadApproved: (params: { projectDir: string }): Promise<{ success: boolean; plan?: AudioPlan; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_DOWNLOAD_APPROVED, params),

    onProgress: (callback: (data: { message: string; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.AUDIO_SEARCH_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.AUDIO_SEARCH_PROGRESS, handler)
    },

    onDownloadProgress: (callback: (data: { message: string; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.AUDIO_DOWNLOAD_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.AUDIO_DOWNLOAD_PROGRESS, handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
