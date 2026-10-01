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
export type TimeRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all' | 'custom'
export type ProviderSource = 'OFFICIAL' | 'SCRAPER' | 'MIXED'
export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH'
export type CompetitionLevel = 'LOW' | 'MEDIUM' | 'HIGH'
export type TrendState = 'Emerging' | 'Rising' | 'Stable' | 'Cooling'

export type ResearchStage =
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

export interface ResearchProgressState {
  run_id: string
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
