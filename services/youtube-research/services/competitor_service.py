import re
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from providers.fallback import ProviderFallbackManager
from scoring.calculator import (
    compute_channel_baseline,
    compute_outlier_ratio,
    calculate_lifetime_velocity,
    is_small_channel_breakout
)
from utils.parsers import calculate_age_days
from schemas.research_schemas import CompetitorResponse, BreakoutVideoSchema
from core.logger import research_logger

def extract_channel_identifier(url_or_handle: str) -> str:
    clean = url_or_handle.strip()
    if clean.startswith("@"):
        return clean
    if "youtube.com/@" in clean:
        match = re.search(r"youtube\.com/(@[\w\-\.]+)", clean)
        if match:
            return match.group(1)
    if "youtube.com/channel/" in clean:
        match = re.search(r"youtube\.com/channel/([A-Za-z0-9_\-]+)", clean)
        if match:
            return match.group(1)
    return clean

class CompetitorService:
    def __init__(self, provider_mgr: ProviderFallbackManager):
        self.provider_mgr = provider_mgr

    async def analyze_channel(self, channel_input: str, market: str = "US") -> CompetitorResponse:
        channel_id = extract_channel_identifier(channel_input)
        research_logger.info(f"[Competitor] Analyzing channel: {channel_id} (market={market})")

        channel_data = await self.provider_mgr.get_channel_baseline(
            channel_id=channel_id,
            content_type="LONG",
            max_videos=25
        )

        videos = channel_data.recent_videos
        views_list = [v.views for v in videos]
        median_views, mean_views, p75, p90 = compute_channel_baseline(views_list)

        # Calculate outlier videos (> 2.0x channel median)
        outlier_items: List[BreakoutVideoSchema] = []
        for v in videos:
            age_days = calculate_age_days(v.published_at)
            ratio = compute_outlier_ratio(v.views, median_views)
            vpd = calculate_lifetime_velocity(v.views, v.published_at)
            is_breakout = is_small_channel_breakout(
                views=v.views,
                outlier_ratio=ratio,
                channel_subscribers=channel_data.subscriber_count,
                published_at=v.published_at,
                channel_median_views=median_views
            )

            if ratio >= 2.0 or v.views >= p75:
                outlier_items.append(
                    BreakoutVideoSchema(
                        video_id=v.video_id,
                        url=v.url,
                        title=v.title,
                        channel_id=v.channel_id,
                        channel_title=channel_data.title,
                        published_at=v.published_at,
                        age_days=round(age_days, 1),
                        views=v.views,
                        views_per_day=round(vpd, 1),
                        channel_subscribers=channel_data.subscriber_count,
                        channel_median_views=round(median_views, 1),
                        outlier_ratio=ratio,
                        market_signal=f"Channel Market: {channel_data.country or market}",
                        source_provider=channel_data.provider,
                        thumbnail_url=v.thumbnail_url,
                        is_small_channel_breakout=is_breakout
                    )
                )

        # Cadence calculation
        cadence_days = 7.0
        if len(videos) >= 3:
            try:
                dates = sorted(
                    [datetime.fromisoformat(v.published_at.replace("Z", "+00:00")) for v in videos],
                    reverse=True
                )
                intervals = [(dates[i] - dates[i+1]).total_seconds() / 86400.0 for i in range(len(dates)-1)]
                valid_intervals = [i for i in intervals if i > 0]
                if valid_intervals:
                    cadence_days = round(sum(valid_intervals) / len(valid_intervals), 1)
            except Exception:
                pass

        # Title patterns & repeat topics
        title_patterns = []
        repeat_topics = []
        words_count: Dict[str, int] = {}
        for v in videos:
            for w in v.title.lower().split():
                clean_w = re.sub(r"[^\w]", "", w)
                if len(clean_w) > 3:
                    words_count[clean_w] = words_count.get(clean_w, 0) + 1

        common_words = [w for w, c in words_count.items() if c >= 3]
        if common_words:
            repeat_topics = [w.title() for w in common_words[:5]]

        for v in outlier_items[:5]:
            if "why" in v.title.lower():
                title_patterns.append("Why [Subject] [Consequence]")
            elif "how" in v.title.lower():
                title_patterns.append("How [Subject] [Action]")
            elif "truth" in v.title.lower() or "secret" in v.title.lower():
                title_patterns.append("The Hidden Truth About [Subject]")
            else:
                title_patterns.append(f"Angle: {v.title[:45]}...")

        # Deduplicate patterns
        title_patterns = list(dict.fromkeys(title_patterns))[:4]
        if not title_patterns:
            title_patterns = ["Direct Statement / Question Hook", "Comparison / Contrast Analysis"]

        consistency = "High" if len(repeat_topics) >= 3 else ("Moderate" if len(repeat_topics) >= 1 else "Broad")

        # Build raw video list for thumbnail intelligence
        videos_for_thumbnail = []
        for v in videos:
            age_days = calculate_age_days(v.published_at)
            vpd = calculate_lifetime_velocity(v.views, v.published_at)
            ratio = compute_outlier_ratio(v.views, median_views)
            videos_for_thumbnail.append({
                "video_id": v.video_id,
                "title": v.title,
                "published_at": v.published_at,
                "age_days": round(age_days, 1),
                "views": v.views,
                "views_per_day": round(vpd, 1),
                "outlier_ratio": ratio,
                "thumbnail_url": v.thumbnail_url or "",
                "thumbnail_quality": getattr(v, 'thumbnail_quality', 'unknown'),
            })

        return CompetitorResponse(
            channel_id=channel_id,
            channel_title=channel_data.title,
            channel_url=f"https://www.youtube.com/{channel_id}",
            country=channel_data.country,
            subscriber_count=channel_data.subscriber_count,
            video_count=channel_data.video_count or len(videos),
            recent_videos_analyzed=len(videos),
            median_recent_views=round(median_views, 1),
            mean_recent_views=round(mean_views, 1),
            p75_views=round(p75, 1),
            p90_views=round(p90, 1),
            outlier_videos=outlier_items[:8],
            best_repeated_topics=repeat_topics or ["General Production"],
            winning_title_patterns=title_patterns,
            upload_cadence_days=cadence_days,
            topic_consistency=consistency,
            # V2: Pass video list for frontend to run thumbnail intelligence
            videos_for_thumbnail=videos_for_thumbnail,
        )
