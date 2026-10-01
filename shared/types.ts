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
  // Production Intelligence extension fields
  candidates?: StockCandidate[]
  selectedCandidateId?: string
  approvalStatus?: 'auto_selected' | 'approved' | 'needs_review'
  reviewedAt?: string
}

// ─── Production Intelligence Types ──────────────────────────────────────────

export type VisualTruthLabel =
  | 'EXACT_SUBJECT'
  | 'CONTEXTUAL_MATCH'
  | 'ILLUSTRATIVE'
  | 'HISTORICAL'
  | 'GENERIC_STOCK'
  | 'CONTRADICTORY'
  | 'UNKNOWN'

export interface VisualTruthVerification {
  candidateId: string
  sceneId: string
  actualSubjects: string[]
  actualActions: string[]
  visibleObjects: string[]
  visibleText?: string[]
  possibleLocations: string[]
  possibleTimePeriods: string[]
  subjectMatch: number
  actionMatch: number
  objectMatch: number
  geographyMatch: number
  timePeriodMatch: number
  narrationMatch: number
  visualIntentMatch: number
  documentaryEvidenceValue: number
  sequenceContinuity: number
  genericStockRisk: number
  contradictionRisk: number
  technicalQuality: number
  truthLabel: VisualTruthLabel
  positiveReasons: string[]
  negativeReasons: string[]
  contradictionReasons: string[]
  confidence: number
  approved: boolean
  requiresReview: boolean
  analyzedAt: string
  analysisVersion: string
  model?: string
}

export interface VisualTruthWeights {
  metadataRelevance: number
  visualVerification: number
  globalContext: number
  actionMatch: number
  sequenceContinuity: number
  technicalQuality: number
  genericStockPenalty: number
  contradictionPenalty: number
  reusePenalty: number
}

export const DEFAULT_VISUAL_TRUTH_WEIGHTS: VisualTruthWeights = {
  metadataRelevance: 0.25,
  visualVerification: 0.30,
  globalContext: 0.15,
  actionMatch: 0.10,
  sequenceContinuity: 0.10,
  technicalQuality: 0.10,
  genericStockPenalty: 25,
  contradictionPenalty: 50,
  reusePenalty: 15
}

// ─── Claim & Evidence Ledger Types ──────────────────────────────────────────

export type ClaimType =
  | 'STATISTIC'
  | 'MONEY'
  | 'DATE'
  | 'HISTORICAL_EVENT'
  | 'PERSON'
  | 'COMPANY'
  | 'LOCATION'
  | 'POLICY'
  | 'QUOTE'
  | 'COMPARISON'
  | 'CAUSAL'
  | 'GENERAL_FACT'

export type ClaimVerificationStatus =
  | 'VERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'UNSOURCED'
  | 'CONTRADICTED'
  | 'NOT_REQUIRED'

export type EvidenceType =
  | 'SOURCE_URL'
  | 'DOCUMENT'
  | 'REPORT'
  | 'SCREENSHOT'
  | 'ARCHIVE_IMAGE'
  | 'ARCHIVE_VIDEO'
  | 'CHART'
  | 'USER_MEDIA'
  | 'STOCK_CONTEXT'

export interface EvidenceSource {
  id: string
  type: EvidenceType
  title?: string
  publisher?: string
  author?: string
  url?: string
  publishedAt?: string
  accessedAt?: string
  localPath?: string
  assetId?: string
  pageNumber?: number
  timecodeStart?: number
  timecodeEnd?: number
  license?: string
  attribution?: string
  notes?: string
  manuallyAdded: boolean
}

export interface DocumentaryClaim {
  id: string
  scriptText: string
  normalizedClaim: string
  type: ClaimType
  chapterId?: string
  sequenceId?: string
  sceneIds: string[]
  importance: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  confidence: number
  verificationStatus: ClaimVerificationStatus
  evidenceSourceIds: string[]
  proofVisualRecommended: boolean
  proofVisualType?:
    | 'STAT_CARD'
    | 'DOCUMENT_CARD'
    | 'QUOTE_CARD'
    | 'COMPARISON_CARD'
    | 'DATA_NOTE'
    | 'ARCHIVE_VISUAL'
  warnings: string[]
  extractionVersion: string
  createdAt: string
  updatedAt: string
}

export interface ClaimEvidenceLedger {
  projectId: string
  scriptHash: string
  globalContextHash: string
  claims: DocumentaryClaim[]
  sources: EvidenceSource[]
  summary: {
    totalClaims: number
    verified: number
    partiallyVerified: number
    unsourced: number
    contradicted: number
    criticalUnsourced: number
    coveragePct?: number
  }
  generatedAt: string
  version: string
}

export interface ProductionIntelligenceSettings {
  enabled: boolean
  candidateRankingEnabled: boolean
  storyboardReviewEnabled: boolean
  visualSceneGrammarEnabled: boolean
  renderQaEnabled: boolean
  strictMissingMedia: boolean
  candidatesPerScene: number
  maxVisualGrammarDensity: number

  // Visual Truth Reranker & Claim Evidence additions
  visualTruthEnabled: boolean
  visualTruthShortlistSize: number
  visualTruthFrameCount: number
  visualTruthMinConfidence: number
  visualTruthTimeoutMs: number
  claimEvidenceEnabled: boolean
  evidenceWarningsEnabled: boolean
  blockCriticalContradictedClaims: boolean

  // Compatibility container if passed as nested object
  productionIntelligence?: {
    visualTruthEnabled?: boolean
    visualTruthShortlistSize?: number
    visualTruthFrameCount?: number
    visualTruthMinConfidence?: number
    visualTruthTimeoutMs?: number
    claimEvidenceEnabled?: boolean
    evidenceWarningsEnabled?: boolean
    blockCriticalContradictedClaims?: boolean
  }
}

export const DEFAULT_PRODUCTION_INTELLIGENCE_SETTINGS: ProductionIntelligenceSettings = {
  enabled: true,
  candidateRankingEnabled: true,
  storyboardReviewEnabled: true,
  visualSceneGrammarEnabled: true,
  renderQaEnabled: true,
  strictMissingMedia: false,
  candidatesPerScene: 3,
  maxVisualGrammarDensity: 0.25,

  // New features defaults
  visualTruthEnabled: true,
  visualTruthShortlistSize: 6,
  visualTruthFrameCount: 3,
  visualTruthMinConfidence: 60,
  visualTruthTimeoutMs: 15000,
  claimEvidenceEnabled: true,
  evidenceWarningsEnabled: true,
  blockCriticalContradictedClaims: false
}

export interface StockCandidateScore {
  localRelevance: number        // 0..30
  globalContextFit: number      // 0..20
  chapterContextFit: number     // 0..10
  technicalQuality: number      // 0..10
  motionSuitability: number     // 0..10
  aspectRatioFit: number        // 0..5
  diversityScore: number        // 0..15
  reusePenalty: number          // -30..0
  totalScore: number            // 0..100
  reasons: string[]
  rejectionReasons: string[]
}

export interface StockCandidate {
  candidateId: string
  sceneId: string
  sceneIndex: number
  result: StockSearchResult
  score: StockCandidateScore
  rank: number
  selected: boolean
  approved: boolean
  rejected: boolean
  // Production Intelligence Visual Truth extension
  visualTruth?: VisualTruthVerification
  finalScore?: number
}

export interface StoryboardSummary {
  totalScenes: number
  assignedScenes: number
  approvedScenes: number
  needsReviewScenes: number
  missingScenes: number
  averageRelevanceScore: number
  duplicateAssetsAvoided: number
}

// ─── Visual Scene Grammar Types ─────────────────────────────────────────────

export type VisualGrammarType =
  | 'stock_video'
  | 'stock_image'
  | 'photo_parallax'
  | 'stat_card'
  | 'quote_card'
  | 'date_card'
  | 'location_card'
  | 'comparison_card'
  | 'chapter_title'
  | 'document_card'

export interface VisualGrammarDecision {
  sceneId: string
  sceneIndex: number
  type: VisualGrammarType
  confidence: number
  reason: string
  primaryText?: string
  secondaryText?: string
  sourceNarration?: string
  startOffset: number
  duration: number
  position?: string
  enabled: boolean
}

export interface VisualGrammarPlan {
  version: number
  generatedAt: string
  decisions: VisualGrammarDecision[]
}

// ─── Render QA Types ────────────────────────────────────────────────────────

export type QaSeverity = 'info' | 'warning' | 'fatal'

export interface RenderQaIssue {
  id: string
  stage: 'preflight' | 'postflight'
  severity: QaSeverity
  category:
    | 'plan'
    | 'media'
    | 'audio'
    | 'caption'
    | 'overlay'
    | 'transition'
    | 'output'
  sceneId?: string
  sceneIndex?: number
  message: string
  suggestion?: string
  details?: Record<string, unknown>
}

export interface RenderQaReport {
  version: number
  generatedAt: string
  status: 'passed' | 'passed_with_warnings' | 'failed'
  expectedDuration: number
  actualDuration?: number
  totalScenes: number
  resolvedScenes: number
  missingScenes: number
  fatalCount: number
  warningCount: number
  infoCount: number
  issues: RenderQaIssue[]
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

// ─── API Key Verification Types ──────────────────────────────────────────────
export type ApiKeyStatus =
  | 'EMPTY'
  | 'UNSAVED'
  | 'SAVING'
  | 'SAVED_NOT_VERIFIED'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'INVALID_KEY'
  | 'QUOTA_EXCEEDED'
  | 'PERMISSION_DENIED'
  | 'MODEL_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'SERVICE_UNAVAILABLE'

export interface ApiKeyVerifyResult {
  valid: boolean
  status: ApiKeyStatus
  message?: string
  modelTested?: string
}

// ─── Scene Transition Types ──────────────────────────────────────────────────
export type VideoTransitionType =
  | 'cut'
  | 'fade'
  | 'dissolve'
  | 'wipeleft'
  | 'wiperight'
  | 'slideleft'
  | 'slideright'
  | 'smoothleft'
  | 'smoothright'
  | 'circleopen'
  | 'circleclose'
  | 'pixelize'
  | 'zoomin'

export type TransitionRenderMode =
  | 'smart'
  | 'single'

export interface RenderTransitionSettings {
  enabled: boolean
  mode: TransitionRenderMode
  singleType?: VideoTransitionType
  defaultDuration: number
  chapterDuration: number
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
  CONFIG_VERIFY_KEY: 'config:verify-key',

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
  CAPTIONS_RENDER_PROGRESS: 'captions:render-progress',

  // Production Intelligence — Storyboard & Candidates
  STOCK_CANDIDATES_GET: 'stock:candidates-get',
  STOCK_CANDIDATE_SELECT: 'stock:candidate-select',
  STOCK_CANDIDATE_APPROVE: 'stock:candidate-approve',
  STOCK_STORYBOARD_SUMMARY_GET: 'stock:storyboard-summary-get',

  // Production Intelligence — Settings
  PRODUCTION_SETTINGS_GET: 'production-settings:get',
  PRODUCTION_SETTINGS_SET: 'production-settings:set',

  // Production Intelligence — Render QA
  RENDER_PREFLIGHT_RUN: 'render:preflight-run',
  RENDER_QA_GET: 'render:qa-get',
  RENDER_QA_PROGRESS: 'render:qa-progress',

  // Production Intelligence — Claim & Evidence Ledger
  CLAIM_GET_LEDGER: 'claim:get-ledger',
  CLAIM_UPDATE_STATUS: 'claim:update-status',
  CLAIM_ADD_SOURCE: 'claim:add-source',
  CLAIM_REMOVE_SOURCE: 'claim:remove-source',
  CLAIM_LINK_SOURCE: 'claim:link-source',
  CLAIM_UNLINK_SOURCE: 'claim:unlink-source',
  CLAIM_EXPORT_MANIFESTS: 'claim:export-manifests',

  // Production Intelligence — Visual Truth Reranker
  VISUAL_TRUTH_GET_DATA: 'visual-truth:get-data',
  VISUAL_TRUTH_REANALYZE: 'visual-truth:reanalyze',

  // Auto Production Pipeline
  PIPELINE_START: 'pipeline:start',
  PIPELINE_RESUME: 'pipeline:resume',
  PIPELINE_CANCEL: 'pipeline:cancel',
  PIPELINE_STATUS_GET: 'pipeline:status-get',
  PIPELINE_PROGRESS: 'pipeline:progress',
  PIPELINE_RETRY_STAGE: 'pipeline:retry-stage',
  PIPELINE_RUN_FROM_STAGE: 'pipeline:run-from-stage',
  PIPELINE_RECOVER: 'pipeline:recover',

  // Thumbnail Studio & Google Flow companion workflow
  THUMBNAIL_TEMPLATE_LIST: 'thumbnail:template-list',
  THUMBNAIL_TEMPLATE_CREATE: 'thumbnail:template-create',
  THUMBNAIL_TEMPLATE_UPDATE: 'thumbnail:template-update',
  THUMBNAIL_TEMPLATE_DUPLICATE: 'thumbnail:template-duplicate',
  THUMBNAIL_TEMPLATE_DELETE: 'thumbnail:template-delete',
  THUMBNAIL_TEMPLATE_IMPORT: 'thumbnail:template-import',
  THUMBNAIL_TEMPLATE_EXPORT: 'thumbnail:template-export',

  THUMBNAIL_SETTINGS_GET: 'thumbnail:settings-get',
  THUMBNAIL_SETTINGS_SAVE: 'thumbnail:settings-save',

  THUMBNAIL_FLOW_HEALTH: 'thumbnail:flow-health',
  THUMBNAIL_FLOW_OPEN: 'thumbnail:flow-open',

  THUMBNAIL_PLAN_GENERATE: 'thumbnail:plan-generate',
  THUMBNAIL_JOB_START: 'thumbnail:job-start',
  THUMBNAIL_JOB_GET: 'thumbnail:job-get',
  THUMBNAIL_JOB_RESUME: 'thumbnail:job-resume',
  THUMBNAIL_JOB_CANCEL: 'thumbnail:job-cancel',
  THUMBNAIL_JOB_GENERATE_MORE: 'thumbnail:job-generate-more',

  THUMBNAIL_CANDIDATE_RETRY: 'thumbnail:candidate-retry',
  THUMBNAIL_CANDIDATE_REGENERATE: 'thumbnail:candidate-regenerate',
  THUMBNAIL_CANDIDATE_EXPORT_4K: 'thumbnail:candidate-export-4k',
  THUMBNAIL_CANDIDATE_SELECT: 'thumbnail:candidate-select',

  THUMBNAIL_OPEN_FOLDER: 'thumbnail:open-folder',
  THUMBNAIL_PROGRESS: 'thumbnail:progress',

  // FlowKit Runtime Manager
  FLOWKIT_RUNTIME_GET_SETTINGS: 'flowkit:runtime-get-settings',
  FLOWKIT_RUNTIME_SAVE_SETTINGS: 'flowkit:runtime-save-settings',
  FLOWKIT_RUNTIME_START: 'flowkit:runtime-start',
  FLOWKIT_RUNTIME_STOP: 'flowkit:runtime-stop',
  FLOWKIT_RUNTIME_STATUS: 'flowkit:runtime-status',
  FLOWKIT_RUNTIME_LOG: 'flowkit:runtime-log',
  FLOWKIT_RUNTIME_SELECT_FOLDER: 'flowkit:runtime-select-folder',
  FLOWKIT_RUNTIME_SELECT_PYTHON: 'flowkit:runtime-select-python',
  FLOWKIT_RUNTIME_ENSURE_READY: 'flowkit:runtime-ensure-ready',
  FLOWKIT_RUNTIME_DETECT_PYTHON: 'flowkit:runtime-detect-python'
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

// ─── Auto Production Pipeline Types ──────────────────────────────────────────

export type PipelineStage =
  | 'idle'
  | 'validating'
  | 'transcribing'
  | 'planning'
  | 'captions'
  | 'global-context'
  | 'stock-search'
  | 'audio-search'
  | 'preflight'
  | 'rendering'
  | 'postflight'
  | 'completed'
  | 'needs-attention'
  | 'cancelled'
  | 'failed'

export type StageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'warning'
  | 'failed'
  | 'cancelled'

export interface PipelineStageState {
  status: StageStatus
  progress: number // 0 to 1
  message?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  warning?: string
  error?: string
  artifactPath?: string
  stats?: {
    totalScenes?: number
    processedScenes?: number
    assignedScenes?: number
    downloadedScenes?: number
    missingScenes?: number
    lowConfidenceScenes?: number
    missingSceneIndices?: number[]
    [key: string]: unknown
  }
}

export interface InputFingerprint {
  scriptPath: string
  scriptHash?: string
  voiceoverPath: string
  voiceoverSize?: number
  voiceoverMtimeMs?: number
}

export interface AutoPipelineOptions {
  projectDir: string
  scriptPath: string
  voiceoverPath: string
  whisperModel?: 'tiny' | 'base' | 'small' | 'medium'
  geminiModel?: string
  forceRegenerateCaptions?: boolean
  preferredStockProvider?: 'pexels' | 'pixabay' | 'all'
  requireBackgroundMusic?: boolean
  outputName?: string
  resolution?: { width: number; height: number }
  fps?: 24 | 25 | 30 | 60
  transitionSettings?: RenderTransitionSettings
  autoStartOnReady?: boolean
}

export type PipelineOverallStatus =
  | 'idle'
  | 'running'
  | 'interrupted'
  | 'recovering'
  | 'needs-attention'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface PipelineLease {
  runId: string
  appInstanceId: string
  pid: number
  acquiredAt: string
  heartbeatAt: string
  currentStage: PipelineStage
}

export interface PipelineSnapshot {
  version: number
  runId: string
  projectDir: string
  currentStage: PipelineStage
  overallStatus: PipelineOverallStatus
  stages: Record<string, PipelineStageState>
  updatedAt: string
  lease?: PipelineLease
  warnings?: string[]
  fatalErrors?: string[]
  renderOutputPath?: string
  preflightReportPath?: string
  postflightReportPath?: string
}

export interface PipelineRecoveryResult {
  recovered: boolean
  previousRunId?: string
  resumable: boolean
  resumeFrom?: PipelineStage
  completedStages: PipelineStage[]
  invalidStages: PipelineStage[]
  warnings: string[]
  snapshot?: PipelineSnapshot
}

export interface AutoPipelineState {
  schemaVersion: number
  version: number // Monotonically increasing version counter for snapshots
  runId: string
  projectDir: string
  currentStage: PipelineStage
  overallStatus: PipelineOverallStatus
  startedAt?: string
  updatedAt: string
  completedAt?: string
  inputFingerprint: InputFingerprint
  options: AutoPipelineOptions
  stages: Record<string, PipelineStageState>
  lease?: PipelineLease
  warnings: string[]
  fatalErrors: string[]
  renderOutputPath?: string
  preflightReportPath?: string
  postflightReportPath?: string
}

export interface PipelineError {
  code: string
  stage: PipelineStage
  message: string
  recoverable: boolean
  provider?: string
  retryAfterMs?: number
  originalError?: string
}

// ─── Thumbnail Studio & Google Flow Types ─────────────────────────────────────

export const THUMBNAIL_CATEGORIES = [
  'US Grocery',
  'Preparedness',
  'Hutterite Documentary',
  'Hidden Cost Documentary',
  'Streamer Reaction',
  'Custom'
] as const

export const BUILT_IN_PROMPT_CATEGORIES = THUMBNAIL_CATEGORIES
export type ThumbnailCategory = (typeof THUMBNAIL_CATEGORIES)[number]

export interface ThumbnailPromptTemplate {
  id: string
  name: string
  description?: string
  category: string
  promptText: string
  isBuiltIn: boolean
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface FlowKitRuntimeSettings {
  mode: 'external' | 'managed'
  bridgeUrl: string
  flowKitPath?: string
  pythonPath?: string
  flowProjectId?: string
  autoStartBridge: boolean
}

export type FlowConnectionErrorCode =
  | 'FLOWKIT_NOT_CONFIGURED'
  | 'FLOWKIT_PATH_INVALID'
  | 'FLOWKIT_PYTHON_NOT_FOUND'
  | 'FLOWKIT_DEPENDENCIES_MISSING'
  | 'FLOWKIT_BRIDGE_OFFLINE'
  | 'FLOWKIT_START_FAILED'
  | 'FLOWKIT_HEALTH_TIMEOUT'
  | 'FLOW_EXTENSION_DISCONNECTED'
  | 'FLOW_TAB_NOT_OPEN'
  | 'FLOW_NOT_SIGNED_IN'
  | 'FLOW_PROJECT_ID_MISSING'
  | 'FLOW_PROJECT_ID_INVALID'
  | 'FLOW_PROVIDER_UNAVAILABLE'
  | 'FLOW_IMAGE_GENERATION_UNAVAILABLE'

export interface FlowReadinessResult {
  ready: boolean
  bridgeReachable: boolean
  extensionConnected: boolean
  flowConnected: boolean
  flowProjectIdPresent: boolean
  imageGenerationReady: boolean
  export4kStatus: 'available' | 'unknown' | 'unavailable'
  blockingCode?: FlowConnectionErrorCode
  message: string
  diagnostics?: Record<string, unknown>
}

export interface ProjectThumbnailSettings {
  enabled: boolean
  autoGenerateAfterRender: boolean
  selectedTemplateId?: string
  templateSnapshot?: string
  templateSnapshotHash?: string
  existingVideoTitle?: string
  variantCount: 5
  outputLanguage: 'en-US'
  provider: 'google-flow'
  imageModel: string
  outputQuality: '4k'
  // FlowKit connection
  flowKitSettings?: FlowKitRuntimeSettings
}

export interface ThumbnailProviderHealth {
  reachable: boolean
  providerAvailable: boolean
  extensionConnected: boolean
  signedIn: boolean
  supportsImageGeneration: boolean
  requestedExportQuality: '4k'
  message?: string
  details?: {
    version?: string
    flowProjectId?: string
    generationThrottle?: {
      min_interval_s?: number
      cooldown_active?: boolean
      unusual_activity_cooldown_s?: number
      [key: string]: unknown
    }
  }
}

export interface ThumbnailPlanOption {
  id: 'A' | 'B' | 'C' | 'D' | 'E'
  conceptName: string
  yellowText: string
  whiteText: string
  visualConcept: string
  imagePrompt: string
  titleClear: string
  titleCuriosity: string
  whyItWorks: string
}

export interface ThumbnailPlanScriptInsight {
  mainTopic: string
  groundedHook: string
  strongestVisualDetail: string
  viewerConcernOrGoal: string
  unsupportedClaimsToAvoid: string[]
}

export interface ThumbnailPlan {
  scriptInsight: ThumbnailPlanScriptInsight
  options: ThumbnailPlanOption[]
  recommendedOptionId: string
  recommendationReason: string
  postGenerationCheck: string
  generatedAt?: string
  modelUsed?: string
  generationRound?: number
}

export type ThumbnailJobStatus =
  | 'idle'
  | 'planning'
  | 'awaiting-review'
  | 'generating'
  | 'exporting'
  | 'partial'
  | 'completed'
  | 'needs-attention'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ThumbnailCandidate {
  id: string
  optionId: 'A' | 'B' | 'C' | 'D' | 'E'
  round: number
  revision: number
  conceptName: string
  yellowText: string
  whiteText: string
  imagePrompt: string
  titleClear: string
  titleCuriosity: string
  status:
    | 'pending'
    | 'generating'
    | 'exporting'
    | 'completed'
    | 'failed'
  attempts: number
  mediaId?: string
  originalImagePath?: string
  exportedImagePath?: string
  actualWidth?: number
  actualHeight?: number
  exportQuality?: 'native-4k' | '2k-fallback' | 'original-fallback'
  error?: string
}

export interface ThumbnailJobState {
  schemaVersion: number
  version: number
  jobId: string
  jobKey: string
  projectDir: string
  renderOutputPath: string
  status: ThumbnailJobStatus
  generationRound: number
  scriptHash: string
  templateSnapshotHash: string
  flowProjectId?: string
  candidates: ThumbnailCandidate[]
  selectedCandidateId?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  warnings: string[]
  errors: string[]
  lease?: {
    jobId: string
    appInstanceId: string
    pid: number
    acquiredAt: string
    heartbeatAt: string
  }
}

export interface ThumbnailManifest {
  projectId: string
  renderOutput: string
  scriptHash: string
  templateId?: string
  templateSnapshotHash?: string
  generationRound: number
  flowModel: string
  flowProjectId?: string
  candidates: {
    id: string
    optionId: 'A' | 'B' | 'C' | 'D' | 'E'
    conceptName: string
    yellowText: string
    whiteText: string
    titleClear: string
    titleCuriosity: string
    imagePrompt: string
    mediaId?: string
    actualDimensions?: { width: number; height: number }
    actualExportQuality?: 'native-4k' | '2k-fallback' | 'original-fallback'
    filePath?: string
    status: string
    error?: string
  }[]
  selectedCandidateId?: string
  createdAt: string
  completedAt?: string
  errors: string[]
}

export interface ThumbnailProgressPayload {
  projectDir: string
  jobId: string
  status: ThumbnailJobStatus
  stage: 'idle' | 'planning' | 'generating' | 'exporting' | 'completed' | 'failed'
  currentOptionId?: 'A' | 'B' | 'C' | 'D' | 'E'
  completedCount: number
  totalCount: number
  progress: number // 0 to 1
  message: string
  candidate?: ThumbnailCandidate
  jobState?: ThumbnailJobState
}

