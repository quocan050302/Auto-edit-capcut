from typing import Protocol, List, Dict, Any, Optional
from pydantic import BaseModel

class RawVideoData(BaseModel):
    video_id: str
    url: str
    title: str
    description: str = ""
    channel_id: str
    channel_title: str
    published_at: str
    duration_seconds: int = 0
    views: int = 0
    likes: Optional[int] = None
    comments: Optional[int] = None
    thumbnail_url: str = ""
    channel_subscribers: Optional[int] = None
    channel_country: Optional[str] = None
    content_type: str = "LONG" # LONG, SHORT, LIVE
    provider: str = "SCRAPER"
    raw_data: Optional[Dict[str, Any]] = None

class RawChannelData(BaseModel):
    channel_id: str
    title: str
    custom_url: Optional[str] = None
    country: Optional[str] = None
    subscriber_count: Optional[int] = None
    video_count: Optional[int] = None
    recent_videos: List[RawVideoData] = []
    provider: str = "SCRAPER"

class YouTubeProvider(Protocol):
    name: str

    async def search_videos(
        self,
        query: str,
        market: str = "US",
        language: str = "en",
        content_type: str = "LONG",
        time_range: str = "30d",
        limit: int = 50
    ) -> List[RawVideoData]:
        ...

    async def get_videos(self, video_ids: List[str]) -> List[RawVideoData]:
        ...

    async def get_channel_baseline(
        self,
        channel_id: str,
        content_type: str = "LONG",
        max_videos: int = 25
    ) -> RawChannelData:
        ...

    async def get_autocomplete(self, query: str, market: str = "US", language: str = "en") -> List[str]:
        ...

    async def check_health(self) -> Dict[str, Any]:
        ...
