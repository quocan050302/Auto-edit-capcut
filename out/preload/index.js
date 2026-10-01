"use strict";
const electron = require("electron");
const IPC_CHANNELS = {
  // File dialogs
  SELECT_FILE: "select-file",
  SELECT_FOLDER: "select-folder",
  // Project management
  PROJECT_CREATE: "project:create",
  PROJECT_OPEN: "project:open",
  PROJECT_SAVE: "project:save",
  PROJECT_UPDATE_INPUTS: "project:update-inputs",
  PROJECT_UPDATE_SETTINGS: "project:update-settings",
  // Media scanning
  MEDIA_SCAN: "media:scan",
  MEDIA_SCAN_PROGRESS: "media:scan-progress",
  // Transcription
  TRANSCRIBE_START: "transcribe:start",
  TRANSCRIBE_PROGRESS: "transcribe:progress",
  TRANSCRIBE_GET: "transcribe:get",
  TRANSCRIBE_CHECK_MODEL: "transcribe:check-model",
  // App info
  GET_APP_VERSION: "app:get-version",
  GET_PROJECTS_DIR: "app:get-projects-dir",
  SET_PROJECTS_DIR: "app:set-projects-dir",
  // Config (API keys, preferences)
  CONFIG_GET: "config:get",
  CONFIG_SET: "config:set",
  CONFIG_VERIFY_KEY: "config:verify-key",
  // AI Edit Planning
  PLAN_GENERATE: "plan:generate",
  PLAN_PROGRESS: "plan:progress",
  PLAN_GET: "plan:get",
  // Video Rendering
  RENDER_START: "render:start",
  RENDER_PROGRESS: "render:progress",
  // Stock Media Engine
  STOCK_SEARCH_START: "stock:search-start",
  STOCK_SEARCH_PROGRESS: "stock:search-progress",
  STOCK_REVIEW_GET: "stock:review-get",
  STOCK_SCENE_REPLACE: "stock:scene-replace",
  STOCK_SCENE_LOCK: "stock:scene-lock",
  STOCK_SCENE_UPLOAD: "stock:scene-upload",
  // Context-Aware Global Script Director
  STOCK_CONTEXT_ANALYZE: "stock:context-analyze",
  STOCK_CONTEXT_GET: "stock:context-get",
  STOCK_CONTEXT_SAVE: "stock:context-save",
  STOCK_CONTEXT_PROGRESS: "stock:context-progress",
  // Smart Audio Director
  AUDIO_SEARCH_START: "audio:search-start",
  AUDIO_SEARCH_PROGRESS: "audio:search-progress",
  AUDIO_PLAN_GET: "audio:plan-get",
  AUDIO_PLAN_SAVE: "audio:plan-save",
  AUDIO_APPROVE_SECTION: "audio:approve-section",
  AUDIO_APPROVE_SFX: "audio:approve-sfx",
  AUDIO_DOWNLOAD_APPROVED: "audio:download-approved",
  AUDIO_DOWNLOAD_PROGRESS: "audio:download-progress",
  // Dynamic Kinetic Captions Engine
  CAPTIONS_GENERATE_PLAN: "captions:generate-plan",
  CAPTIONS_GET_PLAN: "captions:get-plan",
  CAPTIONS_UPDATE_PHRASE: "captions:update-phrase",
  CAPTIONS_TOGGLE_RANGE: "captions:toggle-range",
  CAPTIONS_REGENERATE_ASS: "captions:regenerate-ass",
  // kept for backward compat
  CAPTIONS_PREVIEW_RENDER: "captions:preview-render",
  CAPTIONS_PROGRESS: "captions:progress",
  // Remotion caption overlay render progress (separate from main FFmpeg render)
  CAPTIONS_RENDER_PROGRESS: "captions:render-progress",
  // Production Intelligence — Storyboard & Candidates
  STOCK_CANDIDATES_GET: "stock:candidates-get",
  STOCK_CANDIDATE_SELECT: "stock:candidate-select",
  STOCK_CANDIDATE_APPROVE: "stock:candidate-approve",
  STOCK_STORYBOARD_SUMMARY_GET: "stock:storyboard-summary-get",
  // Production Intelligence — Settings
  PRODUCTION_SETTINGS_GET: "production-settings:get",
  PRODUCTION_SETTINGS_SET: "production-settings:set",
  // Production Intelligence — Render QA
  RENDER_PREFLIGHT_RUN: "render:preflight-run",
  RENDER_QA_GET: "render:qa-get",
  RENDER_QA_PROGRESS: "render:qa-progress",
  // Production Intelligence — Claim & Evidence Ledger
  CLAIM_GET_LEDGER: "claim:get-ledger",
  CLAIM_UPDATE_STATUS: "claim:update-status",
  CLAIM_ADD_SOURCE: "claim:add-source",
  CLAIM_REMOVE_SOURCE: "claim:remove-source",
  CLAIM_LINK_SOURCE: "claim:link-source",
  CLAIM_UNLINK_SOURCE: "claim:unlink-source",
  CLAIM_EXPORT_MANIFESTS: "claim:export-manifests",
  // Production Intelligence — Visual Truth Reranker
  VISUAL_TRUTH_GET_DATA: "visual-truth:get-data",
  // Auto Production Pipeline
  PIPELINE_START: "pipeline:start",
  PIPELINE_RESUME: "pipeline:resume",
  PIPELINE_CANCEL: "pipeline:cancel",
  PIPELINE_STATUS_GET: "pipeline:status-get",
  PIPELINE_PROGRESS: "pipeline:progress",
  PIPELINE_RETRY_STAGE: "pipeline:retry-stage",
  PIPELINE_RUN_FROM_STAGE: "pipeline:run-from-stage",
  PIPELINE_RECOVER: "pipeline:recover",
  // Thumbnail Studio & Google Flow companion workflow
  THUMBNAIL_TEMPLATE_LIST: "thumbnail:template-list",
  THUMBNAIL_TEMPLATE_CREATE: "thumbnail:template-create",
  THUMBNAIL_TEMPLATE_UPDATE: "thumbnail:template-update",
  THUMBNAIL_TEMPLATE_DUPLICATE: "thumbnail:template-duplicate",
  THUMBNAIL_TEMPLATE_DELETE: "thumbnail:template-delete",
  THUMBNAIL_TEMPLATE_IMPORT: "thumbnail:template-import",
  THUMBNAIL_TEMPLATE_EXPORT: "thumbnail:template-export",
  THUMBNAIL_SETTINGS_GET: "thumbnail:settings-get",
  THUMBNAIL_SETTINGS_SAVE: "thumbnail:settings-save",
  THUMBNAIL_FLOW_HEALTH: "thumbnail:flow-health",
  THUMBNAIL_FLOW_OPEN: "thumbnail:flow-open",
  THUMBNAIL_PLAN_GENERATE: "thumbnail:plan-generate",
  THUMBNAIL_JOB_START: "thumbnail:job-start",
  THUMBNAIL_JOB_GET: "thumbnail:job-get",
  THUMBNAIL_JOB_RESUME: "thumbnail:job-resume",
  THUMBNAIL_JOB_CANCEL: "thumbnail:job-cancel",
  THUMBNAIL_JOB_GENERATE_MORE: "thumbnail:job-generate-more",
  THUMBNAIL_CANDIDATE_RETRY: "thumbnail:candidate-retry",
  THUMBNAIL_CANDIDATE_REGENERATE: "thumbnail:candidate-regenerate",
  THUMBNAIL_CANDIDATE_EXPORT_4K: "thumbnail:candidate-export-4k",
  THUMBNAIL_CANDIDATE_SELECT: "thumbnail:candidate-select",
  THUMBNAIL_OPEN_FOLDER: "thumbnail:open-folder",
  THUMBNAIL_PROGRESS: "thumbnail:progress"
};
const api = {
  window: {
    minimize: () => electron.ipcRenderer.send("window:minimize"),
    maximize: () => electron.ipcRenderer.send("window:maximize"),
    close: () => electron.ipcRenderer.send("window:close")
  },
  selectFile: (options) => electron.ipcRenderer.invoke(IPC_CHANNELS.SELECT_FILE, options),
  selectFolder: (options) => electron.ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER, options),
  project: {
    create: (name) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, name),
    open: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_OPEN, projectDir),
    save: (state) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SAVE, state),
    updateInputs: (projectDir, inputs) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE_INPUTS, projectDir, inputs),
    updateSettings: (projectDir, settings) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE_SETTINGS, projectDir, settings),
    getDir: () => electron.ipcRenderer.invoke(IPC_CHANNELS.GET_PROJECTS_DIR),
    setDir: (newDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.SET_PROJECTS_DIR, newDir)
  },
  media: {
    scan: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.MEDIA_SCAN, params),
    onScanProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.MEDIA_SCAN_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.MEDIA_SCAN_PROGRESS, handler);
    }
  },
  transcribe: {
    start: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.TRANSCRIBE_START, params),
    getTranscript: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.TRANSCRIBE_GET, projectDir),
    checkModel: (modelName) => electron.ipcRenderer.invoke(IPC_CHANNELS.TRANSCRIBE_CHECK_MODEL, modelName),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.TRANSCRIBE_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.TRANSCRIBE_PROGRESS, handler);
    }
  },
  config: {
    get: (key) => electron.ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET, key),
    set: (key, value) => electron.ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, key, value),
    verifyKey: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CONFIG_VERIFY_KEY, params)
  },
  plan: {
    generate: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.PLAN_GENERATE, params),
    get: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.PLAN_GET, projectDir),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.PLAN_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.PLAN_PROGRESS, handler);
    }
  },
  render: {
    start: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.RENDER_START, params),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.RENDER_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.RENDER_PROGRESS, handler);
    },
    runPreflight: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.RENDER_PREFLIGHT_RUN, params),
    getQaReport: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.RENDER_QA_GET, params),
    onQaProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.RENDER_QA_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.RENDER_QA_PROGRESS, handler);
    }
  },
  stock: {
    run: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_SEARCH_START, params),
    getReview: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_REVIEW_GET, projectDir),
    replaceScene: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_SCENE_REPLACE, params),
    lockScene: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_SCENE_LOCK, params),
    uploadOwnMedia: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_SCENE_UPLOAD, params),
    // Context-Aware Global Script Director
    analyzeContext: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_CONTEXT_ANALYZE, params),
    getContext: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_CONTEXT_GET, projectDir),
    saveContext: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_CONTEXT_SAVE, params),
    // Candidate Storyboard Review
    getCandidates: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_CANDIDATES_GET, params),
    selectCandidate: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_CANDIDATE_SELECT, params),
    approveCandidate: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_CANDIDATE_APPROVE, params),
    getStoryboardSummary: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.STOCK_STORYBOARD_SUMMARY_GET, projectDir),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.STOCK_SEARCH_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.STOCK_SEARCH_PROGRESS, handler);
    },
    onContextProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.STOCK_CONTEXT_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.STOCK_CONTEXT_PROGRESS, handler);
    }
  },
  getProjectsDir: () => electron.ipcRenderer.invoke(IPC_CHANNELS.GET_PROJECTS_DIR),
  getAppVersion: () => electron.ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION),
  audio: {
    search: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.AUDIO_SEARCH_START, params),
    getPlan: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.AUDIO_PLAN_GET, projectDir),
    savePlan: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.AUDIO_PLAN_SAVE, params),
    approveSection: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.AUDIO_APPROVE_SECTION, params),
    approveSfx: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.AUDIO_APPROVE_SFX, params),
    downloadApproved: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.AUDIO_DOWNLOAD_APPROVED, params),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.AUDIO_SEARCH_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.AUDIO_SEARCH_PROGRESS, handler);
    },
    onDownloadProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.AUDIO_DOWNLOAD_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.AUDIO_DOWNLOAD_PROGRESS, handler);
    }
  },
  captions: {
    generatePlan: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_GENERATE_PLAN, params),
    getPlan: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_GET_PLAN, projectDir),
    updatePhrase: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_UPDATE_PHRASE, params),
    toggleRange: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_TOGGLE_RANGE, params),
    regenerateAss: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_REGENERATE_ASS, params),
    previewRender: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CAPTIONS_PREVIEW_RENDER, params),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.CAPTIONS_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.CAPTIONS_PROGRESS, handler);
    },
    // Separate listener for Remotion caption overlay render phase (used by RenderPage)
    onRenderProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.CAPTIONS_RENDER_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.CAPTIONS_RENDER_PROGRESS, handler);
    }
  },
  production: {
    getSettings: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.PRODUCTION_SETTINGS_GET, projectDir),
    setSettings: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.PRODUCTION_SETTINGS_SET, params)
  },
  claims: {
    getLedger: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.CLAIM_GET_LEDGER, projectDir),
    updateStatus: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CLAIM_UPDATE_STATUS, params),
    addSource: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CLAIM_ADD_SOURCE, params),
    removeSource: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CLAIM_REMOVE_SOURCE, params),
    linkSource: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CLAIM_LINK_SOURCE, params),
    unlinkSource: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CLAIM_UNLINK_SOURCE, params),
    exportManifests: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.CLAIM_EXPORT_MANIFESTS, params)
  },
  visualTruth: {
    getData: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.VISUAL_TRUTH_GET_DATA, projectDir)
  },
  pipeline: {
    start: (options) => electron.ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_START, options),
    resume: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_RESUME, { projectDir }),
    cancel: (runId) => electron.ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_CANCEL, { runId }),
    getStatus: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_STATUS_GET, { projectDir }),
    retryStage: (projectDir, stage) => electron.ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_RETRY_STAGE, { projectDir, stage }),
    runFromStage: (projectDir, stage, options) => electron.ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_RUN_FROM_STAGE, { projectDir, stage, options }),
    recover: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_RECOVER, { projectDir }),
    onProgress: (callback) => {
      const handler = (_event, state) => {
        callback(state);
      };
      electron.ipcRenderer.on(IPC_CHANNELS.PIPELINE_PROGRESS, handler);
      return () => {
        electron.ipcRenderer.off(IPC_CHANNELS.PIPELINE_PROGRESS, handler);
      };
    }
  },
  thumbnail: {
    templates: {
      list: () => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_TEMPLATE_LIST),
      create: (data) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_TEMPLATE_CREATE, data),
      update: (id, updates) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_TEMPLATE_UPDATE, { id, updates }),
      duplicate: (id, newName) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_TEMPLATE_DUPLICATE, { id, newName }),
      delete: (id) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_TEMPLATE_DELETE, { id }),
      import: (jsonContent) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_TEMPLATE_IMPORT, { jsonContent }),
      export: (ids, saveToFile) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_TEMPLATE_EXPORT, { ids, saveToFile })
    },
    settings: {
      get: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_SETTINGS_GET, { projectDir }),
      save: (projectDir, settings) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_SETTINGS_SAVE, { projectDir, settings })
    },
    flow: {
      checkHealth: (bridgeUrl) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_FLOW_HEALTH, { bridgeUrl }),
      openFlow: () => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_FLOW_OPEN)
    },
    jobs: {
      generatePlan: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_PLAN_GENERATE, params),
      start: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_JOB_START, params),
      get: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_JOB_GET, { projectDir }),
      resume: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_JOB_RESUME, { projectDir }),
      cancel: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_JOB_CANCEL, { projectDir }),
      generateMore: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_JOB_GENERATE_MORE, params)
    },
    candidates: {
      retry: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_CANDIDATE_RETRY, params),
      regenerate: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_CANDIDATE_REGENERATE, params),
      export4k: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_CANDIDATE_EXPORT_4K, params),
      select: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_CANDIDATE_SELECT, params)
    },
    openFolder: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.THUMBNAIL_OPEN_FOLDER, params),
    onProgress: (callback) => {
      const handler = (_event, payload) => {
        callback(payload);
      };
      electron.ipcRenderer.on(IPC_CHANNELS.THUMBNAIL_PROGRESS, handler);
      return () => {
        electron.ipcRenderer.off(IPC_CHANNELS.THUMBNAIL_PROGRESS, handler);
      };
    }
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
