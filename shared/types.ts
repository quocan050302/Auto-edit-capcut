// ==================================================
// SHARED TYPES — used by both main and renderer process
// ==================================================

export type ProjectStatus =
  | 'NEW'
  | 'ANALYZING_AUDIO'
  | 'BUILDING_TRANSCRIPT'
  | 'ANALYZING_MEDIA'
  | 'PLANNING'
  | 'READY_TO_RENDER'
  | 'RENDERING'
  | 'QA'
  | 'ASSEMBLING'
  | 'COMPLETE'
  | 'ERROR'

export type VideoType =
  | 'documentary'
  | 'history'
  | 'storytelling'
  | 'educational'
  | 'cinematic-documentary'

export type AspectRatio = '16:9' | '9:16' | '1:1'

export type Pacing = 'slow' | 'balanced' | 'fast' | 'cinematic'

export interface ProjectSettings {
  videoType: VideoType
  aspectRatio: AspectRatio
  resolution: { width: number; height: number }
  fps: 24 | 25 | 30 | 60
  pacing: Pacing
}

export interface ProjectInputs {
  scriptPath: string | null
  voiceoverPath: string | null
  imagesFolder: string | null
  videosFolder: string | null
  musicFolder: string | null
  sfxFolder: string | null
}

export type MediaItemType = 'image' | 'video' | 'audio'

export interface MediaItem {
  id: string
  type: MediaItemType
  path: string
  filename: string
  fileSize: number
  // Image specific
  width?: number
  height?: number
  // Video specific
  duration?: number
  fps?: number
  codec?: string
  // Audio specific
  audioDuration?: number
  // Shared
  aspectRatio?: string
  tags: string[]
  description: string
  usageCount: number
  lastUsedInScene?: string
  importedAt: string
}

export interface ProjectState {
  id: string
  name: string
  projectDir: string
  status: ProjectStatus
  settings: ProjectSettings
  inputs: ProjectInputs
  stats: {
    totalImages: number
    totalVideos: number
    totalMusic: number
    totalSfx: number
    voiceDurationSeconds: number
    estimatedScenes: number
    estimatedChapters: number
  }
  createdAt: string
  updatedAt: string
  lastOperation: string | null
  error: string | null
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'success' | 'debug'
  message: string
  timestamp: string
  category?: string
}

export interface ScanResult {
  images: MediaItem[]
  videos: MediaItem[]
  music: MediaItem[]
  sfx: MediaItem[]
  errors: Array<{ path: string; error: string }>
}

// ─── Stock Media Types ────────────────────────────────────────────────────────

export type StockProvider = 'pexels' | 'pixabay'
export type StockMediaType = 'video' | 'photo'

/** A single candidate returned from a stock media API search */
export interface StockSearchResult {
  assetId: string
  provider: StockProvider
  mediaType: StockMediaType
  title: string
  tags: string[]
  thumbnailUrl: string
  previewUrl: string       // small/preview video or image URL
  downloadUrl: string      // best quality download URL
  width: number
  height: number
  durationSecs?: number    // only for video
  creator: string
  creatorUrl?: string
  licenseUrl?: string
  pageUrl: string
}

/** A stock asset that has been downloaded to disk */
export interface StockAsset {
  assetId: string
  provider: StockProvider
  mediaType: StockMediaType
  localPath: string        // absolute path in project/assets/stock/
  thumbnailUrl: string
  downloadUrl: string
  creator: string
  licenseUrl?: string
  searchQuery: string
  downloadedAt: string
  fileSizeBytes?: number
}

/** Assignment of a stock asset to one scene */
export interface StockSceneAssignment {
  sceneId: string          // scene identifier from the edit plan
  sceneIndex: number
  narrationText: string
  startTime: number
  endTime: number
  visualIntent: string
  searchQueries: string[]
  usedQuery: string
  asset: StockAsset | null
  score: number
  locked: boolean
  manualOverride: boolean  // true if user uploaded their own file
  status: 'pending' | 'searching' | 'assigned' | 'failed' | 'disabled'
  errorMessage?: string
}

/** Parameters passed to the stock engine */
export interface StockRunParams {
  projectDir: string
  pexelsApiKey: string
  pixabayApiKey?: string
  preferredAspectRatio?: string  // e.g. '16:9'
}

/** Result from a completed stock engine run */
export interface StockRunResult {
  success: boolean
  totalScenes: number
  assignedScenes: number
  failedScenes: number
  assignments: StockSceneAssignment[]
  error?: string
}

/** What the renderer fetches for the review UI */
export interface StockReviewData {
  assignments: StockSceneAssignment[]
  totalScenes: number
  assignedScenes: number
  stockAssetsJson: StockAsset[]
}

// IPC channel names
export const IPC_CHANNELS = {
  // File dialogs
  SELECT_FILE: 'select-file',
  SELECT_FOLDER: 'select-folder',

  // Project management
  PROJECT_CREATE: 'project:create',
  PROJECT_OPEN: 'project:open',
  PROJECT_SAVE: 'project:save',
  PROJECT_UPDATE_INPUTS: 'project:update-inputs',
  PROJECT_UPDATE_SETTINGS: 'project:update-settings',

  // Media scanning
  MEDIA_SCAN: 'media:scan',
  MEDIA_SCAN_PROGRESS: 'media:scan-progress',

  // Transcription
  TRANSCRIBE_START: 'transcribe:start',
  TRANSCRIBE_PROGRESS: 'transcribe:progress',
  TRANSCRIBE_GET: 'transcribe:get',
  TRANSCRIBE_CHECK_MODEL: 'transcribe:check-model',

  // Logging
  LOG_ENTRY: 'log:entry',

  // App info
  GET_APP_VERSION: 'app:get-version',
  GET_PROJECTS_DIR: 'app:get-projects-dir',

  // Config (API keys, preferences)
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',

  // AI Edit Planning
  PLAN_GENERATE: 'plan:generate',
  PLAN_PROGRESS: 'plan:progress',
  PLAN_GET: 'plan:get',

  // Video Rendering
  RENDER_START: 'render:start',
  RENDER_PROGRESS: 'render:progress',
  RENDER_CANCEL: 'render:cancel',

  // Stock Media Engine
  STOCK_SEARCH_START: 'stock:search-start',
  STOCK_SEARCH_PROGRESS: 'stock:search-progress',
  STOCK_REVIEW_GET: 'stock:review-get',
  STOCK_SCENE_REPLACE: 'stock:scene-replace',
  STOCK_SCENE_LOCK: 'stock:scene-lock',
  STOCK_SCENE_UPLOAD: 'stock:scene-upload'
} as const

// ─── Transcript types (shared between main and renderer) ─────────────────────

export interface TranscriptWord {
  word: string
  start: number
  end: number
}

export interface TranscriptSegment {
  id: string
  text: string
  start: number
  end: number
  duration: number
  words: TranscriptWord[]
}

export interface TranscriptResult {
  language: string
  languageProbability?: number
  duration: number
  segments: TranscriptSegment[]
  fullText: string
  wordCount: number
  generatedAt: string
}
