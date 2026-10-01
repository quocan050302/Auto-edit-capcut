from typing import List, Optional, Dict, Any
from datetime import datetime, timezone
import json
from sqlalchemy.orm import Session
from sqlalchemy import desc
from models.entities import (
    ResearchProject,
    ResearchRun,
    Video,
    Channel,
    VideoSnapshot,
    Keyword,
    KeywordRun,
    KeywordScore,
    KeywordVideoMatch,
    TopicCluster,
    AiReport,
    ProviderHealth,
    SearchCache,
    utcnow_str
)

class ResearchRepository:
    def __init__(self, db: Session):
        self.db = db

    # ─── Runs ─────────────────────────────────────────────────────────
    def create_run(self, run: ResearchRun) -> ResearchRun:
        self.db.add(run)
        self.db.commit()
        self.db.refresh(run)
        return run

    def get_run(self, run_id: str) -> Optional[ResearchRun]:
        return self.db.query(ResearchRun).filter(ResearchRun.id == run_id).first()

    def update_run_stage(
        self,
        run_id: str,
        stage: str,
        progress_percent: int,
        message: str,
        videos_collected: Optional[int] = None,
        channels_analyzed: Optional[int] = None,
        keywords_expanded: Optional[int] = None,
        error: Optional[str] = None
    ) -> Optional[ResearchRun]:
        run = self.get_run(run_id)
        if not run:
            return None
        run.stage = stage
        run.progress_percent = progress_percent
        run.message = message
        run.updated_at = utcnow_str()
        if videos_collected is not None:
            run.videos_collected = videos_collected
        if channels_analyzed is not None:
            run.channels_analyzed = channels_analyzed
        if keywords_expanded is not None:
            run.keywords_expanded = keywords_expanded
        if error:
            run.error = error
        if stage in ("COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"):
            run.status = stage
            run.completed_at = utcnow_str()
        else:
            run.status = "RUNNING"
        self.db.commit()
        self.db.refresh(run)
        return run

    def mark_interrupted_runs(self) -> int:
        running = self.db.query(ResearchRun).filter(ResearchRun.status.in_(["QUEUED", "RUNNING"])).all()
        for r in running:
            r.status = "INTERRUPTED"
            r.stage = "INTERRUPTED"
            r.message = "Run was interrupted by application shutdown"
            r.updated_at = utcnow_str()
        self.db.commit()
        return len(running)

    def get_latest_run(self, topic: Optional[str] = None, market: Optional[str] = None) -> Optional[ResearchRun]:
        q = self.db.query(ResearchRun).filter(ResearchRun.status == "COMPLETED")
        if topic:
            q = q.filter(ResearchRun.topic.ilike(f"%{topic}%"))
        if market:
            q = q.filter(ResearchRun.market == market)
        return q.order_by(desc(ResearchRun.created_at)).first()

    # ─── Videos & Snapshots ───────────────────────────────────────────
    def upsert_video(self, v_data: Dict[str, Any]) -> Video:
        existing = self.db.query(Video).filter(Video.video_id == v_data["video_id"]).first()
        if existing:
            for k, val in v_data.items():
                if val is not None and hasattr(existing, k):
                    setattr(existing, k, val)
            existing.last_updated_at = utcnow_str()
            self.db.commit()
            self.db.refresh(existing)
            return existing
        else:
            video = Video(**v_data)
            self.db.add(video)
            self.db.commit()
            self.db.refresh(video)
            return video

    def add_snapshot_if_eligible(self, video_id: str, views: int, likes: Optional[int], comments: Optional[int], min_interval_hours: int = 6) -> Optional[VideoSnapshot]:
        last_snap = (
            self.db.query(VideoSnapshot)
            .filter(VideoSnapshot.video_id == video_id)
            .order_by(desc(VideoSnapshot.captured_at))
            .first()
        )
        if last_snap:
            try:
                last_time = datetime.fromisoformat(last_snap.captured_at)
                now = datetime.now(timezone.utc)
                diff_hours = (now - last_time).total_seconds() / 3600.0
                if diff_hours < min_interval_hours:
                    return None
            except Exception:
                pass

        snap = VideoSnapshot(
            video_id=video_id,
            captured_at=utcnow_str(),
            view_count=views,
            like_count=likes,
            comment_count=comments
        )
        self.db.add(snap)
        self.db.commit()
        return snap

    def get_video_snapshots(self, video_id: str) -> List[VideoSnapshot]:
        return (
            self.db.query(VideoSnapshot)
            .filter(VideoSnapshot.video_id == video_id)
            .order_by(VideoSnapshot.captured_at)
            .all()
        )

    # ─── Channels & Baselines ─────────────────────────────────────────
    def get_channel(self, channel_id: str) -> Optional[Channel]:
        return self.db.query(Channel).filter(Channel.channel_id == channel_id).first()

    def upsert_channel_baseline(
        self,
        channel_id: str,
        title: str,
        subscriber_count: Optional[int],
        median_views: float,
        mean_views: float,
        p75: float,
        p90: float,
        sample_size: int,
        country: Optional[str] = None
    ) -> Channel:
        channel = self.get_channel(channel_id)
        if channel:
            channel.title = title
            if subscriber_count is not None:
                channel.subscriber_count = subscriber_count
            if country:
                channel.country = country
            channel.median_recent_views = median_views
            channel.mean_recent_views = mean_views
            channel.p75_views = p75
            channel.p90_views = p90
            channel.baseline_sample_size = sample_size
            channel.last_baseline_computed_at = utcnow_str()
        else:
            channel = Channel(
                channel_id=channel_id,
                title=title,
                subscriber_count=subscriber_count,
                country=country,
                median_recent_views=median_views,
                mean_recent_views=mean_views,
                p75_views=p75,
                p90_views=p90,
                baseline_sample_size=sample_size,
                last_baseline_computed_at=utcnow_str()
            )
            self.db.add(channel)
        self.db.commit()
        self.db.refresh(channel)
        return channel

    # ─── Keywords & Scores ────────────────────────────────────────────
    def save_keyword_score(self, score: KeywordScore) -> KeywordScore:
        self.db.add(score)
        self.db.commit()
        return score

    def save_topic_cluster(self, cluster: TopicCluster) -> TopicCluster:
        self.db.add(cluster)
        self.db.commit()
        return cluster

    def save_ai_report(self, report: AiReport) -> AiReport:
        self.db.add(report)
        self.db.commit()
        return report

    # ─── Saved Projects ───────────────────────────────────────────────
    def list_saved_projects(self) -> List[ResearchProject]:
        return self.db.query(ResearchProject).order_by(desc(ResearchProject.updated_at)).all()

    def get_saved_project(self, project_id: str) -> Optional[ResearchProject]:
        return self.db.query(ResearchProject).filter(ResearchProject.id == project_id).first()

    def create_saved_project(self, project: ResearchProject) -> ResearchProject:
        self.db.add(project)
        self.db.commit()
        self.db.refresh(project)
        return project

    def delete_saved_project(self, project_id: str) -> bool:
        project = self.get_saved_project(project_id)
        if not project:
            return False
        self.db.delete(project)
        self.db.commit()
        return True

    # ─── Cache ────────────────────────────────────────────────────────
    def get_cache(self, key: str) -> Optional[str]:
        entry = self.db.query(SearchCache).filter(SearchCache.cache_key == key).first()
        if not entry:
            return None
        try:
            if datetime.fromisoformat(entry.expires_at) < datetime.now(timezone.utc):
                self.db.delete(entry)
                self.db.commit()
                return None
            return entry.data_json
        except Exception:
            return None

    def set_cache(self, key: str, data_json: str, ttl_seconds: int = 21600) -> None:
        expires_at = datetime.fromtimestamp(
            datetime.now(timezone.utc).timestamp() + ttl_seconds,
            tz=timezone.utc
        ).isoformat()
        
        entry = self.db.query(SearchCache).filter(SearchCache.cache_key == key).first()
        if entry:
            entry.data_json = data_json
            entry.expires_at = expires_at
        else:
            entry = SearchCache(cache_key=key, data_json=data_json, expires_at=expires_at)
            self.db.add(entry)
        self.db.commit()
