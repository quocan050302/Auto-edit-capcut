"""
Filter Service — Micro-Niche Intelligence V2

Key design:
- market_universe: ALL videos matching topic/time/format (used for competition, demand, supply)
- matching_evidence: videos that pass advanced filters (used for small-channel proof, exact matches)

Subscriber states:
  VERIFIED_MATCH   — subscriber known AND ≤ max_subscribers
  UNVERIFIED_MATCH — subscriber hidden/unknown, video meets other criteria
  REJECTED         — subscriber known AND > max_subscribers (or other hard fail)

Filter funnel is tracked granularly to explain empty states.
No silent filter relaxation.
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any, Literal
import logging
from schemas.research_schemas import (
    ResearchFilters,
    KeywordRecordSchema,
)

logger = logging.getLogger(__name__)


# ─── Subscriber Match Status ──────────────────────────────────────────────────

SubscriberStatus = Literal["VERIFIED_MATCH", "UNVERIFIED_MATCH", "REJECTED"]


def classify_subscriber_status(
    channel_subscribers: Optional[int],
    max_subscribers: Optional[int],
) -> SubscriberStatus:
    """
    Three-state subscriber classification.
    VERIFIED_MATCH   : subscriber public AND ≤ max_subscribers (or no max set)
    UNVERIFIED_MATCH : subscriber hidden (None) when max_subscribers is set
    REJECTED         : subscriber public AND > max_subscribers
    """
    if max_subscribers is None:
        return "VERIFIED_MATCH"  # No subscriber filter active
    if channel_subscribers is None:
        return "UNVERIFIED_MATCH"  # Hidden — cannot verify
    if channel_subscribers <= max_subscribers:
        return "VERIFIED_MATCH"
    return "REJECTED"


# ─── Filter Funnel (minh bạch, không double-count) ───────────────────────────

@dataclass
class FilterFunnel:
    """Granular per-stage counts. Each video counted exactly once per stage."""
    raw_collected: int = 0
    unique_after_dedupe: int = 0
    after_time_range: int = 0
    after_content_type: int = 0

    # Metadata-level
    above_min_views: int = 0
    above_min_vpd: int = 0

    # Enriched-level (after channel baseline)
    above_min_outlier: int = 0

    # Subscriber-level
    subscriber_known: int = 0       # subset whose sub count is public
    subscriber_unknown: int = 0     # subset with hidden subs
    below_max_subscribers: int = 0  # verified ≤ max_subscribers

    # Final buckets
    exact_matches: int = 0          # VERIFIED_MATCH + all other filters pass
    unverified_matches: int = 0     # UNVERIFIED_MATCH + other filters pass
    near_matches: int = 0           # close but not all filters pass

    # Exclusion reasons (for "why no results" UI)
    excluded_min_views: int = 0
    excluded_min_vpd: int = 0
    excluded_max_subscribers: int = 0
    excluded_unknown_subscribers: int = 0  # those dropped (pre-v2, now kept as unverified)
    excluded_min_outlier: int = 0
    excluded_missing_baseline: int = 0
    excluded_min_opportunity: int = 0
    excluded_max_competition: int = 0


# ─── Legacy FilterStats (kept for backward compat with existing callers) ─────

@dataclass
class FilterStats:
    """Backward-compatible stats object. Delegates to FilterFunnel internally."""
    raw_videos: int = 0
    matched_metadata: int = 0
    matched_enriched: int = 0
    matched_keywords: int = 0
    excluded_min_views: int = 0
    excluded_min_views_per_day: int = 0
    excluded_max_subscribers: int = 0
    excluded_unknown_subscribers: int = 0
    excluded_min_outlier: int = 0
    excluded_missing_baseline: int = 0
    excluded_min_opportunity: int = 0
    excluded_max_competition: int = 0

    # V2 additions
    videos_after_metadata_filters: int = 0
    videos_after_all_filters: int = 0
    keywords_before_filters: int = 0
    keywords_after_filters: int = 0

    funnel: FilterFunnel = field(default_factory=FilterFunnel)


# ─── Video Filter Evaluation ─────────────────────────────────────────────────

@dataclass
class FilterEvaluation:
    """
    Per-video filter evaluation result.
    status: VERIFIED_MATCH | UNVERIFIED_MATCH | REJECTED
    passed: list of filter names that passed
    failed: list of filter names that failed hard
    unknown: list of filter names that could not be evaluated (missing data)
    filter_distance: 0.0 = perfect match, higher = farther from passing
    """
    status: str = "REJECTED"
    passed: List[str] = field(default_factory=list)
    failed: List[str] = field(default_factory=list)
    unknown: List[str] = field(default_factory=list)
    filter_distance: float = 0.0
    failure_reasons: Dict[str, str] = field(default_factory=dict)


def evaluate_video_filters(
    video: Any,
    filters: ResearchFilters,
) -> FilterEvaluation:
    """
    Evaluate a single video against all filters.
    Returns FilterEvaluation with status, passed/failed lists, and filter_distance.
    This is the single source of truth for filter decisions.
    """
    from datetime import datetime, timezone

    def get(key: str, default: Any = None) -> Any:
        if isinstance(video, dict):
            return video.get(key, default)
        return getattr(video, key, default)

    eval_result = FilterEvaluation()
    gaps: Dict[str, float] = {}

    # ── min_views ─────────────────────────────────────────────────────────────
    views = get("views", 0) or 0
    if filters.min_views is not None:
        if views >= filters.min_views:
            eval_result.passed.append("min_views")
        else:
            gap = max(0, filters.min_views - views) / max(filters.min_views, 1)
            gaps["min_views"] = gap
            eval_result.failed.append("min_views")
            eval_result.failure_reasons["min_views"] = (
                f"views={views:,} < required {filters.min_views:,}"
            )

    # ── min_views_per_day ─────────────────────────────────────────────────────
    if filters.min_views_per_day is not None:
        published_at = get("published_at")
        vpd = get("views_per_day")
        if vpd is None and published_at:
            try:
                pub_dt = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                age_days = (datetime.now(timezone.utc) - pub_dt).total_seconds() / 86400.0
                age_days = max(age_days, 1.0)
                vpd = views / age_days
            except Exception:
                vpd = None

        if vpd is None:
            eval_result.unknown.append("min_views_per_day")
        elif vpd >= filters.min_views_per_day:
            eval_result.passed.append("min_views_per_day")
        else:
            gap = max(0, filters.min_views_per_day - vpd) / max(filters.min_views_per_day, 1.0)
            gaps["min_views_per_day"] = gap
            eval_result.failed.append("min_views_per_day")
            eval_result.failure_reasons["min_views_per_day"] = (
                f"vpd={vpd:.1f} < required {filters.min_views_per_day:.1f}"
            )

    # ── max_subscribers ───────────────────────────────────────────────────────
    subs = get("channel_subscribers")
    sub_status = classify_subscriber_status(subs, filters.max_subscribers)

    if filters.max_subscribers is not None:
        if sub_status == "VERIFIED_MATCH":
            eval_result.passed.append("max_subscribers")
        elif sub_status == "UNVERIFIED_MATCH":
            eval_result.unknown.append("max_subscribers")
        else:  # REJECTED
            gap = max(0, (subs or 0) - filters.max_subscribers) / max(filters.max_subscribers, 1)
            gaps["max_subscribers"] = gap
            eval_result.failed.append("max_subscribers")
            eval_result.failure_reasons["max_subscribers"] = (
                f"subscribers={subs:,} > max {filters.max_subscribers:,}"
            )

    # ── min_outlier_ratio ─────────────────────────────────────────────────────
    if filters.min_outlier_ratio is not None:
        outlier = get("outlier_ratio")
        baseline = get("channel_median_views") or get("channel_median")

        if outlier is None or baseline is None:
            eval_result.unknown.append("min_outlier_ratio")
        elif outlier >= filters.min_outlier_ratio:
            eval_result.passed.append("min_outlier_ratio")
        else:
            gap = max(0, filters.min_outlier_ratio - outlier) / max(filters.min_outlier_ratio, 0.1)
            gaps["min_outlier_ratio"] = gap
            eval_result.failed.append("min_outlier_ratio")
            eval_result.failure_reasons["min_outlier_ratio"] = (
                f"outlier={outlier:.2f}x < required {filters.min_outlier_ratio:.2f}x"
            )

    # ── Determine overall status ──────────────────────────────────────────────
    hard_fails = [f for f in eval_result.failed if f != "max_subscribers" or sub_status == "REJECTED"]

    if not hard_fails:
        if sub_status == "UNVERIFIED_MATCH":
            eval_result.status = "UNVERIFIED_MATCH"
        else:
            eval_result.status = "VERIFIED_MATCH"
    else:
        eval_result.status = "REJECTED"

    # ── Compute filter_distance ───────────────────────────────────────────────
    if gaps:
        eval_result.filter_distance = round(sum(gaps.values()) / len(gaps), 4)
    else:
        eval_result.filter_distance = 0.0

    return eval_result


# ─── Helpers ──────────────────────────────────────────────────────────────────

def get_val(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def get_active_filters(filters: ResearchFilters) -> Dict[str, float]:
    result = {}
    if filters.min_views is not None:
        result["min_views"] = float(filters.min_views)
    if filters.max_subscribers is not None:
        result["max_subscribers"] = float(filters.max_subscribers)
    if filters.min_views_per_day is not None:
        result["min_views_per_day"] = filters.min_views_per_day
    if filters.min_outlier_ratio is not None:
        result["min_outlier_ratio"] = filters.min_outlier_ratio
    if filters.min_opportunity is not None:
        result["min_opportunity"] = filters.min_opportunity
    if filters.max_competition is not None:
        result["max_competition"] = filters.max_competition
    return result


# ─── apply_metadata_filters (market-level, minimal pre-filter) ───────────────

def apply_metadata_filters(
    videos: List[Any],
    filters: ResearchFilters,
    stats: FilterStats,
) -> List[Any]:
    """
    Apply only METADATA-level filters (min_views, min_vpd).
    Does NOT apply subscriber or outlier filters — those belong to matching_evidence.

    This preserves market_universe integrity: competition and demand are computed
    from the full market, not just the verified-small-channel subset.
    """
    from datetime import datetime, timezone

    if not videos:
        return []

    min_views = filters.min_views
    min_vpd = filters.min_views_per_day

    filtered: List[Any] = []
    for v in videos:
        valid = True

        if min_views is not None:
            views = get_val(v, "views", 0)
            if views < min_views:
                stats.excluded_min_views += 1
                stats.funnel.excluded_min_views += 1
                valid = False

        if valid and min_vpd is not None:
            views = get_val(v, "views", 0)
            published_at = get_val(v, "published_at")
            vpd = 0.0
            if published_at:
                try:
                    pub_dt = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                    age_days = (datetime.now(timezone.utc) - pub_dt).total_seconds() / 86400.0
                    age_days = max(age_days, 1.0)
                    vpd = views / age_days
                except Exception:
                    pass
            if vpd < min_vpd:
                stats.excluded_min_views_per_day += 1
                stats.funnel.excluded_min_vpd += 1
                valid = False

        if valid:
            filtered.append(v)

    # DO NOT overwrite stats.matched_metadata here — caller sets it after dedup.
    # (Prevents the double-count bug where caller did += len(filtered) again)
    stats.funnel.above_min_views = len(filtered)
    return filtered


# ─── partition_evidence — builds exact / unverified / near match lists ────────

def partition_evidence(
    videos: List[Any],
    filters: ResearchFilters,
    stats: FilterStats,
    max_near: int = 20,
) -> Dict[str, List[Any]]:
    """
    Partition enriched videos into three buckets:
      exact_matches      — VERIFIED_MATCH (all hard filters pass, subscriber verified ≤ max)
      unverified_matches — UNVERIFIED_MATCH (subscriber hidden, other filters pass)
      near_matches       — REJECTED but close (filter_distance low, ≤2 failing criteria)
    """
    exact: List[Any] = []
    unverified: List[Any] = []
    near_candidates: List[Any] = []

    for v in videos:
        ev = evaluate_video_filters(v, filters)

        if ev.status == "VERIFIED_MATCH":
            exact.append(v)
            stats.funnel.exact_matches += 1
        elif ev.status == "UNVERIFIED_MATCH":
            unverified.append(v)
            stats.funnel.unverified_matches += 1
            stats.excluded_unknown_subscribers += 1  # legacy compat counter
        else:
            # Near match: only 1–2 failing criteria AND distance not too large
            if len(ev.failed) <= 2 and ev.filter_distance <= 0.5:
                near_candidates.append((ev.filter_distance, v))

    # Sort near matches by distance ascending (closest first)
    near_candidates.sort(key=lambda t: t[0])
    near = [v for _, v in near_candidates[:max_near]]
    stats.funnel.near_matches = len(near)

    return {
        "exact_matches": exact,
        "unverified_matches": unverified,
        "near_matches": near,
    }


# ─── apply_enriched_video_filters (for backward compat with existing caller) ──

def apply_enriched_video_filters(
    videos: List[Any],
    filters: ResearchFilters,
    stats: FilterStats,
) -> List[Any]:
    """
    V2: Returns only VERIFIED_MATCH videos (for backward compat with callers that
    expect a flat filtered list). Side-effects stats with all three buckets.

    Callers that want unverified and near should use partition_evidence() directly.
    """
    buckets = partition_evidence(videos, filters, stats)
    exact = buckets["exact_matches"]

    # Update legacy stats
    stats.matched_enriched = len(exact)
    stats.excluded_max_subscribers = stats.funnel.excluded_max_subscribers

    # Track subscriber counts
    subs_known = sum(1 for v in videos if get_val(v, "channel_subscribers") is not None)
    stats.funnel.subscriber_known = subs_known
    stats.funnel.subscriber_unknown = len(videos) - subs_known

    return exact


# ─── apply_keyword_filters ────────────────────────────────────────────────────

def apply_keyword_filters(
    keywords: List[KeywordRecordSchema],
    filters: ResearchFilters,
    stats: FilterStats,
) -> List[KeywordRecordSchema]:
    if not keywords:
        stats.matched_keywords = 0
        return []

    min_opp = filters.min_opportunity
    max_comp = filters.max_competition

    filtered: List[KeywordRecordSchema] = []
    for kw in keywords:
        valid = True
        if min_opp is not None:
            if kw.opportunity_score < min_opp:
                stats.excluded_min_opportunity += 1
                stats.funnel.excluded_min_opportunity += 1
                valid = False

        if valid and max_comp is not None:
            if kw.competition_score > max_comp:
                stats.excluded_max_competition += 1
                stats.funnel.excluded_max_competition += 1
                valid = False

        if valid:
            filtered.append(kw)

    stats.matched_keywords = len(filtered)
    return filtered
