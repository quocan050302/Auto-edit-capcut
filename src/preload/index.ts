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
  GlobalScriptContext,
  CaptionPlan,
  CaptionPhrase,
  ApiKeyVerifyResult,
  RenderTransitionSettings,
  StockCandidate,
  StoryboardSummary,
  ProductionIntelligenceSettings,
  RenderQaReport,
  AutoPipelineOptions,
  AutoPipelineState,
  PipelineStage,
  PipelineRecoveryResult,
  ClaimEvidenceLedger,
  DocumentaryClaim,
  EvidenceSource,
  ClaimVerificationStatus,
  ResearchSidecarStatus,
  ResearchProjectHandoffPayload
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
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, key, value),
    verifyKey: (params: { key: string; configKey?: string; model?: string }): Promise<ApiKeyVerifyResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_VERIFY_KEY, params)
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
      transitionSettings?: RenderTransitionSettings
    }): Promise<{ success: boolean; result?: unknown; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.RENDER_START, params),

    onProgress: (callback: (data: { stage: string; sceneIndex?: number; totalScenes?: number; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { stage: string; sceneIndex?: number; totalScenes?: number; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.RENDER_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.RENDER_PROGRESS, handler)
    },

    runPreflight: (params: { projectDir: string }): Promise<RenderQaReport> =>
      ipcRenderer.invoke(IPC_CHANNELS.RENDER_PREFLIGHT_RUN, params),

    getQaReport: (params: { projectDir: string }): Promise<RenderQaReport | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.RENDER_QA_GET, params),

    onQaProgress: (callback: (data: { stage: string; progress: number; message: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { stage: string; progress: number; message: string }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.RENDER_QA_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.RENDER_QA_PROGRESS, handler)
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

    // Candidate Storyboard Review
    getCandidates: (params: { projectDir: string; sceneIndex?: number }): Promise<Record<string, StockCandidate[]> | StockCandidate[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_CANDIDATES_GET, params),

    selectCandidate: (params: { projectDir: string; sceneIndex: number; candidateId: string }): Promise<{ success: boolean; asset?: StockAsset; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_CANDIDATE_SELECT, params),

    approveCandidate: (params: { projectDir: string; sceneIndex: number; candidateId?: string }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_CANDIDATE_APPROVE, params),

    getStoryboardSummary: (projectDir: string): Promise<StoryboardSummary> =>
      ipcRenderer.invoke(IPC_CHANNELS.STOCK_STORYBOARD_SUMMARY_GET, projectDir),


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
  },

  captions: {
    generatePlan: (params: { projectDir: string; forceRegenerate?: boolean; model?: string }): Promise<{ success: boolean; plan?: CaptionPlan; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_GENERATE_PLAN, params),

    getPlan: (projectDir: string): Promise<{ success: boolean; plan?: CaptionPlan | null; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_GET_PLAN, projectDir),

    updatePhrase: (params: { projectDir: string; phraseId: string; updates: Partial<CaptionPhrase> }): Promise<{ success: boolean; plan?: CaptionPlan; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_UPDATE_PHRASE, params),

    toggleRange: (params: { projectDir: string; rangeIndex: number; enabled: boolean; captionEnabled?: boolean }): Promise<{ success: boolean; plan?: CaptionPlan; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_TOGGLE_RANGE, params),

    regenerateAss: (params: { projectDir: string; videoDurationInSeconds?: number }): Promise<{ success: boolean; overlayPath?: string; assPath?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_REGENERATE_ASS, params),

    previewRender: (params: { projectDir: string; startTime: number; endTime: number }): Promise<{ success: boolean; previewPath?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_PREVIEW_RENDER, params),

    onProgress: (callback: (data: { message: string; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.CAPTIONS_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.CAPTIONS_PROGRESS, handler)
    },

    // Separate listener for Remotion caption overlay render phase (used by RenderPage)
    onRenderProgress: (callback: (data: { message: string; progress: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string; progress: number }): void =>
        callback(data)
      ipcRenderer.on(IPC_CHANNELS.CAPTIONS_RENDER_PROGRESS, handler)
      return () => ipcRenderer.off(IPC_CHANNELS.CAPTIONS_RENDER_PROGRESS, handler)
    }
  },

  production: {
    getSettings: (projectDir?: string): Promise<ProductionIntelligenceSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRODUCTION_SETTINGS_GET, projectDir),

    setSettings: (params: { projectDir?: string; settings: Partial<ProductionIntelligenceSettings> }): Promise<ProductionIntelligenceSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRODUCTION_SETTINGS_SET, params)
  },

  claims: {
    getLedger: (projectDir: string): Promise<ClaimEvidenceLedger | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAIM_GET_LEDGER, projectDir),

    updateStatus: (params: {
      projectDir: string
      claimId: string
      status: ClaimVerificationStatus
      warningText?: string
    }): Promise<{ success: boolean; claim?: DocumentaryClaim; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAIM_UPDATE_STATUS, params),

    addSource: (params: {
      projectDir: string
      source: Omit<EvidenceSource, 'id'>
    }): Promise<{ success: boolean; source?: EvidenceSource; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAIM_ADD_SOURCE, params),

    removeSource: (params: { projectDir: string; sourceId: string }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAIM_REMOVE_SOURCE, params),

    linkSource: (params: {
      projectDir: string
      claimId: string
      sourceId: string
      newStatus?: ClaimVerificationStatus
    }): Promise<{ success: boolean; claim?: DocumentaryClaim; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAIM_LINK_SOURCE, params),

    unlinkSource: (params: {
      projectDir: string
      claimId: string
      sourceId: string
    }): Promise<{ success: boolean; claim?: DocumentaryClaim; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAIM_UNLINK_SOURCE, params),

    exportManifests: (params: {
      projectDir: string
      exportDir?: string
    }): Promise<{ success: boolean; csvPath?: string; jsonPath?: string; licensesPath?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAIM_EXPORT_MANIFESTS, params)
  },

  visualTruth: {
    getData: (projectDir: string): Promise<any> =>
      ipcRenderer.invoke(IPC_CHANNELS.VISUAL_TRUTH_GET_DATA, projectDir)
  },

  pipeline: {
    start: (options: AutoPipelineOptions): Promise<{ success: boolean; runId?: string; state?: AutoPipelineState; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_START, options),

    resume: (projectDir: string): Promise<{ success: boolean; runId?: string; state?: AutoPipelineState; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_RESUME, { projectDir }),

    cancel: (runId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_CANCEL, { runId }),

    getStatus: (projectDir: string): Promise<AutoPipelineState | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_STATUS_GET, { projectDir }),

    retryStage: (projectDir: string, stage: PipelineStage): Promise<{ success: boolean; runId?: string; state?: AutoPipelineState; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_RETRY_STAGE, { projectDir, stage }),

    runFromStage: (
      projectDir: string,
      stage: PipelineStage,
      options?: Partial<AutoPipelineOptions>
    ): Promise<{ success: boolean; runId?: string; state?: AutoPipelineState; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_RUN_FROM_STAGE, { projectDir, stage, options }),

    recover: (
      projectDir: string
    ): Promise<{ success: boolean; result?: PipelineRecoveryResult; state?: AutoPipelineState; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_RECOVER, { projectDir }),

    onProgress: (callback: (state: AutoPipelineState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: AutoPipelineState): void => {
        callback(state)
      }
      ipcRenderer.on(IPC_CHANNELS.PIPELINE_PROGRESS, handler)
      return () => {
        ipcRenderer.off(IPC_CHANNELS.PIPELINE_PROGRESS, handler)
      }
    }
  },

  research: {
    getStatus: (): Promise<ResearchSidecarStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_SIDECAR_STATUS),

    restartSidecar: (): Promise<ResearchSidecarStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_SIDECAR_RESTART),

    createProjectHandoff: (
      payload: ResearchProjectHandoffPayload
    ): Promise<{ success: boolean; projectDir?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_CREATE_PROJECT_HANDOFF, payload)
  }
}


contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
