"use strict";
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const fs = require("fs");
const uuid = require("uuid");
const winston = require("winston");
require("crypto");
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
  STOCK_SCENE_UPLOAD: "stock:scene-upload"
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
const DEFAULT_PROJECTS_DIR = path.join(
  electron.app.getPath("documents"),
  "VideoFactory",
  "projects"
);
function ensureProjectsDir() {
  if (!fs__namespace.existsSync(DEFAULT_PROJECTS_DIR)) {
    fs__namespace.mkdirSync(DEFAULT_PROJECTS_DIR, { recursive: true });
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
      const projectDir = path.join(DEFAULT_PROJECTS_DIR, safeName);
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
    return DEFAULT_PROJECTS_DIR;
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
async function buildEditPlan(params) {
  const { projectDir, apiKey, onProgress } = params;
  const modelId = params.model ?? "gemini-3.6-flash";
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
  let rawJson = "";
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      progress(
        attempt === 1 ? "Waiting for Gemini response (may take 30-60 seconds)..." : `Thử lại với Gemini (lần ${attempt}/${maxRetries})...`,
        0.3 + (attempt - 1) * 0.1
      );
      const response = await ai.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.3,
          maxOutputTokens: 32768
        }
      });
      rawJson = response.text ?? "";
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isOverloaded = msg.includes("503") || msg.includes("high demand") || msg.includes("UNAVAILABLE") || msg.includes("429");
      if (isOverloaded && attempt < maxRetries) {
        const waitSec = attempt * 4;
        logger.warn(`Gemini 503 high demand (attempt ${attempt}/${maxRetries}), waiting ${waitSec}s...`);
        progress(`Google AI đang quá tải (503), tự động thử lại lần ${attempt + 1}/${maxRetries} sau ${waitSec}s...`, 0.35 + attempt * 0.1);
        await new Promise((res) => setTimeout(res, waitSec * 1e3));
        continue;
      }
      if (isOverloaded) {
        throw new Error(`Google AI đang quá tải (503 High Demand). Bạn hãy thử đổi sang model "gemini-2.0-flash (stable)" ở dropdown hoặc đợi 1-2 phút rồi bấm lại.`);
      }
      throw new Error(`Gemini API error: ${msg}`);
    }
  }
  progress("Parsing edit plan...", 0.85);
  let planData;
  try {
    const clean = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    planData = JSON.parse(clean);
  } catch (err) {
    logger.error("Failed to parse Gemini JSON", { raw: rawJson.slice(0, 500) });
    throw new Error(`Failed to parse AI response as JSON: ${err}`);
  }
  const allScenes = planData.chapters.flatMap(
    (c) => c.sequences.flatMap((s) => s.scenes)
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
    modelUsed: modelId
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
  const item = mediaIndex.find((m) => m.filename === filename || path__namespace.basename(m.path) === filename);
  return item ? item.path : null;
}
function resolveSceneMedia(scene, mediaIndex) {
  if (scene.localPath && fs__namespace.existsSync(scene.localPath)) return scene.localPath;
  if (scene.localAsset && fs__namespace.existsSync(scene.localAsset)) return scene.localAsset;
  return resolveMediaPath(scene.mediaFile, mediaIndex);
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
    (ch) => ch.sequences.flatMap((seq) => seq.scenes)
  );
  const totalScenes = scenes.length;
  progress(`Processing ${totalScenes} scenes...`, 0.06);
  const tmpDir = path__namespace.join(projectDir, "renders", "_tmp");
  fs__namespace.mkdirSync(tmpDir, { recursive: true });
  const sceneClips = [];
  const { width, height } = resolution;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const pct = 0.06 + i / totalScenes * 0.7;
    progress(`Scene ${i + 1}/${totalScenes}: ${scene.mediaFile}`, pct, {
      sceneIndex: i + 1,
      totalScenes
    });
    const mediaPath = resolveSceneMedia(scene, mediaIndex);
    const outClip = path__namespace.join(tmpDir, `scene_${String(i + 1).padStart(4, "0")}.mp4`);
    const scaleFilt = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    if (!mediaPath || !fs__namespace.existsSync(mediaPath)) {
      logger.warn(`[RENDER] Missing media: ${scene.mediaFile}, using black placeholder`);
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
    } else if (scene.mediaType === "image") {
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
  progress("Mixing voiceover audio...", 0.88);
  const outputDir = path__namespace.join(projectDir, "output");
  fs__namespace.mkdirSync(outputDir, { recursive: true });
  const outputPath = path__namespace.join(outputDir, `${outputName}.mp4`);
  if (fs__namespace.existsSync(voiceoverPath)) {
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
    fs__namespace.copyFileSync(rawVideo, outputPath);
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
function tokenize(text) {
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
  const intentTokens = tokenize(ctx.visualIntent);
  const narrationTokens = tokenize(ctx.narrationText);
  const refTokens = /* @__PURE__ */ new Set([...intentTokens, ...narrationTokens]);
  const titleTokens = tokenize(candidate.title);
  const tagTokens = new Set(candidate.tags.flatMap((t) => t.toLowerCase().split(/\s+/)));
  const candidateTokens = /* @__PURE__ */ new Set([...titleTokens, ...tagTokens]);
  return Math.min(1, jaccardSimilarity(refTokens, candidateTokens) * 5);
}
function technicalScore(candidate) {
  const minDim = Math.min(candidate.width, candidate.height);
  if (minDim >= 2160) return 1;
  if (minDim >= 1080) return 0.9;
  if (minDim >= 720) return 0.6;
  return 0.3;
}
function compositionScore(candidate, preferredAr) {
  const [pw, ph] = preferredAr.split(":").map(Number);
  const preferred = pw / ph;
  const actual = candidate.width / candidate.height;
  if (!preferred || !actual) return 0.5;
  const diff = Math.abs(preferred - actual) / preferred;
  return Math.max(0, 1 - diff * 2);
}
function durationScore(candidate, sceneDuration) {
  if (candidate.mediaType === "photo") return 0.8;
  const clipDur = candidate.durationSecs ?? 0;
  if (clipDur <= 0) return 0.4;
  if (clipDur >= sceneDuration) return 1;
  return Math.max(0.2, clipDur / sceneDuration);
}
function scoreCandidate(candidate, ctx) {
  const sem = semanticScore(candidate, ctx) * 0.5;
  const tech = technicalScore(candidate) * 0.2;
  const comp = compositionScore(candidate, ctx.preferredAspectRatio) * 0.15;
  const dur = durationScore(candidate, ctx.sceneDurationSecs) * 0.15;
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
function flattenScenes(plan) {
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
function toOrientation(ar) {
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
  const allScenes = flattenScenes(plan);
  const scenesNeedingStock = allScenes.filter(
    (s) => !s.locked && (!s.localPath || !fs__namespace.existsSync(s.localPath))
  );
  const assignments = [];
  let assignedCount = 0;
  let failedCount = 0;
  const orientation = toOrientation(preferredAspectRatio);
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
  const orientation = toOrientation(preferredAspectRatio);
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
    const scene = flattenScenes(plan).find((s) => s.sceneIndex === sceneIndex);
    if (scene) {
      scene.localPath = asset.localPath;
      fs__namespace.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
    }
  }
  return asset;
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
          error: "No stock API keys configured. Go to Settings → API Providers to add Pexels or Pixabay key."
        };
      }
      const sendProgress = (message, progress) => {
        win?.webContents.send(IPC_CHANNELS.STOCK_SEARCH_PROGRESS, { message, progress });
      };
      try {
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
