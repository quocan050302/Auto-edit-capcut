from typing import List, Dict, Any, Optional
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
        limit: int = 50
    ) -> List[RawVideoData]:
        should_use_official_first = (
            self.use_official
            and self.official.api_key
            and not self.official.quota_exceeded
            and self.priority == "official_first"
        )

        if should_use_official_first:
            try:
                research_logger.info(f"[Provider] Searching via Official API: {query}")
                results = await self.official.search_videos(query, market, language, content_type, time_range, limit)
                if results:
                    self.last_provenance = "OFFICIAL"
                    return results
                research_logger.warning("[Provider] Official API returned empty or failed. Falling back to Scraper...")
            except Exception as e:
                research_logger.warning(f"[Provider] Official API error ({e}). Falling back to Scraper...")

        # Use scraper
        research_logger.info(f"[Provider] Searching via Scraper: {query} (market={market})")
        results = await self.scraper.search_videos(query, market, language, content_type, time_range, limit)
        if results:
            self.last_provenance = "SCRAPER" if not should_use_official_first else "MIXED"
            return results

        # Fallback to official if scraper failed and official was second
        if self.use_official and self.official.api_key and not self.official.quota_exceeded and not should_use_official_first:
            research_logger.info(f"[Provider] Scraper returned empty. Trying Official API fallback...")
            res = await self.official.search_videos(query, market, language, content_type, time_range, limit)
            if res:
                self.last_provenance = "MIXED"
                return res

        return []

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
