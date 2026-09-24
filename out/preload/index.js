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
  AUDIO_DOWNLOAD_PROGRESS: "audio:download-progress"
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
    set: (key, value) => electron.ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, key, value)
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
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
