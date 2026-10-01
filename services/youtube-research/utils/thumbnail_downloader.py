"""
Thumbnail Downloader — Competitor Thumbnail Intelligence V1

Security rules:
- Only YouTube CDN hosts allowed
- HTTPS/HTTP only, no other protocols
- Blocks localhost and private IP ranges
- File size limit: 10MB
- Content-Type validation (image/* only)
- Timeout enforcement
- No binary in logs
- No API keys in logs
"""

from __future__ import annotations

import hashlib
import ipaddress
import socket
import urllib.parse
from typing import Optional, Tuple
import httpx
from core.logger import research_logger

# ── Allowed thumbnail hosts ─────────────────────────────────────────────────
ALLOWED_THUMBNAIL_HOSTS = frozenset({
    "i.ytimg.com",
    "img.youtube.com",
    "yt3.ggpht.com",
    "yt3.googleusercontent.com",
    "lh3.googleusercontent.com",
})

# ── Limits ──────────────────────────────────────────────────────────────────
MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024  # 10 MB
DOWNLOAD_TIMEOUT_S = 12.0
MAX_RETRIES = 2
VALID_CONTENT_TYPE_PREFIXES = ("image/jpeg", "image/png", "image/webp", "image/gif")


class ThumbnailDownloadError(Exception):
    pass


def _is_private_ip(host: str) -> bool:
    """Return True if host resolves to localhost or private IP range."""
    try:
        addr = socket.gethostbyname(host)
        ip = ipaddress.ip_address(addr)
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
    except Exception:
        return True  # Fail-safe: treat unresolvable as unsafe


def validate_thumbnail_url(url: str) -> str:
    """
    Validate and normalize a thumbnail URL.

    Returns the normalized URL or raises ThumbnailDownloadError.
    Does NOT make any network request.
    """
    url = url.strip()
    parsed = urllib.parse.urlparse(url)

    if parsed.scheme not in ("http", "https"):
        raise ThumbnailDownloadError(f"Protocol not allowed: {parsed.scheme!r}")

    host = parsed.hostname or ""
    if not host:
        raise ThumbnailDownloadError("Missing host in URL")

    # Strip port
    host_clean = host.lower()

    if host_clean not in ALLOWED_THUMBNAIL_HOSTS:
        raise ThumbnailDownloadError(
            f"Host not in allowlist: {host_clean!r}. "
            f"Allowed: {sorted(ALLOWED_THUMBNAIL_HOSTS)}"
        )

    # Force HTTPS
    if parsed.scheme == "http":
        url = url.replace("http://", "https://", 1)

    return url


async def download_thumbnail(url: str, retries: int = MAX_RETRIES) -> bytes:
    """
    Download thumbnail bytes safely.

    - Validates host
    - Checks for private IP SSRF after DNS resolution
    - Validates Content-Type
    - Validates file size
    - Returns raw bytes or raises ThumbnailDownloadError
    """
    url = validate_thumbnail_url(url)
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""

    # SSRF check: resolve DNS and verify IP is public
    if _is_private_ip(host):
        raise ThumbnailDownloadError(f"Host resolves to private IP (SSRF blocked): {host}")

    last_error: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(
                follow_redirects=True,
                max_redirects=3,
                timeout=DOWNLOAD_TIMEOUT_S,
            ) as client:
                response = await client.get(
                    url,
                    headers={"User-Agent": "Mozilla/5.0 (compatible; research-bot/1.0)"},
                )
                if response.status_code != 200:
                    raise ThumbnailDownloadError(
                        f"HTTP {response.status_code} for thumbnail"
                    )

                content_type = response.headers.get("content-type", "").lower()
                if not any(content_type.startswith(p) for p in VALID_CONTENT_TYPE_PREFIXES):
                    raise ThumbnailDownloadError(
                        f"Invalid Content-Type: {content_type!r}"
                    )

                content_length = int(response.headers.get("content-length", 0))
                if content_length > MAX_THUMBNAIL_BYTES:
                    raise ThumbnailDownloadError(
                        f"Thumbnail too large: {content_length} bytes > {MAX_THUMBNAIL_BYTES}"
                    )

                data = await response.aread()
                if len(data) > MAX_THUMBNAIL_BYTES:
                    raise ThumbnailDownloadError(
                        f"Downloaded content too large: {len(data)} bytes"
                    )

                research_logger.debug(
                    f"[ThumbnailDL] Downloaded {len(data)} bytes from host={host}"
                )
                return data

        except ThumbnailDownloadError:
            raise
        except Exception as e:
            last_error = e
            if attempt < retries:
                research_logger.warning(
                    f"[ThumbnailDL] Attempt {attempt+1} failed for host={host}: {type(e).__name__}"
                )

    raise ThumbnailDownloadError(
        f"Download failed after {retries+1} attempts: {type(last_error).__name__}: {last_error}"
    )


def hash_thumbnail(data: bytes) -> str:
    """SHA-256 hash of raw thumbnail bytes for cache key."""
    return hashlib.sha256(data).hexdigest()


def best_thumbnail_url(
    thumbnails: dict,
    fallback_url: str = ""
) -> Tuple[str, str]:
    """
    Pick best-quality thumbnail URL from YouTube snippet.thumbnails dict.

    Returns (url, quality) tuple.
    Quality preference: maxres > standard > high > medium > default
    """
    priority = ["maxres", "standard", "high", "medium", "default"]
    for quality in priority:
        entry = thumbnails.get(quality)
        if entry and isinstance(entry, dict):
            url = entry.get("url", "")
            if url:
                return url, quality
    # Fallback to any available
    for quality, entry in thumbnails.items():
        if isinstance(entry, dict) and entry.get("url"):
            return entry["url"], quality
    return fallback_url, "unknown"
