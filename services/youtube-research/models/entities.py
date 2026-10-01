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
