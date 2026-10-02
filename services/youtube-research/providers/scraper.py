import asyncio
import json
import re
import urllib.parse
from typing import List, Dict, Any, Optional
import httpx

from providers.protocol import RawVideoData, RawChannelData
from utils.parsers import (
    parse_view_count,
    parse_duration,
    parse_subscriber_count,
    approximate_published_date,
    calculate_age_days
)
from core.logger import research_logger

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

class PublicScraperProvider:
    name: str = "SCRAPER"

    def __init__(self, timeout: float = 12.0, max_retries: int = 3):
        self.timeout = timeout
        self.max_retries = max_retries
        self.health_status = "OK"
        self.last_error: Optional[str] = None
        self.error_count = 0

    async def _fetch_with_backoff(self, url: str, headers: Optional[Dict[str, str]] = None) -> Optional[str]:
        h = {**DEFAULT_HEADERS, **(headers or {})}
        backoff = 1.0

        for attempt in range(self.max_retries):
            try:
                async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                    resp = await client.get(url, headers=h)
                    if resp.status_code == 200:
                        self.health_status = "OK"
                        return resp.text
                    elif resp.status_code in (429, 500, 502, 503, 504):
                        research_logger.warning(f"[Scraper] HTTP {resp.status_code} for {url}, retrying in {backoff}s...")
                        await asyncio.sleep(backoff)
                        backoff *= 2.0
                    else:
                        research_logger.warning(f"[Scraper] Unexpected status {resp.status_code} for {url}")
                        return None
            except Exception as e:
                research_logger.warning(f"[Scraper] Request attempt {attempt + 1} failed: {e}")
                self.error_count += 1
                self.last_error = str(e)
                await asyncio.sleep(backoff)
                backoff *= 2.0

        self.health_status = "DEGRADED"
        return None

    def _extract_initial_data(self, html: str) -> Optional[Dict[str, Any]]:
        # Find ytInitialData = { ... };
        pattern = re.compile(r"var ytInitialData\s*=\s*({.+?});</script>", re.DOTALL)
        match = pattern.search(html)
        if not match:
            # Alternate pattern
            pattern2 = re.compile(r"ytInitialData\s*=\s*({.+?});", re.DOTALL)
            match = pattern2.search(html)

        if match:
            try:
                return json.loads(match.group(1))
            except Exception as e:
                research_logger.warning(f"[Scraper] Failed to parse ytInitialData JSON: {e}")
                return None
        return None

    async def search_videos(
        self,
        query: str,
        market: str = "US",
        language: str = "en",
        content_type: str = "LONG",
        time_range: str = "30d",
        limit: int = 50
    ) -> List[RawVideoData]:
        q_encoded = urllib.parse.quote(query)
        url = f"https://www.youtube.com/results?search_query={q_encoded}&gl={market}&hl={language}"
        
        headers = {
            "Accept-Language": f"{language}-{market},{language};q=0.9,en;q=0.8"
        }

        html = await self._fetch_with_backoff(url, headers)
        if not html:
            return []

        data = self._extract_initial_data(html)
        if not data:
            research_logger.warning("[Scraper] ytInitialData not found in search page response")
            return []

        videos: List[RawVideoData] = []
        try:
            sections = (
                data.get("contents", {})
                .get("twoColumnSearchResultsRenderer", {})
                .get("primaryContents", {})
                .get("sectionListRenderer", {})
                .get("contents", [])
            )

            for section in sections:
                item_section = section.get("itemSectionRenderer", {})
                items = item_section.get("contents", [])
                for item in items:
                    v_render = item.get("videoRenderer")
                    if not v_render:
                        continue

                    video_id = v_render.get("videoId")
                    if not video_id:
                        continue

                    title = ""
                    title_runs = v_render.get("title", {}).get("runs", [])
                    if title_runs:
                        title = "".join(r.get("text", "") for r in title_runs)

                    channel_title = ""
                    channel_id = ""
                    owner_runs = v_render.get("ownerText", {}).get("runs", []) or v_render.get("shortBylineText", {}).get("runs", [])
                    if owner_runs:
                        channel_title = owner_runs[0].get("text", "")
                        nav = owner_runs[0].get("navigationEndpoint", {}).get("browseEndpoint", {})
                        channel_id = nav.get("browseId", "")

                    views_raw = v_render.get("viewCountText", {}).get("simpleText") or ""
                    if not views_raw and "runs" in v_render.get("viewCountText", {}):
                        views_raw = "".join(r.get("text", "") for r in v_render["viewCountText"]["runs"])
                    views = parse_view_count(views_raw)

                    duration_raw = v_render.get("lengthText", {}).get("simpleText") or ""
                    duration = parse_duration(duration_raw)

                    # Determine content type: Shorts usually <= 60s or marked as short
                    is_short = duration > 0 and duration <= 60
                    detected_type = "SHORT" if is_short else "LONG"
                    
                    if content_type == "LONG" and is_short:
                        continue
                    if content_type == "SHORT" and not is_short:
                        continue

                    pub_raw = v_render.get("publishedTimeText", {}).get("simpleText") or ""
                    pub_iso = approximate_published_date(pub_raw)

                    thumb = ""
                    thumbs = v_render.get("thumbnail", {}).get("thumbnails", [])
                    if thumbs:
                        thumb = thumbs[-1].get("url", "")

                    desc = ""
                    desc_snippets = v_render.get("detailedMetadataSnippets", [])
                    if desc_snippets:
                        desc_runs = desc_snippets[0].get("snippetText", {}).get("runs", [])
                        desc = "".join(r.get("text", "") for r in desc_runs)

                    videos.append(
                        RawVideoData(
                            video_id=video_id,
                            url=f"https://www.youtube.com/watch?v={video_id}",
                            title=title,
                            description=desc,
                            channel_id=channel_id or f"ch_{video_id}",
                            channel_title=channel_title or "Unknown Channel",
                            published_at=pub_iso,
                            duration_seconds=duration,
                            views=views,
                            thumbnail_url=thumb,
                            content_type=detected_type,
                            provider=self.name
                        )
                    )

                    if len(videos) >= limit:
                        break
                if len(videos) >= limit:
                    break

        except Exception as e:
            research_logger.warning(f"[Scraper] Error parsing video search contents: {e}")
            self.health_status = "DEGRADED"

        return videos

    async def get_videos(self, video_ids: List[str]) -> List[RawVideoData]:
        # For scraper, individual video details can be retrieved or filled from search
        results = []
        for vid in video_ids[:10]: # concurrency safety limit
            url = f"https://www.youtube.com/watch?v={vid}"
            html = await self._fetch_with_backoff(url)
            if not html:
                continue
            data = self._extract_initial_data(html)
            if not data:
                continue
            try:
                media = data.get("contents", {}).get("twoColumnWatchNextResults", {}).get("results", {}).get("results", {}).get("contents", [])
                title = ""
                views = 0
                channel_id = ""
                channel_title = ""
                pub_iso = ""

                for m in media:
                    prim = m.get("videoPrimaryInfoRenderer")
                    if prim:
                        title_runs = prim.get("title", {}).get("runs", [])
                        title = "".join(r.get("text", "") for r in title_runs)
                        views_raw = prim.get("viewCount", {}).get("videoViewCountRenderer", {}).get("viewCount", {}).get("simpleText") or ""
                        views = parse_view_count(views_raw)
                        date_raw = prim.get("dateText", {}).get("simpleText") or ""
                        pub_iso = approximate_published_date(date_raw)

                    sec = m.get("videoSecondaryInfoRenderer")
                    if sec:
                        owner = sec.get("owner", {}).get("videoOwnerRenderer", {})
                        c_title_runs = owner.get("title", {}).get("runs", [])
                        channel_title = "".join(r.get("text", "") for r in c_title_runs)
                        nav = owner.get("navigationEndpoint", {}).get("browseEndpoint", {})
                        channel_id = nav.get("browseId", "")

                if title:
                    results.append(
                        RawVideoData(
                            video_id=vid,
                            url=url,
                            title=title,
                            channel_id=channel_id or f"ch_{vid}",
                            channel_title=channel_title or "Unknown",
                            published_at=pub_iso,
                            views=views,
                            thumbnail_url=f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                            provider=self.name
                        )
                    )
            except Exception as e:
                research_logger.warning(f"[Scraper] Failed parsing watch page {vid}: {e}")
        return results

    async def get_channel_baseline(
        self,
        channel_id: str,
        content_type: str = "LONG",
        max_videos: int = 25
    ) -> RawChannelData:
        # Handles channel browseId or @handle
        if channel_id.startswith("@"):
            url = f"https://www.youtube.com/{channel_id}/videos"
        elif channel_id.startswith("UC"):
            url = f"https://www.youtube.com/channel/{channel_id}/videos"
        else:
            url = f"https://www.youtube.com/channel/{channel_id}/videos"

        html = await self._fetch_with_backoff(url)
        if not html:
            return RawChannelData(channel_id=channel_id, title="Unknown", provider=self.name)

        data = self._extract_initial_data(html)
        if not data:
            return RawChannelData(channel_id=channel_id, title="Unknown", provider=self.name)

        channel_title = ""
        sub_count = None
        recent_videos: List[RawVideoData] = []

        try:
            # Header info
            header = data.get("header", {}).get("c4TabbedHeaderRenderer") or data.get("header", {}).get("pageHeaderRenderer")
            if header:
                if "title" in header:
                    channel_title = header["title"]
                elif "pageTitle" in header:
                    channel_title = header["pageTitle"]

                sub_text = header.get("subscriberCountText", {}).get("simpleText") or ""
                if not sub_text:
                    try:
                        vm = header.get("content", {}).get("pageHeaderViewModel", {})
                        meta_rows = vm.get("metadata", {}).get("contentMetadataViewModel", {}).get("metadataRows", [])
                        for row in meta_rows:
                            for part in row.get("metadataParts", []):
                                text_content = part.get("text", {}).get("content", "")
                                if "subscribers" in text_content.lower() or "subscriber" in text_content.lower():
                                    sub_text = text_content
                                    break
                            if sub_text:
                                break
                    except Exception:
                        pass
                sub_count = parse_subscriber_count(sub_text)

            # Extract recent video list from tabs
            tabs = data.get("contents", {}).get("twoColumnBrowseResultsRenderer", {}).get("tabs", [])
            for tab in tabs:
                tab_renderer = tab.get("tabRenderer", {})
                if tab_renderer.get("selected") or "videos" in tab_renderer.get("title", "").lower():
                    grid_contents = (
                        tab_renderer.get("content", {})
                        .get("richGridRenderer", {})
                        .get("contents", [])
                    )
                    for item in grid_contents:
                        rich_item = item.get("richItemRenderer", {}).get("content", {})
                        
                        v_render = rich_item.get("videoRenderer")
                        lockup = rich_item.get("lockupViewModel")

                        if v_render:
                            vid_id = v_render.get("videoId")
                            if not vid_id:
                                continue

                            v_title_runs = v_render.get("title", {}).get("runs", [])
                            v_title = "".join(r.get("text", "") for r in v_title_runs)

                            v_views_raw = v_render.get("viewCountText", {}).get("simpleText") or ""
                            
                            v_dur_raw = v_render.get("lengthText", {}).get("simpleText") or ""
                            pub_raw = v_render.get("publishedTimeText", {}).get("simpleText") or ""
                            
                        elif lockup:
                            vid_id = lockup.get("contentId")
                            if not vid_id:
                                continue
                            
                            v_title = lockup.get("metadata", {}).get("lockupMetadataViewModel", {}).get("title", {}).get("content", "")
                            
                            v_views_raw = ""
                            pub_raw = ""
                            
                            meta_rows = lockup.get("metadata", {}).get("lockupMetadataViewModel", {}).get("metadata", {}).get("contentMetadataViewModel", {}).get("metadataRows", [])
                            if meta_rows and len(meta_rows) > 0:
                                parts = meta_rows[0].get("metadataParts", [])
                                if len(parts) > 0:
                                    v_views_raw = parts[0].get("text", {}).get("content", "")
                                if len(parts) > 1:
                                    pub_raw = parts[1].get("text", {}).get("content", "")
                            
                            # Duration is in overlays -> thumbnailBottomOverlayViewModel
                            v_dur_raw = ""
                            overlays = lockup.get("contentImage", {}).get("thumbnailViewModel", {}).get("overlays", [])
                            for overlay in overlays:
                                bottom_overlay = overlay.get("thumbnailBottomOverlayViewModel", {})
                                if bottom_overlay:
                                    badges = bottom_overlay.get("badges", [])
                                    if badges:
                                        v_dur_raw = badges[0].get("thumbnailBadgeViewModel", {}).get("text", "")
                                        break
                                        
                        else:
                            continue

                        v_views = parse_view_count(v_views_raw)
                        v_dur = parse_duration(v_dur_raw)
                        is_short = v_dur > 0 and v_dur <= 60

                        # Filter by requested content type
                        if content_type == "LONG" and is_short:
                            continue
                        if content_type == "SHORT" and not is_short:
                            continue

                        v_pub_iso = approximate_published_date(pub_raw)

                        recent_videos.append(
                            RawVideoData(
                                video_id=vid_id,
                                url=f"https://www.youtube.com/watch?v={vid_id}",
                                title=v_title,
                                channel_id=channel_id,
                                channel_title=channel_title or "Unknown",
                                published_at=v_pub_iso,
                                duration_seconds=v_dur,
                                views=v_views,
                                thumbnail_url=f"https://i.ytimg.com/vi/{vid_id}/hqdefault.jpg",
                                content_type="SHORT" if is_short else "LONG",
                                provider=self.name
                            )
                        )

                        if len(recent_videos) >= max_videos:
                            break
                    break

        except Exception as e:
            research_logger.warning(f"[Scraper] Failed extracting channel baseline {channel_id}: {e}")

        return RawChannelData(
            channel_id=channel_id,
            title=channel_title or "Unknown Channel",
            subscriber_count=sub_count,
            video_count=len(recent_videos),
            recent_videos=recent_videos,
            provider=self.name
        )

    async def get_autocomplete(self, query: str, market: str = "US", language: str = "en") -> List[str]:
        # Fast query suggestions
        q_enc = urllib.parse.quote(query)
        url = f"https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q={q_enc}&gl={market}&hl={language}"
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                res = await client.get(url, headers=DEFAULT_HEADERS)
                if res.status_code == 200:
                    data = res.json()
                    if isinstance(data, list) and len(data) > 1 and isinstance(data[1], list):
                        return [str(item) for item in data[1]]
        except Exception as e:
            research_logger.warning(f"[Autocomplete] Failed: {e}")
        return []

    async def check_health(self) -> Dict[str, Any]:
        return {
            "provider": self.name,
            "status": self.health_status,
            "error_count": self.error_count,
            "last_error": self.last_error
        }
