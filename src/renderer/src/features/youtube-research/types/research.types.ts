export type MarketCode = 'US' | 'GB' | 'CA' | 'AU' | 'DE' | 'FR' | 'JP' | 'KR'

export interface MarketInfo {
  code: MarketCode
  name: string
  defaultLanguage: string
  flag: string
}

export const SUPPORTED_MARKETS: MarketInfo[] = [
  { code: 'US', name: 'United States', defaultLanguage: 'en', flag: '🇺🇸' },
  { code: 'GB', name: 'United Kingdom', defaultLanguage: 'en', flag: '🇬🇧' },
  { code: 'CA', name: 'Canada', defaultLanguage: 'en', flag: '🇨🇦' },
  { code: 'AU', name: 'Australia', defaultLanguage: 'en', flag: '🇦🇺' },
  { code: 'DE', name: 'Germany', defaultLanguage: 'de', flag: '🇩🇪' },
  { code: 'FR', name: 'France', defaultLanguage: 'fr', flag: '🇫🇷' },
  { code: 'JP', name: 'Japan', defaultLanguage: 'ja', flag: '🇯🇵' },
  { code: 'KR', name: 'South Korea', defaultLanguage: 'ko', flag: '🇰🇷' }
]

export type ContentType = 'LONG' | 'SHORT' | 'BOTH'
export type TimeRange = '24h' | '7d' | '30d' | '90d' | '4m' | '5m' | '6m' | '1y' | '365d' | 'all' | 'custom'
export type ProviderSource = 'OFFICIAL' | 'SCRAPER' | 'MIXED'
export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH'
export type CompetitionLevel = 'LOW' | 'MEDIUM' | 'HIGH'
export type TrendState = 'Emerging' | 'Rising' | 'Stable' | 'Cooling'
export type ApiConnectionStatus = 'checking' | 'reachable' | 'blocked' | 'offline'

// V2: YouTube API key connection status
export type ApiKeyStatus =
  | 'not_configured'
  | 'testing'
  | 'connected'
  | 'invalid_key'
  | 'api_not_enabled'
  | 'quota_exhausted'
  | 'network_error'
  | 'server_error'
  | 'rate_limited'
  | 'unknown_error'

// V2: Subscriber verification states
export type SubscriberStatus = 'VERIFIED_MATCH' | 'UNVERIFIED_MATCH' | 'REJECTED'

// V2: Search budget options
export type SearchBudget = 3 | 6 | 8 | 10

// V2: Research presets
export type ResearchPreset = 'small_niche' | 'balanced' | 'deep'

export type ResearchStage =
  | 'STARTING'
  | 'QUEUED'
  | 'EXPANDING_KEYWORDS'
  | 'SEARCHING'
  | 'FETCHING_METADATA'
  | 'BASIC_SCORING'
  | 'ENRICHING_CANDIDATES'
  | 'LOADING_CHANNEL_BASELINES'
  | 'CALCULATING_ADVANCED_METRICS'
  | 'CLUSTERING'
  | 'AI_ANALYSIS'
  | 'PERSISTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED'

export const ACTIVE_RESEARCH_STAGES = [
  'STARTING',
  'QUEUED',
  'RUNNING',
  'EXPANDING_KEYWORDS',
  'SEARCHING',
  'FETCHING_METADATA',
  'BASIC_SCORING',
  'ENRICHING_CANDIDATES',
  'LOADING_CHANNEL_BASELINES',
  'CALCULATING_ADVANCED_METRICS',
  'CLUSTERING',
  'AI_ANALYSIS',
  'PERSISTING'
] as const

export const TERMINAL_RESEARCH_STAGES = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED'
] as const

export function isResearchStageActive(stage?: string | null): boolean {
  if (!stage || stage === 'IDLE') return false
  if ((TERMINAL_RESEARCH_STAGES as readonly string[]).includes(stage)) return false
  return true
}

export function isResearchStageTerminal(stage?: string | null): boolean {
  if (!stage) return false
  return (TERMINAL_RESEARCH_STAGES as readonly string[]).includes(stage)
}

export function isResearchRunActive(progress?: ResearchProgressState | null): boolean {
  if (!progress) return false
  return isResearchStageActive(progress.stage)
}

export interface ResearchProgressState {
  run_id?: string | null
  stage: ResearchStage
  progress_percent: number
  message: string
  videos_collected: number
  channels_analyzed: number
  keywords_expanded: number
  elapsed_seconds: number
  can_cancel: boolean
  error?: string
}

export interface NormalizedVideo {
  video_id: string
  url: string
  title: string
  description?: string
  channel_id: string
  channel_title: string
  published_at: string
  duration_seconds: number
  views: number
  likes?: number | null
  comments?: number | null
  thumbnail_url: string
  channel_subscribers?: number | null
  channel_total_views?: number | null
  channel_video_count?: number | null
  channel_country?: string | null
  search_keyword: string
  market: MarketCode
  language: string
  content_type: 'LONG' | 'SHORT' | 'LIVE'
  source_provider: ProviderSource
  collected_at: string
  raw_metadata?: Record<string, unknown>
}

export interface VideoSnapshot {
  id?: number
  video_id: string
  captured_at: string
  view_count: number
  like_count?: number | null
  comment_count?: number | null
}

export interface BreakoutVideoItem {
  video_id: string
  url: string
  title: string
  channel_id: string
  channel_title: string
  published_at: string
  age_days: number
  views: number
  views_per_day: number
  observed_velocity?: number | null // from delta snapshots
  channel_subscribers?: number | null
  channel_median_views?: number | null
  outlier_ratio: number
  market_signal: string
  source_provider: ProviderSource
  thumbnail_url: string
  is_small_channel_breakout: boolean
}

// V2: Candidate video with subscriber status
export interface CandidateVideoItem {
  video_id: string
  url: string
  title: string
  channel_id: string
  channel_title: string
  published_at: string
  age_days: number
  views: number
  views_per_day: number
  channel_subscribers?: number | null
  outlier_ratio?: number | null
  subscriber_status: SubscriberStatus
  subscriber_label: string   // "Subscriber hidden / unverified" or ""
  filter_distance: number    // 0.0 = perfect, higher = farther from passing
  source_provider: string
  thumbnail_url: string
}

// V2: Near-match suggestion
export interface NearMatchSuggestion {
  field: string
  current_value: number | string
  suggested_value: number | string
  would_add_candidates: number
  description: string
}

// V2: Search diagnostics
export interface SearchDiagnostics {
  queries_generated: number
  queries_searched: number
  pages_fetched: number
  raw_results: number
  unique_videos: number
  duplicate_rate: number
  channels_discovered: number
  channels_enriched: number
  subscriber_known_pct: number
  baseline_coverage_pct: number
  official_api_calls: number
  fallback_calls: number
  cache_hits: number
  search_stop_reason: string
  search_budget_used: number
  search_budget_total: number
}

// V2: Filter funnel for UI display
export interface FilterFunnel {
  raw_collected: number
  unique_after_dedupe: number
  above_min_views: number
  above_min_vpd: number
  above_min_outlier: number
  subscriber_known: number
  subscriber_unknown: number
  below_max_subscribers: number
  exact_matches: number
  unverified_matches: number
  near_matches: number
  excluded_by_reason: Record<string, number>
}

export interface KeywordMetricRecord {
  keyword: string
  opportunity_score: number
  confidence_level: ConfidenceLevel
  confidence_score: number
  demand_score: number
  velocity_score: number
  outlier_score: number
  competition_score: number
  competition_level: CompetitionLevel
  market_fit_score: number
  freshness_score: number
  freshness_state: TrendState
  video_count: number
  channel_count: number
  median_views: number
  median_views_per_day: number
  best_outlier_ratio: number
  is_rising: boolean
  is_low_competition: boolean
  is_breakout: boolean
  is_small_channel_win: boolean
  has_market_signal: boolean
  breakdown?: {
    demand_details: string
    velocity_details: string
    outlier_details: string
    cross_channel_details: string
    market_fit_details: string
    competition_details: string
  }
}

export interface TopicClusterItem {
  id: string
  label: string
  summary: string
  video_count: number
  unique_channels: number
  median_velocity: number
  top_titles: string[]
  sample_keywords: string[]
}

export interface TrendRadarItem {
  topic: string
  count_24h: number
  count_7d: number
  count_30d: number
  median_velocity: number
  breakout_count: number
  unique_channels: number
  trend_state: TrendState
  confidence_level: ConfidenceLevel
}

export interface CompetitorAnalysisResult {
  channel_id: string
  channel_title: string
  channel_url: string
  country?: string | null
  subscriber_count?: number | null
  video_count: number
  recent_videos_analyzed: number
  median_recent_views: number
  mean_recent_views: number
  p75_views: number
  p90_views: number
  outlier_videos: BreakoutVideoItem[]
  best_repeated_topics: string[]
  winning_title_patterns: string[]
  upload_cadence_days: number
  topic_consistency: 'High' | 'Moderate' | 'Broad'
  // V2 — thumbnail intelligence
  videos_for_thumbnail?: VideoForThumbnail[] | null
  thumbnail_intelligence?: ThumbnailIntelligenceResult | null
}

export interface VideoForThumbnail {
  video_id: string
  title: string
  published_at: string
  age_days: number
  views: number
  views_per_day: number
  outlier_ratio: number
  thumbnail_url: string
  thumbnail_quality: string
}

// ── Thumbnail Intelligence Types (V2) ─────────────────────────────────────────

export type PerformanceGroup = 'outlier' | 'baseline' | 'low'
export type ThumbnailConfidence = 'insufficient' | 'low' | 'medium' | 'high'

export interface NormalizedBox {
  x: number
  y: number
  width: number
  height: number
}

export interface DominantColor {
  hex: string
  rgb: [number, number, number]
  fraction: number
  label: string
}

export interface ThumbnailOcrAnalysis {
  text: string
  word_count: number
  line_count: number
  char_count: number
  has_uppercase: boolean
  uppercase_ratio: number
  has_numbers: boolean
  has_currency: boolean
  has_question: boolean
  has_exclamation: boolean
  repeats_title: boolean
  text_coverage_pct: number
  text_alignment: string
  confidence: number
  is_uncertain: boolean
  font_category: string
}

export interface ThumbnailCompositionAnalysis {
  layout_type: string
  main_focal_point: string
  has_negative_space: boolean
  background_complexity: 'low' | 'medium' | 'high'
  subject_size_pct: number
  face_size_pct: number
  main_subject_box?: NormalizedBox | null
  text_region_box?: NormalizedBox | null
  duration_badge_risk: boolean
}

export interface ThumbnailSubjectAnalysis {
  has_person: boolean
  person_count: number
  face_count: number
  shot_type: string
  facial_expression: string
  gaze_direction: string
  has_proof_object: boolean
  has_arrow_circle: boolean
  has_comparison: boolean
  has_contradiction: boolean
}

export interface ThumbnailColorAnalysis {
  dominant_colors: DominantColor[]
  background_color: string
  accent_color: string
  warm_cool_balance: 'warm' | 'cool' | 'neutral'
  saturation: number
  brightness: number
  contrast: number
  has_yellow: boolean
  has_red: boolean
}

export interface ThumbnailHook {
  hook_type: string
  confidence: number
  visual_evidence: string
  text_evidence: string
  title_evidence: string
}

export interface ThumbnailTitlePairing {
  relationship: string
  redundancy_pct: number
  has_curiosity_gap: boolean
  has_promise_mismatch: boolean
  thumbnail_adds: string
}

export interface MobileReadability {
  score: number
  text_readable: boolean
  face_recognizable: boolean
  main_object_clear: boolean
  duration_badge_overlap_risk: boolean
  breakdown: Record<string, number>
}

export interface ThumbnailAnalysis {
  video_id: string
  video_title: string
  thumbnail_url: string
  thumbnail_hash: string
  thumbnail_quality: string
  width: number
  height: number
  performance_group: PerformanceGroup
  views: number
  views_per_day: number
  outlier_ratio: number
  video_age_days: number
  ocr: ThumbnailOcrAnalysis
  composition: ThumbnailCompositionAnalysis
  subjects: ThumbnailSubjectAnalysis
  colors: ThumbnailColorAnalysis
  hooks: ThumbnailHook[]
  title_pairing: ThumbnailTitlePairing
  mobile_readability: MobileReadability
  provider: string
  model?: string | null
  analysis_version: string
  confidence: number
  warnings: string[]
  is_error: boolean
  error_reason: string
}

export interface ThumbnailPattern {
  pattern_id: string
  name: string
  description: string
  outlier_count: number
  outlier_total: number
  baseline_count: number
  baseline_total: number
  low_count: number
  low_total: number
  sample_size: number
  confidence: ThumbnailConfidence
  evidence_video_ids: string[]
  is_winning: boolean
  is_avoid: boolean
}

export type ThumbnailBlueprintMode =
  | 'validated_winning'
  | 'observed_outlier_style'
  | 'observed_channel_style'
  | 'title_derived_fallback'
  | 'safe_default'

export interface ThumbnailBlueprint {
  id: string
  name: string
  use_when: string
  target_hook: string
  blueprint_mode: ThumbnailBlueprintMode
  is_statistically_validated: boolean
  fallback_reason: string
  source_group: 'outlier' | 'all' | 'title' | 'default'
  sample_summary: {
    total_analyzed: number
    outlier_count: number
    baseline_count: number
    low_count: number
    has_valid_control_group: boolean
  }
  limitations: string[]
  based_on_pattern_ids: string[]
  layout_description: string
  subject_recipe: string
  background_recipe: string
  text_recipe: string
  color_recipe: string
  lighting_recipe: string
  hierarchy_recipe: string
  title_pairing_recipe: string
  overlay_text_formula: string[]
  image_prompt_template: string
  negative_prompt: string
  evidence: string[]
  confidence: ThumbnailConfidence
  originality_rules: string[]
}

export interface ThumbnailGroupStats {
  n: number
  has_text_pct?: number
  has_face_pct?: number
  has_proof_pct?: number
  has_arrow_pct?: number
  has_comparison_pct?: number
  has_yellow_pct?: number
  has_red_pct?: number
  median_word_count?: number
  median_brightness?: number
  median_contrast?: number
  median_saturation?: number
  median_mobile_score?: number
  median_subject_size?: number
  median_outlier_ratio?: number
  top_hook?: string
  top_layout?: string
}

export interface ThumbnailIntelligenceResult {
  channel_id: string
  analyzed_count: number
  cached_count: number
  failed_count: number
  skipped_count: number
  outlier_count: number
  baseline_count: number
  low_count: number
  overall_confidence: ThumbnailConfidence
  confidence_score: number
  analyses: ThumbnailAnalysis[]
  patterns: ThumbnailPattern[]
  winning_patterns: ThumbnailPattern[]
  avoid_patterns: ThumbnailPattern[]
  blueprints: ThumbnailBlueprint[]
  group_stats: {
    outlier?: ThumbnailGroupStats
    baseline?: ThumbnailGroupStats
    low?: ThumbnailGroupStats
  }
  analysis_version: string
  provider: string
  limitations: string[]
  failure_details: Array<{ video_id: string; title: string; reason: string; stage: string }>
  created_at: string
}

export interface AiInsightsReport {
  summary: string
  why_it_is_rising: string[]
  winning_angles: string[]
  title_patterns: string[]
  content_gaps: string[]
  risks: string[]
  video_ideas: Array<{
    title: string
    angle: string
    target_format: 'Long-form' | 'Shorts'
    why_it_works: string
  }>
}

export interface ResearchFilters {
  min_views?: number
  max_subscribers?: number
  min_views_per_day?: number
  min_outlier_ratio?: number
  min_opportunity?: number
  max_competition?: number
}

export interface ResearchFilterSummary {
  applied_filters: Record<string, number>
  raw_videos_collected: number
  videos_after_metadata_filters: number
  videos_after_all_filters: number
  keywords_before_filters: number
  keywords_after_filters: number
  excluded_by_reason: Record<string, number>
  // V2
  funnel?: Record<string, number>
}

export interface ThumbnailGenerationRequest {
  title: string
  script_summary?: string
  blueprint: ThumbnailBlueprint
}

export interface ThumbnailGenerationResponse {
  image_base64: string
  prompt_used: string
}

export interface ResearchRunResult {
  run_id: string
  project_id?: string
  topic: string
  market: MarketCode
  language: string
  content_type: ContentType
  time_range: TimeRange
  created_at: string
  completed_at?: string
  provider_source: ProviderSource
  provider_notes?: string
  top_opportunity?: {
    keyword: string
    opportunity_score: number
    confidence_level: ConfidenceLevel
    market_fit_score: number
    competition_score: number
    trend_state: TrendState
    summary: string
  }
  overview_metrics: {
    videos_analyzed: number
    unique_channels: number
    keywords_found: number
    breakouts_found: number
    small_channel_wins: number
    data_confidence: ConfidenceLevel
  }
  keywords: KeywordMetricRecord[]
  breakout_videos: BreakoutVideoItem[]
  trend_radar: TrendRadarItem[]
  topic_clusters: TopicClusterItem[]
  ai_insights?: AiInsightsReport | null
  data_sources: Array<{ metric: string; source: string; note?: string }>
  filter_summary?: ResearchFilterSummary
  // V2 optional fields — old runs without these will be undefined
  exact_matches?: CandidateVideoItem[]
  unverified_matches?: CandidateVideoItem[]
  near_matches?: CandidateVideoItem[]
  near_match_suggestions?: NearMatchSuggestion[]
  filter_funnel?: FilterFunnel
  search_diagnostics?: SearchDiagnostics
}

export interface SavedResearchProject {
  id: string
  name: string
  seed_topic: string
  market: MarketCode
  language: string
  content_type: ContentType
  time_range: TimeRange
  created_at: string
  updated_at: string
  last_run_id?: string
  scoring_version: string
  provider_source: ProviderSource
  summary_snippet?: string
  top_opportunity_keyword?: string
  top_opportunity_score?: number
  video_count: number
}

export interface ResearchScoringWeights {
  demand: number
  velocity: number
  outlier: number
  cross_channel: number
  market_fit: number
  freshness: number
  competition: number
}

export interface ResearchSettings {
  use_official_api: boolean
  has_official_api_key: boolean
  scraper_fallback: boolean
  provider_priority: 'official_first' | 'scraper_first'
  default_market: MarketCode
  default_language: string
  default_date_range: TimeRange
  default_content_type: ContentType
  default_result_size: number
  ai_provider: 'ollama' | 'gemini' | 'openai' | 'anthropic' | 'disabled'
  ollama_base_url: string
  ollama_model: string
  has_cloud_ai_key: boolean
  max_expanded_keywords: number
  raw_video_limit: number
  max_enrichment_videos: number
  channel_baseline_size: number
  snapshot_policy_hours: number
  scoring_weights: ResearchScoringWeights
  debug_mode: boolean
}

// V2: Research presets definition
export interface ResearchPresetDef {
  id: ResearchPreset
  label: string
  description: string
  icon: string
  minViews?: number
  maxSubscribers?: number
  timeRange: TimeRange
  contentType: ContentType
  resultLimit: number
  searchBudget: SearchBudget
  includeUnverified: boolean
}

export const RESEARCH_PRESETS: ResearchPresetDef[] = [
  {
    id: 'small_niche',
    label: 'Small Niche',
    description: 'Focus on small channels with breakout potential',
    icon: '🔬',
    minViews: 10000,
    maxSubscribers: 100000,
    timeRange: '90d',
    contentType: 'LONG',
    resultLimit: 50,
    searchBudget: 6,
    includeUnverified: true
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Mix of popular and emerging niches',
    icon: '⚖️',
    minViews: 5000,
    timeRange: '30d',
    contentType: 'LONG',
    resultLimit: 100,
    searchBudget: 8,
    includeUnverified: true
  },
  {
    id: 'deep',
    label: 'Deep Research',
    description: 'Exhaustive analysis with max API budget',
    icon: '🔭',
    minViews: 1000,
    timeRange: '90d',
    contentType: 'LONG',
    resultLimit: 300,
    searchBudget: 10,
    includeUnverified: true
  }
]

// Unified research input (single source of truth)
export interface NicheResearchInput {
  seedTopic: string
  regionCode: MarketCode
  relevanceLanguage: string
  timeRange: TimeRange
  contentType: ContentType
  minimumViews?: number
  maximumSubscribers?: number
  minimumViewsPerDay?: number
  minimumOutlierRatio?: number
  resultLimit: number
  searchQueryBudget: SearchBudget
  includeUnverifiedChannels: boolean
  semanticClustering: boolean
  transcriptAnalysis: boolean
}

// V2: API key test response
export interface ApiKeyTestResult {
  valid: boolean
  status: ApiKeyStatus
  error?: string
}

// ── Thumbnail Prompt Studio types (V2 Part B) ─────────────────────────────────

export interface ThumbnailOverlayText {
  line_1: string
  line_2?: string
  combined_text: string
  total_words: number
  capitalization: string
  text_color: string
  outline_color: string
  placement: string
  typography: string
}

export interface ThumbnailPromptVariant {
  id: string
  option_label: 'A' | 'B' | 'C' | 'D' | 'E'
  concept_name: string
  strategic_angle: string
  title_interpretation: string
  overlay_text: ThumbnailOverlayText
  visual_concept: string
  subject_direction: string
  composition_direction: string
  background_direction: string
  color_direction: string
  lighting_direction: string
  mobile_readability_direction: string
  title_thumbnail_relationship: string
  full_image_prompt: string
  negative_prompt: string
  competitor_traits_used: string[]
  evidence: string[]
  originality_changes: string[]
  why_it_works: string
  warnings: string[]
}

export interface ThumbnailPromptAnalysisSummary {
  title_subject: string
  title_promise: string
  viewer_tension: string
  recommended_hook: string
  competitor_style_summary: string
  overlay_style_summary: string
}

export interface ThumbnailPromptGenerationRequest {
  title: string
  video_context?: string
  channel_title: string
  market?: string
  blueprint: ThumbnailBlueprint
  thumbnail_intelligence: ThumbnailIntelligenceResult
}

export interface ThumbnailPromptGenerationResponse {
  title: string
  channel_title: string
  provider: string
  model: string
  used_ai: boolean
  fallback_used: boolean
  fallback_reason?: string
  analysis_summary: ThumbnailPromptAnalysisSummary
  variants: ThumbnailPromptVariant[]
  generated_at: string
}
