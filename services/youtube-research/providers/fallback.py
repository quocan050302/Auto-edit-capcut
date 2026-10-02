from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple
from providers.protocol import RawVideoData, RawChannelData, YouTubeProvider
from providers.official import OfficialYouTubeProvider
from providers.scraper import PublicScraperProvider
from core.logger import research_logger

class ProviderFallbackManager:
    def __init__(
        self,
        official_api_key: str = "",
        use_official: bool = False,
        priority: str = "scraper_first"
    ):
        self.official = OfficialYouTubeProvider(official_api_key)
        self.scraper = PublicScraperProvider()
        self.use_official = use_official
        self.priority = priority
        self.last_provenance: str = "SCRAPER"

    def update_configuration(self, api_key: str, use_official: bool, priority: str):
        self.official.update_key(api_key)
        self.use_official = use_official
        self.priority = priority

    async def search_videos(
        self,
        query: str,
        market: str = "US",
        language: str = "en",
        content_type: str = "LONG",
        time_range: str = "30d",
        limit: int = 50,
        published_after: Optional[str] = None,
        published_before: Optional[str] = None,
        order: str = "relevance",
        merge_sources: bool = False,
    ) -> List[RawVideoData]:
        # Mode 1: Merge Sources (used by Similar Channel Discovery)
        # Official API provides verified dates/channel IDs; Scraper provides breadth.
        # Dedupe by video_id with Official winning conflicts.
        if merge_sources:
            official_records: List[RawVideoData] = []
            has_official = (
                self.use_official
                and self.official.api_key
                and not self.official.quota_exceeded
            )

            if has_official:
                try:
                    official_res, _ = await self.official.search_videos(
                        query=query, market=market, language=language,
                        content_type=content_type, time_range=time_range, limit=limit,
                        published_after=published_after, published_before=published_before,
                        order=order,
                    )
                    official_records = official_res
                except Exception as e:
                    research_logger.warning(f"[Provider] Merge mode Official search error: {e}")

            scraper_records: List[RawVideoData] = []
            try:
                scraper_records = await self.scraper.search_videos(
                    query=query, market=market, language=language,
                    content_type=content_type, time_range=time_range, limit=limit,
                    order=order, published_after=published_after, published_before=published_before,
                )
            except Exception as e:
                research_logger.warning(f"[Provider] Merge mode Scraper search error: {e}")

            # Merge: Official record wins on collision
            merged: Dict[str, RawVideoData] = {}
            for v in official_records:
                if v.video_id:
                    merged[v.video_id] = v
            for v in scraper_records:
                if v.video_id and v.video_id not in merged:
                    merged[v.video_id] = v

            if official_records and scraper_records:
                self.last_provenance = "MERGED"
            elif official_records:
                self.last_provenance = "OFFICIAL"
            else:
                self.last_provenance = "SCRAPER"

            return list(merged.values())

        # Mode 2: Standard Fallback (keeps backward-compatibility with other tools)
        should_use_official_first = (
            self.use_official
            and self.official.api_key
            and not self.official.quota_exceeded
            and self.priority == "official_first"
        )

        if should_use_official_first:
            try:
                research_logger.info(f"[Provider] Searching via Official API: {query}")
                results, _ = await self.official.search_videos(
                    query, market, language, content_type, time_range, limit,
                    published_after=published_after,
                    published_before=published_before,
                    order=order,
                )
                if results:
                    self.last_provenance = "OFFICIAL"
                    return results
                research_logger.warning("[Provider] Official API returned empty or failed. Falling back to Scraper...")
            except Exception as e:
                research_logger.warning(f"[Provider] Official API error ({e}). Falling back to Scraper...")

        # Use scraper
        research_logger.info(f"[Provider] Searching via Scraper: {query} (market={market})")
        results = await self.scraper.search_videos(
            query, market, language, content_type, time_range, limit,
            order=order, published_after=published_after, published_before=published_before,
        )
        if results:
            self.last_provenance = "SCRAPER" if not should_use_official_first else "MIXED"
            return results

        # Fallback to official if scraper failed and official was second
        if self.use_official and self.official.api_key and not self.official.quota_exceeded and not should_use_official_first:
            research_logger.info(f"[Provider] Scraper returned empty. Trying Official API fallback...")
            res, _ = await self.official.search_videos(
                query, market, language, content_type, time_range, limit,
                published_after=published_after,
                published_before=published_before,
                order=order,
            )
            if res:
                self.last_provenance = "MIXED"
                return res

        return []

    async def resolve_channel_id(self, video_id: str) -> Optional[str]:
        """Try Official API first to resolve snippet.channelId, then fallback to scraper watch page."""
        if self.use_official and self.official.api_key and not self.official.quota_exceeded:
            try:
                cid = await self.official.resolve_channel_id(video_id)
                if cid:
                    return cid
            except Exception:
                pass
        return await self.scraper.resolve_channel_id(video_id)

    async def get_channel_videos_in_window(
        self,
        channel_id: str,
        content_type: str,
        published_after: datetime,
        published_before: datetime,
        max_videos: int = 100,
    ) -> Tuple[List[RawVideoData], str]:
        """Fetch channel videos in exact 90-day window, delegating to Official API then Scraper."""
        if self.use_official and self.official.api_key and not self.official.quota_exceeded:
            try:
                vids, cov = await self.official.get_channel_videos_in_window(
                    channel_id, content_type, published_after, published_before, max_videos
                )
                if vids or cov == "COMPLETE":
                    return vids, cov
            except Exception as e:
                research_logger.warning(f"[Provider] get_channel_videos_in_window official error: {e}")

        return await self.scraper.get_channel_videos_in_window(
            channel_id, content_type, published_after, published_before, max_videos
        )

    async def get_channel_baseline(
        self,
        channel_id: str,
        content_type: str = "LONG",
        max_videos: int = 25
    ) -> RawChannelData:
        # Prefer scraper for channel baseline to conserve YouTube Data API quota (search costs 100 units per query on Official API!)
        if self.priority == "official_first" and self.use_official and self.official.api_key and not self.official.quota_exceeded:
            try:
                res = await self.official.get_channel_baseline(channel_id, content_type, max_videos)
                if res and res.recent_videos:
                    return res
            except Exception:
                pass

        # Use scraper
        res = await self.scraper.get_channel_baseline(channel_id, content_type, max_videos)
        if res and res.recent_videos:
            return res

        # Fallback to official if scraper failed
        if self.use_official and self.official.api_key and not self.official.quota_exceeded:
            return await self.official.get_channel_baseline(channel_id, content_type, max_videos)

        return res

    def get_cached_health(self) -> Dict[str, Any]:
        return {
            "scraper": {
                "provider": self.scraper.name,
                "status": self.scraper.health_status,
                "error_count": self.scraper.error_count,
                "last_error": self.scraper.last_error
            },
            "official": {
                "provider": self.official.name,
                "status": self.official.health_status,
                "quota_exceeded": self.official.quota_exceeded,
                "last_error": self.official.last_error
            },
            "active_preference": "official" if (self.use_official and self.official.api_key) else "scraper",
            "last_provenance": self.last_provenance
        }

    async def get_health_status(self) -> Dict[str, Any]:
        return self.get_cached_health()
