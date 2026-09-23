"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
require("child_process");
const winston = require("winston");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const winston__namespace = /* @__PURE__ */ _interopNamespaceDefault(winston);
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
const logsDir = path.join(electron.app.getPath("userData"), "logs");
if (!fs__namespace.existsSync(logsDir)) {
  fs__namespace.mkdirSync(logsDir, { recursive: true });
}
const logFormat = winston__namespace.format.combine(
  winston__namespace.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston__namespace.format.errors({ stack: true }),
  winston__namespace.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
  })
);
const logger = winston__namespace.createLogger({
  level: "debug",
  format: logFormat,
  transports: [
    new winston__namespace.transports.File({
      filename: path.join(logsDir, "app.log"),
      maxsize: 10 * 1024 * 1024,
      // 10 MB
      maxFiles: 5
    }),
    new winston__namespace.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error"
    })
  ]
});
if (process.env.NODE_ENV === "development") {
  logger.add(
    new winston__namespace.transports.Console({
      format: winston__namespace.format.combine(winston__namespace.format.colorize(), logFormat)
    })
  );
}
winston__namespace.createLogger({
  level: "debug",
  format: logFormat,
  transports: [
    new winston__namespace.transports.File({
      filename: path.join(logsDir, "ffmpeg.log"),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 3
    })
  ]
});
const TRANSCRIBE_CHANNELS = {
  START: "transcribe:start",
  PROGRESS: "transcribe:progress",
  GET_TRANSCRIPT: "transcribe:get",
  CHECK_MODEL: "transcribe:check-model"
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
  // Audio transcription (Whisper)
  transcribe: {
    start: (params) => electron.ipcRenderer.invoke(TRANSCRIBE_CHANNELS.START, params),
    getTranscript: (projectDir) => electron.ipcRenderer.invoke(TRANSCRIBE_CHANNELS.GET_TRANSCRIPT, projectDir),
    checkModel: (modelName) => electron.ipcRenderer.invoke(TRANSCRIBE_CHANNELS.CHECK_MODEL, modelName),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      electron.ipcRenderer.on(TRANSCRIBE_CHANNELS.PROGRESS, handler);
      return () => electron.ipcRenderer.off(TRANSCRIBE_CHANNELS.PROGRESS, handler);
    }
  },
  // App info
  getProjectsDir: () => electron.ipcRenderer.invoke(IPC_CHANNELS.GET_PROJECTS_DIR),
  getAppVersion: () => electron.ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION)
};
electron.contextBridge.exposeInMainWorld("api", api);
