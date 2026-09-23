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
  // App info
  GET_APP_VERSION: "app:get-version",
  GET_PROJECTS_DIR: "app:get-projects-dir"
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
  // App info
  getProjectsDir: () => electron.ipcRenderer.invoke(IPC_CHANNELS.GET_PROJECTS_DIR),
  getAppVersion: () => electron.ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION)
};
electron.contextBridge.exposeInMainWorld("api", api);
