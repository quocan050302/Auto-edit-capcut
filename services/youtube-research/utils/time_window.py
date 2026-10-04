"""
Time Window Resolver — Micro-Niche Intelligence V2.1

Single source of truth for all time range semantics.
All other modules must import from here instead of re-implementing date math.

Supported time_range values:
    "7d"   = 7 days
    "30d"  = 30 days
    "90d"  = 90 days
    "4m"   = 4 calendar months (relativedelta)
    "5m"   = 5 calendar months
    "6m"   = 6 calendar months
    "365d" = 365 days
    "all"  = no time restriction

Backward-compat aliases (accepted, normalized internally):
    "120d" → "4m"
    "150d" → "5m"
    "180d" → "6m"

All returned datetimes are timezone-aware UTC.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import List, Optional


# ---------------------------------------------------------------------------
# Alias normalization
# ---------------------------------------------------------------------------

_ALIASES: dict[str, str] = {
    "120d": "4m",
    "150d": "5m",
    "180d": "6m",
}


def normalize_time_range(raw: str) -> str:
    """Normalize alias values to canonical keys."""
    return _ALIASES.get(raw.strip().lower(), raw.strip().lower())


# ---------------------------------------------------------------------------
# Calendar-month arithmetic without dateutil dependency
# ---------------------------------------------------------------------------

def _subtract_months(dt: datetime, months: int) -> datetime:
    """
    Subtract `months` calendar months from `dt`, clamping to month end.
    E.g. 2026-10-31 - 1 month = 2026-09-30 (not September 31).
    """
    year = dt.year
    month = dt.month - months
    while month <= 0:
        month += 12
        year -= 1
    # Clamp day to month end
    import calendar
    max_day = calendar.monthrange(year, month)[1]
    day = min(dt.day, max_day)
    return dt.replace(year=year, month=month, day=day)


# ---------------------------------------------------------------------------
# Core data structures
# ---------------------------------------------------------------------------

@dataclass
class TimeBucket:
    """
    A single time bucket for temporal sampling.
    Each bucket gets at least one query pass.
    """
    bucket_index: int           # 0-based
    start_utc: datetime
    end_utc: datetime
    label: str                  # Human-readable, e.g. "Jul 3 – Aug 1"
    raw_results: int = 0
    valid_results: int = 0
    deduplicated_results: int = 0
    provider_calls: int = 0
    out_of_window_dropped: int = 0


@dataclass
class TimeWindow:
    """
    Resolved time window with all bucket info.
    """
    range_key: str              # normalized key, e.g. "90d"
    label: str                  # UI-friendly label
    start_utc: Optional[datetime]
    end_utc: datetime
    buckets: List[TimeBucket] = field(default_factory=list)

    @property
    def is_open_ended(self) -> bool:
        return self.start_utc is None

    def to_published_after_rfc3339(self) -> Optional[str]:
        if self.start_utc is None:
            return None
        return self.start_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    def to_published_before_rfc3339(self) -> str:
        return self.end_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    def is_video_in_window(self, published_at: str) -> bool:
        """Return True if published_at (ISO8601) falls within [start, end]."""
        if not published_at:
            return False
        try:
            pub = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
            if pub.tzinfo is None:
                pub = pub.replace(tzinfo=timezone.utc)
            if self.start_utc and pub < self.start_utc:
                return False
            if pub > self.end_utc:
                return False
            return True
        except Exception:
            return False

    def coverage_summary(self) -> dict:
        total_raw = sum(b.raw_results for b in self.buckets)
        total_valid = sum(b.valid_results for b in self.buckets)
        total_calls = sum(b.provider_calls for b in self.buckets)
        covered = sum(1 for b in self.buckets if b.raw_results > 0)
        return {
            "range_key": self.range_key,
            "label": self.label,
            "start_utc": self.start_utc.isoformat() if self.start_utc else None,
            "end_utc": self.end_utc.isoformat(),
            "bucket_count": len(self.buckets),
            "buckets_covered": covered,
            "total_raw_results": total_raw,
            "total_valid_results": total_valid,
            "total_provider_calls": total_calls,
        }


# ---------------------------------------------------------------------------
# Bucket builders
# ---------------------------------------------------------------------------

def _build_day_buckets(start_utc: datetime, end_utc: datetime, n: int) -> List[TimeBucket]:
    """Divide [start_utc, end_utc] into n equal-ish day buckets."""
    total_seconds = (end_utc - start_utc).total_seconds()
    bucket_seconds = total_seconds / max(n, 1)
    buckets = []
    for i in range(n):
        b_start = start_utc + timedelta(seconds=i * bucket_seconds)
        b_end = start_utc + timedelta(seconds=(i + 1) * bucket_seconds)
        if i == n - 1:
            b_end = end_utc
        label = f"{b_start.strftime('%b %d')} – {b_end.strftime('%b %d')}"
        buckets.append(TimeBucket(
            bucket_index=i,
            start_utc=b_start,
            end_utc=b_end,
            label=label,
        ))
    return buckets


def _build_month_buckets(end_utc: datetime, n_months: int) -> List[TimeBucket]:
    """Build n_months calendar-month buckets ending at end_utc."""
    buckets = []
    current_end = end_utc
    for i in range(n_months - 1, -1, -1):
        current_start = _subtract_months(current_end, 1)
        label = f"{current_start.strftime('%b %d')} – {current_end.strftime('%b %d')}"
        buckets.append(TimeBucket(
            bucket_index=i,
            start_utc=current_start,
            end_utc=current_end,
            label=label,
        ))
        current_end = current_start
    # Sort chronologically (oldest first)
    buckets.reverse()
    for i, b in enumerate(buckets):
        b.bucket_index = i
    return buckets


# ---------------------------------------------------------------------------
# Main resolver
# ---------------------------------------------------------------------------

def resolve_time_window(
    time_range: str,
    now_utc: Optional[datetime] = None,
) -> TimeWindow:
    """
    Resolve a time_range string into a TimeWindow with temporal buckets.

    Args:
        time_range: One of "7d", "30d", "90d", "4m", "5m", "6m", "365d", "all"
                    or aliases "120d" → "4m", "150d" → "5m", "180d" → "6m"
        now_utc:    Override for current UTC time (useful in tests).

    Returns:
        TimeWindow with start_utc, end_utc, buckets and metadata.
    """
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)

    key = normalize_time_range(time_range)

    # ── Open-ended ("all") ───────────────────────────────────────────────────
    if key == "all":
        return TimeWindow(
            range_key="all",
            label="All Time",
            start_utc=None,
            end_utc=now_utc,
            buckets=[TimeBucket(
                bucket_index=0,
                start_utc=now_utc - timedelta(days=3650),  # 10y safety
                end_utc=now_utc,
                label="All Time",
            )],
        )

    # ── Day-based ranges ─────────────────────────────────────────────────────
    day_configs = {
        "7d":   (7,   1, "Last 7 Days"),
        "30d":  (30,  2, "Last 30 Days"),
        "90d":  (90,  3, "Last 90 Days"),
        "365d": (365, 6, "Last 12 Months"),
    }
    if key in day_configs:
        days, n_buckets, label = day_configs[key]
        start_utc = now_utc - timedelta(days=days)
        buckets = _build_day_buckets(start_utc, now_utc, n_buckets)
        return TimeWindow(
            range_key=key,
            label=label,
            start_utc=start_utc,
            end_utc=now_utc,
            buckets=buckets,
        )

    # ── Month-based ranges ───────────────────────────────────────────────────
    month_configs = {
        "4m": (4, "Last 4 Months"),
        "5m": (5, "Last 5 Months"),
        "6m": (6, "Last 6 Months"),
    }
    if key in month_configs:
        n_months, label = month_configs[key]
        start_utc = _subtract_months(now_utc, n_months)
        buckets = _build_month_buckets(now_utc, n_months)
        return TimeWindow(
            range_key=key,
            label=label,
            start_utc=start_utc,
            end_utc=now_utc,
            buckets=buckets,
        )

    # ── Unknown / fallback → treat as 30 days ────────────────────────────────
    start_utc = now_utc - timedelta(days=30)
    return TimeWindow(
        range_key="30d",
        label="Last 30 Days (fallback)",
        start_utc=start_utc,
        end_utc=now_utc,
        buckets=_build_day_buckets(start_utc, now_utc, 2),
    )
