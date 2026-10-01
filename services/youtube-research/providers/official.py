import urllib.parse
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any, Optional, Tuple
import httpx
from providers.protocol import RawVideoData, RawChannelData
from utils.parsers import parse_duration, calculate_age_days
from utils.time_window import resolve_time_window, TimeWindow
from core.logger import research_logger

def _resolve_published_bounds(
    time_range: str,
    published_after: Optional[str] = None,
    published_before: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Return (publishedAfter, publishedBefore) RFC3339 strings.
    If explicit bounds are given, use those directly.
    Otherwise resolve from time_range string.
    """
    if published_after is not None or published_before is not None:
        return published_after, published_before
    if time_range == "all":
        return None, None
    tw = resolve_time_window(time_range)
    return tw.to_published_after_rfc3339(), tw.to_published_before_rfc3339()


def _classify_content_type(duration_seconds: int) -> str:
    """Classify content type by actual duration. SHORT ≤ 60s, LONG > 60s."""
    if duration_seconds <= 0:
        return "LONG"
    return "SHORT" if duration_seconds <= 60 else "LONG"


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
        limit: int = 50,
        page_token: Optional[str] = None,
        # V2: explicit bucket bounds (override time_range when set)
        published_after: Optional[str] = None,
        published_before: Optional[str] = None,
    ) -> Tuple[List[RawVideoData], Optional[str]]:
        """
        Search videos via YouTube Data API.
        Returns (videos, next_page_token).
        
        V2: Sends both publishedAfter AND publishedBefore for precise time windows.
        When published_after/published_before are given explicitly (bucket mode),
        they override the time_range-derived bounds.
        """
        if not self.api_key:
            return [], None

        pa, pb = _resolve_published_bounds(time_range, published_after, published_before)
        search_url = "https://www.googleapis.com/youtube/v3/search"
        params: Dict[str, Any] = {
            "key": self.api_key,
            "part": "snippet",
            "q": query,
            "type": "video",
            "regionCode": market,
            "relevanceLanguage": language,
            "maxResults": min(limit, 50),
            "order": "relevance",
        }

        if pa:
            params["publishedAfter"] = pa
        if pb:
            params["publishedBefore"] = pb

        if page_token:
            params["pageToken"] = page_token

        if content_type == "SHORT":
            params["videoDuration"] = "short"

        video_ids: List[str] = []
        next_page_token: Optional[str] = None
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
                    return [], None
                elif res.status_code != 200:
                    self.health_status = "DEGRADED"
                    self.last_error = f"HTTP {res.status_code}"
                    return [], None

                data = res.json()
                next_page_token = data.get("nextPageToken")
                items = data.get("items", [])
                for it in items:
                    v_id = it.get("id", {}).get("videoId")
                    if v_id:
                        video_ids.append(v_id)

        except Exception as e:
            research_logger.warning(f"[OfficialAPI] Request error: {e}")
            self.last_error = str(e)
            self.health_status = "DEGRADED"
            return [], None

        if not video_ids:
            return [], next_page_token

        videos = await self.get_videos(video_ids, target_content_type=content_type)
        return videos, next_page_token

    async def search_videos_simple(
        self,
        query: str,
        market: str = "US",
        language: str = "en",
        content_type: str = "LONG",
        time_range: str = "30d",
        limit: int = 50,
    ) -> List[RawVideoData]:
        """Backward-compat wrapper that drops the next_page_token return value."""
        videos, _ = await self.search_videos(
            query=query,
            market=market,
            language=language,
            content_type=content_type,
            time_range=time_range,
            limit=limit,
        )
        return videos

    async def get_videos(
        self,
        video_ids: List[str],
        target_content_type: Optional[str] = None,
    ) -> List[RawVideoData]:
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
                    # Classify by actual duration, not search-level hint
                    actual_content_type = _classify_content_type(duration)

                    # If caller wants a specific type, skip videos that don't match.
                    # This ensures SHORT only gets ≤60s and LONG only gets >60s.
                    if target_content_type and actual_content_type != target_content_type:
                        continue

                    # Skip live/upcoming broadcasts
                    live_status = details.get("contentRating", {})
                    broadcast = snippet.get("liveBroadcastContent", "none")
                    if broadcast in ("live", "upcoming"):
                        continue

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
                            content_type=actual_content_type,
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
        max_videos: int = 25,
    ) -> RawChannelData:
        """
        Correct channel baseline flow:
        1. channels.list → snippet,statistics,contentDetails
        2. contentDetails.relatedPlaylists.uploads → uploads playlist ID
        3. playlistItems.list → up to max_videos video IDs
        4. videos.list batch → contentDetails + statistics
        5. Filter by content_type, exclude livestreams, compute baseline
        """
        if not self.api_key:
            return RawChannelData(channel_id=channel_id, title="Unknown", provider=self.name)

        channel_title = "Unknown Channel"
        sub_count: Optional[int] = None
        country: Optional[str] = None
        video_count: Optional[int] = None
        uploads_playlist_id: Optional[str] = None

        # Step 1: Fetch channel metadata + contentDetails
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(
                    "https://www.googleapis.com/youtube/v3/channels",
                    params={
                        "key": self.api_key,
                        "part": "snippet,statistics,contentDetails",
                        "id": channel_id,
                    },
                )
                if res.status_code == 200:
                    data = res.json()
                    items = data.get("items", [])
                    if items:
                        c = items[0]
                        snip = c.get("snippet", {})
                        stats = c.get("statistics", {})
                        content_details = c.get("contentDetails", {})
                        channel_title = snip.get("title", channel_title)
                        country = snip.get("country")
                        if "subscriberCount" in stats:
                            sub_count = int(stats["subscriberCount"])
                        video_count = int(stats.get("videoCount", 0)) or None
                        uploads_playlist_id = (
                            content_details.get("relatedPlaylists", {}).get("uploads")
                        )
        except Exception as e:
            research_logger.warning(f"[OfficialAPI] Channel lookup error {channel_id}: {e}")

        if not uploads_playlist_id:
            research_logger.warning(f"[OfficialAPI] No uploads playlist for {channel_id}, using fallback search")
            # Fallback to search if playlist unavailable
            recent_videos = await self.search_videos_simple(
                query=f"site:youtube.com channel:{channel_id}",
                content_type=content_type,
                limit=max_videos,
            )
            return RawChannelData(
                channel_id=channel_id,
                title=channel_title,
                country=country,
                subscriber_count=sub_count,
                video_count=video_count or len(recent_videos),
                recent_videos=recent_videos,
                provider=self.name,
            )

        # Step 2: Fetch recent video IDs from uploads playlist
        video_ids: List[str] = []
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(
                    "https://www.googleapis.com/youtube/v3/playlistItems",
                    params={
                        "key": self.api_key,
                        "part": "contentDetails",
                        "playlistId": uploads_playlist_id,
                        "maxResults": min(max_videos, 50),
                    },
                )
                if res.status_code == 200:
                    data = res.json()
                    for item in data.get("items", []):
                        vid_id = item.get("contentDetails", {}).get("videoId")
                        if vid_id:
                            video_ids.append(vid_id)
        except Exception as e:
            research_logger.warning(f"[OfficialAPI] playlistItems error for {channel_id}: {e}")

        if not video_ids:
            return RawChannelData(
                channel_id=channel_id,
                title=channel_title,
                country=country,
                subscriber_count=sub_count,
                video_count=video_count or 0,
                recent_videos=[],
                provider=self.name,
            )

        # Step 3: Batch fetch video details, filter by content_type
        recent_videos = await self.get_videos(video_ids, target_content_type=content_type)

        return RawChannelData(
            channel_id=channel_id,
            title=channel_title,
            country=country,
            subscriber_count=sub_count,
            video_count=video_count or len(recent_videos),
            recent_videos=recent_videos,
            provider=self.name,
        )

    async def get_autocomplete(self, query: str, market: str = "US", language: str = "en") -> List[str]:
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
            "last_error": self.last_error,
        }
