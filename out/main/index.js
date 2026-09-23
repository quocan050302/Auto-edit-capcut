"use strict";
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const fs = require("fs");
const uuid = require("uuid");
const winston = require("winston");
require("crypto");
const ffprobeStatic = require("ffprobe-static");
const child_process = require("child_process");
const genai = require("@google/genai");
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
  RENDER_PROGRESS: "render:progress"
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
const UV_PATH = "C:\\Users\\ADMIN\\.local\\bin\\uv.exe";
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
  if (!fs__namespace.existsSync(scriptPath)) {
    throw new Error(`Transcription script not found: ${scriptPath}`);
  }
  if (!fs__namespace.existsSync(UV_PATH)) {
    throw new Error(`uv not found at ${UV_PATH}. Please install uv: https://docs.astral.sh/uv/`);
  }
  logger.info("Starting transcription via uv + faster-whisper", {
    audio: audioPath,
    model: modelName,
    script: scriptPath
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
    logger.info(`Spawning: ${UV_PATH} ${args.join(" ")}`);
    const proc = child_process.spawn(UV_PATH, args, {
      env: { ...process.env },
      windowsHide: true
    });
    let resultData = null;
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      const lines = chunk.toString().split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "progress") {
            onProgress?.(msg.message, msg.progress);
            logger.info(`[WHISPER] ${msg.message}`);
          } else if (msg.type === "result") {
            resultData = msg;
          }
        } catch {
          logger.debug(`[WHISPER stdout] ${line}`);
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
    const cacheDir = path.join(process.env.APPDATA || "", "long-form-video-factory", "whisper-models");
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
  const mediaList = [
    ...videoFiles.map((v) => `  VIDEO: ${v.filename} (${v.durationSecs?.toFixed(1) ?? "?"}s)`),
    ...imageFiles.map((i) => `  IMAGE: ${i.filename}`)
  ].join("\n");
  const transcriptLines = transcript.segments.map(
    (seg) => `[${seg.id}] ${seg.start.toFixed(1)}s-${seg.end.toFixed(1)}s: "${seg.text}"`
  ).join("\n");
  return `You are a professional documentary video editor AI. Your job is to create a complete master edit plan that matches narration segments with available media files.

## NARRATION TRANSCRIPT (${transcript.segments.length} segments, ${transcript.duration.toFixed(0)}s total)
${transcriptLines}

## AVAILABLE MEDIA LIBRARY
${mediaList}

${scriptText ? `## ORIGINAL SCRIPT
${scriptText.slice(0, 8e3)}
` : ""}

## YOUR TASK
Create a master edit plan as a JSON object. Rules:
1. Every second of narration MUST be covered by a media clip
2. Match media files logically to the narrative content (use filename clues)
3. Videos can be used for their full duration or trimmed
4. Images should display for 3-8 seconds
5. Divide the content into 3-6 chapters with meaningful titles
6. Each chapter has 2-4 sequences, each sequence has 2-6 scenes
7. Transition between scenes: mostly "cut", use "fade" for chapter breaks

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
            {
              "sceneIndex": 1,
              "mediaFile": "exact_filename.mp4",
              "mediaType": "video",
              "startTime": 0,
              "endTime": 15,
              "duration": 15,
              "narrativeText": "The narration text spoken here",
              "transcriptSegmentIds": ["N001", "N002"],
              "transitionIn": "cut",
              "visualNote": "Shows opening establishing shot"
            }
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
    const mediaPath = resolveMediaPath(scene.mediaFile, mediaIndex);
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
