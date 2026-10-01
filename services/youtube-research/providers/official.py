import urllib.parse
from typing import List, Dict, Any, Optional
import httpx
from providers.protocol import RawVideoData, RawChannelData
from utils.parsers import parse_duration, calculate_age_days
from core.logger import research_logger

class OfficialYouTubeProvider:
    name: str = "OFFICIAL"

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.health_status = "OK" if api_key else "OFFLINE"
        self.last_error: Optional[str] = None
        self.quota_exceeded: bool = False

    def update_key(self, api_key: str):
        self.api_key = api_key
        self.health_status = "OK" if api_key else "OFFLINE"
        self.quota_exceeded = False
        self.last_error = None

    async def search_videos(
        self,
        query: str,
        market: str = "US",
        language: str = "en",
        content_type: str = "LONG",
        time_range: str = "30d",
        limit: int = 50
    ) -> List[RawVideoData]:
        if not self.api_key:
            return []

        search_url = "https://www.googleapis.com/youtube/v3/search"
        params = {
            "key": self.api_key,
            "part": "snippet",
            "q": query,
            "type": "video",
            "regionCode": market,
            "relevanceLanguage": language,
            "maxResults": min(limit, 50),
        }

        if content_type == "LONG":
            params["videoDuration"] = "medium" # or long
        elif content_type == "SHORT":
            params["videoDuration"] = "short"

        video_ids = []
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(search_url, params=params)
                if res.status_code == 403:
                    data = res.json()
                    err_msg = data.get("error", {}).get("message", "Forbidden")
                    if "quota" in err_msg.lower():
                        self.quota_exceeded = True
                        self.health_status = "QUOTA_EXCEEDED"
                        self.last_error = "YouTube API quota exceeded"
                    else:
                        self.health_status = "INVALID_KEY"
                        self.last_error = err_msg
                    research_logger.warning(f"[OfficialAPI] Search error: {self.last_error}")
                    return []
                elif res.status_code != 200:
                    self.health_status = "DEGRADED"
                    self.last_error = f"HTTP {res.status_code}"
                    return []

                data = res.json()
                items = data.get("items", [])
                for it in items:
                    v_id = it.get("id", {}).get("videoId")
                    if v_id:
                        video_ids.append(v_id)

        except Exception as e:
            research_logger.warning(f"[OfficialAPI] Request error: {e}")
            self.last_error = str(e)
            self.health_status = "DEGRADED"
            return []

        if not video_ids:
            return []

        return await self.get_videos(video_ids)

    async def get_videos(self, video_ids: List[str]) -> List[RawVideoData]:
        if not self.api_key or not video_ids:
            return []

        url = "https://www.googleapis.com/youtube/v3/videos"
        params = {
            "key": self.api_key,
            "part": "snippet,contentDetails,statistics",
            "id": ",".join(video_ids[:50]),
        }

        results: List[RawVideoData] = []
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(url, params=params)
                if res.status_code != 200:
                    return []
                data = res.json()
                for item in data.get("items", []):
                    vid = item.get("id", "")
                    snippet = item.get("snippet", {})
                    details = item.get("contentDetails", {})
                    stats = item.get("statistics", {})

                    duration = parse_duration(details.get("duration", ""))
                    is_short = duration > 0 and duration <= 60

                    thumbs = snippet.get("thumbnails", {})
                    thumb_url = (
                        thumbs.get("high", {}).get("url")
                        or thumbs.get("medium", {}).get("url")
                        or thumbs.get("default", {}).get("url")
                        or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                    )

                    views = int(stats.get("viewCount", 0))
                    likes = int(stats.get("likeCount", 0)) if "likeCount" in stats else None
                    comments = int(stats.get("commentCount", 0)) if "commentCount" in stats else None

                    results.append(
                        RawVideoData(
                            video_id=vid,
                            url=f"https://www.youtube.com/watch?v={vid}",
                            title=snippet.get("title", ""),
                            description=snippet.get("description", ""),
                            channel_id=snippet.get("channelId", ""),
                            channel_title=snippet.get("channelTitle", ""),
                            published_at=snippet.get("publishedAt", ""),
                            duration_seconds=duration,
                            views=views,
                            likes=likes,
                            comments=comments,
                            thumbnail_url=thumb_url,
                            content_type="SHORT" if is_short else "LONG",
                            provider=self.name,
                            raw_data=item
                        )
                    )

        except Exception as e:
            research_logger.warning(f"[OfficialAPI] get_videos error: {e}")

        return results

    async def get_channel_baseline(
        self,
        channel_id: str,
        content_type: str = "LONG",
        max_videos: int = 25
    ) -> RawChannelData:
        if not self.api_key:
            return RawChannelData(channel_id=channel_id, title="Unknown", provider=self.name)

        url = "https://www.googleapis.com/youtube/v3/channels"
        params = {
            "key": self.api_key,
            "part": "snippet,statistics",
            "id": channel_id,
        }

        channel_title = "Unknown Channel"
        sub_count = None
        country = None
        video_count = None

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(url, params=params)
                if res.status_code == 200:
                    data = res.json()
                    items = data.get("items", [])
                    if items:
                        c = items[0]
                        snip = c.get("snippet", {})
                        stats = c.get("statistics", {})
                        channel_title = snip.get("title", channel_title)
                        country = snip.get("country")
                        sub_count = int(stats.get("subscriberCount", 0)) if "subscriberCount" in stats else None
                        video_count = int(stats.get("videoCount", 0)) if "videoCount" in stats else None
        except Exception as e:
            research_logger.warning(f"[OfficialAPI] Channel lookup error {channel_id}: {e}")

        # Fetch recent uploads via search
        recent_videos = await self.search_videos(
            query=f"channel:{channel_id}",
            content_type=content_type,
            limit=max_videos
        )

        return RawChannelData(
            channel_id=channel_id,
            title=channel_title,
            country=country,
            subscriber_count=sub_count,
            video_count=video_count or len(recent_videos),
            recent_videos=recent_videos,
            provider=self.name
        )

    async def get_autocomplete(self, query: str, market: str = "US", language: str = "en") -> List[str]:
        # Official API does not have dedicated autocomplete endpoint without quota cost, so use public suggest
        q_enc = urllib.parse.quote(query)
        url = f"https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q={q_enc}&gl={market}&hl={language}"
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                res = await client.get(url)
                if res.status_code == 200:
                    data = res.json()
                    if isinstance(data, list) and len(data) > 1 and isinstance(data[1], list):
                        return [str(item) for item in data[1]]
        except Exception:
            pass
        return []

    async def check_health(self) -> Dict[str, Any]:
        return {
            "provider": self.name,
            "status": self.health_status,
            "quota_exceeded": self.quota_exceeded,
            "last_error": self.last_error
        }
