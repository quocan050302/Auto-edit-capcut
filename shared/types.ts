// ==================================================
// SHARED TYPES — used by both main and renderer process
// ==================================================

// ─── Retention Engine Types ──────────────────────────────────────────────────
// Added for the Retention Engine upgrade — all optional, backward compatible

/** Open loop (Zeigarnik effect): a teaser opened at one scene, paid off at another */
export interface OpenLoop {
  id: string
  type: 'cold_open_tease' | 'mid_chapter_question' | 'teased_info'
  teaserText: string           // The teaser sentence injected at openedAtSceneId
  openedAtSceneId: string
  payoffSceneId: string        // The scene that "closes" the loop
  payoffText?: string
}

/** Recurring visual/narrative element that creates continuity across scenes */
export interface Motif {
  id: string
  label: string                // e.g. "the pocket watch", "Harold the farmer"
  firstSeenSceneId: string
  recurringSceneIds: string[]
  preferredAssetId?: string    // Stock asset ID to reuse for visual consistency
}

/** Output of the Retention QA Pass — a lint-like warning for the editor */
export interface RetentionFlag {
  sceneId: string
  severity: 'low' | 'medium' | 'high'
  issue: string                // e.g. "3 consecutive minutes without shot type change"
  suggestion: string           // Specific, actionable fix suggestion
}

/** Pacing issue detected by the algorithmic pacing-guard module */
export interface PacingIssue {
  sceneId: string
  accumulatedMonotoneSeconds: number
  suggestion: 'insert_broll' | 'insert_text_overlay' | 'vary_shot_type'
  affectedField: 'energyLevel' | 'shotType' | 'both'
}

/** Cold open: a sneak-peek of the most compelling scenes shown before Chapter 1 */
export interface ColdOpen {
  sourceSceneIds: string[]     // Scene IDs to extract into the cold open
  reasoning?: string
  scriptOverlayText?: string   // Short text to overlay (e.g. "What really happened?")
}

/** Script Doctor result: revised script proposal, must be reviewed before use */
export interface ScriptDoctorResult {
  revisedScript: string
  openLoopsInjected: Array<{
    teaserText: string
    approxPosition: string
    suggestedPayoffPosition: string
  }>
  changesSummary: string
  generatedAt: string
}

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

// ─── Extended Scene Plan (Retention Engine fields) ───────────────────────────
// NOTE: ScenePlan lives in planner.ts (Main) and PlanningPage.tsx (Renderer).
// These shared types are re-exported so both sides can use them without duplication.

/** Energy level of a scene — used by pacing-guard and audio intensity decisions */
export type SceneEnergyLevel = 'low' | 'medium' | 'high'

/** Shot type — used by pattern interrupt detection and stock query weighting */
export type SceneShotType = 'wide' | 'medium' | 'close-up' | 'abstract'

// ─── Global Script Context (Phase 1) ────────────────────────────────────────

export interface GlobalScriptGeography {
  primaryCountry?: string
  primaryRegion?: string
  secondaryLocations: string[]
}

export interface GlobalScriptTimeContext {
  primaryPeriod: string
  historicalPeriods: string[]
}

export interface GlobalScriptCommunity {
  name: string
  role: string
  visualDescription: string
  mustNotConfuseWith: string[]
}

export interface GlobalScriptPerson {
  id: string
  role: string
  ageRange?: string
  gender?: string
  appearance?: string
  clothing?: string
}

export interface GlobalScriptVisualWorld {
  environment: string[]
  architecture: string[]
  clothing: string[]
  occupations: string[]
  machinery: string[]
  recurringObjects: string[]
  colorMood: string
  documentaryStyle: string
}

export interface GlobalScriptStoryArc {
  chapterId: string
  title: string
  purpose: string
  startText: string
  endText: string
}

export interface GlobalScriptContext {
  projectId: string
  language: string
  version: number             // incremented when user edits context
  generatedAt: string
  modelUsed: string

  primarySubject: string
  secondarySubjects: string[]

  globalSynopsis: string
  centralThesis: string
  documentaryAngle: string
  targetAudience: string

  geography: GlobalScriptGeography
  timeContext: GlobalScriptTimeContext
  communities: GlobalScriptCommunity[]
  recurringPeople: GlobalScriptPerson[]

  visualWorld: GlobalScriptVisualWorld

  exactTopicAnchors: string[]    // e.g. "Hutterite", "Hutterian Brethren"
  contextualAnchors: string[]    // e.g. "Canadian prairie", "communal farming"
  forbiddenSubstitutions: string[] // e.g. "Amish presented as Hutterite"
  negativeKeywords: string[]     // e.g. "horse and buggy", "urban teenager"
  recurringVisualMotifs: string[]

  storyArc: GlobalScriptStoryArc[]
}

// ─── Stock Search Plan (tiered queries — Phase 4) ─────────────────────────────

export interface StockSearchPlan {
  visualIntent: string

  exactQueries: string[]        // Tier A — exact subject + location
  subjectQueries: string[]      // Tier B — subject anchored, broader action
  contextualQueries: string[]   // Tier C — contextual, no exact name
  fallbackQueries: string[]     // Tier D — illustrative only

  requiredTerms: string[]
  preferredTerms: string[]
  negativeTerms: string[]

  targetMediaType: 'video' | 'image' | 'either'
  desiredShotTypes: string[]
  desiredOrientation: 'landscape' | 'portrait'
}

// ─── Scene Context Packet (Phase 3) ──────────────────────────────────────────

export interface SceneContextPacket {
  globalContext: {
    primarySubject: string
    centralThesis: string
    geography: string[]
    timePeriod: string[]
    exactTopicAnchors: string[]
    contextualAnchors: string[]
    forbiddenSubstitutions: string[]
    negativeKeywords: string[]
  }
  chapterContext: {
    chapterId: string
    chapterTitle: string
    chapterPurpose: string
  }
  localContext: {
    narration: string
    scenePurpose: string
    visibleSubject: string
    visibleAction: string
    preferredLocation: string
    preferredTimePeriod: string
  }
  neighboringContext: {
    previousScene: string
    nextScene: string
  }
}

// ─── Context-Aware Score Breakdown (Phase 7) ─────────────────────────────────

export interface ContextScoreBreakdown {
  localRelevance: number      // 0–30
  globalSubjectRelevance: number  // 0–25
  geographyMatch: number      // 0–15
  timePeriodMatch: number     // 0–10
  chapterPurposeMatch: number // 0–10
  technicalQuality: number    // 0–5
  sequenceContinuity: number  // 0–5
  totalScore: number          // 0–100
  penalties: number           // negative value
  penaltyReasons: string[]
  matchLabel: 'STRONG_MATCH' | 'ACCEPTABLE' | 'ILLUSTRATIVE' | 'REJECTED'
  visualTruthLabel: 'EXACT_SUBJECT' | 'CONTEXTUAL_MATCH' | 'ILLUSTRATIVE' | 'HISTORICAL' | 'USER_MEDIA'
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
  // Context-aware extension fields
  chapterId?: string
  chapterTitle?: string
  scenePurpose?: string
  continuityGroup?: string
  matchLabel?: string
  visualTruthLabel?: string
  scoreBreakdown?: ContextScoreBreakdown
  searchPlan?: StockSearchPlan
  rejectedCandidates?: Array<{ title: string; score: number; reason: string }>
  tierUsed?: 'A' | 'B' | 'C' | 'D'
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

// ─── Smart Audio Director Types ───────────────────────────────────────────────

export type AudioProvider = 'openverse'
export type AudioMediaType = 'music' | 'sfx'

/** A single candidate returned from an audio search provider */
export interface AudioSearchResult {
  assetId: string
  provider: AudioProvider
  audioType: AudioMediaType
  title: string
  creator: string
  creatorUrl?: string
  downloadUrl: string
  thumbnailUrl: string
  durationSecs: number
  tags: string[]
  license: string
  licenseUrl: string
  pageUrl: string
  filetype: string
  searchQuery: string
}

/** A music section spanning one or more scenes that share a narrative mood */
export interface AudioSection {
  sectionId: string
  sectionLabel: string
  mood: string
  startTime: number
  endTime: number
  durationSecs: number
  sceneIndexes: number[]
  musicCandidate: AudioSearchResult | null
  approved: boolean
  status: 'found' | 'failed' | 'pending'
  errorMessage?: string
  // Populated after download
  approvedLocalPath?: string
  approvedFilename?: string
  // User-customisable volume & fade
  volumeDb?: number       // default -18 (background)
  fadeInSecs?: number     // default 2
  fadeOutSecs?: number    // default 3
}

/** Sound-effect assignment for one scene */
export interface AudioSfxAssignment {
  sceneIndex: number
  startTime: number
  endTime: number
  sfxQuery: string
  sfxCandidate: AudioSearchResult | null
  approved: boolean
  volumeDb: number        // default -12
  fadeInSecs: number
  fadeOutSecs: number
  // Populated after download
  approvedLocalPath?: string
  approvedFilename?: string
}

/** Full audio plan saved to disk */
export interface AudioPlan {
  generatedAt: string
  sections: AudioSection[]
  sfxAssignments: AudioSfxAssignment[]
}

/** Result from a runAudioDirector() call */
export interface AudioRunResult {
  success: boolean
  sections: AudioSection[]
  sfxAssignments: AudioSfxAssignment[]
  error?: string
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
  SET_PROJECTS_DIR: 'app:set-projects-dir',


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
  STOCK_SCENE_UPLOAD: 'stock:scene-upload',

  // Context-Aware Global Script Director
  STOCK_CONTEXT_ANALYZE: 'stock:context-analyze',
  STOCK_CONTEXT_GET: 'stock:context-get',
  STOCK_CONTEXT_SAVE: 'stock:context-save',
  STOCK_CONTEXT_PROGRESS: 'stock:context-progress',

  // Smart Audio Director
  AUDIO_SEARCH_START: 'audio:search-start',
  AUDIO_SEARCH_PROGRESS: 'audio:search-progress',
  AUDIO_PLAN_GET: 'audio:plan-get',
  AUDIO_PLAN_SAVE: 'audio:plan-save',
  AUDIO_APPROVE_SECTION: 'audio:approve-section',
  AUDIO_APPROVE_SFX: 'audio:approve-sfx',
  AUDIO_DOWNLOAD_APPROVED: 'audio:download-approved',
  AUDIO_DOWNLOAD_PROGRESS: 'audio:download-progress',

  // Retention Engine — Script Doctor
  SCRIPT_DOCTOR_RUN: 'script:doctor-run',

  // Retention Engine — Retention QA Pass
  RETENTION_QA_RUN: 'retention:qa-run',
  RETENTION_QA_PROGRESS: 'retention:qa-progress',

  // Dynamic Kinetic Captions Engine
  CAPTIONS_GENERATE_PLAN: 'captions:generate-plan',
  CAPTIONS_GET_PLAN: 'captions:get-plan',
  CAPTIONS_UPDATE_PHRASE: 'captions:update-phrase',
  CAPTIONS_TOGGLE_RANGE: 'captions:toggle-range',
  CAPTIONS_REGENERATE_ASS: 'captions:regenerate-ass',   // kept for backward compat
  CAPTIONS_PREVIEW_RENDER: 'captions:preview-render',
  CAPTIONS_PROGRESS: 'captions:progress',
  // Remotion caption overlay render progress (separate from main FFmpeg render)
  CAPTIONS_RENDER_PROGRESS: 'captions:render-progress'
} as const

// ─── Master Edit Plan Retention Extension ─────────────────────────────────────
// Extends the MasterEditPlan (defined in planner.ts) with Retention Engine output.
// All fields are optional so existing plan files load without migration.
export interface MasterEditPlanRetentionExt {
  openLoops?: OpenLoop[]
  motifRegistry?: Motif[]
  coldOpen?: ColdOpen
  retentionFlags?: RetentionFlag[]
  retentionQAAssessment?: string  // Overall assessment text from Gemini Retention QA
}

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

// ─── Dynamic Kinetic Captions Engine ─────────────────────────────────────────
// Hệ thống chữ nhảy theo cụm từ, animation, đồng bộ word timestamps

/** Loại nhấn mạnh của cụm từ caption — quyết định style và animation */
export type CaptionEmphasis = 'hook' | 'list_transition' | 'shock_stat' | 'punchline' | 'normal'

/**
 * Remotion render preset — quyết định component nào được dùng khi render overlay.
 * - big_statement : chữ to chiếm trọn màn hình, ô đỏ ôm sát từ được nhấn
 * - news_chyron   : 2 khối màu nối liền (kiểu bản tin), đổi font giữa 2 khối
 * - data_note     : callout nhỏ góc màn hình, không che B-roll
 */
export type CaptionPreset = 'big_statement' | 'news_chyron' | 'data_note'

/** Một segment trong News Chyron (mỗi khối màu riêng) */
export interface ChyronSegment {
  text: string
  background: string          // hex color, vd '#E8352B' hoặc '#F5F0E6'
  textColor: string           // hex color
  fontPreset: 'sans_bold_caps' | 'serif'
}

/** Một cụm từ 2-4 chữ trong caption, kèm style và timing chính xác */
export interface CaptionPhrase {
  id: string
  sceneId: string              // liên kết tới Scene trong master-edit-plan
  text: string                 // cụm từ 2-4 chữ, viết hoa khi render
  startTime: number            // giây, lấy từ word timestamps trong transcript
  endTime: number
  emphasisType: CaptionEmphasis
  highlightWords?: string[]    // các từ trong "text" cần đổi màu vàng riêng
  style: {
    fontPreset: 'sans_bold_caps' | 'serif_italic'
    boxHighlight: boolean      // dải đỏ phía sau chữ
    skew: boolean              // bẻ góc 3D (shear trục X)
    baseColor: 'white' | 'yellow_pale'
  }
  // ── Remotion preset fields (NEW) ──────────────────────────────────────────
  presetType?: CaptionPreset              // quyết định component Remotion nào render
  chyronSegments?: ChyronSegment[]        // chỉ dùng khi presetType === 'news_chyron'
  dataNote?: {
    label: string                          // bản rút gọn số liệu dưới 8 từ
    position: 'bottom_left' | 'bottom_right' | 'top_right'
  }
  // ── Animation metadata (OPTIONAL — backward compatible) ───────────────────
  // Nếu không có → CaptionsOverlay tự infer từ emphasisType + phraseIndex
  animationPreset?: 'smooth_kinetic' | 'punch' | 'swipe_reveal' | 'blur_focus' | 'impact_keyword' | 'type_pop'
  animationIntensity?: 'subtle' | 'medium' | 'strong'
  keywordAnimation?: 'none' | 'spring' | 'impact' | 'highlight'
  wordStaggerFrames?: number
}

/** Khoảng thời gian caption được BẬT */
export interface CaptionActiveRange {
  startTime: number
  endTime: number
  reason: CaptionEmphasis
  chapterId?: string
}

/** Toàn bộ kế hoạch caption cho 1 video */
export interface CaptionPlan {
  enabled: boolean
  activeRanges: CaptionActiveRange[]  // các khoảng thời gian caption được BẬT
  phrases: CaptionPhrase[]             // rỗng ngoài activeRanges
  generatedByFallback?: boolean        // true nếu dùng thuật toán thay vì Gemini (backward compat)
  generatedAt?: string
  // ── Optional metadata (new — backward compatible) ─────────────────────────
  generationSource?: 'gemini' | 'fallback'   // nguồn generation
  generationModel?: string                    // Gemini model đã dùng
  generationReason?: string                   // lý do fallback nếu có
  hookWindowSeconds?: number                  // hook window đã dùng khi generate
  sourceDuration?: number                     // transcript.duration — dùng cho timeline UI
}
