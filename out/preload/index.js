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
  // Config (API keys, preferences)
  CONFIG_GET: "config:get",
  CONFIG_SET: "config:set",
  // AI Edit Planning
  PLAN_GENERATE: "plan:generate",
  PLAN_PROGRESS: "plan:progress",
  PLAN_GET: "plan:get"
};
const api = {
  // Window controls
  window: {
    minimize: () => electron.ipcRenderer.send("window:minimize"),
    maximize: () => electron.ipcRenderer.send("window:maximize"),
    close: () => electron.ipcRenderer.send("window:close")
  },
  // File dialogs
  selectFile: (options) => electron.ipcRenderer.invoke(IPC_CHANNELS.SELECT_FILE, options),
  selectFolder: (options) => electron.ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER, options),
  // Project management
  project: {
    create: (name) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, name),
    open: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_OPEN, projectDir),
    save: (state) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SAVE, state),
    updateInputs: (projectDir, inputs) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE_INPUTS, projectDir, inputs),
    updateSettings: (projectDir, settings) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE_SETTINGS, projectDir, settings)
  },
  // Media scanning
  media: {
    scan: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.MEDIA_SCAN, params),
    onScanProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.MEDIA_SCAN_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.MEDIA_SCAN_PROGRESS, handler);
    }
  },
  // Audio transcription (Whisper via uv + faster-whisper)
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
  // App config (API keys stored locally)
  config: {
    get: (key) => electron.ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET, key),
    set: (key, value) => electron.ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, key, value)
  },
  // AI Edit Planning
  plan: {
    generate: (params) => electron.ipcRenderer.invoke(IPC_CHANNELS.PLAN_GENERATE, params),
    get: (projectDir) => electron.ipcRenderer.invoke(IPC_CHANNELS.PLAN_GET, projectDir),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(IPC_CHANNELS.PLAN_PROGRESS, handler);
      return () => electron.ipcRenderer.off(IPC_CHANNELS.PLAN_PROGRESS, handler);
    }
  },
  // App info
  getProjectsDir: () => electron.ipcRenderer.invoke(IPC_CHANNELS.GET_PROJECTS_DIR),
  getAppVersion: () => electron.ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION)
};
electron.contextBridge.exposeInMainWorld("api", api);
