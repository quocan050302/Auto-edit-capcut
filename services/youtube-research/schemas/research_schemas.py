from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, ConfigDict

class ResearchFilters(BaseModel):
    min_views: Optional[int] = Field(default=None, ge=0)
    max_subscribers: Optional[int] = Field(default=None, ge=0)
    min_views_per_day: Optional[float] = Field(default=None, ge=0)
    min_outlier_ratio: Optional[float] = Field(default=None, ge=0)
    min_opportunity: Optional[float] = Field(default=None, ge=0, le=100)
    max_competition: Optional[float] = Field(default=None, ge=0, le=100)
    # V2 fields
    search_query_budget: Optional[int] = Field(default=6, ge=1, le=20)
    include_unverified_channels: Optional[bool] = Field(default=True)
    model_config = ConfigDict(extra="forbid")

class DiscoverRequest(BaseModel):
    topic: str
    market: str = "US"
    content_type: str = "LONG"
    time_range: str = "30d"
    limit: int = 50
    filters: ResearchFilters = Field(default_factory=ResearchFilters)

class DiscoverResponse(BaseModel):
    run_id: str
    status: str
    message: str

class KeywordExpandRequest(BaseModel):
    topic: str
    market: str = "US"

class KeywordExpandResponse(BaseModel):
    keywords: List[str]
    sources: Dict[str, List[str]]

class CompetitorRequest(BaseModel):
    channel_url: str
    market: str = "US"

class BreakoutVideoSchema(BaseModel):
    video_id: str
    url: str
    title: str
    channel_id: str
    channel_title: str
    published_at: str
    age_days: float
    views: int
    views_per_day: float
    observed_velocity: Optional[float] = None
    channel_subscribers: Optional[int] = None
    channel_median_views: Optional[float] = None
    outlier_ratio: float
    market_signal: str
    source_provider: str
    thumbnail_url: str
    is_small_channel_breakout: bool

# V2: Candidate video with subscriber status label
class CandidateVideoSchema(BaseModel):
    video_id: str
    url: str
    title: str
    channel_id: str
    channel_title: str
    published_at: str
    age_days: float
    views: int
    views_per_day: float
    channel_subscribers: Optional[int] = None
    outlier_ratio: Optional[float] = None
    subscriber_status: str = "VERIFIED_MATCH"  # VERIFIED_MATCH | UNVERIFIED_MATCH
    subscriber_label: str = ""
    filter_distance: float = 0.0
    source_provider: str = ""
    thumbnail_url: str = ""

class KeywordRecordSchema(BaseModel):
    keyword: str
    opportunity_score: float
    confidence_level: str
    confidence_score: float
    demand_score: float
    velocity_score: float
    outlier_score: float
    competition_score: float
    competition_level: str
    market_fit_score: float
    freshness_score: float
    freshness_state: str
    video_count: int
    channel_count: int
    median_views: float
    median_views_per_day: float
    best_outlier_ratio: float
    is_rising: bool
    is_low_competition: bool
    is_breakout: bool
    is_small_channel_win: bool
    has_market_signal: bool
    breakdown: Optional[Dict[str, str]] = None

class TopicClusterSchema(BaseModel):
    id: str
    label: str
    summary: str
    video_count: int
    unique_channels: int
    median_velocity: float
    top_titles: List[str]
    sample_keywords: List[str]

class TrendRadarSchema(BaseModel):
    topic: str
    count_24h: int
    count_7d: int
    count_30d: int
    median_velocity: float
    breakout_count: int
    unique_channels: int
    trend_state: str
    confidence_level: str

class VideoIdeaSchema(BaseModel):
    title: str
    angle: str
    target_format: str
    why_it_works: str

class AiReportSchema(BaseModel):
    summary: str
    why_it_is_rising: List[str]
    winning_angles: List[str]
    title_patterns: List[str]
    content_gaps: List[str]
    risks: List[str]
    video_ideas: List[VideoIdeaSchema]

class CompetitorResponse(BaseModel):
    channel_id: str
    channel_title: str
    channel_url: str
    country: Optional[str] = None
    subscriber_count: Optional[int] = None
    video_count: int
    recent_videos_analyzed: int
    median_recent_views: float
    mean_recent_views: float
    p75_views: float
    p90_views: float
    outlier_videos: List[BreakoutVideoSchema]
    best_repeated_topics: List[str]
    winning_title_patterns: List[str]
    upload_cadence_days: float
    topic_consistency: str
    # V2: Thumbnail Intelligence (optional — does not block baseline)
    thumbnail_intelligence: Optional[Dict[str, Any]] = None
    videos_for_thumbnail: Optional[List[Dict[str, Any]]] = None

# ── Thumbnail Intelligence Schemas (V2) ──────────────────────────────────────

class ThumbnailPatternSchema(BaseModel):
    pattern_id: str
    name: str
    description: str
    outlier_count: int = 0
    outlier_total: int = 0
    baseline_count: int = 0
    baseline_total: int = 0
    low_count: int = 0
    low_total: int = 0
    sample_size: int = 0
    confidence: str = "low"
    evidence_video_ids: List[str] = []
    is_winning: bool = False
    is_avoid: bool = False
    control_ratio: Optional[float] = None
    uplift: Optional[float] = None
    relative_lift: Optional[float] = None

class ThumbnailBlueprintSchema(BaseModel):
    id: str
    name: str
    use_when: str
    target_hook: str
    blueprint_mode: str = "validated_winning"
    is_statistically_validated: bool = False
    fallback_reason: str = ""
    source_group: str = "all"
    sample_summary: Dict[str, Any] = Field(default_factory=dict)
    limitations: List[str] = Field(default_factory=list)
    based_on_pattern_ids: List[str] = []
    layout_description: str = ""
    subject_recipe: str = ""
    background_recipe: str = ""
    text_recipe: str = ""
    color_recipe: str = ""
    lighting_recipe: str = ""
    hierarchy_recipe: str = ""
    title_pairing_recipe: str = ""
    overlay_text_formula: List[str] = []
    image_prompt_template: str = ""
    negative_prompt: str = ""
    evidence: List[str] = []
    confidence: str = "low"
    originality_rules: List[str] = []

class ThumbnailSampleVideoSchema(BaseModel):
    video_id: str
    title: str
    published_at: str
    age_days: float
    views: int
    views_per_day: float
    outlier_ratio: float
    performance_group: str
    thumbnail_url: str
    thumbnail_quality: str = "unknown"

class ThumbnailIntelligenceRequest(BaseModel):
    channel_id: str
    channel_title: str
    videos: List[Dict[str, Any]]
    channel_median_views: float
    p75_views: float
    max_videos: int = 30

class ThumbnailGenerationRequest(BaseModel):
    title: str
    script_summary: Optional[str] = None
    blueprint: ThumbnailBlueprintSchema

class ThumbnailGenerationResponse(BaseModel):
    image_base64: str
    prompt_used: str

# ── Thumbnail Prompt Studio Schemas (V2 Part B — Hook Intelligence) ────────────

class ThumbnailOverlayTextSchema(BaseModel):
    line_1: str
    line_1_color: str = "#FFE600"   # yellow by default
    line_2: Optional[str] = None
    line_2_color: str = "#FFFFFF"   # white by default
    combined_text: str
    total_words: int
    capitalization: str = "ALL_CAPS"
    outline_color: str = "#050505"
    placement: str = "upper_left"
    typography: str = "bold_condensed_sans"

class HookQualityScoreSchema(BaseModel):
    """Scores thumbnail hook quality. No CTR claims allowed."""
    curiosity_gap: int = 0           # /20
    one_second_clarity: int = 0      # /15
    title_complementarity: int = 0   # /15
    visual_tension: int = 0          # /15
    specificity_and_proof: int = 0   # /10
    mobile_readability: int = 0      # /10
    promise_integrity: int = 0       # /10
    competitor_fit: int = 0          # /5
    penalties: int = 0               # negative
    total_score: int = 0             # clamped 0-100
    rejection_reasons: List[str] = []

class ThumbnailPromptVariantSchema(BaseModel):
    id: str
    option_label: str  # A B C D E
    concept_name: str
    hook_family: str   # from HOOK_FAMILIES
    visual_question: str
    hidden_information: str
    test_hypothesis: str
    strategic_angle: str
    title_interpretation: str
    overlay_text: ThumbnailOverlayTextSchema
    visual_concept: str
    subject_direction: str
    composition_direction: str
    background_direction: str
    color_direction: str
    lighting_direction: str
    mobile_readability_direction: str
    title_thumbnail_relationship: str
    full_image_prompt: str
    negative_prompt: str
    competitor_traits_used: List[str] = []
    evidence: List[str] = []
    originality_changes: List[str] = []
    why_it_works: str
    hook_quality: HookQualityScoreSchema = Field(default_factory=HookQualityScoreSchema)
    recommended_test_rank: int = 0   # 1=top, 5=lowest
    recommended_for_ab_test: bool = False
    warnings: List[str] = []

class ThumbnailPromptAnalysisSummarySchema(BaseModel):
    title_subject: str
    title_promise: str
    viewer_tension: str
    viewer_expectation: str = ""
    hidden_variable: str = ""
    strongest_proof_object: str = ""
    visual_contradiction: str = ""
    recommended_hook: str
    hook_source: str = "ai_analysis"  # ai_analysis | deterministic_semantic | safe_fallback
    competitor_style_summary: str
    overlay_style_summary: str

class ThumbnailPromptGenerationRequest(BaseModel):
    title: str = Field(..., min_length=3, max_length=200)
    video_context: Optional[str] = Field(default=None, max_length=2000)
    channel_title: str
    market: str = "US"
    blueprint: ThumbnailBlueprintSchema
    thumbnail_intelligence: Dict[str, Any]

class ThumbnailPromptGenerationResponse(BaseModel):
    title: str
    channel_title: str
    provider: str
    model: str
    used_ai: bool
    fallback_used: bool
    fallback_reason: Optional[str] = None
    analysis_summary: ThumbnailPromptAnalysisSummarySchema
    variants: List[ThumbnailPromptVariantSchema]
    generated_at: str



class TopOpportunitySchema(BaseModel):
    keyword: str
    opportunity_score: float
    confidence_level: str
    market_fit_score: float
    competition_score: float
    trend_state: str
    summary: str

class OverviewMetricsSchema(BaseModel):
    videos_analyzed: int
    unique_channels: int
    keywords_found: int
    breakouts_found: int
    small_channel_wins: int
    data_confidence: str

class DataSourceSchema(BaseModel):
    metric: str
    source: str
    note: Optional[str] = None

class FilterSummarySchema(BaseModel):
    applied_filters: Dict[str, Any] = {}
    raw_videos_collected: int = 0
    videos_after_metadata_filters: int = 0
    videos_after_all_filters: int = 0
    keywords_before_filters: int = 0
    keywords_after_filters: int = 0
    excluded_by_reason: Dict[str, int] = {}
    # V2 detailed funnel
    funnel: Optional[Dict[str, int]] = None

# V2: Filter funnel for UI display
class FilterFunnelSchema(BaseModel):
    raw_collected: int = 0
    unique_after_dedupe: int = 0
    above_min_views: int = 0
    above_min_vpd: int = 0
    above_min_outlier: int = 0
    subscriber_known: int = 0
    subscriber_unknown: int = 0
    below_max_subscribers: int = 0
    exact_matches: int = 0
    unverified_matches: int = 0
    near_matches: int = 0
    excluded_by_reason: Dict[str, int] = {}

# V2: Near match suggestion
class NearMatchSuggestionSchema(BaseModel):
    field: str
    current_value: Any
    suggested_value: Any
    would_add_candidates: int
    description: str

# V2: Search diagnostics
class TimeBucketDiagSchema(BaseModel):
    bucket_index: int = 0
    label: str = ""
    start_utc: Optional[str] = None
    end_utc: Optional[str] = None
    raw_results: int = 0
    valid_results: int = 0
    provider_calls: int = 0
    out_of_window_dropped: int = 0

class SearchDiagnosticsSchema(BaseModel):
    queries_generated: int = 0
    queries_searched: int = 0
    pages_fetched: int = 0
    raw_results: int = 0
    unique_videos: int = 0
    duplicate_rate: float = 0.0
    channels_discovered: int = 0
    channels_enriched: int = 0
    subscriber_known_pct: float = 0.0
    baseline_coverage_pct: float = 0.0
    official_api_calls: int = 0
    fallback_calls: int = 0
    cache_hits: int = 0
    search_stop_reason: str = ""
    search_budget_used: int = 0
    search_budget_total: int = 0
    # V2.1 time window fields
    time_range_key: str = ""
    time_range_label: str = ""
    resolved_start_utc: Optional[str] = None
    resolved_end_utc: Optional[str] = None
    bucket_count: int = 0
    buckets_covered: int = 0
    out_of_window_dropped: int = 0
    time_buckets: List[TimeBucketDiagSchema] = []

class ResearchRunResultSchema(BaseModel):
    run_id: str
    project_id: Optional[str] = None
    topic: str
    market: str
    language: str
    content_type: str
    time_range: str
    created_at: str
    completed_at: Optional[str] = None
    provider_source: str
    provider_notes: Optional[str] = None
    top_opportunity: Optional[TopOpportunitySchema] = None
    overview_metrics: OverviewMetricsSchema
    keywords: List[KeywordRecordSchema]
    breakout_videos: List[BreakoutVideoSchema]
    trend_radar: List[TrendRadarSchema]
    topic_clusters: List[TopicClusterSchema]
    ai_insights: Optional[AiReportSchema] = None
    data_sources: List[DataSourceSchema]
    filter_summary: Optional[FilterSummarySchema] = None
    # V2 optional — old runs without these still deserialize fine
    exact_matches: Optional[List[CandidateVideoSchema]] = None
    unverified_matches: Optional[List[CandidateVideoSchema]] = None
    near_matches: Optional[List[CandidateVideoSchema]] = None
    near_match_suggestions: Optional[List[NearMatchSuggestionSchema]] = None
    filter_funnel: Optional[FilterFunnelSchema] = None
    search_diagnostics: Optional[SearchDiagnosticsSchema] = None

class ProgressStateSchema(BaseModel):
    run_id: str
    stage: str
    progress_percent: int
    message: str
    videos_collected: int
    channels_analyzed: int
    keywords_expanded: int
    elapsed_seconds: int
    can_cancel: bool
    error: Optional[str] = None

class SavedProjectCreate(BaseModel):
    name: str
    run_id: str
    seed_topic: str
    market: str
    content_type: str
    time_range: str

class SavedProjectUpdate(BaseModel):
    name: str

class SavedProjectSchema(BaseModel):
    id: str
    name: str
    seed_topic: str
    market: str
    language: str
    content_type: str
    time_range: str
    created_at: str
    updated_at: str
    last_run_id: Optional[str] = None
    scoring_version: str
    provider_source: str
    summary_snippet: Optional[str] = None
    top_opportunity_keyword: Optional[str] = None
    top_opportunity_score: Optional[float] = None
    video_count: int

class SettingsUpdateSchema(BaseModel):
    use_official_api: Optional[bool] = None
    official_api_key: Optional[str] = None
    scraper_fallback: Optional[bool] = None
    provider_priority: Optional[str] = None
    default_market: Optional[str] = None
    default_language: Optional[str] = None
    default_date_range: Optional[str] = None
    default_content_type: Optional[str] = None
    default_result_size: Optional[int] = None
    ai_provider: Optional[str] = None
    ollama_base_url: Optional[str] = None
    ollama_model: Optional[str] = None
    cloud_ai_key: Optional[str] = None
    max_expanded_keywords: Optional[int] = None
    raw_video_limit: Optional[int] = None
    max_enrichment_videos: Optional[int] = None
    channel_baseline_size: Optional[int] = None
    debug_mode: Optional[bool] = None
    scoring_weights: Optional[Dict[str, float]] = None

class SettingsResponseSchema(BaseModel):
    use_official_api: bool
    has_official_api_key: bool
    scraper_fallback: bool
    provider_priority: str
    default_market: str
    default_language: str
    default_date_range: str
    default_content_type: str
    default_result_size: int
    ai_provider: str
    ollama_base_url: str
    ollama_model: str
    has_cloud_ai_key: bool
    max_expanded_keywords: int
    raw_video_limit: int
    max_enrichment_videos: int
    channel_baseline_size: int
    debug_mode: bool
    scoring_weights: Dict[str, float]
