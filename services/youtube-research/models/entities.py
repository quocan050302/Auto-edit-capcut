from datetime import datetime, timezone
import json
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Text, ForeignKey, Index
from sqlalchemy.orm import relationship
from db.engine import Base

def utcnow_str() -> str:
    return datetime.now(timezone.utc).isoformat()

class ResearchProject(Base):
    __tablename__ = "research_projects"

    id = Column(String(64), primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    seed_topic = Column(String(255), nullable=False)
    market = Column(String(10), default="US")
    language = Column(String(10), default="en")
    content_type = Column(String(20), default="LONG")
    time_range = Column(String(20), default="30d")
    created_at = Column(String(50), default=utcnow_str)
    updated_at = Column(String(50), default=utcnow_str, onupdate=utcnow_str)
    last_run_id = Column(String(64), nullable=True)
    scoring_version = Column(String(20), default="1.0.0")
    provider_source = Column(String(50), default="SCRAPER")
    summary_snippet = Column(Text, nullable=True)
    top_opportunity_keyword = Column(String(255), nullable=True)
    top_opportunity_score = Column(Float, nullable=True)
    video_count = Column(Integer, default=0)

class ResearchRun(Base):
    __tablename__ = "research_runs"

    id = Column(String(64), primary_key=True, index=True)
    project_id = Column(String(64), ForeignKey("research_projects.id"), nullable=True)
    topic = Column(String(255), nullable=False, index=True)
    market = Column(String(10), default="US")
    language = Column(String(10), default="en")
    content_type = Column(String(20), default="LONG")
    time_range = Column(String(20), default="30d")
    status = Column(String(30), default="QUEUED", index=True)
    stage = Column(String(50), default="QUEUED")
    progress_percent = Column(Integer, default=0)
    message = Column(String(255), default="Initializing")
    videos_collected = Column(Integer, default=0)
    channels_analyzed = Column(Integer, default=0)
    keywords_expanded = Column(Integer, default=0)
    created_at = Column(String(50), default=utcnow_str)
    updated_at = Column(String(50), default=utcnow_str, onupdate=utcnow_str)
    completed_at = Column(String(50), nullable=True)
    error = Column(Text, nullable=True)
    provider_source = Column(String(50), default="SCRAPER")
    raw_results_json = Column(Text, nullable=True)

class Video(Base):
    __tablename__ = "videos"

    video_id = Column(String(64), primary_key=True, index=True)
    url = Column(String(255), nullable=False)
    title = Column(String(500), nullable=False)
    description = Column(Text, nullable=True)
    channel_id = Column(String(128), nullable=False, index=True)
    channel_title = Column(String(255), nullable=False)
    published_at = Column(String(50), nullable=False)
    duration_seconds = Column(Integer, default=0)
    views = Column(Integer, default=0)
    likes = Column(Integer, nullable=True)
    comments = Column(Integer, nullable=True)
    thumbnail_url = Column(String(500), nullable=False)
    channel_subscribers = Column(Integer, nullable=True)
    channel_total_views = Column(Integer, nullable=True)
    channel_video_count = Column(Integer, nullable=True)
    channel_country = Column(String(10), nullable=True)
    market = Column(String(10), default="US")
    language = Column(String(10), default="en")
    content_type = Column(String(20), default="LONG")
    source_provider = Column(String(50), default="SCRAPER")
    collected_at = Column(String(50), default=utcnow_str)
    last_updated_at = Column(String(50), default=utcnow_str)

class Channel(Base):
    __tablename__ = "channels"

    channel_id = Column(String(128), primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    custom_url = Column(String(255), nullable=True)
    country = Column(String(10), nullable=True)
    subscriber_count = Column(Integer, nullable=True)
    video_count = Column(Integer, nullable=True)
    median_recent_views = Column(Float, default=0.0)
    mean_recent_views = Column(Float, default=0.0)
    p75_views = Column(Float, default=0.0)
    p90_views = Column(Float, default=0.0)
    baseline_sample_size = Column(Integer, default=0)
    upload_cadence_days = Column(Float, default=7.0)
    last_baseline_computed_at = Column(String(50), nullable=True)

class VideoSnapshot(Base):
    __tablename__ = "video_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(String(64), ForeignKey("videos.video_id"), index=True, nullable=False)
    captured_at = Column(String(50), default=utcnow_str, index=True)
    view_count = Column(Integer, nullable=False)
    like_count = Column(Integer, nullable=True)
    comment_count = Column(Integer, nullable=True)

    __table_args__ = (
        Index("idx_video_captured", "video_id", "captured_at"),
    )

class Keyword(Base):
    __tablename__ = "keywords"

    id = Column(Integer, primary_key=True, autoincrement=True)
    keyword = Column(String(255), nullable=False, unique=True, index=True)
    seed_topic = Column(String(255), nullable=False)
    market = Column(String(10), default="US")
    language = Column(String(10), default="en")
    created_at = Column(String(50), default=utcnow_str)

class KeywordRun(Base):
    __tablename__ = "keyword_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(64), ForeignKey("research_runs.id"), index=True, nullable=False)
    keyword = Column(String(255), nullable=False, index=True)
    video_count = Column(Integer, default=0)
    channel_count = Column(Integer, default=0)
    median_views = Column(Float, default=0.0)
    median_views_per_day = Column(Float, default=0.0)
    best_outlier_ratio = Column(Float, default=1.0)
    is_rising = Column(Boolean, default=False)
    is_low_competition = Column(Boolean, default=False)
    is_breakout = Column(Boolean, default=False)
    is_small_channel_win = Column(Boolean, default=False)

class KeywordScore(Base):
    __tablename__ = "keyword_scores"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(64), ForeignKey("research_runs.id"), index=True, nullable=False)
    keyword = Column(String(255), nullable=False, index=True)
    opportunity_score = Column(Float, default=0.0)
    confidence_level = Column(String(20), default="LOW")
    confidence_score = Column(Float, default=0.0)
    demand_score = Column(Float, default=0.0)
    velocity_score = Column(Float, default=0.0)
    outlier_score = Column(Float, default=0.0)
    competition_score = Column(Float, default=0.0)
    competition_level = Column(String(20), default="MEDIUM")
    market_fit_score = Column(Float, default=0.0)
    freshness_score = Column(Float, default=0.0)
    freshness_state = Column(String(20), default="Stable")
    scoring_version = Column(String(20), default="1.0.0")
    breakdown_json = Column(Text, nullable=True)

class KeywordVideoMatch(Base):
    __tablename__ = "keyword_video_matches"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(64), ForeignKey("research_runs.id"), index=True, nullable=False)
    keyword = Column(String(255), nullable=False, index=True)
    video_id = Column(String(64), ForeignKey("videos.video_id"), index=True, nullable=False)
    relevance_rank = Column(Integer, default=0)

class TopicCluster(Base):
    __tablename__ = "topic_clusters"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(64), ForeignKey("research_runs.id"), index=True, nullable=False)
    label = Column(String(255), nullable=False)
    summary = Column(Text, nullable=True)
    video_count = Column(Integer, default=0)
    unique_channels = Column(Integer, default=0)
    median_velocity = Column(Float, default=0.0)
    top_titles_json = Column(Text, nullable=True)
    keywords_json = Column(Text, nullable=True)

class AiReport(Base):
    __tablename__ = "ai_reports"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(64), ForeignKey("research_runs.id"), unique=True, index=True, nullable=False)
    summary = Column(Text, nullable=False)
    why_rising_json = Column(Text, nullable=True)
    winning_angles_json = Column(Text, nullable=True)
    title_patterns_json = Column(Text, nullable=True)
    content_gaps_json = Column(Text, nullable=True)
    risks_json = Column(Text, nullable=True)
    video_ideas_json = Column(Text, nullable=True)
    provider = Column(String(50), default="disabled")
    created_at = Column(String(50), default=utcnow_str)

class ProviderHealth(Base):
    __tablename__ = "provider_health"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_name = Column(String(50), unique=True, index=True, nullable=False)
    status = Column(String(20), default="OK") # OK, DEGRADED, OFFLINE
    error_count = Column(Integer, default=0)
    last_checked_at = Column(String(50), default=utcnow_str)
    last_error_message = Column(Text, nullable=True)
    quota_remaining = Column(Integer, nullable=True)

class SearchCache(Base):
    __tablename__ = "search_cache"

    cache_key = Column(String(255), primary_key=True, index=True)
    data_json = Column(Text, nullable=False)
    expires_at = Column(String(50), nullable=False)
    created_at = Column(String(50), default=utcnow_str)


# ─── Similar Channel Discovery Tables ────────────────────────────────────────

class SimilarChannelRun(Base):
    """Persists a similar-channel discovery run so it survives app restarts."""
    __tablename__ = "similar_channel_runs"

    run_id           = Column(String(64),  primary_key=True, index=True)
    source_channel_id    = Column(String(128), nullable=False, index=True)
    source_channel_title = Column(String(255), nullable=False)
    market           = Column(String(10),  default="US")
    language         = Column(String(10),  default="en")
    content_type     = Column(String(20),  default="LONG")
    window_days      = Column(Integer,     default=90)
    min_views        = Column(Integer,     default=10_000)
    max_subscribers  = Column(Integer,     default=50_000)
    min_evaluable_videos = Column(Integer, default=3)

    status           = Column(String(30),  default="QUEUED", index=True)  # QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED/INTERRUPTED
    stage            = Column(String(50),  default="STARTING")
    progress_percent = Column(Integer,     default=0)
    message          = Column(String(500), default="")
    error            = Column(Text,        nullable=True)

    candidate_videos_found   = Column(Integer, default=0)
    candidate_channels_found = Column(Integer, default=0)
    channels_enriched        = Column(Integer, default=0)
    qualified_count          = Column(Integer, default=0)
    growing_count            = Column(Integer, default=0)
    watchlist_count          = Column(Integer, default=0)
    rejected_count           = Column(Integer, default=0)

    most_promising_channel_id = Column(String(128), nullable=True)
    most_promising_status     = Column(String(30),  nullable=True)
    most_promising_reason_json = Column(Text,       nullable=True)  # JSON list

    niche_fingerprint_json = Column(Text, nullable=True)   # JSON
    limitations_json       = Column(Text, nullable=True)   # JSON list
    provider_summary_json  = Column(Text, nullable=True)   # JSON dict

    created_at   = Column(String(50), default=utcnow_str, index=True)
    updated_at   = Column(String(50), default=utcnow_str, onupdate=utcnow_str)
    completed_at = Column(String(50), nullable=True)

    __table_args__ = (
        Index("idx_similar_run_source", "source_channel_id"),
        Index("idx_similar_run_status", "status"),
    )


class SimilarChannelCandidate(Base):
    """One candidate channel found in a similar-channel run."""
    __tablename__ = "similar_channel_candidates"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    run_id       = Column(String(64), ForeignKey("similar_channel_runs.run_id"), nullable=False, index=True)
    rank         = Column(Integer, default=0)
    channel_id   = Column(String(128), nullable=False)
    channel_title = Column(String(255), nullable=False)
    channel_url  = Column(String(500), nullable=False)
    country      = Column(String(10), nullable=True)
    subscriber_count = Column(Integer, nullable=True)
    subscriber_status = Column(String(30), default="HIDDEN_UNVERIFIED")
    public_video_count = Column(Integer, nullable=True)

    status = Column(String(20), default="WATCHLIST", index=True)  # QUALIFIED/GROWING/WATCHLIST/REJECTED
    is_most_promising = Column(Boolean, default=False)
    most_promising_label = Column(String(50), nullable=True)

    # Window
    window_start = Column(String(50), nullable=False)
    window_end   = Column(String(50), nullable=False)

    # Video counts
    recent_video_count  = Column(Integer, default=0)
    evaluable_video_count = Column(Integer, default=0)
    pending_video_count = Column(Integer, default=0)
    passed_views_count  = Column(Integer, default=0)
    passed_growth_confirmed_count  = Column(Integer, default=0)
    passed_growth_provisional_count = Column(Integer, default=0)
    failed_video_count  = Column(Integer, default=0)

    strict_success_ratio      = Column(Float, default=0.0)
    provisional_success_ratio = Column(Float, default=0.0)

    # View stats
    minimum_recent_views = Column(Integer, nullable=True)
    median_recent_views  = Column(Float, nullable=True)
    mean_recent_views    = Column(Float, nullable=True)
    p25_recent_views     = Column(Float, nullable=True)
    p75_recent_views     = Column(Float, nullable=True)
    maximum_recent_views = Column(Integer, nullable=True)
    total_recent_views   = Column(Integer, default=0)
    single_hit_dependency = Column(Float, default=0.0)

    # Niche match
    niche_match_reason  = Column(Text, nullable=True)
    matched_topics_json = Column(Text, nullable=True)    # JSON list
    matched_video_ids_json = Column(Text, nullable=True) # JSON list

    # Durability
    active_months_last_12       = Column(Integer, default=0)
    median_upload_cadence_days  = Column(Float, nullable=True)
    maximum_upload_gap_days     = Column(Float, nullable=True)
    evergreen_ratio             = Column(Float, nullable=True)
    topic_cluster_count         = Column(Integer, default=0)
    future_title_angle_count    = Column(Integer, default=0)

    # Monetization
    monetization_viability      = Column(String(20), default="UNKNOWN")
    monetization_evidence_json  = Column(Text, nullable=True)  # JSON list
    policy_risk_flags_json      = Column(Text, nullable=True)  # JSON list

    # Confidence
    data_confidence             = Column(String(20), default="INSUFFICIENT")
    confidence_limitations_json = Column(Text, nullable=True)  # JSON list

    # Reasons
    qualification_reasons_json  = Column(Text, nullable=True)  # JSON list
    rejection_reasons_json      = Column(Text, nullable=True)  # JSON list

    # Scores
    niche_match_score            = Column(Float, default=0.0)
    recent_consistency_score     = Column(Float, default=0.0)
    growth_quality_score         = Column(Float, default=0.0)
    durability_score             = Column(Float, default=0.0)
    monetization_viability_score = Column(Float, default=0.0)
    data_confidence_score        = Column(Float, default=0.0)
    final_score                  = Column(Float, default=0.0)

    created_at = Column(String(50), default=utcnow_str)

    __table_args__ = (
        Index("idx_scand_run_rank", "run_id", "rank"),
        Index("idx_scand_run_channel", "run_id", "channel_id", unique=True),
        Index("idx_scand_status", "status"),
        Index("idx_scand_score", "final_score"),
    )


class SimilarChannelVideo(Base):
    """Video evidence for a similar-channel candidate."""
    __tablename__ = "similar_channel_videos"

    id            = Column(Integer, primary_key=True, autoincrement=True)
    run_id        = Column(String(64), ForeignKey("similar_channel_runs.run_id"), nullable=False, index=True)
    channel_id    = Column(String(128), nullable=False, index=True)

    video_id      = Column(String(64), nullable=False)
    video_url     = Column(String(500), nullable=False)
    title         = Column(String(500), nullable=False)
    published_at  = Column(String(50), nullable=False)
    age_days      = Column(Float, default=0.0)
    duration_seconds = Column(Integer, nullable=True)

    views    = Column(Integer, default=0)
    likes    = Column(Integer, nullable=True)
    comments = Column(Integer, nullable=True)

    lifetime_views_per_day  = Column(Float, default=0.0)
    observed_views_per_day  = Column(Float, nullable=True)
    projected_day_90_views  = Column(Float, nullable=True)

    growth_status      = Column(String(30), default="UNKNOWN")   # PASS_VIEWS/PASS_GROWTH_CONFIRMED/...
    evaluation_status  = Column(String(30), default="PENDING")   # PASS_VIEWS/FAIL/PENDING_TOO_NEW/EXCLUDED
    evaluation_reason  = Column(Text, nullable=True)
    niche_similarity   = Column(Float, default=0.0)
    snapshot_count     = Column(Integer, default=0)

    created_at = Column(String(50), default=utcnow_str)

    __table_args__ = (
        Index("idx_scvid_run_channel", "run_id", "channel_id"),
        Index("idx_scvid_run_video", "run_id", "video_id"),
    )

