"use strict";
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const fs = require("fs");
const uuid = require("uuid");
const winston = require("winston");
const crypto = require("crypto");
const ffprobeStatic = require("ffprobe-static");
const os = require("os");
const child_process = require("child_process");
const genai = require("@google/genai");
const https = require("https");
const http = require("http");
const url = require("url");
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
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const winston__namespace = /* @__PURE__ */ _interopNamespaceDefault(winston);
const os__namespace = /* @__PURE__ */ _interopNamespaceDefault(os);
const https__namespace = /* @__PURE__ */ _interopNamespaceDefault(https);
const http__namespace = /* @__PURE__ */ _interopNamespaceDefault(http);
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
function getWindow(event) {
  return electron.BrowserWindow.fromWebContents(event.sender) ?? electron.BrowserWindow.getAllWindows()[0] ?? null;
}
function registerFsHandlers(ipcMain) {
  ipcMain.handle(
    IPC_CHANNELS.SELECT_FILE,
    async (event, options) => {
      const win = getWindow(event);
      const dialogOptions = {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters || [],
        properties: ["openFile"]
      };
      const result = win ? await electron.dialog.showOpenDialog(win, dialogOptions) : await electron.dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.SELECT_FOLDER,
    async (event, options) => {
      const win = getWindow(event);
      const dialogOptions = {
        title: options.title,
        defaultPath: options.defaultPath,
        properties: ["openDirectory"]
      };
      const result = win ? await electron.dialog.showOpenDialog(win, dialogOptions) : await electron.dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    }
  );
}
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
const ffmpegLogger = winston__namespace.createLogger({
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
const FALLBACK_PROJECTS_DIR = "D:\\Video_factory_hutteries";
function getConfigPath() {
  return path.join(electron.app.getPath("userData"), "config.json");
}
function readConfig() {
  try {
    const cfgPath = getConfigPath();
    if (fs__namespace.existsSync(cfgPath)) {
      return JSON.parse(fs__namespace.readFileSync(cfgPath, "utf-8"));
    }
  } catch {
  }
  return {};
}
function writeConfig(cfg) {
  fs__namespace.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), "utf-8");
}
function getProjectsDir() {
  return readConfig().projectsDir ?? FALLBACK_PROJECTS_DIR;
}
getProjectsDir();
function ensureProjectsDir() {
  const dir = getProjectsDir();
  if (!fs__namespace.existsSync(dir)) {
    fs__namespace.mkdirSync(dir, { recursive: true });
  }
}
function createProjectFolderStructure(projectDir) {
  const dirs = [
    "source",
    "media/images",
    "media/videos",
    "media/music",
    "media/sfx",
    "analysis",
    "planning",
    "renders/segments",
    "qa",
    "output",
    "logs"
  ];
  for (const dir of dirs) {
    fs__namespace.mkdirSync(path.join(projectDir, dir), { recursive: true });
  }
}
function defaultSettings() {
  return {
    videoType: "documentary",
    aspectRatio: "16:9",
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    pacing: "balanced"
  };
}
function saveProjectState(state) {
  const statePath = path.join(state.projectDir, "project-state.json");
  fs__namespace.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}
function registerProjectHandlers(ipcMain) {
  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, async (_event, name) => {
    try {
      ensureProjectsDir();
      const safeName = name.replace(/[^a-zA-Z0-9-_\s]/g, "").trim().replace(/\s+/g, "-");
      const projectDir = path.join(getProjectsDir(), safeName);
      if (fs__namespace.existsSync(projectDir)) {
        throw new Error(
          `Project "${safeName}" already exists at ${projectDir}`
        );
      }
      createProjectFolderStructure(projectDir);
      const state = {
        id: uuid.v4(),
        name: safeName,
        projectDir,
        status: "NEW",
        settings: defaultSettings(),
        inputs: {
          scriptPath: null,
          voiceoverPath: null,
          imagesFolder: null,
          videosFolder: null,
          musicFolder: null,
          sfxFolder: null
        },
        stats: {
          totalImages: 0,
          totalVideos: 0,
          totalMusic: 0,
          totalSfx: 0,
          voiceDurationSeconds: 0,
          estimatedScenes: 0,
          estimatedChapters: 0
        },
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastOperation: null,
        error: null
      };
      saveProjectState(state);
      logger.info(`Project created: ${safeName}`, { projectDir });
      return { success: true, state };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to create project: ${msg}`);
      return { success: false, error: msg };
    }
  });
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_OPEN,
    async (_event, projectDir) => {
      try {
        const statePath = path.join(projectDir, "project-state.json");
        if (!fs__namespace.existsSync(statePath)) {
          throw new Error(`No project-state.json found in ${projectDir}`);
        }
        const state = JSON.parse(
          fs__namespace.readFileSync(statePath, "utf-8")
        );
        logger.info(`Project opened: ${state.name}`, { projectDir });
        return { success: true, state };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to open project: ${msg}`);
        return { success: false, error: msg };
      }
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SAVE,
    async (_event, state) => {
      try {
        state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        saveProjectState(state);
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to save project: ${msg}`);
        return { success: false, error: msg };
      }
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_UPDATE_INPUTS,
    async (_event, projectDir, inputs) => {
      try {
        const statePath = path.join(projectDir, "project-state.json");
        const state = JSON.parse(
          fs__namespace.readFileSync(statePath, "utf-8")
        );
        state.inputs = { ...state.inputs, ...inputs };
        state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        saveProjectState(state);
        return { success: true, state };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to update inputs: ${msg}`);
        return { success: false, error: msg };
      }
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_UPDATE_SETTINGS,
    async (_event, projectDir, settings) => {
      try {
        const statePath = path.join(projectDir, "project-state.json");
        const state = JSON.parse(
          fs__namespace.readFileSync(statePath, "utf-8")
        );
        state.settings = { ...state.settings, ...settings };
        state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        saveProjectState(state);
        return { success: true, state };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to update settings: ${msg}`);
        return { success: false, error: msg };
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.GET_PROJECTS_DIR, () => {
    ensureProjectsDir();
    return getProjectsDir();
  });
  ipcMain.handle(IPC_CHANNELS.SET_PROJECTS_DIR, (_event, newDir) => {
    try {
      if (!newDir || typeof newDir !== "string") return { success: false, error: "Invalid path" };
      fs__namespace.mkdirSync(newDir, { recursive: true });
      const cfg = readConfig();
      cfg.projectsDir = newDir;
      writeConfig(cfg);
      return { success: true, projectsDir: newDir };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  });
  ipcMain.handle(IPC_CHANNELS.GET_APP_VERSION, () => electron.app.getVersion());
}
const FFPROBE_PATH = ffprobeStatic.path;
const IMAGE_EXTS = /* @__PURE__ */ new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"]);
const VIDEO_EXTS = /* @__PURE__ */ new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".mxf"]);
const AUDIO_EXTS = /* @__PURE__ */ new Set([".mp3", ".wav", ".aac", ".m4a", ".ogg", ".flac", ".opus"]);
async function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const proc = spawn(FFPROBE_PATH, [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      filePath
    ]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => stdout += d.toString());
    proc.stderr.on("data", (d) => stderr += d.toString());
    proc.on("close", (code) => {
      if (code !== 0) {
        ffmpegLogger.error(`ffprobe failed for ${filePath}: ${stderr}`);
        reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Failed to parse ffprobe JSON"));
        }
      }
    });
    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
    });
  });
}
function buildMediaItem(filePath, probe) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs__namespace.statSync(filePath);
  const streams = probe.streams || [];
  const format = probe.format || {};
  const videoStream = streams.find((s) => s.codec_type === "video");
  streams.find((s) => s.codec_type === "audio");
  const isImage = IMAGE_EXTS.has(ext);
  const isVideo = VIDEO_EXTS.has(ext);
  const isAudio = AUDIO_EXTS.has(ext);
  const width = videoStream?.width;
  const height = videoStream?.height;
  const duration = parseFloat(
    videoStream?.duration || format.duration || "0"
  );
  const fps = videoStream?.r_frame_rate ? (() => {
    const parts = videoStream.r_frame_rate.split("/");
    return parts.length === 2 ? Math.round(parseFloat(parts[0]) / parseFloat(parts[1])) : parseFloat(videoStream.r_frame_rate);
  })() : void 0;
  const ar = width && height ? `${Math.round(width / height * 100) / 100}:1` : void 0;
  return {
    type: isImage ? "image" : isVideo ? "video" : "audio",
    path: filePath,
    filename: path.basename(filePath),
    fileSize: stat.size,
    width: isImage || isVideo ? width : void 0,
    height: isImage || isVideo ? height : void 0,
    duration: isVideo ? isNaN(duration) ? void 0 : duration : void 0,
    audioDuration: isAudio ? isNaN(duration) ? void 0 : duration : void 0,
    fps: isVideo ? fps : void 0,
    codec: videoStream?.codec_name,
    aspectRatio: ar,
    tags: [],
    description: "",
    usageCount: 0,
    importedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function scanFolder(folderPath, extensions) {
  const results = [];
  if (!fs__namespace.existsSync(folderPath)) return results;
  function recurse(dir) {
    let entries;
    try {
      entries = fs__namespace.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(fullPath);
      } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
  recurse(folderPath);
  return results;
}
function registerMediaHandlers(ipcMain) {
  ipcMain.handle(
    IPC_CHANNELS.MEDIA_SCAN,
    async (event, params) => {
      const result = {
        images: [],
        videos: [],
        music: [],
        sfx: [],
        errors: []
      };
      const win = electron.BrowserWindow.fromWebContents(event.sender);
      const sendProgress = (message, progress) => {
        win?.webContents.send(IPC_CHANNELS.MEDIA_SCAN_PROGRESS, { message, progress });
        logger.info(`[SCAN] ${message} (${Math.round(progress * 100)}%)`);
      };
      const processFiles = async (files, bucket, label, offset, range) => {
        for (let i = 0; i < files.length; i++) {
          const fp = files[i];
          const progress = offset + i / Math.max(files.length, 1) * range;
          sendProgress(`Analyzing ${label}: ${path.basename(fp)}`, progress);
          try {
            const probe = await probeMedia(fp);
            const item = buildMediaItem(fp, probe);
            const id = uuid.v4();
            bucket.push({ id, ...item });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push({ path: fp, error: msg });
            logger.warn(`Failed to probe ${fp}: ${msg}`);
          }
        }
      };
      sendProgress("Scanning image folder...", 0);
      const imageFiles = params.imagesFolder ? scanFolder(params.imagesFolder, IMAGE_EXTS) : [];
      sendProgress("Scanning video folder...", 0.05);
      const videoFiles = params.videosFolder ? scanFolder(params.videosFolder, VIDEO_EXTS) : [];
      sendProgress("Scanning music folder...", 0.1);
      const musicFiles = params.musicFolder ? scanFolder(params.musicFolder, AUDIO_EXTS) : [];
      sendProgress("Scanning SFX folder...", 0.12);
      const sfxFiles = params.sfxFolder ? scanFolder(params.sfxFolder, AUDIO_EXTS) : [];
      const total = imageFiles.length + videoFiles.length + musicFiles.length + sfxFiles.length;
      logger.info(`Found ${total} media files total`, {
        images: imageFiles.length,
        videos: videoFiles.length,
        music: musicFiles.length,
        sfx: sfxFiles.length
      });
      await processFiles(imageFiles, result.images, "image", 0.15, 0.3);
      await processFiles(videoFiles, result.videos, "video", 0.45, 0.35);
      await processFiles(musicFiles, result.music, "music", 0.8, 0.1);
      await processFiles(sfxFiles, result.sfx, "sfx", 0.9, 0.08);
      const allMedia = [
        ...result.images,
        ...result.videos,
        ...result.music,
        ...result.sfx
      ];
      const indexPath = path.join(params.projectDir, "analysis", "media-index.json");
      fs__namespace.mkdirSync(path.join(params.projectDir, "analysis"), { recursive: true });
      fs__namespace.writeFileSync(indexPath, JSON.stringify(allMedia, null, 2), "utf-8");
      sendProgress(`Scan complete — ${total} assets indexed`, 1);
      logger.info("Media scan complete", {
        images: result.images.length,
        videos: result.videos.length,
        music: result.music.length,
        sfx: result.sfx.length,
        errors: result.errors.length
      });
      return result;
    }
  );
}
function getUvPath() {
  if (process.env.UV_PATH && fs__namespace.existsSync(process.env.UV_PATH)) {
    return process.env.UV_PATH;
  }
  try {
    const cmd = process.platform === "win32" ? "where uv" : "which uv";
    const out = child_process.execSync(cmd, { encoding: "utf8", env: process.env }).trim().split(/\r?\n/)[0].trim();
    if (out && fs__namespace.existsSync(out)) {
      return out;
    }
  } catch {
  }
  const homedir = os__namespace.homedir();
  const candidates = process.platform === "win32" ? [
    path.join(homedir, ".local", "bin", "uv.exe"),
    path.join(homedir, ".cargo", "bin", "uv.exe"),
    "C:\\Users\\ADMIN\\.local\\bin\\uv.exe"
  ] : [
    path.join(homedir, ".local", "bin", "uv"),
    path.join(homedir, ".cargo", "bin", "uv"),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
    "/usr/bin/uv"
  ];
  for (const candidate of candidates) {
    if (fs__namespace.existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? candidates[0] : "uv";
}
function getScriptPath() {
  if (!electron.app.isPackaged) {
    return path.join(process.cwd(), "scripts", "transcribe.py");
  }
  return path.join(process.resourcesPath, "scripts", "transcribe.py");
}
function getModelsDir() {
  const dir = path.join(electron.app.getPath("userData"), "whisper-models");
  if (!fs__namespace.existsSync(dir)) fs__namespace.mkdirSync(dir, { recursive: true });
  return dir;
}
async function transcribeAudio(audioPath, modelName = "base", onProgress) {
  const scriptPath = getScriptPath();
  const modelsDir = getModelsDir();
  const uvPath = getUvPath();
  if (!fs__namespace.existsSync(scriptPath)) {
    throw new Error(`Transcription script not found: ${scriptPath}`);
  }
  const uvExists = fs__namespace.existsSync(uvPath) || (() => {
    try {
      child_process.execSync(`${uvPath} --version`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  if (!uvExists) {
    throw new Error(
      `uv not found at "${uvPath}". Please install uv (https://docs.astral.sh/uv/) or run "brew install uv" on macOS.`
    );
  }
  logger.info("Starting transcription via uv + faster-whisper", {
    audio: audioPath,
    model: modelName,
    script: scriptPath,
    uv: uvPath
  });
  onProgress?.("Starting uv + faster-whisper...", 0.02);
  return new Promise((resolve, reject) => {
    const args = [
      "run",
      scriptPath,
      audioPath,
      "--model",
      modelName,
      "--cache-dir",
      modelsDir
    ];
    logger.info(`Spawning: ${uvPath} ${args.join(" ")}`);
    const proc = child_process.spawn(uvPath, args, {
      env: { ...process.env },
      windowsHide: true
    });
    let resultData = null;
    let stderr = "";
    let stdoutBuffer = "";
    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.type === "progress") {
            onProgress?.(msg.message, msg.progress);
            logger.info(`[WHISPER] ${msg.message}`);
          } else if (msg.type === "result") {
            resultData = msg;
          } else if (msg.type === "error") {
            logger.error(`[WHISPER] Script error: ${msg.message}`);
          }
        } catch {
          logger.debug(`[WHISPER stdout] ${trimmed.slice(0, 120)}`);
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line.includes("Transcribing") || line.includes("Detected") || line.includes("%")) {
          onProgress?.(line.trim(), 0.5);
        }
      }
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        logger.error(`Transcription process exited ${code}`, { stderr: stderr.slice(0, 500) });
        reject(new Error(`Transcription failed (exit ${code}): ${stderr.slice(0, 300)}`));
        return;
      }
      if (!resultData) {
        reject(new Error("Transcription produced no result"));
        return;
      }
      logger.info("Transcription complete", {
        segments: resultData.segments.length,
        words: resultData.wordCount,
        duration: resultData.duration
      });
      resolve(resultData);
    });
    proc.on("error", (err) => {
      logger.error(`Failed to spawn transcription process: ${err.message}`);
      reject(new Error(`Failed to start transcription: ${err.message}`));
    });
  });
}
function registerTranscribeHandlers(ipcMain) {
  ipcMain.handle(IPC_CHANNELS.TRANSCRIBE_CHECK_MODEL, (_event, modelName) => {
    const cacheDir = getModelsDir();
    const modelFile = path.join(cacheDir, `models--Systran--faster-whisper-${modelName}`);
    return {
      exists: fs__namespace.existsSync(modelFile),
      path: modelFile,
      modelsDir: cacheDir
    };
  });
  ipcMain.handle(IPC_CHANNELS.TRANSCRIBE_GET, (_event, projectDir) => {
    const transcriptPath = path.join(projectDir, "analysis", "transcript.json");
    if (!fs__namespace.existsSync(transcriptPath)) return null;
    try {
      return JSON.parse(fs__namespace.readFileSync(transcriptPath, "utf-8"));
    } catch {
      return null;
    }
  });
  ipcMain.handle(
    IPC_CHANNELS.TRANSCRIBE_START,
    async (event, params) => {
      const win = electron.BrowserWindow.fromWebContents(event.sender);
      const sendProgress = (message, progress) => {
        win?.webContents.send(IPC_CHANNELS.TRANSCRIBE_PROGRESS, { message, progress });
        logger.info(`[TRANSCRIBE] ${message}`);
      };
      try {
        sendProgress("Initializing Whisper...", 0.02);
        const transcriptPath = path.join(params.projectDir, "analysis", "transcript.json");
        const cacheMetaPath = path.join(params.projectDir, "analysis", "transcript-meta.json");
        if (fs__namespace.existsSync(cacheMetaPath) && fs__namespace.existsSync(transcriptPath)) {
          const meta = JSON.parse(fs__namespace.readFileSync(cacheMetaPath, "utf-8"));
          const stat2 = fs__namespace.statSync(params.voiceoverPath);
          const currentHash = `${params.voiceoverPath}:${stat2.size}:${stat2.mtimeMs}`;
          if (meta.hash === currentHash && meta.model === params.modelName) {
            sendProgress("Using cached transcript", 1);
            const cached = JSON.parse(fs__namespace.readFileSync(transcriptPath, "utf-8"));
            return { success: true, transcript: cached, cached: true };
          }
        }
        const transcript = await transcribeAudio(
          params.voiceoverPath,
          params.modelName,
          (msg, prog) => sendProgress(msg, prog ?? 0.3)
        );
        sendProgress("Saving transcript...", 0.95);
        fs__namespace.mkdirSync(path.join(params.projectDir, "analysis"), { recursive: true });
        fs__namespace.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2), "utf-8");
        const stat = fs__namespace.statSync(params.voiceoverPath);
        fs__namespace.writeFileSync(
          cacheMetaPath,
          JSON.stringify({
            hash: `${params.voiceoverPath}:${stat.size}:${stat.mtimeMs}`,
            model: params.modelName,
            generatedAt: (/* @__PURE__ */ new Date()).toISOString()
          }),
          "utf-8"
        );
        sendProgress(`Done — ${transcript.segments.length} segments`, 1);
        logger.info("Transcript saved", { segments: transcript.segments.length });
        return { success: true, transcript, cached: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Transcription failed: ${msg}`);
        sendProgress(`Error: ${msg}`, -1);
        return { success: false, error: msg };
      }
    }
  );
}
function buildPrompt(transcript, scriptText, mediaFiles) {
  const videoFiles = mediaFiles.filter((m) => m.type === "video");
  const imageFiles = mediaFiles.filter((m) => m.type === "image");
  const hasLocalMedia = mediaFiles.length > 0;
  const mediaList = hasLocalMedia ? [
    ...videoFiles.map((v) => `  VIDEO: ${v.filename} (${v.durationSecs?.toFixed(1) ?? "?"}s)`),
    ...imageFiles.map((i) => `  IMAGE: ${i.filename}`)
  ].join("\n") : "";
  const transcriptLines = transcript.segments.map(
    (seg) => `[${seg.id}] ${seg.start.toFixed(1)}s-${seg.end.toFixed(1)}s: "${seg.text}"`
  ).join("\n");
  const mediaSection = hasLocalMedia ? `## AVAILABLE LOCAL MEDIA LIBRARY
${mediaList}
` : `## MEDIA MODE: STOCK SEARCH ONLY
No local media files provided. You MUST NOT invent filenames. Set "localAsset" to null for all scenes.
`;
  const sceneSchemaExample = hasLocalMedia ? `{
              "sceneIndex": 1,
              "localAsset": "exact_filename.mp4 or null if no match",
              "mediaType": "video",
              "startTime": 0,
              "endTime": 15,
              "duration": 15,
              "narrativeText": "The narration text spoken here",
              "transcriptSegmentIds": ["N001", "N002"],
              "transitionIn": "cut",
              "visualNote": "Shows opening establishing shot",
              "visualIntent": "short description of visual concept (3-10 words)",
              "searchQueries": ["short query 1", "short query 2", "short query 3"]
            }` : `{
              "sceneIndex": 1,
              "localAsset": null,
              "mediaType": "video",
              "startTime": 0,
              "endTime": 15,
              "duration": 15,
              "narrativeText": "The narration text spoken here",
              "transcriptSegmentIds": ["N001", "N002"],
              "transitionIn": "cut",
              "visualNote": "Shows opening establishing shot",
              "visualIntent": "short description of visual concept (3-10 words)",
              "searchQueries": ["short query 1", "short query 2", "short query 3"]
            }`;
  return `You are a professional documentary video editor AI. Your job is to create a complete master edit plan.

## NARRATION TRANSCRIPT (${transcript.segments.length} segments, ${transcript.duration.toFixed(0)}s total)
${transcriptLines}

${mediaSection}
${scriptText ? `## ORIGINAL SCRIPT
${scriptText.slice(0, 8e3)}
` : ""}

## YOUR TASK
Create a master edit plan as a JSON object. Rules:
1. Every second of narration MUST be covered by a media clip
2. ${hasLocalMedia ? 'Match local files logically to narrative content. Set "localAsset" to the exact filename if matched, or null if no local file fits — stock search will fill those gaps.' : 'Set "localAsset" to null for all scenes (stock will be auto-searched).'}
3. Videos can be used for their full duration or trimmed
4. Images should display for 3-8 seconds
5. Divide the content into 3-6 chapters with meaningful titles
6. Each chapter has 2-4 sequences, each sequence has 2-6 scenes
7. Transition between scenes: mostly "cut", use "fade" for chapter breaks
8. For EVERY scene, write a "visualIntent" (3-10 words describing the visual concept) and 3-5 "searchQueries".
   IMPORTANT — searchQueries must be SHORT and VISUALLY SEARCHABLE (not literal narration sentences).
   BAD:  "family has to borrow money to cover funeral expenses"
   GOOD: ["worried family bills", "credit card debt", "financial stress", "loan paperwork"]

Return ONLY valid JSON, no explanation, matching this exact schema:
{
  "chapters": [
    {
      "chapterIndex": 1,
      "title": "Chapter title",
      "startTime": 0,
      "endTime": 120,
      "sequences": [
        {
          "sequenceIndex": 1,
          "title": "Sequence title",
          "startTime": 0,
          "endTime": 60,
          "scenes": [
            ${sceneSchemaExample}
          ]
        }
      ]
    }
  ]
}`;
}
function extractVisualQueries(text) {
  const clean = text.replace(/[.,/#!$%^&*;:{}=\-_`~()?"'0-9]/g, " ").trim();
  const words = clean.split(/\s+/).filter((w) => w.length > 2);
  const queries = [];
  if (words.length >= 3) {
    queries.push(words.slice(0, 4).join(" "));
    const mid = Math.floor(words.length / 2);
    queries.push(words.slice(mid, mid + 3).join(" "));
    queries.push(words.slice(-3).join(" "));
  } else {
    queries.push(clean || "documentary cinematic shot");
  }
  return queries.filter((q) => q.length >= 3).slice(0, 3);
}
function buildAlgorithmicPlan(transcript, projectName) {
  const segments = transcript.segments;
  const totalDuration = transcript.duration;
  const numChapters = Math.min(5, Math.max(2, Math.round(totalDuration / 90)));
  const segsPerChapter = Math.ceil(segments.length / numChapters);
  const chapters = [];
  let globalSceneIdx = 1;
  for (let chIdx = 0; chIdx < numChapters; chIdx++) {
    const chSegs = segments.slice(chIdx * segsPerChapter, (chIdx + 1) * segsPerChapter);
    if (chSegs.length === 0) continue;
    const chStart = chSegs[0].start;
    const chEnd = chSegs[chSegs.length - 1].end;
    const seqsPerCh = Math.min(3, Math.max(1, Math.ceil(chSegs.length / 4)));
    const segsPerSeq = Math.ceil(chSegs.length / seqsPerCh);
    const sequences = [];
    for (let seqIdx = 0; seqIdx < seqsPerCh; seqIdx++) {
      const seqSegs = chSegs.slice(seqIdx * segsPerSeq, (seqIdx + 1) * segsPerSeq);
      if (seqSegs.length === 0) continue;
      const scenes = seqSegs.map((seg) => {
        const dur = Math.max(2, Number((seg.end - seg.start).toFixed(1)));
        const queries = extractVisualQueries(seg.text);
        return {
          sceneIndex: globalSceneIdx++,
          mediaFile: "",
          mediaType: "video",
          startTime: seg.start,
          endTime: seg.end,
          duration: dur,
          narrativeText: seg.text,
          transcriptSegmentIds: [seg.id],
          transitionIn: "cut",
          visualNote: `Visual shot: ${queries[0]}`,
          visualIntent: queries[0] ?? "Documentary cinematic b-roll",
          searchQueries: queries
        };
      });
      sequences.push({
        sequenceIndex: seqIdx + 1,
        title: `Sequence ${seqIdx + 1}`,
        startTime: seqSegs[0].start,
        endTime: seqSegs[seqSegs.length - 1].end,
        scenes
      });
    }
    chapters.push({
      chapterIndex: chIdx + 1,
      title: chIdx === 0 ? "Chapter 1: Introduction" : chIdx === numChapters - 1 ? `Chapter ${chIdx + 1}: Conclusion` : `Chapter ${chIdx + 1}`,
      startTime: chStart,
      endTime: chEnd,
      sequences
    });
  }
  const allScenes = chapters.flatMap((c) => c.sequences.flatMap((s) => s.scenes));
  return {
    projectName,
    totalDuration,
    totalScenes: allScenes.length,
    language: transcript.language,
    chapters,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    modelUsed: "rule-based-engine"
  };
}
async function buildEditPlan(params) {
  const { projectDir, apiKey, onProgress } = params;
  const modelId = params.model ?? "gemini-2.0-flash";
  const progress = (msg, pct) => {
    logger.info(`[PLAN] ${msg}`);
    onProgress?.(msg, pct);
  };
  progress("Loading transcript...", 0.05);
  const transcriptPath = path.join(projectDir, "analysis", "transcript.json");
  if (!fs__namespace.existsSync(transcriptPath)) {
    throw new Error("No transcript found. Run transcription first.");
  }
  const transcript = JSON.parse(fs__namespace.readFileSync(transcriptPath, "utf-8"));
  progress("Loading script...", 0.08);
  const mediaIndexPath = path.join(projectDir, "analysis", "media-index.json");
  let mediaFiles = [];
  if (fs__namespace.existsSync(mediaIndexPath)) {
    const rawItems = JSON.parse(fs__namespace.readFileSync(mediaIndexPath, "utf-8"));
    mediaFiles = rawItems.map((item) => ({
      filePath: item.path ?? "",
      filename: item.filename,
      type: item.type === "video" ? "video" : "image",
      durationSecs: item.durationSecs,
      fps: item.fps,
      width: item.width,
      height: item.height
    }));
  }
  let scriptText = null;
  try {
    const stateFile = fs__namespace.existsSync(path.join(projectDir, "project-state.json")) ? path.join(projectDir, "project-state.json") : path.join(projectDir, "project.json");
    const scriptPathFromParams = params.scriptPath;
    const scriptPathFromState = (() => {
      try {
        const st = JSON.parse(fs__namespace.readFileSync(stateFile, "utf-8"));
        return st?.inputs?.scriptPath;
      } catch {
        return void 0;
      }
    })();
    const resolvedScriptPath = scriptPathFromParams ?? scriptPathFromState;
    if (resolvedScriptPath && fs__namespace.existsSync(resolvedScriptPath)) {
      scriptText = fs__namespace.readFileSync(resolvedScriptPath, "utf-8");
    }
  } catch (err) {
    logger.warn(`Could not load script text: ${err}`);
  }
  let projectName = "Unnamed";
  try {
    const stateFile = fs__namespace.existsSync(path.join(projectDir, "project-state.json")) ? path.join(projectDir, "project-state.json") : path.join(projectDir, "project.json");
    const st = JSON.parse(fs__namespace.readFileSync(stateFile, "utf-8"));
    projectName = st?.name ?? "Unnamed";
  } catch {
  }
  progress(`Building prompt (${transcript.segments.length} segments, ${mediaFiles.length} media files)...`, 0.12);
  const prompt = buildPrompt(transcript, scriptText, mediaFiles);
  progress("Sending to Gemini AI...", 0.2);
  const ai = new genai.GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" }
  });
  const fallbackModelChain = [
    modelId,
    "gemini-2.0-flash",
    "gemini-1.5-flash"
  ].filter((v, i, a) => a.indexOf(v) === i);
  let activeModelIndex = 0;
  let rawJson = "";
  let finalModelUsed = modelId;
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const currentModel = fallbackModelChain[activeModelIndex];
    try {
      progress(
        attempt === 1 ? `Đang gửi yêu cầu tới Gemini AI (${currentModel})...` : `Thử lại lần ${attempt}/${maxRetries} (${currentModel})...`,
        0.2 + (attempt - 1) * 0.1
      );
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.3,
          maxOutputTokens: 32768
        }
      });
      rawJson = response.text ?? "";
      finalModelUsed = currentModel;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isOverloaded = msg.includes("503") || msg.includes("high demand") || msg.includes("UNAVAILABLE") || msg.includes("429");
      if (isOverloaded && activeModelIndex + 1 < fallbackModelChain.length) {
        activeModelIndex++;
        const nextModel = fallbackModelChain[activeModelIndex];
        logger.warn(`Model ${currentModel} overloaded (503). Auto-switching to fallback: ${nextModel}`);
        progress(
          `Model ${currentModel} đang quá tải (503). Tự động chuyển sang model dự phòng "${nextModel}"...`,
          0.3 + attempt / maxRetries * 0.35
        );
        await new Promise((res) => setTimeout(res, 2e3));
        continue;
      }
      if (isOverloaded && attempt < maxRetries) {
        const waitSec = Math.min(attempt * 4, 16);
        logger.warn(`Gemini 503 high demand (attempt ${attempt}/${maxRetries}), waiting ${waitSec}s...`);
        for (let sec = waitSec; sec > 0; sec--) {
          progress(
            `Google AI đang quá tải (503 High Demand), tự động thử lại lần ${attempt + 1}/${maxRetries} sau ${sec}s...`,
            0.3 + (attempt - 1) / maxRetries * 0.35
          );
          await new Promise((res) => setTimeout(res, 1e3));
        }
        continue;
      }
      logger.warn(`All AI attempts failed (${msg}). Activating algorithmic rule-based fallback generator...`);
      progress("Google AI tạm thời quá tải trên diện rộng. Tự động kích hoạt bộ tạo phân cảnh thông minh theo kịch bản...", 0.85);
      const fallbackPlan = buildAlgorithmicPlan(transcript, projectName);
      const planPath2 = path.join(projectDir, "analysis", "master-edit-plan.json");
      fs__namespace.writeFileSync(planPath2, JSON.stringify(fallbackPlan, null, 2), "utf-8");
      progress(`Hoàn tất — đã tạo phân cảnh dự phòng (${fallbackPlan.totalScenes} scenes)`, 1);
      return fallbackPlan;
    }
  }
  progress("Parsing edit plan...", 0.85);
  let planData;
  try {
    const clean = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    planData = JSON.parse(clean);
  } catch (err) {
    logger.warn("Failed to parse Gemini JSON, falling back to algorithmic plan", { raw: rawJson.slice(0, 300) });
    const fallbackPlan = buildAlgorithmicPlan(transcript, projectName);
    const planPath2 = path.join(projectDir, "analysis", "master-edit-plan.json");
    fs__namespace.writeFileSync(planPath2, JSON.stringify(fallbackPlan, null, 2), "utf-8");
    progress(`Hoàn tất — đã tạo phân cảnh dự phòng (${fallbackPlan.totalScenes} scenes)`, 1);
    return fallbackPlan;
  }
  for (const ch of planData.chapters || []) {
    const seqs = ch.sequences ?? ch.chapters_seq ?? [];
    for (const seq of seqs) {
      for (const sc of seq.scenes || []) {
        if (!sc.mediaFile) {
          sc.mediaFile = sc.localAsset || "";
        }
        if (!sc.mediaType) {
          sc.mediaType = "video";
        }
      }
    }
  }
  const allScenes = planData.chapters.flatMap(
    (c) => (c.sequences ?? c.chapters_seq ?? []).flatMap((s) => s.scenes ?? [])
  );
  const totalScenes = allScenes.length;
  const totalDuration = transcript.duration;
  const plan = {
    projectName,
    totalDuration,
    totalScenes,
    language: transcript.language,
    chapters: planData.chapters,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    modelUsed: finalModelUsed
  };
  progress("Saving edit plan...", 0.95);
  const planPath = path.join(projectDir, "analysis", "master-edit-plan.json");
  fs__namespace.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
  logger.info("Edit plan saved", { chapters: plan.chapters.length, scenes: totalScenes });
  progress(`Done — ${plan.chapters.length} chapters, ${totalScenes} scenes`, 1);
  return plan;
}
const CONFIG_PATH = path.join(electron.app.getPath("userData"), "app-config.json");
function loadConfig() {
  try {
    if (fs__namespace.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs__namespace.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch {
    logger.warn("Failed to read app config, using defaults");
  }
  return {};
}
function saveConfig(config) {
  try {
    fs__namespace.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    logger.info("App config saved", { hasGeminiKey: !!config.geminiApiKey });
  } catch (err) {
    logger.error(`Failed to save config: ${err}`);
  }
}
function registerPlannerHandlers(ipcMain) {
  ipcMain.handle(IPC_CHANNELS.CONFIG_SET, (_event, key, value) => {
    const config = loadConfig();
    config[key] = value;
    saveConfig(config);
    return { success: true };
  });
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, (_event, key) => {
    const config = loadConfig();
    return config[key] ?? null;
  });
  ipcMain.handle(IPC_CHANNELS.PLAN_GET, (_event, projectDir) => {
    const planPath = path.join(projectDir, "analysis", "master-edit-plan.json");
    if (!fs__namespace.existsSync(planPath)) return null;
    try {
      return JSON.parse(fs__namespace.readFileSync(planPath, "utf-8"));
    } catch {
      return null;
    }
  });
  ipcMain.handle(
    IPC_CHANNELS.PLAN_GENERATE,
    async (event, params) => {
      const win = electron.BrowserWindow.fromWebContents(event.sender);
      const config = loadConfig();
      if (!config.geminiApiKey) {
        return { success: false, error: "Gemini API key not configured. Go to Settings to add it." };
      }
      const sendProgress = (message, progress) => {
        win?.webContents.send(IPC_CHANNELS.PLAN_PROGRESS, { message, progress });
      };
      try {
        const plan = await buildEditPlan({
          projectDir: params.projectDir,
          apiKey: config.geminiApiKey,
          model: params.model,
          onProgress: sendProgress
        });
        return { success: true, plan };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Edit planning failed: ${msg}`);
        return { success: false, error: msg };
      }
    }
  );
}
const ffmpegPath = require("ffmpeg-static");
function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(ffmpegPath, args, { windowsHide: true });
    const stderr = [];
    proc.stderr.on("data", (d) => stderr.push(d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-5).join("")}`));
    });
    proc.on("error", reject);
  });
}
function resolveMediaPath(filename, mediaIndex) {
  if (!filename) return null;
  const item = mediaIndex.find((m) => m.filename === filename || path__namespace.basename(m.path) === filename);
  return item ? item.path : null;
}
function resolveSceneMedia(scene, mediaIndex) {
  if (scene.localPath && fs__namespace.existsSync(scene.localPath)) return scene.localPath;
  if (scene.localAsset && fs__namespace.existsSync(scene.localAsset)) return scene.localAsset;
  if (scene.mediaFile) {
    const found = resolveMediaPath(scene.mediaFile, mediaIndex);
    if (found) return found;
  }
  if (scene.localAsset) {
    const found = resolveMediaPath(scene.localAsset, mediaIndex);
    if (found) return found;
  }
  return null;
}
async function renderVideo(params) {
  const {
    projectDir,
    voiceoverPath,
    outputName = "final_output",
    resolution = { width: 1920, height: 1080 },
    fps = 30,
    onProgress
  } = params;
  const progress = (stage, pct, extra = {}) => {
    logger.info(`[RENDER] ${stage} (${Math.round(pct * 100)}%)`);
    onProgress?.({ stage, progress: pct, ...extra });
  };
  progress("Loading edit plan...", 0.02);
  const planPath = path__namespace.join(projectDir, "analysis", "master-edit-plan.json");
  if (!fs__namespace.existsSync(planPath)) throw new Error("No edit plan found. Run AI Planning first.");
  const plan = JSON.parse(fs__namespace.readFileSync(planPath, "utf-8"));
  progress("Loading media index...", 0.04);
  const mediaIndexPath = path__namespace.join(projectDir, "analysis", "media-index.json");
  const mediaIndex = fs__namespace.existsSync(mediaIndexPath) ? JSON.parse(fs__namespace.readFileSync(mediaIndexPath, "utf-8")) : [];
  const scenes = plan.chapters.flatMap(
    (ch) => (ch.sequences ?? ch.chapters_seq ?? []).flatMap((seq) => seq.scenes ?? [])
  );
  const totalScenes = scenes.length;
  progress(`Processing ${totalScenes} scenes...`, 0.06);
  const tmpDir = path__namespace.join(projectDir, "renders", "_tmp");
  fs__namespace.mkdirSync(tmpDir, { recursive: true });
  const sceneClips = [];
  const { width, height } = resolution;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const mediaName = scene.localPath ? path__namespace.basename(scene.localPath) : scene.mediaFile || scene.localAsset || scene.visualIntent || `Scene_${scene.sceneIndex}`;
    const pct = 0.06 + i / totalScenes * 0.7;
    progress(`Scene ${i + 1}/${totalScenes}: ${mediaName}`, pct, {
      sceneIndex: i + 1,
      totalScenes
    });
    const mediaPath = resolveSceneMedia(scene, mediaIndex);
    const outClip = path__namespace.join(tmpDir, `scene_${String(i + 1).padStart(4, "0")}.mp4`);
    const scaleFilt = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    if (!mediaPath || !fs__namespace.existsSync(mediaPath)) {
      logger.warn(`[RENDER] Missing media for scene ${scene.sceneIndex}: ${mediaName}, using black placeholder`);
      await ffmpegRun([
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${width}x${height}:d=${scene.duration}:r=${fps}`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-t",
        String(scene.duration),
        "-pix_fmt",
        "yuv420p",
        outClip
      ]);
    } else {
      const isImage = /\.(jpe?g|png|webp|bmp|gif)$/i.test(mediaPath) || scene.mediaType === "image";
      if (isImage) {
        await ffmpegRun([
          "-y",
          "-loop",
          "1",
          "-i",
          mediaPath,
          "-vf",
          scaleFilt,
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "20",
          "-t",
          String(scene.duration),
          "-r",
          String(fps),
          "-pix_fmt",
          "yuv420p",
          outClip
        ]);
      } else {
        await ffmpegRun([
          "-y",
          "-i",
          mediaPath,
          "-vf",
          scaleFilt,
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "20",
          "-t",
          String(scene.duration),
          "-r",
          String(fps),
          "-an",
          // strip audio from source video (voiceover added later)
          "-pix_fmt",
          "yuv420p",
          outClip
        ]);
      }
    }
    sceneClips.push(outClip);
  }
  progress("Concatenating scenes...", 0.78);
  const concatList = path__namespace.join(tmpDir, "concat.txt");
  fs__namespace.writeFileSync(
    concatList,
    sceneClips.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"),
    "utf-8"
  );
  const rawVideo = path__namespace.join(tmpDir, "raw_video.mp4");
  await ffmpegRun([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatList,
    "-c",
    "copy",
    rawVideo
  ]);
  progress("Loading audio plan…", 0.86);
  const audioPlanPath = path__namespace.join(projectDir, "analysis", "audio-plan.json");
  const audioPlan = fs__namespace.existsSync(audioPlanPath) ? JSON.parse(fs__namespace.readFileSync(audioPlanPath, "utf-8")) : null;
  const approvedMusic = audioPlan?.sections.filter(
    (s) => s.approved && s.approvedLocalPath && fs__namespace.existsSync(s.approvedLocalPath)
  ) ?? [];
  const approvedSfx = audioPlan?.sfxAssignments.filter(
    (s) => s.approved && s.approvedLocalPath && fs__namespace.existsSync(s.approvedLocalPath)
  ) ?? [];
  const hasAudio = fs__namespace.existsSync(voiceoverPath);
  const hasMusicOrSfx = approvedMusic.length > 0 || approvedSfx.length > 0;
  logger.info(`[RENDER] Audio: voiceover=${hasAudio}, music=${approvedMusic.length}, sfx=${approvedSfx.length}`);
  progress("Mixing audio tracks…", 0.9);
  const outputDir = path__namespace.join(projectDir, "output");
  fs__namespace.mkdirSync(outputDir, { recursive: true });
  const outputPath = path__namespace.join(outputDir, `${outputName}.mp4`);
  if (!hasAudio && !hasMusicOrSfx) {
    fs__namespace.copyFileSync(rawVideo, outputPath);
  } else if (!hasMusicOrSfx && hasAudio) {
    await ffmpegRun([
      "-y",
      "-i",
      rawVideo,
      "-i",
      voiceoverPath,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-shortest",
      outputPath
    ]);
  } else {
    const ffArgs = ["-y", "-i", rawVideo];
    let inputIdx = 1;
    const voiceoverIdx = hasAudio ? inputIdx++ : -1;
    if (hasAudio) ffArgs.push("-i", voiceoverPath);
    const musicInputs = [];
    for (const sec of approvedMusic) {
      ffArgs.push("-i", sec.approvedLocalPath);
      musicInputs.push({ idx: inputIdx++, section: sec });
    }
    const sfxInputs = [];
    for (const sfx of approvedSfx) {
      ffArgs.push("-i", sfx.approvedLocalPath);
      sfxInputs.push({ idx: inputIdx++, sfx });
    }
    const filterParts = [];
    const mixLabels = [];
    if (hasAudio) {
      filterParts.push(`[${voiceoverIdx}:a]loudnorm=I=-16:TP=-1.5:LRA=11[vo]`);
      mixLabels.push("[vo]");
    }
    for (const { idx, section } of musicInputs) {
      const vol = Math.pow(10, (section.volumeDb ?? -30) / 20).toFixed(6);
      const fadeIn = section.fadeInSecs ?? 2;
      const fadeOut = section.fadeOutSecs ?? 3;
      const dur = section.durationSecs;
      const label = `music_${idx}`;
      filterParts.push(
        `[${idx}:a]volume=${vol},afade=t=in:ss=0:d=${fadeIn},afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut},adelay=${Math.round(section.startTime * 1e3)}|${Math.round(section.startTime * 1e3)},apad[${label}]`
      );
      mixLabels.push(`[${label}]`);
    }
    for (const { idx, sfx } of sfxInputs) {
      const vol = Math.pow(10, (sfx.volumeDb ?? -18) / 20).toFixed(6);
      const fadeIn = sfx.fadeInSecs ?? 0.5;
      const fadeOut = sfx.fadeOutSecs ?? 0.5;
      const dur = sfx.endTime - sfx.startTime;
      const label = `sfx_${idx}`;
      filterParts.push(
        `[${idx}:a]volume=${vol},afade=t=in:ss=0:d=${fadeIn},afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut},adelay=${Math.round(sfx.startTime * 1e3)}|${Math.round(sfx.startTime * 1e3)},apad[${label}]`
      );
      mixLabels.push(`[${label}]`);
    }
    const nInputs = mixLabels.length;
    filterParts.push(
      // normalize=1 scales by 1/nInputs to prevent summing clips
      `${mixLabels.join("")}amix=inputs=${nInputs}:duration=first:normalize=1,alimiter=limit=0.891:attack=5:release=50:level=disabled[amixed]`
    );
    const filterComplex = filterParts.join(";");
    logger.info(`[RENDER] filter_complex: ${filterComplex.slice(0, 200)}…`);
    await ffmpegRun([
      ...ffArgs,
      "-filter_complex",
      filterComplex,
      "-map",
      "0:v:0",
      "-map",
      "[amixed]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      outputPath
    ]);
  }
  progress("Cleaning up...", 0.97);
  try {
    for (const clip of sceneClips) fs__namespace.unlinkSync(clip);
    fs__namespace.unlinkSync(concatList);
    fs__namespace.unlinkSync(rawVideo);
  } catch {
  }
  const stat = fs__namespace.statSync(outputPath);
  const durationSecs = scenes.reduce((a, s) => a + s.duration, 0);
  progress(`Done → ${outputPath}`, 1);
  logger.info("[RENDER] Complete", {
    outputPath,
    durationSecs: Math.round(durationSecs),
    fileSizeMB: (stat.size / 1024 / 1024).toFixed(1)
  });
  return { outputPath, durationSecs, fileSizeBytes: stat.size };
}
function registerRenderHandlers(ipcMain) {
  ipcMain.handle(
    IPC_CHANNELS.RENDER_START,
    async (event, params) => {
      const win = electron.BrowserWindow.fromWebContents(event.sender);
      const sendProgress = (p) => {
        win?.webContents.send(IPC_CHANNELS.RENDER_PROGRESS, p);
      };
      try {
        const result = await renderVideo({
          ...params,
          onProgress: sendProgress
        });
        return { success: true, result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Render failed: ${msg}`);
        return { success: false, error: msg };
      }
    }
  );
}
const PEXELS_BASE = "https://api.pexels.com";
async function pexelsFetch(url2, apiKey, attempt = 0) {
  const res = await fetch(url2, {
    headers: { Authorization: apiKey }
  });
  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? 5) || 5;
    const delay = Math.max(retryAfter, Math.pow(2, attempt) * 3) * 1e3;
    logger.warn(`[Pexels] 429 rate-limited — waiting ${delay / 1e3}s (attempt ${attempt + 1}/3)`);
    await new Promise((r) => setTimeout(r, delay));
    return pexelsFetch(url2, apiKey, attempt + 1);
  }
  return res;
}
async function pexelsSearchVideos(query, apiKey, perPage = 8, orientation = "landscape") {
  const url2 = `${PEXELS_BASE}/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orientation}`;
  let res;
  try {
    res = await pexelsFetch(url2, apiKey);
  } catch (err) {
    logger.error(`[Pexels] Network error searching videos: ${err}`);
    return [];
  }
  if (!res.ok) {
    logger.warn(`[Pexels] Video search returned ${res.status} for query "${query}"`);
    return [];
  }
  const data = await res.json();
  return (data.videos ?? []).map((v) => {
    const files = (v.video_files ?? []).sort((a, b) => {
      const qualityOrder = { hd: 3, sd: 2, hls: 1 };
      return (qualityOrder[b.quality] ?? 0) - (qualityOrder[a.quality] ?? 0);
    });
    const best = files[0] ?? { link: "", width: v.width, height: v.height };
    return {
      assetId: `pexels_v_${v.id}`,
      provider: "pexels",
      mediaType: "video",
      title: `Pexels video ${v.id}`,
      tags: [],
      thumbnailUrl: v.image ?? "",
      previewUrl: v.image ?? "",
      downloadUrl: best.link,
      width: best.width ?? v.width,
      height: best.height ?? v.height,
      durationSecs: v.duration,
      creator: v.user?.name ?? "Unknown",
      creatorUrl: v.user?.url,
      pageUrl: v.url
    };
  });
}
async function pexelsSearchPhotos(query, apiKey, perPage = 8, orientation = "landscape") {
  const url2 = `${PEXELS_BASE}/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orientation}`;
  let res;
  try {
    res = await pexelsFetch(url2, apiKey);
  } catch (err) {
    logger.error(`[Pexels] Network error searching photos: ${err}`);
    return [];
  }
  if (!res.ok) {
    logger.warn(`[Pexels] Photo search returned ${res.status} for query "${query}"`);
    return [];
  }
  const data = await res.json();
  return (data.photos ?? []).map((p) => ({
    assetId: `pexels_p_${p.id}`,
    provider: "pexels",
    mediaType: "photo",
    title: p.alt || `Pexels photo ${p.id}`,
    tags: [],
    thumbnailUrl: p.src?.large ?? p.src?.original ?? "",
    previewUrl: p.src?.large ?? "",
    downloadUrl: p.src?.original ?? p.src?.large2x ?? "",
    width: p.width,
    height: p.height,
    creator: p.photographer ?? "Unknown",
    creatorUrl: p.photographer_url,
    pageUrl: p.url
  }));
}
const PIXABAY_BASE = "https://pixabay.com/api";
async function pixabayFetch(url2, attempt = 0) {
  const res = await fetch(url2);
  if (res.status === 429 && attempt < 3) {
    const delay = Math.pow(2, attempt) * 4e3;
    logger.warn(`[Pixabay] 429 rate-limited — waiting ${delay / 1e3}s (attempt ${attempt + 1}/3)`);
    await new Promise((r) => setTimeout(r, delay));
    return pixabayFetch(url2, attempt + 1);
  }
  return res;
}
async function pixabaySearchVideos(query, apiKey, perPage = 8, orientation = "horizontal") {
  const url2 = `${PIXABAY_BASE}/videos/?key=${apiKey}&q=${encodeURIComponent(query)}&per_page=${perPage}&video_type=all&orientation=${orientation}`;
  let res;
  try {
    res = await pixabayFetch(url2);
  } catch (err) {
    logger.error(`[Pixabay] Network error searching videos: ${err}`);
    return [];
  }
  if (!res.ok) {
    logger.warn(`[Pixabay] Video search returned ${res.status} for query "${query}"`);
    return [];
  }
  const data = await res.json();
  return (data.hits ?? []).map((v) => {
    const best = v.videos?.large?.url ? v.videos.large : v.videos?.medium ?? v.videos?.small;
    const thumb = `https://i.vimeocdn.com/video/${v.picture_id}_640x360.jpg`;
    return {
      assetId: `pixabay_v_${v.id}`,
      provider: "pixabay",
      mediaType: "video",
      title: `Pixabay video ${v.id}`,
      tags: (v.tags ?? "").split(",").map((t) => t.trim()),
      thumbnailUrl: thumb,
      previewUrl: thumb,
      downloadUrl: best?.url ?? "",
      width: best?.width ?? 1920,
      height: best?.height ?? 1080,
      durationSecs: v.duration,
      creator: v.user ?? "Unknown",
      pageUrl: v.pageURL
    };
  });
}
async function pixabaySearchPhotos(query, apiKey, perPage = 8, orientation = "horizontal") {
  const url2 = `${PIXABAY_BASE}/?key=${apiKey}&q=${encodeURIComponent(query)}&per_page=${perPage}&image_type=photo&orientation=${orientation}`;
  let res;
  try {
    res = await pixabayFetch(url2);
  } catch (err) {
    logger.error(`[Pixabay] Network error searching photos: ${err}`);
    return [];
  }
  if (!res.ok) {
    logger.warn(`[Pixabay] Photo search returned ${res.status} for query "${query}"`);
    return [];
  }
  const data = await res.json();
  return (data.hits ?? []).map((p) => ({
    assetId: `pixabay_p_${p.id}`,
    provider: "pixabay",
    mediaType: "photo",
    title: `Pixabay photo ${p.id}`,
    tags: (p.tags ?? "").split(",").map((t) => t.trim()),
    thumbnailUrl: p.webformatURL ?? "",
    previewUrl: p.webformatURL ?? "",
    downloadUrl: p.largeImageURL ?? p.webformatURL ?? "",
    width: p.imageWidth ?? 1920,
    height: p.imageHeight ?? 1080,
    creator: p.user ?? "Unknown",
    pageUrl: p.pageURL
  }));
}
const CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
class QueryCache {
  cachePath;
  data = {};
  dirty = false;
  constructor(cacheDir) {
    fs__namespace.mkdirSync(cacheDir, { recursive: true });
    this.cachePath = path.join(cacheDir, ".query-cache.json");
    this.load();
  }
  /** Normalize a query so "wood working", "Wood Working" and "woodworking" are similar keys */
  static normalize(query) {
    return query.toLowerCase().trim().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "");
  }
  load() {
    try {
      if (fs__namespace.existsSync(this.cachePath)) {
        this.data = JSON.parse(fs__namespace.readFileSync(this.cachePath, "utf-8"));
      }
    } catch {
      this.data = {};
    }
  }
  save() {
    if (!this.dirty) return;
    try {
      fs__namespace.writeFileSync(this.cachePath, JSON.stringify(this.data, null, 2), "utf-8");
      this.dirty = false;
    } catch {
    }
  }
  get(query) {
    const key = QueryCache.normalize(query);
    const entry = this.data[key];
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      delete this.data[key];
      this.dirty = true;
      return null;
    }
    return entry.results;
  }
  set(query, results) {
    const key = QueryCache.normalize(query);
    this.data[key] = { results, cachedAt: Date.now() };
    this.dirty = true;
  }
  size() {
    return Object.keys(this.data).length;
  }
}
function tokenize$1(text) {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2)
  );
}
function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  a.forEach((token) => {
    if (b.has(token)) intersection++;
  });
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
function semanticScore(candidate, ctx) {
  const intentTokens = tokenize$1(ctx.visualIntent);
  const narrationTokens = tokenize$1(ctx.narrationText);
  const refTokens = /* @__PURE__ */ new Set([...intentTokens, ...narrationTokens]);
  const titleTokens = tokenize$1(candidate.title);
  const tagTokens = new Set(candidate.tags.flatMap((t) => t.toLowerCase().split(/\s+/)));
  const candidateTokens2 = /* @__PURE__ */ new Set([...titleTokens, ...tagTokens]);
  return Math.min(1, jaccardSimilarity(refTokens, candidateTokens2) * 5);
}
function technicalScore$1(candidate) {
  const minDim = Math.min(candidate.width, candidate.height);
  if (minDim >= 2160) return 1;
  if (minDim >= 1080) return 0.9;
  if (minDim >= 720) return 0.6;
  return 0.3;
}
function compositionScore$1(candidate, preferredAr) {
  const [pw, ph] = preferredAr.split(":").map(Number);
  const preferred = pw / ph;
  const actual = candidate.width / candidate.height;
  if (!preferred || !actual) return 0.5;
  const diff = Math.abs(preferred - actual) / preferred;
  return Math.max(0, 1 - diff * 2);
}
function durationScore$1(candidate, sceneDuration) {
  if (candidate.mediaType === "photo") return 0.8;
  const clipDur = candidate.durationSecs ?? 0;
  if (clipDur <= 0) return 0.4;
  if (clipDur >= sceneDuration) return 1;
  return Math.max(0.2, clipDur / sceneDuration);
}
function scoreCandidate(candidate, ctx) {
  const sem = semanticScore(candidate, ctx) * 0.5;
  const tech = technicalScore$1(candidate) * 0.2;
  const comp = compositionScore$1(candidate, ctx.preferredAspectRatio) * 0.15;
  const dur = durationScore$1(candidate, ctx.sceneDurationSecs) * 0.15;
  const reuse = ctx.usedAssetIds.has(candidate.assetId) ? 0.3 : 0;
  return Math.max(0, sem + tech + comp + dur - reuse);
}
function rankCandidates(candidates, ctx) {
  return candidates.map((c) => ({ ...c, score: scoreCandidate(c, ctx) })).sort((a, b) => b.score - a.score);
}
const ASSETS_MANIFEST = "stock-assets.json";
function loadAssetsManifest(stockDir) {
  const p = path.join(stockDir, ASSETS_MANIFEST);
  try {
    if (fs__namespace.existsSync(p)) return JSON.parse(fs__namespace.readFileSync(p, "utf-8"));
  } catch {
  }
  return [];
}
function saveAssetsManifest(stockDir, assets) {
  const p = path.join(stockDir, ASSETS_MANIFEST);
  fs__namespace.writeFileSync(p, JSON.stringify(assets, null, 2), "utf-8");
}
function downloadToFile(url$1, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(url$1);
    const proto = parsed.protocol === "https:" ? https__namespace : http__namespace;
    const doRequest = (targetUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error("Too many redirects"));
        return;
      }
      proto.get(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (!location) {
            reject(new Error("Redirect without location"));
            return;
          }
          doRequest(location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${targetUrl}`));
          return;
        }
        const out = fs__namespace.createWriteStream(destPath);
        res.pipe(out);
        out.on("finish", () => {
          const stat = fs__namespace.statSync(destPath);
          resolve(stat.size);
        });
        out.on("error", reject);
        res.on("error", reject);
      }).on("error", reject);
    };
    doRequest(url$1);
  });
}
function guessExtension(url$1, mediaType) {
  try {
    const pathname = new url.URL(url$1).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (ext && ext.length > 1 && ext.length < 6) return ext;
  } catch {
  }
  return mediaType === "video" ? ".mp4" : ".jpg";
}
async function downloadAsset(candidate, sceneIndex, searchQuery, stockDir, existingManifest) {
  fs__namespace.mkdirSync(stockDir, { recursive: true });
  const existing = existingManifest.find(
    (a) => a.assetId === candidate.assetId && fs__namespace.existsSync(a.localPath)
  );
  if (existing) {
    logger.info(`[Downloader] Reusing cached asset ${candidate.assetId}`);
    return existing;
  }
  const ext = guessExtension(candidate.downloadUrl, candidate.mediaType);
  const filename = `S${String(sceneIndex).padStart(3, "0")}_${candidate.provider}_${candidate.assetId}${ext}`;
  const destPath = path.join(stockDir, filename);
  logger.info(`[Downloader] Downloading ${candidate.assetId} → ${filename}`);
  let fileSizeBytes;
  try {
    fileSizeBytes = await downloadToFile(candidate.downloadUrl, destPath);
  } catch (err) {
    logger.error(`[Downloader] Failed to download ${candidate.assetId}: ${err}`);
    throw new Error(`Download failed for ${candidate.assetId}: ${err}`);
  }
  const asset = {
    assetId: candidate.assetId,
    provider: candidate.provider,
    mediaType: candidate.mediaType,
    localPath: destPath,
    thumbnailUrl: candidate.thumbnailUrl,
    downloadUrl: candidate.downloadUrl,
    creator: candidate.creator,
    licenseUrl: candidate.licenseUrl,
    searchQuery,
    downloadedAt: (/* @__PURE__ */ new Date()).toISOString(),
    fileSizeBytes
  };
  logger.info(`[Downloader] Downloaded ${filename} (${Math.round((fileSizeBytes ?? 0) / 1024)} KB)`);
  return asset;
}
function flattenScenes$1(plan) {
  return plan.chapters.flatMap((ch) => ch.chapters_seq ?? ch.sequences ?? []).flatMap((seq) => seq.scenes ?? []);
}
async function searchForScene(queries, pexelsApiKey, pixabayApiKey, preferredOrientation, cache) {
  const allCandidates = [];
  const seenIds = /* @__PURE__ */ new Set();
  const addCandidates = (results) => {
    for (const r of results) {
      if (!seenIds.has(r.assetId)) {
        seenIds.add(r.assetId);
        allCandidates.push(r);
      }
    }
  };
  for (const query of queries) {
    let cached = cache.get(`pexels_v:${query}`);
    if (cached) {
      addCandidates(cached);
    } else {
      const res = await pexelsSearchVideos(query, pexelsApiKey, 8, preferredOrientation);
      cache.set(`pexels_v:${query}`, res);
      addCandidates(res);
    }
    if (allCandidates.length >= 6) break;
  }
  if (allCandidates.length < 3 && pixabayApiKey) {
    for (const query of queries.slice(0, 2)) {
      const cached = cache.get(`pixabay_v:${query}`);
      if (cached) {
        addCandidates(cached);
      } else {
        const orientation = preferredOrientation === "portrait" ? "vertical" : "horizontal";
        const res = await pixabaySearchVideos(query, pixabayApiKey, 8, orientation);
        cache.set(`pixabay_v:${query}`, res);
        addCandidates(res);
      }
    }
  }
  if (allCandidates.length < 2) {
    for (const query of queries.slice(0, 2)) {
      const cached = cache.get(`pexels_p:${query}`);
      if (cached) {
        addCandidates(cached);
      } else {
        const res = await pexelsSearchPhotos(query, pexelsApiKey, 6, preferredOrientation);
        cache.set(`pexels_p:${query}`, res);
        addCandidates(res);
      }
    }
  }
  if (allCandidates.length < 2 && pixabayApiKey) {
    for (const query of queries.slice(0, 1)) {
      const cached = cache.get(`pixabay_p:${query}`);
      if (cached) {
        addCandidates(cached);
      } else {
        const orientation = preferredOrientation === "portrait" ? "vertical" : "horizontal";
        const res = await pixabaySearchPhotos(query, pixabayApiKey, 6, orientation);
        cache.set(`pixabay_p:${query}`, res);
        addCandidates(res);
      }
    }
  }
  return allCandidates;
}
function toOrientation$1(ar) {
  if (ar === "9:16") return "portrait";
  if (ar === "1:1") return "square";
  return "landscape";
}
async function runStockEngine(params, onProgress = () => {
}) {
  const { projectDir, pexelsApiKey, pixabayApiKey, preferredAspectRatio = "16:9" } = params;
  const planPath = path.join(projectDir, "analysis", "master-edit-plan.json");
  if (!fs__namespace.existsSync(planPath)) {
    return {
      success: false,
      totalScenes: 0,
      assignedScenes: 0,
      failedScenes: 0,
      assignments: [],
      error: "No edit plan found. Run AI Planning first."
    };
  }
  const plan = JSON.parse(fs__namespace.readFileSync(planPath, "utf-8"));
  const stockDir = path.join(projectDir, "assets", "stock");
  fs__namespace.mkdirSync(stockDir, { recursive: true });
  const cache = new QueryCache(stockDir);
  let manifest = loadAssetsManifest(stockDir);
  const usedAssetIds = new Set(manifest.map((a) => a.assetId));
  const allScenes = flattenScenes$1(plan);
  const scenesNeedingStock = allScenes.filter(
    (s) => !s.locked && (!s.localPath || !fs__namespace.existsSync(s.localPath))
  );
  const assignments = [];
  let assignedCount = 0;
  let failedCount = 0;
  const orientation = toOrientation$1(preferredAspectRatio);
  onProgress(`Starting stock search for ${scenesNeedingStock.length} scenes…`, 0.01);
  for (let i = 0; i < scenesNeedingStock.length; i++) {
    const scene = scenesNeedingStock[i];
    const pct = 0.05 + i / scenesNeedingStock.length * 0.85;
    const queries = scene.searchQueries?.length ? scene.searchQueries : [scene.visualIntent ?? scene.narrativeText ?? "nature background"].slice(0, 4);
    const visualIntent = scene.visualIntent ?? queries[0] ?? "";
    const narrationText = scene.narrativeText ?? "";
    const sceneDuration = scene.duration ?? scene.endTime - scene.startTime;
    onProgress(
      `[${i + 1}/${scenesNeedingStock.length}] Scene ${scene.sceneIndex} — "${queries[0]}"`,
      pct
    );
    const assignment = {
      sceneId: `scene_${scene.sceneIndex}`,
      sceneIndex: scene.sceneIndex,
      narrationText,
      startTime: scene.startTime,
      endTime: scene.endTime,
      visualIntent,
      searchQueries: queries,
      usedQuery: queries[0],
      asset: null,
      score: 0,
      locked: false,
      manualOverride: false,
      status: "searching"
    };
    try {
      const candidates = await searchForScene(
        queries,
        pexelsApiKey,
        pixabayApiKey,
        orientation,
        cache
      );
      if (candidates.length === 0) {
        assignment.status = "failed";
        assignment.errorMessage = "No candidates found from any provider";
        failedCount++;
      } else {
        const ranked = rankCandidates(candidates, {
          visualIntent,
          narrationText,
          sceneDurationSecs: sceneDuration,
          preferredAspectRatio,
          usedAssetIds
        });
        const winner = ranked[0];
        const usedQuery = queries.find(
          (q) => winner.searchQuery !== void 0 ? winner.searchQuery === q : true
        ) ?? queries[0];
        const downloadedAsset = await downloadAsset(
          winner,
          scene.sceneIndex,
          usedQuery,
          stockDir,
          manifest
        );
        manifest = manifest.filter((a) => a.assetId !== downloadedAsset.assetId);
        manifest.push(downloadedAsset);
        usedAssetIds.add(downloadedAsset.assetId);
        scene.localPath = downloadedAsset.localPath;
        scene.mediaFile = path.basename(downloadedAsset.localPath);
        scene.mediaType = downloadedAsset.mediaType === "photo" ? "image" : "video";
        assignment.asset = downloadedAsset;
        assignment.score = winner.score;
        assignment.usedQuery = usedQuery;
        assignment.status = "assigned";
        assignedCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[StockEngine] Scene ${scene.sceneIndex} failed: ${msg}`);
      assignment.status = "failed";
      assignment.errorMessage = msg;
      failedCount++;
    }
    assignments.push(assignment);
    cache.save();
    saveAssetsManifest(stockDir, manifest);
  }
  fs__namespace.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
  const reviewPath = path.join(projectDir, "analysis", "stock-assignments.json");
  fs__namespace.writeFileSync(reviewPath, JSON.stringify(assignments, null, 2), "utf-8");
  onProgress(
    `Done — ${assignedCount}/${scenesNeedingStock.length} scenes assigned, ${failedCount} failed`,
    1
  );
  return {
    success: true,
    totalScenes: scenesNeedingStock.length,
    assignedScenes: assignedCount,
    failedScenes: failedCount,
    assignments
  };
}
async function replaceSceneAsset(projectDir, sceneIndex, newQuery, pexelsApiKey, pixabayApiKey, preferredAspectRatio = "16:9") {
  const stockDir = path.join(projectDir, "assets", "stock");
  const cache = new QueryCache(stockDir);
  const manifest = loadAssetsManifest(stockDir);
  const orientation = toOrientation$1(preferredAspectRatio);
  const candidates = await searchForScene(
    [newQuery],
    pexelsApiKey,
    pixabayApiKey,
    orientation,
    cache
  );
  if (candidates.length === 0) throw new Error(`No results for query "${newQuery}"`);
  const usedIds = new Set(manifest.map((a) => a.assetId));
  const ranked = rankCandidates(candidates, {
    visualIntent: newQuery,
    narrationText: newQuery,
    sceneDurationSecs: 10,
    preferredAspectRatio,
    usedAssetIds: usedIds
  });
  const winner = ranked[0];
  const asset = await downloadAsset(winner, sceneIndex, newQuery, stockDir, manifest);
  const updatedManifest = manifest.filter((a) => a.assetId !== asset.assetId);
  updatedManifest.push(asset);
  saveAssetsManifest(stockDir, updatedManifest);
  cache.save();
  const planPath = path.join(projectDir, "analysis", "master-edit-plan.json");
  if (fs__namespace.existsSync(planPath)) {
    const plan = JSON.parse(fs__namespace.readFileSync(planPath, "utf-8"));
    const scene = flattenScenes$1(plan).find((s) => s.sceneIndex === sceneIndex);
    if (scene) {
      scene.localPath = asset.localPath;
      scene.mediaFile = path.basename(asset.localPath);
      scene.mediaType = asset.mediaType === "photo" ? "image" : "video";
      fs__namespace.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
    }
  }
  return asset;
}
function getContextPath(projectDir) {
  return path.join(projectDir, "analysis", "global-script-context.json");
}
function scriptHash(text) {
  return crypto.createHash("md5").update(text).digest("hex").slice(0, 16);
}
const SYSTEM_PROMPT$1 = `You are the Context-Aware Visual Research Engine for a long-form documentary.
Analyze the ENTIRE script and produce a GlobalScriptContext JSON object used by every scene to generate stock-media search queries.
Rules:
- Identify primary subject, central thesis, geography, time period, communities from the script.
- List exactTopicAnchors (proper nouns) that MUST appear in exact-match queries.
- List contextualAnchors (broader descriptors) for when exact results are unavailable.
- List forbiddenSubstitutions (visually similar but factually wrong subjects).
- List negativeKeywords (terms that would return wrong stock).
- Map the storyArc per chapter.
- Do NOT invent facts not in the script.
- Return ONLY valid JSON. No markdown. No explanation.`;
function buildGeminiPrompt(fullScriptText, projectId, language) {
  return `FULL SCRIPT (analyze completely before responding):
---
${fullScriptText.slice(0, 4e4)}
---
PROJECT ID: ${projectId}
LANGUAGE: ${language}

Return ONLY valid JSON matching this schema:
{
  "projectId": "${projectId}",
  "language": "${language}",
  "version": 1,
  "primarySubject": "the single most important subject",
  "secondarySubjects": ["string"],
  "globalSynopsis": "2-3 sentence summary",
  "centralThesis": "the main argument",
  "documentaryAngle": "journalistic angle",
  "targetAudience": "audience description",
  "geography": { "primaryCountry": null, "primaryRegion": null, "secondaryLocations": [] },
  "timeContext": { "primaryPeriod": "contemporary", "historicalPeriods": [] },
  "communities": [{ "name": "name", "role": "protagonist", "visualDescription": "desc", "mustNotConfuseWith": [] }],
  "recurringPeople": [{ "id": "p1", "role": "narrator", "ageRange": null, "gender": null, "appearance": null, "clothing": null }],
  "visualWorld": { "environment": [], "architecture": [], "clothing": [], "occupations": [], "machinery": [], "recurringObjects": [], "colorMood": "natural", "documentaryStyle": "observational" },
  "exactTopicAnchors": [],
  "contextualAnchors": [],
  "forbiddenSubstitutions": [],
  "negativeKeywords": [],
  "recurringVisualMotifs": [],
  "storyArc": [{ "chapterId": "CH1", "title": "title", "purpose": "purpose", "startText": "first words", "endText": "last words" }]
}`;
}
async function analyzeGlobalContext(params) {
  const { projectDir, apiKey, forceRegenerate = false } = params;
  const progress = params.onProgress ?? (() => {
  });
  const modelId = params.model ?? "gemini-2.0-flash";
  const fullText = params.scriptText ?? params.transcript?.fullText ?? params.transcript?.segments.map((s) => s.text).join(" ") ?? "";
  if (!fullText.trim()) throw new Error("No script or transcript text for global context analysis.");
  let projectId = "unknown";
  const language = params.transcript?.language ?? "en";
  try {
    const stateFile = fs__namespace.existsSync(path.join(projectDir, "project-state.json")) ? path.join(projectDir, "project-state.json") : path.join(projectDir, "project.json");
    const st = JSON.parse(fs__namespace.readFileSync(stateFile, "utf-8"));
    projectId = st?.id ?? st?.name ?? "unknown";
  } catch {
  }
  const contextPath = getContextPath(projectDir);
  const hash = scriptHash(fullText);
  if (!forceRegenerate && fs__namespace.existsSync(contextPath)) {
    try {
      const cached = JSON.parse(fs__namespace.readFileSync(contextPath, "utf-8"));
      if (cached._scriptHash === hash) {
        logger.info("[GlobalContext] Cache hit");
        progress("Using cached global script context...", 1);
        return cached;
      }
    } catch {
    }
  }
  progress("Analyzing full script for global context...", 0.05);
  const ai = new genai.GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
  const prompt = buildGeminiPrompt(fullText, projectId, language);
  const fallbackModels = [modelId, "gemini-2.0-flash", "gemini-1.5-flash"].filter((v, i, a) => a.indexOf(v) === i);
  let rawJson = "";
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const currentModel = fallbackModels[Math.min(attempt - 1, fallbackModels.length - 1)];
    try {
      progress(attempt === 1 ? `Sending full script to Gemini (${currentModel}) for global analysis...` : `Retry ${attempt}/${maxRetries} (${currentModel})...`, 0.05 + attempt * 0.1);
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: [{ role: "user", parts: [{ text: SYSTEM_PROMPT$1 + "\n\n" + prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 8192 }
      });
      rawJson = response.text ?? "";
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const overloaded = msg.includes("503") || msg.includes("429") || msg.includes("UNAVAILABLE");
      if (overloaded && attempt < maxRetries) {
        const wait = Math.min(attempt * 3, 12);
        for (let s = wait; s > 0; s--) {
          progress(`Gemini overloaded, retrying in ${s}s...`, 0.2);
          await new Promise((r) => setTimeout(r, 1e3));
        }
        continue;
      }
      throw new Error(`Global context analysis failed: ${msg}`);
    }
  }
  let ctx;
  try {
    const clean = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    ctx = JSON.parse(clean);
  } catch {
    logger.warn("[GlobalContext] JSON parse failed, using fallback context");
    ctx = buildFallbackContext(projectId, language, fullText);
  }
  ctx.generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  ctx.modelUsed = modelId;
  ctx.version = 1;
  ctx._scriptHash = hash;
  fs__namespace.mkdirSync(path.join(projectDir, "analysis"), { recursive: true });
  fs__namespace.writeFileSync(contextPath, JSON.stringify(ctx, null, 2), "utf-8");
  logger.info("[GlobalContext] Saved", { subject: ctx.primarySubject });
  progress(`Global context ready -- "${ctx.primarySubject}"`, 1);
  return ctx;
}
function buildFallbackContext(projectId, language, text) {
  const words = text.split(/\s+/).filter((w) => w.length > 4);
  const freq = {};
  for (const w of words) {
    const key = w.toLowerCase().replace(/[^a-z]/g, "");
    if (key) freq[key] = (freq[key] ?? 0) + 1;
  }
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);
  return {
    projectId,
    language,
    version: 1,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    modelUsed: "fallback",
    primarySubject: top[0] ?? "documentary subject",
    secondarySubjects: top.slice(1, 4),
    globalSynopsis: text.slice(0, 200),
    centralThesis: "See script",
    documentaryAngle: "documentary",
    targetAudience: "general audience",
    geography: { secondaryLocations: [] },
    timeContext: { primaryPeriod: "contemporary", historicalPeriods: [] },
    communities: [],
    recurringPeople: [],
    visualWorld: { environment: [], architecture: [], clothing: [], occupations: [], machinery: [], recurringObjects: [], colorMood: "natural", documentaryStyle: "observational" },
    exactTopicAnchors: top.slice(0, 3),
    contextualAnchors: top.slice(3, 6),
    forbiddenSubstitutions: [],
    negativeKeywords: [],
    recurringVisualMotifs: [],
    storyArc: []
  };
}
function loadGlobalContext(projectDir) {
  const p = getContextPath(projectDir);
  if (!fs__namespace.existsSync(p)) return null;
  try {
    return JSON.parse(fs__namespace.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
function saveGlobalContext(projectDir, ctx) {
  const p = getContextPath(projectDir);
  fs__namespace.mkdirSync(path.join(projectDir, "analysis"), { recursive: true });
  fs__namespace.writeFileSync(p, JSON.stringify(ctx, null, 2), "utf-8");
}
function getQueryCachePath(projectDir) {
  return path.join(projectDir, "assets", "stock", ".context-query-cache.json");
}
function loadQueryCache(projectDir) {
  const p = getQueryCachePath(projectDir);
  if (!fs__namespace.existsSync(p)) return {};
  try {
    return JSON.parse(fs__namespace.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}
function saveQueryCache(projectDir, cache) {
  const p = getQueryCachePath(projectDir);
  fs__namespace.mkdirSync(path.join(projectDir, "assets", "stock"), { recursive: true });
  fs__namespace.writeFileSync(p, JSON.stringify(cache, null, 2), "utf-8");
}
function makeCacheKey(globalContext, sceneId, narration) {
  const narrationHash = crypto.createHash("md5").update(narration).digest("hex").slice(0, 8);
  return `v${globalContext.version}_${sceneId}_${narrationHash}`;
}
const SYSTEM_PROMPT = `You are the Context-Aware Visual Research Engine for a documentary video editor.

You must NEVER interpret a scene in isolation.
Every scene belongs to a complete documentary with a defined primary subject, central thesis, geography, historical period, community, visual identity and story arc.

Analyze the current scene using four levels:
1. Complete script context (GlobalScriptContext).
2. Current chapter context.
3. Exact current narration.
4. Previous and next scene context.

Produce stock-media search queries in four tiers:
- Tier A (exactQueries): subject name + action + geography. These MUST contain the primary community/subject proper noun.
- Tier B (subjectQueries): subject name only, broader action or location.
- Tier C (contextualQueries): no exact proper noun, uses environment/setting descriptors.
- Tier D (fallbackQueries): purely illustrative, concept-level only. Use ONLY as last resort.

Rules:
- NEVER start with Tier D.
- Every Tier A and B query must contain at least one exact topic anchor from GlobalScriptContext.
- negativeTerms must include all negativeKeywords from GlobalScriptContext plus any scene-specific ones.
- Return ONLY valid JSON. No markdown. No explanation.`;
function buildScenePrompt(packet, globalCtx) {
  return `GLOBAL SCRIPT CONTEXT:
Primary Subject: ${globalCtx.primarySubject}
Central Thesis: ${globalCtx.centralThesis}
Geography: ${[globalCtx.geography.primaryCountry, globalCtx.geography.primaryRegion, ...globalCtx.geography.secondaryLocations].filter(Boolean).join(", ")}
Time Period: ${globalCtx.timeContext.primaryPeriod}
Exact Topic Anchors: ${globalCtx.exactTopicAnchors.join(", ")}
Contextual Anchors: ${globalCtx.contextualAnchors.join(", ")}
Forbidden Substitutions: ${globalCtx.forbiddenSubstitutions.join("; ")}
Negative Keywords: ${globalCtx.negativeKeywords.join(", ")}
Visual World: ${[...globalCtx.visualWorld.environment, ...globalCtx.visualWorld.occupations].join(", ")}

CHAPTER CONTEXT:
Title: ${packet.chapterContext.chapterTitle}
Purpose: ${packet.chapterContext.chapterPurpose}

PREVIOUS SCENE: ${packet.neighboringContext.previousScene || "none"}
CURRENT NARRATION: "${packet.localContext.narration}"
NEXT SCENE: ${packet.neighboringContext.nextScene || "none"}

CURRENT SCENE PURPOSE: ${packet.localContext.scenePurpose}
VISIBLE SUBJECT: ${packet.localContext.visibleSubject}
VISIBLE ACTION: ${packet.localContext.visibleAction}
PREFERRED LOCATION: ${packet.localContext.preferredLocation}
PREFERRED TIME PERIOD: ${packet.localContext.preferredTimePeriod}

Generate a context-aware StockSearchPlan. Return ONLY this JSON:
{
  "visualIntent": "short visual concept (5-12 words)",
  "exactQueries": ["Tier A query 1", "Tier A query 2", "Tier A query 3"],
  "subjectQueries": ["Tier B query 1", "Tier B query 2"],
  "contextualQueries": ["Tier C query 1", "Tier C query 2"],
  "fallbackQueries": ["Tier D query 1", "Tier D query 2"],
  "requiredTerms": ["term that must appear in Tier A"],
  "preferredTerms": ["preferred search term"],
  "negativeTerms": ["term to exclude"],
  "targetMediaType": "video",
  "desiredShotTypes": ["wide shot", "medium shot"],
  "desiredOrientation": "landscape"
}`;
}
function buildFallbackPlan(packet, globalCtx) {
  const anchor = globalCtx.exactTopicAnchors[0] ?? globalCtx.primarySubject;
  const env = globalCtx.visualWorld.environment[0] ?? "rural";
  const action = packet.localContext.visibleAction || "community life";
  const location = globalCtx.geography.primaryRegion ?? globalCtx.geography.primaryCountry ?? "";
  return {
    visualIntent: `${anchor} ${action}`,
    exactQueries: [
      `${anchor} ${action} ${location}`.trim(),
      `${anchor} ${action}`.trim(),
      `${anchor} community ${env}`.trim()
    ],
    subjectQueries: [
      `${anchor} ${env}`,
      `${anchor} community`
    ],
    contextualQueries: [
      `${env} community ${action}`,
      `rural ${action}`,
      packet.chapterContext.chapterTitle.toLowerCase()
    ],
    fallbackQueries: [
      action,
      env + " landscape"
    ],
    requiredTerms: [anchor],
    preferredTerms: globalCtx.contextualAnchors.slice(0, 3),
    negativeTerms: globalCtx.negativeKeywords,
    targetMediaType: "video",
    desiredShotTypes: ["wide shot", "medium shot"],
    desiredOrientation: "landscape"
  };
}
async function generateContextAwareSearchPlan(params) {
  const { projectDir, apiKey, packet, globalContext, sceneId, useCache = true } = params;
  const modelId = params.model ?? "gemini-2.0-flash";
  const cacheKey = makeCacheKey(globalContext, sceneId, packet.localContext.narration);
  const cache = useCache ? loadQueryCache(projectDir) : {};
  if (useCache && cache[cacheKey] && cache[cacheKey].contextVersion === globalContext.version) {
    logger.info(`[QueryGen] Cache hit for scene ${sceneId}`);
    return cache[cacheKey].plan;
  }
  const ai = new genai.GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
  const prompt = buildScenePrompt(packet, globalContext);
  const fallbackModels = [modelId, "gemini-2.0-flash", "gemini-1.5-flash"].filter((v, i, a) => a.indexOf(v) === i);
  let rawJson = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const currentModel = fallbackModels[Math.min(attempt - 1, fallbackModels.length - 1)];
    try {
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: [{ role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0.25, maxOutputTokens: 2048 }
      });
      rawJson = response.text ?? "";
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const overloaded = msg.includes("503") || msg.includes("429") || msg.includes("UNAVAILABLE");
      if (overloaded && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2e3 * attempt));
        continue;
      }
      logger.warn(`[QueryGen] Scene ${sceneId} AI failed (${msg}), using rule-based fallback`);
      return buildFallbackPlan(packet, globalContext);
    }
  }
  let plan;
  try {
    const clean = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    plan = JSON.parse(clean);
    if (!plan.exactQueries?.length) throw new Error("Missing exactQueries");
  } catch {
    logger.warn(`[QueryGen] Scene ${sceneId} JSON parse failed, using rule-based fallback`);
    plan = buildFallbackPlan(packet, globalContext);
  }
  if (useCache) {
    cache[cacheKey] = { plan, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), contextVersion: globalContext.version };
    saveQueryCache(projectDir, cache);
  }
  return plan;
}
function tokenize(text) {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2)
  );
}
function overlapScore(ref, candidate) {
  if (ref.size === 0) return 0;
  let hits = 0;
  ref.forEach((t) => {
    if (candidate.has(t)) hits++;
  });
  return Math.min(1, hits / Math.max(1, Math.min(ref.size, 5)));
}
function candidateTokens(c) {
  const titleTokens = tokenize(c.title);
  const tagTokens = new Set(c.tags.flatMap((t) => t.toLowerCase().split(/\s+/).filter((x) => x.length > 2)));
  return /* @__PURE__ */ new Set([...titleTokens, ...tagTokens]);
}
function localRelevanceScore(c, ctx) {
  const refTokens = /* @__PURE__ */ new Set([...tokenize(ctx.visualIntent), ...tokenize(ctx.narration)]);
  return overlapScore(refTokens, candidateTokens(c));
}
function globalSubjectScore(c, ctx) {
  const anchors = new Set([
    ...ctx.globalContext.exactTopicAnchors,
    ...ctx.globalContext.contextualAnchors
  ].flatMap((a) => a.toLowerCase().split(/\s+/)));
  return overlapScore(anchors, candidateTokens(c));
}
function geographyScore(c, ctx) {
  const geos = [
    ctx.globalContext.geography.primaryCountry,
    ctx.globalContext.geography.primaryRegion,
    ...ctx.globalContext.geography.secondaryLocations
  ].filter(Boolean);
  if (geos.length === 0) return 0.5;
  const geoTokens = new Set(geos.flatMap((g) => g.toLowerCase().split(/\s+/)));
  return overlapScore(geoTokens, candidateTokens(c));
}
function timePeriodScore(c, ctx) {
  const period = (ctx.preferredTimePeriod ?? ctx.globalContext.timeContext.primaryPeriod).toLowerCase();
  const tokens = candidateTokens(c);
  const historicTerms = /* @__PURE__ */ new Set(["historical", "vintage", "antique", "old", "century", "archival"]);
  const isModerrn = period === "contemporary" || period === "modern";
  if (isModerrn && tokens.has("contemporary")) return 1;
  if (!isModerrn && [...historicTerms].some((t) => tokens.has(t))) return 1;
  if (isModerrn && [...historicTerms].some((t) => tokens.has(t))) return 0.2;
  return 0.5;
}
function chapterPurposeScore(c, ctx) {
  const refTokens = /* @__PURE__ */ new Set([...tokenize(ctx.chapterTitle), ...tokenize(ctx.chapterPurpose)]);
  return overlapScore(refTokens, candidateTokens(c));
}
function technicalScore(c) {
  const minDim = Math.min(c.width, c.height);
  if (minDim >= 2160) return 1;
  if (minDim >= 1080) return 0.9;
  if (minDim >= 720) return 0.6;
  return 0.3;
}
function compositionScore(c, preferredAr) {
  const [pw, ph] = preferredAr.split(":").map(Number);
  const preferred = pw / ph;
  const actual = c.width / c.height;
  if (!preferred || !actual) return 0.5;
  const diff = Math.abs(preferred - actual) / preferred;
  return Math.max(0, 1 - diff * 2);
}
function durationScore(c, sceneDuration) {
  if (c.mediaType === "photo") return 0.8;
  const clipDur = c.durationSecs ?? 0;
  if (clipDur <= 0) return 0.4;
  if (clipDur >= sceneDuration) return 1;
  return Math.max(0.2, clipDur / sceneDuration);
}
function applyPenalties(c, ctx) {
  const reasons = [];
  let total = 0;
  const tokens = candidateTokens(c);
  for (const community of ctx.globalContext.communities) {
    for (const wrong of community.mustNotConfuseWith) {
      const wrongTokens = tokenize(wrong);
      if ([...wrongTokens].some((t) => tokens.has(t))) {
        total += 60;
        reasons.push(`Wrong community: contains "${wrong}" (should be "${community.name}")`);
      }
    }
  }
  for (const forbidden of ctx.globalContext.forbiddenSubstitutions) {
    const fTokens = tokenize(forbidden);
    if ([...fTokens].filter((t) => t.length > 3).some((t) => tokens.has(t))) {
      total += 50;
      reasons.push(`Forbidden substitution: ${forbidden}`);
    }
  }
  for (const neg of ctx.globalContext.negativeKeywords) {
    const negTokens = tokenize(neg);
    if ([...negTokens].some((t) => tokens.has(t))) {
      total += 30;
      reasons.push(`Negative keyword: ${neg}`);
    }
  }
  if (ctx.usedAssetIds.has(c.assetId)) {
    total += 20;
    reasons.push("Asset already used");
  }
  return { total, reasons };
}
function getMatchLabel(score, penalties) {
  const adjusted = score - penalties;
  if (adjusted >= 80) return "STRONG_MATCH";
  if (adjusted >= 65) return "ACCEPTABLE";
  if (adjusted >= 50) return "ILLUSTRATIVE";
  return "REJECTED";
}
function getVisualTruthLabel(c, ctx, localScore, globalScore) {
  const tokens = candidateTokens(c);
  const hasExactAnchor = ctx.globalContext.exactTopicAnchors.some(
    (a) => a.toLowerCase().split(/\s+/).every((t) => tokens.has(t))
  );
  if (hasExactAnchor && localScore >= 0.5) return "EXACT_SUBJECT";
  if (globalScore >= 0.3 && localScore >= 0.3) return "CONTEXTUAL_MATCH";
  const isHistorical = ctx.globalContext.timeContext.historicalPeriods.length > 0 && (tokens.has("historical") || tokens.has("vintage") || tokens.has("archival"));
  if (isHistorical) return "HISTORICAL";
  return "ILLUSTRATIVE";
}
function scoreContextCandidate(candidate, ctx) {
  const local = localRelevanceScore(candidate, ctx) * 30;
  const global = globalSubjectScore(candidate, ctx) * 25;
  const geo = geographyScore(candidate, ctx) * 15;
  const time = timePeriodScore(candidate, ctx) * 10;
  const chapter = chapterPurposeScore(candidate, ctx) * 10;
  const tech = (technicalScore(candidate) * 0.6 + compositionScore(candidate, ctx.preferredAspectRatio) * 0.4) * 5;
  const dur = durationScore(candidate, ctx.sceneDurationSecs);
  const sequenceContinuity = dur * 5;
  const rawScore = local + global + geo + time + chapter + tech + sequenceContinuity;
  const { total: penalties, reasons: penaltyReasons } = applyPenalties(candidate, ctx);
  const totalScore = Math.max(0, rawScore - penalties);
  const matchLabel = getMatchLabel(rawScore, penalties);
  const visualTruthLabel = getVisualTruthLabel(candidate, ctx, local / 30, global / 25);
  return {
    localRelevance: Math.round(local),
    globalSubjectRelevance: Math.round(global),
    geographyMatch: Math.round(geo),
    timePeriodMatch: Math.round(time),
    chapterPurposeMatch: Math.round(chapter),
    technicalQuality: Math.round(tech),
    sequenceContinuity: Math.round(sequenceContinuity),
    totalScore: Math.round(totalScore),
    penalties: -Math.round(penalties),
    penaltyReasons,
    matchLabel,
    visualTruthLabel
  };
}
function rankContextCandidates(candidates, ctx) {
  return candidates.map((c) => ({ ...c, contextScore: scoreContextCandidate(c, ctx) })).filter((c) => c.contextScore.matchLabel !== "REJECTED").sort((a, b) => b.contextScore.totalScore - a.contextScore.totalScore);
}
function flattenScenesWithChapter(plan) {
  const result = [];
  for (const ch of plan.chapters ?? []) {
    const seqs = ch.sequences ?? ch.chapters_seq ?? [];
    for (const seq of seqs) {
      for (const scene of seq.scenes ?? []) {
        result.push({
          scene,
          chapterId: `CH${ch.chapterIndex}`,
          chapterTitle: ch.title,
          chapterPurpose: ch.purpose ?? ""
        });
      }
    }
  }
  return result;
}
function toOrientation(ar) {
  if (ar === "9:16") return "portrait";
  if (ar === "1:1") return "square";
  return "landscape";
}
async function searchWithTieredPlan(plan, pexelsApiKey, pixabayApiKey, orientation, cache) {
  const allCandidates = [];
  const seenIds = /* @__PURE__ */ new Set();
  const addCandidates = (results) => {
    for (const r of results) {
      if (!seenIds.has(r.assetId)) {
        seenIds.add(r.assetId);
        allCandidates.push(r);
      }
    }
  };
  const searchTier = async (queries, minNeeded) => {
    for (const query of queries) {
      let cached = cache.get(`pexels_v:${query}`);
      if (cached) {
        addCandidates(cached);
      } else {
        const res = await pexelsSearchVideos(query, pexelsApiKey, 10, orientation);
        cache.set(`pexels_v:${query}`, res);
        addCandidates(res);
      }
      if (allCandidates.length >= 10) return true;
    }
    if (allCandidates.length >= minNeeded) return true;
    if (pixabayApiKey) {
      for (const query of queries.slice(0, 2)) {
        const cached = cache.get(`pixabay_v:${query}`);
        if (cached) {
          addCandidates(cached);
        } else {
          const pxOrientation = orientation === "portrait" ? "vertical" : "horizontal";
          const res = await pixabaySearchVideos(query, pixabayApiKey, 8, pxOrientation);
          cache.set(`pixabay_v:${query}`, res);
          addCandidates(res);
        }
        if (allCandidates.length >= minNeeded) return true;
      }
    }
    return allCandidates.length >= minNeeded;
  };
  const photoFallback = async (queries) => {
    for (const query of queries.slice(0, 2)) {
      const cached = cache.get(`pexels_p:${query}`);
      if (cached) {
        addCandidates(cached);
      } else {
        const res = await pexelsSearchPhotos(query, pexelsApiKey, 6, orientation);
        cache.set(`pexels_p:${query}`, res);
        addCandidates(res);
      }
    }
  };
  const tierAok = await searchTier(plan.exactQueries, 3);
  if (tierAok && allCandidates.length >= 3) {
    if (allCandidates.length < 2) await photoFallback(plan.exactQueries);
    return { candidates: allCandidates, tierUsed: "A" };
  }
  const tierBok = await searchTier(plan.subjectQueries, 3);
  if (tierBok && allCandidates.length >= 3) {
    if (allCandidates.length < 2) await photoFallback(plan.subjectQueries);
    return { candidates: allCandidates, tierUsed: "B" };
  }
  await searchTier(plan.contextualQueries, 2);
  if (allCandidates.length >= 2) {
    if (allCandidates.length < 2) await photoFallback(plan.contextualQueries);
    return { candidates: allCandidates, tierUsed: "C" };
  }
  await searchTier(plan.fallbackQueries, 1);
  await photoFallback(plan.fallbackQueries);
  return { candidates: allCandidates, tierUsed: "D" };
}
async function runContextAwareStockEngine(params, onProgress = () => {
}) {
  const {
    projectDir,
    pexelsApiKey,
    pixabayApiKey,
    preferredAspectRatio = "16:9",
    apiKey,
    model,
    forceReanalysis = false
  } = params;
  const planPath = path.join(projectDir, "analysis", "master-edit-plan.json");
  if (!fs__namespace.existsSync(planPath)) {
    return { success: false, totalScenes: 0, assignedScenes: 0, failedScenes: 0, assignments: [], error: "No edit plan found. Run AI Planning first." };
  }
  const plan = JSON.parse(fs__namespace.readFileSync(planPath, "utf-8"));
  const stockDir = path.join(projectDir, "assets", "stock");
  fs__namespace.mkdirSync(stockDir, { recursive: true });
  const cache = new QueryCache(stockDir);
  let manifest = loadAssetsManifest(stockDir);
  const usedAssetIds = new Set(manifest.map((a) => a.assetId));
  const flatScenes = flattenScenesWithChapter(plan);
  const scenesNeedingStock = flatScenes.filter(
    ({ scene }) => !scene.locked && (!scene.localPath || !fs__namespace.existsSync(scene.localPath))
  );
  onProgress(`Starting context-aware stock search for ${scenesNeedingStock.length} scenes...`, 0.01);
  let globalContext = null;
  if (apiKey) {
    try {
      onProgress("Phase 1: Analyzing full script for global context...", 0.02);
      let scriptText = null;
      let transcript = null;
      const transcriptPath = path.join(projectDir, "analysis", "transcript.json");
      if (fs__namespace.existsSync(transcriptPath)) {
        transcript = JSON.parse(fs__namespace.readFileSync(transcriptPath, "utf-8"));
      }
      try {
        const stateFile = fs__namespace.existsSync(path.join(projectDir, "project-state.json")) ? path.join(projectDir, "project-state.json") : path.join(projectDir, "project.json");
        const st = JSON.parse(fs__namespace.readFileSync(stateFile, "utf-8"));
        const scriptPath = st?.inputs?.scriptPath;
        if (scriptPath && fs__namespace.existsSync(scriptPath)) {
          scriptText = fs__namespace.readFileSync(scriptPath, "utf-8");
        }
      } catch {
      }
      globalContext = await analyzeGlobalContext({
        projectDir,
        apiKey,
        model,
        scriptText,
        transcript,
        forceRegenerate: forceReanalysis,
        onProgress: (msg, pct) => onProgress(`[GlobalContext] ${msg}`, pct * 0.08)
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[StockEngine] GlobalContext analysis failed (${msg}), falling back to basic mode`);
      globalContext = loadGlobalContext(projectDir);
    }
  } else {
    globalContext = loadGlobalContext(projectDir);
  }
  const hasGlobalContext = globalContext !== null;
  if (!hasGlobalContext) {
    logger.warn("[StockEngine] No GlobalContext available. Running in legacy mode.");
    onProgress("Warning: No global context. Running in basic query mode.", 0.05);
  }
  const orientation = toOrientation(preferredAspectRatio);
  const assignments = [];
  let assignedCount = 0;
  let failedCount = 0;
  for (let i = 0; i < scenesNeedingStock.length; i++) {
    const { scene, chapterId, chapterTitle, chapterPurpose } = scenesNeedingStock[i];
    const pct = 0.1 + i / scenesNeedingStock.length * 0.85;
    const sceneId = `scene_${scene.sceneIndex}`;
    const narration = scene.narrativeText ?? "";
    const sceneDuration = scene.duration ?? scene.endTime - scene.startTime;
    onProgress(`[${i + 1}/${scenesNeedingStock.length}] Scene ${scene.sceneIndex} — context-aware search...`, pct);
    const prevEntry = i > 0 ? scenesNeedingStock[i - 1] : null;
    const nextEntry = i < scenesNeedingStock.length - 1 ? scenesNeedingStock[i + 1] : null;
    const previousSceneSummary = prevEntry ? (prevEntry.scene.narrativeText ?? "").slice(0, 100) : "";
    const nextSceneSummary = nextEntry ? (nextEntry.scene.narrativeText ?? "").slice(0, 100) : "";
    let searchPlan = null;
    let tierUsed = "D";
    if (hasGlobalContext && apiKey) {
      const packet = {
        globalContext: {
          primarySubject: globalContext.primarySubject,
          centralThesis: globalContext.centralThesis,
          geography: [
            globalContext.geography.primaryCountry,
            globalContext.geography.primaryRegion,
            ...globalContext.geography.secondaryLocations
          ].filter(Boolean),
          timePeriod: [globalContext.timeContext.primaryPeriod, ...globalContext.timeContext.historicalPeriods],
          exactTopicAnchors: globalContext.exactTopicAnchors,
          contextualAnchors: globalContext.contextualAnchors,
          forbiddenSubstitutions: globalContext.forbiddenSubstitutions,
          negativeKeywords: globalContext.negativeKeywords
        },
        chapterContext: { chapterId, chapterTitle, chapterPurpose },
        localContext: {
          narration,
          scenePurpose: scene.visualIntent ?? "",
          visibleSubject: scene.visualIntent ?? globalContext.primarySubject,
          visibleAction: scene.visualIntent ?? "community activity",
          preferredLocation: globalContext.geography.primaryRegion ?? globalContext.geography.primaryCountry ?? "",
          preferredTimePeriod: globalContext.timeContext.primaryPeriod
        },
        neighboringContext: { previousScene: previousSceneSummary, nextScene: nextSceneSummary }
      };
      try {
        searchPlan = await generateContextAwareSearchPlan({
          projectDir,
          apiKey,
          model,
          packet,
          globalContext,
          sceneId,
          useCache: true
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[StockEngine] QueryGen failed for scene ${scene.sceneIndex}: ${msg}`);
      }
    }
    const legacyQueries = scene.searchQueries?.length ? scene.searchQueries : [scene.visualIntent ?? narration ?? "documentary b-roll"].slice(0, 3);
    const planToUse = searchPlan ?? {
      visualIntent: scene.visualIntent ?? "",
      exactQueries: legacyQueries.slice(0, 2),
      subjectQueries: legacyQueries.slice(0, 2),
      contextualQueries: legacyQueries,
      fallbackQueries: legacyQueries,
      requiredTerms: [],
      preferredTerms: [],
      negativeTerms: [],
      targetMediaType: "video",
      desiredShotTypes: ["wide shot"],
      desiredOrientation: "landscape"
    };
    const assignment = {
      sceneId,
      sceneIndex: scene.sceneIndex,
      narrationText: narration,
      startTime: scene.startTime,
      endTime: scene.endTime,
      visualIntent: planToUse.visualIntent || (scene.visualIntent ?? ""),
      searchQueries: [...planToUse.exactQueries, ...planToUse.subjectQueries, ...planToUse.contextualQueries],
      usedQuery: planToUse.exactQueries[0] ?? legacyQueries[0] ?? "",
      asset: null,
      score: 0,
      locked: false,
      manualOverride: false,
      status: "searching",
      chapterId,
      chapterTitle,
      scenePurpose: scene.visualIntent ?? "",
      searchPlan: planToUse
    };
    try {
      const { candidates, tierUsed: tu } = await searchWithTieredPlan(
        planToUse,
        pexelsApiKey,
        pixabayApiKey,
        orientation,
        cache
      );
      tierUsed = tu;
      if (candidates.length === 0) {
        assignment.status = "failed";
        assignment.errorMessage = "No candidates found from any provider or tier";
        failedCount++;
      } else {
        let ranked;
        if (hasGlobalContext) {
          const ctx = {
            globalContext,
            chapterTitle,
            chapterPurpose,
            narration,
            visualIntent: planToUse.visualIntent,
            scenePurpose: scene.visualIntent ?? "",
            sceneDurationSecs: sceneDuration,
            preferredAspectRatio,
            usedAssetIds
          };
          ranked = rankContextCandidates(candidates, ctx);
          if (ranked.length === 0) {
            ranked = candidates.map((c) => ({ ...c, contextScore: void 0 }));
          }
        } else {
          ranked = candidates;
        }
        const winner = ranked[0];
        const usedQuery = planToUse.exactQueries[0] ?? legacyQueries[0];
        const downloadedAsset = await downloadAsset(winner, scene.sceneIndex, usedQuery, stockDir, manifest);
        manifest = manifest.filter((a) => a.assetId !== downloadedAsset.assetId);
        manifest.push(downloadedAsset);
        usedAssetIds.add(downloadedAsset.assetId);
        scene.localPath = downloadedAsset.localPath;
        scene.mediaFile = path.basename(downloadedAsset.localPath);
        scene.mediaType = downloadedAsset.mediaType === "photo" ? "image" : "video";
        const contextScore = winner.contextScore;
        assignment.asset = downloadedAsset;
        assignment.score = contextScore?.totalScore ?? 75;
        assignment.usedQuery = usedQuery;
        assignment.status = "assigned";
        assignment.tierUsed = tierUsed;
        assignment.matchLabel = contextScore?.matchLabel;
        assignment.visualTruthLabel = contextScore?.visualTruthLabel;
        assignment.scoreBreakdown = contextScore;
        assignment.rejectedCandidates = ranked.slice(1, 4).map((c) => ({
          title: c.title,
          score: c.contextScore?.totalScore ?? 0,
          reason: c.contextScore?.penaltyReasons?.[0] ?? "lower score"
        }));
        assignedCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[StockEngine] Scene ${scene.sceneIndex} failed: ${msg}`);
      assignment.status = "failed";
      assignment.errorMessage = msg;
      failedCount++;
    }
    assignments.push(assignment);
    cache.save();
    saveAssetsManifest(stockDir, manifest);
  }
  fs__namespace.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
  const reviewPath = path.join(projectDir, "analysis", "stock-assignments.json");
  fs__namespace.writeFileSync(reviewPath, JSON.stringify(assignments, null, 2), "utf-8");
  onProgress(`Done -- ${assignedCount}/${scenesNeedingStock.length} scenes assigned, ${failedCount} failed`, 1);
  return {
    success: true,
    totalScenes: scenesNeedingStock.length,
    assignedScenes: assignedCount,
    failedScenes: failedCount,
    assignments
  };
}
function registerStockHandlers(ipcMain) {
  ipcMain.handle(
    IPC_CHANNELS.STOCK_SEARCH_START,
    async (event, params) => {
      const win = electron.BrowserWindow.fromWebContents(event.sender);
      const config = loadConfig();
      if (!config.pexelsApiKey && !config.pixabayApiKey) {
        return {
          success: false,
          error: "No stock API keys configured. Go to Settings to add Pexels or Pixabay key."
        };
      }
      const sendProgress = (message, progress) => {
        win?.webContents.send(IPC_CHANNELS.STOCK_SEARCH_PROGRESS, { message, progress });
      };
      try {
        if (config.geminiApiKey) {
          const result2 = await runContextAwareStockEngine(
            {
              projectDir: params.projectDir,
              pexelsApiKey: config.pexelsApiKey ?? "",
              pixabayApiKey: config.pixabayApiKey,
              preferredAspectRatio: "16:9",
              apiKey: config.geminiApiKey,
              forceReanalysis: params.forceReanalysis ?? false
            },
            sendProgress
          );
          return result2;
        }
        const result = await runStockEngine(
          {
            projectDir: params.projectDir,
            pexelsApiKey: config.pexelsApiKey ?? "",
            pixabayApiKey: config.pixabayApiKey,
            preferredAspectRatio: "16:9"
          },
          sendProgress
        );
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Stock engine error: ${msg}`);
        return { success: false, error: msg, totalScenes: 0, assignedScenes: 0, failedScenes: 0, assignments: [] };
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.STOCK_REVIEW_GET, (_event, projectDir) => {
    const stockDir = path.join(projectDir, "assets", "stock");
    const assignmentsPath = path.join(projectDir, "analysis", "stock-assignments.json");
    let assignments = [];
    try {
      if (fs__namespace.existsSync(assignmentsPath)) {
        assignments = JSON.parse(fs__namespace.readFileSync(assignmentsPath, "utf-8"));
      }
    } catch {
    }
    const manifest = loadAssetsManifest(stockDir);
    const assigned = assignments.filter((a) => a.status === "assigned").length;
    const review = {
      assignments,
      totalScenes: assignments.length,
      assignedScenes: assigned,
      stockAssetsJson: manifest
    };
    return review;
  });
  ipcMain.handle(
    IPC_CHANNELS.STOCK_SCENE_REPLACE,
    async (_event, params) => {
      const config = loadConfig();
      if (!config.pexelsApiKey && !config.pixabayApiKey) {
        throw new Error("No stock API keys configured");
      }
      try {
        const asset = await replaceSceneAsset(
          params.projectDir,
          params.sceneIndex,
          params.query,
          config.pexelsApiKey ?? "",
          config.pixabayApiKey
        );
        const assignmentsPath = path.join(params.projectDir, "analysis", "stock-assignments.json");
        if (fs__namespace.existsSync(assignmentsPath)) {
          const assignments = JSON.parse(fs__namespace.readFileSync(assignmentsPath, "utf-8"));
          const idx = assignments.findIndex((a) => a.sceneIndex === params.sceneIndex);
          if (idx >= 0) {
            assignments[idx].asset = asset;
            assignments[idx].usedQuery = params.query;
            assignments[idx].status = "assigned";
            fs__namespace.writeFileSync(assignmentsPath, JSON.stringify(assignments, null, 2), "utf-8");
          }
        }
        return { success: true, asset };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.STOCK_SCENE_LOCK,
    (_event, params) => {
      const assignmentsPath = path.join(params.projectDir, "analysis", "stock-assignments.json");
      if (!fs__namespace.existsSync(assignmentsPath)) return { success: false, error: "No assignments found" };
      const assignments = JSON.parse(fs__namespace.readFileSync(assignmentsPath, "utf-8"));
      const idx = assignments.findIndex((a) => a.sceneIndex === params.sceneIndex);
      if (idx >= 0) {
        assignments[idx].locked = params.locked;
        fs__namespace.writeFileSync(assignmentsPath, JSON.stringify(assignments, null, 2), "utf-8");
      }
      return { success: true };
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.STOCK_SCENE_UPLOAD,
    (_event, params) => {
      if (!fs__namespace.existsSync(params.filePath)) {
        return { success: false, error: `File not found: ${params.filePath}` };
      }
      const stockDir = path.join(params.projectDir, "assets", "stock");
      fs__namespace.mkdirSync(stockDir, { recursive: true });
      const stat = fs__namespace.statSync(params.filePath);
      const asset = {
        assetId: `manual_${params.sceneIndex}_${Date.now()}`,
        provider: "pexels",
        // placeholder; not actually from Pexels
        mediaType: params.filePath.match(/\.(mp4|mov|avi|mkv|webm)$/i) ? "video" : "photo",
        localPath: params.filePath,
        thumbnailUrl: "",
        downloadUrl: params.filePath,
        creator: "User",
        searchQuery: "manual upload",
        downloadedAt: (/* @__PURE__ */ new Date()).toISOString(),
        fileSizeBytes: stat.size
      };
      const manifest = loadAssetsManifest(stockDir);
      const updated = manifest.filter((a) => !a.assetId.startsWith(`manual_${params.sceneIndex}_`));
      updated.push(asset);
      saveAssetsManifest(stockDir, updated);
      const planPath = path.join(params.projectDir, "analysis", "master-edit-plan.json");
      if (fs__namespace.existsSync(planPath)) {
        const plan = JSON.parse(fs__namespace.readFileSync(planPath, "utf-8"));
        const allScenes = (plan.chapters ?? []).flatMap((ch) => ch.sequences ?? []).flatMap((seq) => seq.scenes ?? []);
        const scene = allScenes.find((s) => s.sceneIndex === params.sceneIndex);
        if (scene) {
          scene.localPath = params.filePath;
          scene.mediaFile = path.basename(params.filePath);
          scene.mediaType = params.filePath.match(/\.(mp4|mov|avi|mkv|webm)$/i) ? "video" : "image";
          fs__namespace.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
        }
      }
      const assignmentsPath = path.join(params.projectDir, "analysis", "stock-assignments.json");
      if (fs__namespace.existsSync(assignmentsPath)) {
        const assignments = JSON.parse(fs__namespace.readFileSync(assignmentsPath, "utf-8"));
        const idx = assignments.findIndex((a) => a.sceneIndex === params.sceneIndex);
        if (idx >= 0) {
          assignments[idx].asset = asset;
          assignments[idx].status = "assigned";
          assignments[idx].manualOverride = true;
          assignments[idx].locked = true;
          fs__namespace.writeFileSync(assignmentsPath, JSON.stringify(assignments, null, 2), "utf-8");
        }
      }
      return { success: true, asset };
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.STOCK_CONTEXT_ANALYZE,
    async (event, params) => {
      const win = electron.BrowserWindow.fromWebContents(event.sender);
      const config = loadConfig();
      if (!config.geminiApiKey) return { success: false, error: "Gemini API key required for global context analysis." };
      const sendProgress = (message, progress) => {
        win?.webContents.send(IPC_CHANNELS.STOCK_CONTEXT_PROGRESS, { message, progress });
      };
      try {
        const transcriptPath = path.join(params.projectDir, "analysis", "transcript.json");
        const transcript = fs__namespace.existsSync(transcriptPath) ? JSON.parse(fs__namespace.readFileSync(transcriptPath, "utf-8")) : null;
        let scriptText = null;
        if (params.scriptPath && fs__namespace.existsSync(params.scriptPath)) {
          scriptText = fs__namespace.readFileSync(params.scriptPath, "utf-8");
          logger.info(`[ContextAnalyze] Reading script from frontend param: ${params.scriptPath}`);
        }
        if (!scriptText) {
          try {
            const stateFile = fs__namespace.existsSync(path.join(params.projectDir, "project-state.json")) ? path.join(params.projectDir, "project-state.json") : path.join(params.projectDir, "project.json");
            const st = JSON.parse(fs__namespace.readFileSync(stateFile, "utf-8"));
            const savedScriptPath = st?.inputs?.scriptPath;
            if (savedScriptPath && fs__namespace.existsSync(savedScriptPath)) {
              scriptText = fs__namespace.readFileSync(savedScriptPath, "utf-8");
              logger.info(`[ContextAnalyze] Reading script from project-state.json: ${savedScriptPath}`);
            }
          } catch {
          }
        }
        if (!scriptText && transcript?.fullText) {
          scriptText = transcript.fullText;
          logger.info("[ContextAnalyze] No script file found, using transcript.fullText");
        }
        if (!scriptText && !transcript) {
          return { success: false, error: "No script or transcript found. Please add a script file to the project first." };
        }
        const ctx = await analyzeGlobalContext({
          projectDir: params.projectDir,
          apiKey: config.geminiApiKey,
          scriptText,
          transcript,
          forceRegenerate: params.forceRegenerate ?? false,
          onProgress: sendProgress
        });
        return { success: true, context: ctx };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.STOCK_CONTEXT_GET, (_event, projectDir) => {
    const ctx = loadGlobalContext(projectDir);
    return ctx;
  });
  ipcMain.handle(
    IPC_CHANNELS.STOCK_CONTEXT_SAVE,
    (_event, params) => {
      try {
        params.context.version = (params.context.version ?? 0) + 1;
        saveGlobalContext(params.projectDir, params.context);
        return { success: true, version: params.context.version };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    }
  );
}
const OV_HOST = "api.openverse.org";
function httpsGet(url2, headers, timeoutMs = 12e3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url2);
    const req = https__namespace.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers,
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`JSON parse error: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => reject(new Error(`Request error: ${err.message}`)));
    req.end();
  });
}
async function openverseSearchAudio(query, category, limit = 6, accessToken) {
  const params = {
    q: query,
    page_size: String(Math.min(limit, 20)),
    license_type: "commercial",
    mature: "false"
  };
  if (category) params.category = category;
  const qs = new URLSearchParams(params);
  const headers = {
    Accept: "application/json",
    "User-Agent": "VideoFactory/1.0 (AI video editor)"
  };
  const url2 = `https://${OV_HOST}/v1/audio/?${qs.toString()}`;
  logger.info(`[Openverse] ${category ?? "any"} search: "${query}"`);
  let data;
  try {
    data = await httpsGet(url2, headers, 12e3);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[Openverse] Search "${query}" failed: ${msg}`);
    return [];
  }
  logger.info(`[Openverse] "${query}" → ${data.result_count ?? 0} results`);
  return (data.results ?? []).map((item) => ({
    assetId: item.id,
    provider: "openverse",
    audioType: category === "sound_effects" ? "sfx" : "music",
    title: item.title ?? "Unknown",
    creator: item.creator ?? "Unknown",
    creatorUrl: item.creator_url,
    downloadUrl: item.url,
    thumbnailUrl: item.thumbnail ?? "",
    durationSecs: item.duration ?? 0,
    tags: item.tags?.map((t) => t.name) ?? [],
    license: item.license,
    licenseUrl: item.license_url ?? `https://creativecommons.org/licenses/${item.license}/${item.license_version ?? "4.0"}/`,
    pageUrl: item.foreign_landing_url,
    filetype: item.filetype ?? "mp3",
    searchQuery: query
  }));
}
function flattenScenes(plan) {
  return plan.chapters.flatMap((ch) => ch.chapters_seq ?? ch.sequences ?? []).flatMap((seq) => seq.scenes ?? []);
}
function groupScenesIntoSections(plan) {
  const sections = [];
  for (const ch of plan.chapters) {
    const scenes = (ch.chapters_seq ?? ch.sequences ?? []).flatMap((seq) => seq.scenes ?? []);
    if (scenes.length === 0) continue;
    const startTime = Math.min(...scenes.map((s) => s.startTime));
    const endTime = Math.max(...scenes.map((s) => s.endTime));
    const narrativeSummary = scenes.map((s) => s.narrativeText ?? s.visualIntent ?? "").filter(Boolean).join(". ").slice(0, 300);
    sections.push({
      sectionLabel: ch.title ?? `Section ${sections.length + 1}`,
      mood: ch.mood ?? "neutral",
      narrativeSummary,
      scenes,
      startTime,
      endTime
    });
  }
  if (sections.length === 0) {
    const allScenes = flattenScenes(plan);
    if (allScenes.length > 0) {
      sections.push({
        sectionLabel: "Main",
        mood: "neutral",
        narrativeSummary: allScenes.map((s) => s.narrativeText ?? "").filter(Boolean).join(". ").slice(0, 300),
        scenes: allScenes,
        startTime: allScenes[0].startTime,
        endTime: allScenes[allScenes.length - 1].endTime
      });
    }
  }
  return sections;
}
function buildMusicQuery(mood, _narrativeSummary, _sectionLabel) {
  const moodMap = {
    tense: ["dramatic tension", "suspense", "thriller"],
    emotional: ["emotional piano", "sad piano", "cinematic emotional"],
    inspirational: ["uplifting", "motivational", "inspiring"],
    peaceful: ["calm ambient", "peaceful", "relaxing"],
    dramatic: ["cinematic epic", "dramatic orchestral", "epic"],
    melancholic: ["melancholic", "sad ambient", "nostalgic"],
    hopeful: ["hopeful", "uplifting acoustic", "positive"],
    neutral: ["ambient", "background music", "instrumental"],
    action: ["action", "driving", "energetic"],
    mysterious: ["mysterious", "dark ambient", "eerie"]
  };
  const queries = moodMap[mood.toLowerCase()] ?? moodMap.neutral;
  return queries;
}
function buildSfxQuery(visualIntent) {
  const text = (visualIntent ?? "").toLowerCase();
  const patterns = [
    [/crowd|audience|people|group/i, "crowd ambience"],
    [/rain|storm|thunder/i, "rain storm sound"],
    [/ocean|sea|wave|beach/i, "ocean waves"],
    [/forest|bird|nature|park/i, "forest nature ambience"],
    [/city|traffic|urban|street/i, "city street ambience"],
    [/wind|breeze/i, "wind sound effect"],
    [/fire|flame/i, "fire crackling"],
    [/music|concert|instrument/i, "live music crowd"],
    [/whisper|quiet|silence/i, "subtle ambient"],
    [/footstep|walk|run/i, "footsteps walking"],
    [/door|enter|exit/i, "door sound effect"],
    [/phone|call|ring/i, "phone notification"],
    [/car|vehicle|drive/i, "car engine driving"],
    [/explosion|crash|impact/i, "impact crash sound"],
    [/water|river|stream/i, "flowing water stream"]
  ];
  for (const [pattern, sfxQuery] of patterns) {
    if (pattern.test(text)) return sfxQuery;
  }
  return null;
}
async function downloadAudio(asset, audioDir, timeoutMs = 45e3) {
  const ext = (asset.filetype ?? path.extname(asset.downloadUrl).slice(1)) || "mp3";
  const filename = `${asset.audioType}_${asset.assetId.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.${ext}`;
  const destPath = path.join(audioDir, filename);
  if (fs__namespace.existsSync(destPath) && fs__namespace.statSync(destPath).size > 0) return destPath;
  const fetchUrl = (url2, redirectsLeft = 8) => new Promise((resolve, reject) => {
    const u = new URL(url2);
    const protocol = u.protocol === "https:" ? https__namespace : http__namespace;
    const req = protocol.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: { "User-Agent": "VideoFactory/1.0" },
        timeout: timeoutMs
      },
      (res) => {
        const loc = res.headers.location;
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && loc) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects"));
            return;
          }
          const nextUrl = loc.startsWith("http") ? loc : `${u.protocol}//${u.host}${loc}`;
          fetchUrl(nextUrl, redirectsLeft - 1).then(resolve).catch(reject);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} downloading ${url2}`));
          return;
        }
        const tmp = destPath + ".tmp";
        const out = fs__namespace.createWriteStream(tmp);
        res.pipe(out);
        out.on("finish", () => {
          const size = fs__namespace.existsSync(tmp) ? fs__namespace.statSync(tmp).size : 0;
          if (size < 1024) {
            fs__namespace.unlinkSync(tmp);
            reject(new Error(`Downloaded file too small (${size} bytes) — likely an error page`));
            return;
          }
          fs__namespace.rename(tmp, destPath, (err) => {
            if (err) reject(err);
            else resolve(destPath);
          });
        });
        out.on("error", (err) => {
          try {
            fs__namespace.unlinkSync(tmp);
          } catch {
          }
          reject(err);
        });
        res.on("error", (err) => {
          try {
            fs__namespace.unlinkSync(tmp);
          } catch {
          }
          reject(err);
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Download timed out after ${timeoutMs}ms: ${url2}`));
    });
    req.on("error", reject);
    req.end();
  });
  return fetchUrl(asset.downloadUrl);
}
async function runAudioDirector(projectDir, onProgress = () => {
}, openverseToken) {
  const planPath = path.join(projectDir, "analysis", "master-edit-plan.json");
  if (!fs__namespace.existsSync(planPath)) {
    return { success: false, error: "No edit plan found. Run AI Planning first.", sections: [], sfxAssignments: [] };
  }
  const plan = JSON.parse(fs__namespace.readFileSync(planPath, "utf-8"));
  const audioDir = path.join(projectDir, "assets", "audio");
  fs__namespace.mkdirSync(audioDir, { recursive: true });
  onProgress("Analysing narrative structure…", 0.05);
  const rawSections = groupScenesIntoSections(plan);
  logger.info(`[AudioDirector] Found ${rawSections.length} narrative sections`);
  const sections = [];
  const sfxAssignments = [];
  for (let i = 0; i < rawSections.length; i++) {
    const sec = rawSections[i];
    const pct = 0.08 + i / rawSections.length * 0.5;
    onProgress(`[${i + 1}/${rawSections.length}] Music search: "${sec.sectionLabel}"`, pct);
    const queries = buildMusicQuery(sec.mood, sec.narrativeSummary, sec.sectionLabel);
    const sectionDuration = sec.endTime - sec.startTime;
    const pickBest = (results) => {
      if (results.length === 0) return null;
      const sorted = results.sort((a, b) => {
        const aDiff = Math.abs((a.durationSecs || 120) - sectionDuration);
        const bDiff = Math.abs((b.durationSecs || 120) - sectionDuration);
        return aDiff - bDiff;
      });
      return sorted[0];
    };
    let musicResult = null;
    for (const q of queries) {
      const results = await openverseSearchAudio(q, "music", 6);
      const best = pickBest(results);
      if (best) {
        musicResult = { ...best, searchQuery: q };
        logger.info(`[AudioDirector] Section "${sec.sectionLabel}" → "${q}" (music category): ${best.title}`);
        break;
      }
    }
    if (!musicResult) {
      for (const q of queries) {
        const results = await openverseSearchAudio(q, void 0, 6);
        const best = pickBest(results);
        if (best) {
          musicResult = { ...best, searchQuery: q };
          logger.info(`[AudioDirector] Section "${sec.sectionLabel}" → "${q}" (no category): ${best.title}`);
          break;
        }
      }
    }
    if (!musicResult) {
      const results = await openverseSearchAudio("ambient background music", void 0, 6);
      const best = pickBest(results);
      if (best) {
        musicResult = { ...best, searchQuery: "ambient background music" };
        logger.info(`[AudioDirector] Section "${sec.sectionLabel}" → fallback generic: ${best.title}`);
      }
    }
    if (!musicResult) {
      logger.warn(`[AudioDirector] Section "${sec.sectionLabel}": no music found after all passes`);
    }
    const section = {
      sectionId: `section_${i}`,
      sectionLabel: sec.sectionLabel,
      mood: sec.mood,
      startTime: sec.startTime,
      endTime: sec.endTime,
      durationSecs: sec.endTime - sec.startTime,
      sceneIndexes: sec.scenes.map((s) => s.sceneIndex),
      musicCandidate: musicResult,
      approved: false,
      status: musicResult ? "found" : "failed"
    };
    sections.push(section);
  }
  const allScenes = flattenScenes(plan);
  let sfxCount = 0;
  for (let i = 0; i < allScenes.length; i++) {
    const scene = allScenes[i];
    const sfxQuery = buildSfxQuery(scene.visualIntent ?? scene.narrativeText ?? "");
    if (!sfxQuery) continue;
    const pct = 0.6 + i / allScenes.length * 0.3;
    onProgress(`[SFX] Scene ${scene.sceneIndex}: ${sfxQuery}`, pct);
    try {
      const results = await openverseSearchAudio(sfxQuery, "sound_effects", 3, openverseToken);
      if (results.length > 0) {
        sfxAssignments.push({
          sceneIndex: scene.sceneIndex,
          startTime: scene.startTime,
          endTime: scene.endTime,
          sfxQuery,
          sfxCandidate: results[0],
          approved: false,
          volumeDb: -12,
          fadeInSecs: 0.5,
          fadeOutSecs: 0.5
        });
        sfxCount++;
      }
    } catch {
    }
  }
  const foundSections = sections.filter((s) => s.status === "found" && s.musicCandidate);
  for (let i = 0; i < foundSections.length; i++) {
    const sec = foundSections[i];
    sec.approved = true;
    const pct = 0.62 + i / Math.max(foundSections.length, 1) * 0.3;
    onProgress(`Downloading music [${i + 1}/${foundSections.length}]: ${sec.sectionLabel}…`, pct);
    try {
      const localPath = await downloadAudio(sec.musicCandidate, audioDir);
      sec.approvedLocalPath = localPath;
      sec.approvedFilename = path.basename(localPath);
      logger.info(`[AudioDirector] Downloaded: ${sec.sectionLabel} → ${localPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[AudioDirector] Download failed for ${sec.sectionLabel}: ${msg}`);
    }
  }
  const audioPlan = {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sections,
    sfxAssignments
  };
  const audioPlanPath = path.join(projectDir, "analysis", "audio-plan.json");
  fs__namespace.writeFileSync(audioPlanPath, JSON.stringify(audioPlan, null, 2), "utf-8");
  const downloadedCount = sections.filter((s) => s.approvedLocalPath).length;
  onProgress(`Complete — ${sections.filter((s) => s.status === "found").length}/${sections.length} music found, ${downloadedCount} downloaded, ${sfxCount} SFX`, 1);
  return {
    success: true,
    sections,
    sfxAssignments
  };
}
async function downloadApprovedAudio(projectDir, plan, onProgress = () => {
}) {
  const audioDir = path.join(projectDir, "assets", "audio");
  fs__namespace.mkdirSync(audioDir, { recursive: true });
  const total = plan.sections.filter((s) => s.approved && s.musicCandidate).length + plan.sfxAssignments.filter((s) => s.approved && s.sfxCandidate).length;
  let done = 0;
  for (const section of plan.sections) {
    if (!section.approved || !section.musicCandidate) continue;
    try {
      onProgress(`Downloading music: ${section.sectionLabel}`, done / total);
      const localPath = await downloadAudio(section.musicCandidate, audioDir);
      section.approvedLocalPath = localPath;
      section.approvedFilename = path.basename(localPath);
      done++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[AudioDirector] Failed to download music for ${section.sectionLabel}: ${msg}`);
    }
  }
  for (const sfx of plan.sfxAssignments) {
    if (!sfx.approved || !sfx.sfxCandidate) continue;
    try {
      onProgress(`Downloading SFX: Scene ${sfx.sceneIndex}`, done / total);
      const localPath = await downloadAudio(sfx.sfxCandidate, audioDir);
      sfx.approvedLocalPath = localPath;
      sfx.approvedFilename = path.basename(localPath);
      done++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[AudioDirector] Failed to download SFX for scene ${sfx.sceneIndex}: ${msg}`);
    }
  }
  const audioPlanPath = path.join(projectDir, "analysis", "audio-plan.json");
  fs__namespace.writeFileSync(audioPlanPath, JSON.stringify(plan, null, 2), "utf-8");
  return plan;
}
function loadAudioPlan(projectDir) {
  const audioPlanPath = path.join(projectDir, "analysis", "audio-plan.json");
  if (!fs__namespace.existsSync(audioPlanPath)) return null;
  try {
    return JSON.parse(fs__namespace.readFileSync(audioPlanPath, "utf-8"));
  } catch {
    return null;
  }
}
function saveAudioPlan(projectDir, plan) {
  const audioPlanPath = path.join(projectDir, "analysis", "audio-plan.json");
  fs__namespace.writeFileSync(audioPlanPath, JSON.stringify(plan, null, 2), "utf-8");
}
function registerAudioHandlers(ipcMain) {
  ipcMain.handle(
    IPC_CHANNELS.AUDIO_SEARCH_START,
    async (event, params) => {
      const win = electron.BrowserWindow.fromWebContents(event.sender);
      const sendProgress = (message, progress) => {
        win?.webContents.send(IPC_CHANNELS.AUDIO_SEARCH_PROGRESS, { message, progress });
      };
      try {
        const result = await runAudioDirector(params.projectDir, sendProgress);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AudioIPC] Search error: ${msg}`);
        return { success: false, error: msg, sections: [], sfxAssignments: [] };
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.AUDIO_PLAN_GET, (_event, projectDir) => {
    return loadAudioPlan(projectDir);
  });
  ipcMain.handle(
    IPC_CHANNELS.AUDIO_PLAN_SAVE,
    (_event, params) => {
      try {
        saveAudioPlan(params.projectDir, params.plan);
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.AUDIO_APPROVE_SECTION,
    (_event, params) => {
      const plan = loadAudioPlan(params.projectDir);
      if (!plan) return { success: false, error: "No audio plan found" };
      const section = plan.sections.find((s) => s.sectionId === params.sectionId);
      if (!section) return { success: false, error: "Section not found" };
      section.approved = params.approved;
      if (params.volumeDb !== void 0) section.volumeDb = params.volumeDb;
      if (params.fadeInSecs !== void 0) section.fadeInSecs = params.fadeInSecs;
      if (params.fadeOutSecs !== void 0) section.fadeOutSecs = params.fadeOutSecs;
      saveAudioPlan(params.projectDir, plan);
      return { success: true, plan };
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.AUDIO_APPROVE_SFX,
    (_event, params) => {
      const plan = loadAudioPlan(params.projectDir);
      if (!plan) return { success: false, error: "No audio plan found" };
      const sfx = plan.sfxAssignments.find((s) => s.sceneIndex === params.sceneIndex);
      if (!sfx) return { success: false, error: "SFX assignment not found" };
      sfx.approved = params.approved;
      if (params.volumeDb !== void 0) sfx.volumeDb = params.volumeDb;
      saveAudioPlan(params.projectDir, plan);
      return { success: true, plan };
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.AUDIO_DOWNLOAD_APPROVED,
    async (event, params) => {
      const win = electron.BrowserWindow.fromWebContents(event.sender);
      const plan = loadAudioPlan(params.projectDir);
      if (!plan) return { success: false, error: "No audio plan found" };
      const sendProgress = (message, progress) => {
        win?.webContents.send(IPC_CHANNELS.AUDIO_DOWNLOAD_PROGRESS, { message, progress });
      };
      try {
        const updatedPlan = await downloadApprovedAudio(params.projectDir, plan, sendProgress);
        return { success: true, plan: updatedPlan };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AudioIPC] Download error: ${msg}`);
        return { success: false, error: msg };
      }
    }
  );
}
function createWindow() {
  const mainWindow = new electron.BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#0a0a0f",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
    logger.info("Main window shown");
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return mainWindow;
}
electron.app.whenReady().then(() => {
  utils.electronApp.setAppUserModelId("com.videofactory.app");
  electron.app.on("browser-window-created", (_, window) => {
    utils.optimizer.watchWindowShortcuts(window);
  });
  registerFsHandlers(electron.ipcMain);
  registerProjectHandlers(electron.ipcMain);
  registerMediaHandlers(electron.ipcMain);
  registerTranscribeHandlers(electron.ipcMain);
  registerPlannerHandlers(electron.ipcMain);
  registerRenderHandlers(electron.ipcMain);
  registerStockHandlers(electron.ipcMain);
  registerAudioHandlers(electron.ipcMain);
  const mainWindow = createWindow();
  electron.ipcMain.on("window:minimize", () => mainWindow.minimize());
  electron.ipcMain.on("window:maximize", () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  electron.ipcMain.on("window:close", () => mainWindow.close());
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  logger.info("Long-Form AI Video Factory started", { version: electron.app.getVersion() });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
