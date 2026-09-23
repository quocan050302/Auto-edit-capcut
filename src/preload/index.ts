import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import { TRANSCRIBE_CHANNELS } from '../main/ipc/transcribe.ipc'
import type {
  ProjectState,
  ProjectSettings,
  ProjectInputs,
  ScanResult
} from '../../shared/types'
import type { TranscriptResult } from '../main/transcriber'

// Expose a typed API to the renderer via window.api
const api = {
  // Window controls
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  },

  // File dialogs
  selectFile: (options: {
    title: string
    filters?: Electron.FileFilter[]
    defaultPath?: string
  }): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SELECT_FILE, options),

  selectFolder: (options: {
    title: string
    defaultPath?: string
  }): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER, options),

  // Project management
  project: {
    create: (name: string): Promise<{ success: boolean; state?: ProjectState; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, name),

    open: (
      projectDir: string
    ): Promise<{ success: boolean; state?: ProjectState; error?: string }> =>
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
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE_SETTINGS, projectDir, settings)
  },

  // Media scanning
  media: {
    scan: (params: {
      projectDir: string
      imagesFolder: string | null
      videosFolder: string | null
      musicFolder: string | null
      sfxFolder: string | null
    }): Promise<ScanResult> => ipcRenderer.invoke(IPC_CHANNELS.MEDIA_SCAN, params),

    onScanProgress: (
      callback: (data: { message: string; progress: number }) => void
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { message: string; progress: number }
      ): void => callback(data)
      ipcRenderer.on(IPC_CHANNELS.MEDIA_SCAN_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.MEDIA_SCAN_PROGRESS, handler)
    }
  },

  // Audio transcription (Whisper)
  transcribe: {
    start: (params: {
      projectDir: string
      voiceoverPath: string
      modelName: 'tiny' | 'base' | 'small' | 'medium'
      scriptPath: string | null
    }): Promise<{ success: boolean; transcript?: TranscriptResult; cached?: boolean; error?: string }> =>
      ipcRenderer.invoke(TRANSCRIBE_CHANNELS.START, params),

    getTranscript: (projectDir: string): Promise<TranscriptResult | null> =>
      ipcRenderer.invoke(TRANSCRIBE_CHANNELS.GET_TRANSCRIPT, projectDir),

    checkModel: (modelName: string): Promise<{ exists: boolean; path: string; modelsDir: string }> =>
      ipcRenderer.invoke(TRANSCRIBE_CHANNELS.CHECK_MODEL, modelName),

    onProgress: (callback: (data: { message: string; progress: number }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { message: string; progress: number }
      ): void => callback(data)
      ipcRenderer.on(TRANSCRIBE_CHANNELS.PROGRESS, handler)
      return () => ipcRenderer.off(TRANSCRIBE_CHANNELS.PROGRESS, handler)
    }
  },

  // App info
  getProjectsDir: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.GET_PROJECTS_DIR),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION)
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
