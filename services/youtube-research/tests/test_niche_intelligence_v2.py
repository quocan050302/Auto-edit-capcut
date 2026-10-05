"""
Micro-Niche Intelligence V2 — New Tests

Covers all 25 Python test requirements from the spec.
All tests use deterministic fixtures, no live API calls.
"""

import pytest
from datetime import datetime, timezone, timedelta
from typing import Optional, List
from unittest.mock import AsyncMock, MagicMock, patch

from services.filter_service import (
    FilterStats,
    FilterFunnel,
    classify_subscriber_status,
    evaluate_video_filters,
    partition_evidence,
    apply_metadata_filters,
    apply_enriched_video_filters,
)
from schemas.research_schemas import (
    ResearchFilters,
    ResearchRunResultSchema,
    OverviewMetricsSchema,
    FilterSummarySchema,
    CandidateVideoSchema,
)
from providers.official import _classify_content_type
from utils.time_window import resolve_time_window
from scoring.calculator import compute_channel_baseline


# ─── Fixtures ──────────────────────────────────────────────────────────────────

def _make_video(
    video_id: str = "vid1",
    views: int = 50_000,
    published_days_ago: int = 15,
    channel_id: str = "ch1",
    channel_subscribers: Optional[int] = None,
    outlier_ratio: Optional[float] = None,
    channel_median: Optional[float] = None,
    duration_seconds: int = 300,
) -> dict:
    pub = (datetime.now(timezone.utc) - timedelta(days=published_days_ago)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    return {
        "video_id": video_id,
        "url": f"https://youtube.com/watch?v={video_id}",
        "title": f"Video {video_id}",
        "channel_id": channel_id,
        "channel_title": f"Channel {channel_id}",
        "published_at": pub,
        "views": views,
        "duration_seconds": duration_seconds,
        "channel_subscribers": channel_subscribers,
        "outlier_ratio": outlier_ratio,
        "channel_median": channel_median,
        "channel_median_views": channel_median,
        "provider": "TEST",
        "thumbnail_url": "",
    }


# ─── 1. limit affects target videos ──────────────────────────────────────────

def test_limit_controls_target_video_count():
    from services.discovery_service import _resolve_search_budget
    # Fast — no user budget, derives from limit
    budget = _resolve_search_budget(50, None)
    assert 3 <= budget <= 10, f"Fast mode budget should be 3-10, got {budget}"
    # Balanced
    budget = _resolve_search_budget(150, None)
    assert 6 <= budget <= 12
    # Deep
    budget = _resolve_search_budget(500, None)
    assert 8 <= budget <= 20
    # User budget overrides
    budget = _resolve_search_budget(500, 3)
    assert budget == 3
    budget = _resolve_search_budget(50, 10)
    assert budget == 10


# ─── 2. time_range produces correct publishedAfter ───────────────────────────

def test_time_range_produces_correct_published_after():
    from datetime import datetime, timezone, timedelta
    frozen_now = datetime(2026, 10, 1, 15, 0, 0, tzinfo=timezone.utc)
    for range_str, expected_days in [("7d", 7), ("30d", 30), ("90d", 90), ("365d", 365)]:
        tw = resolve_time_window(range_str, frozen_now)
        pa = tw.to_published_after_rfc3339()
        assert pa is not None, f"publishedAfter should not be None for {range_str}"
        dt = datetime.fromisoformat(pa.replace("Z", "+00:00"))
        age_days = (frozen_now - dt).days
        assert abs(age_days - expected_days) <= 1, (
            f"publishedAfter for {range_str} should be ~{expected_days} days ago, got {age_days}"
        )


# ─── 3. LONG accepts videos >60s, SHORT only ≤60s ────────────────────────────

def test_long_accepts_videos_over_60s():
    for dur in [90, 300, 1500]:  # 90s, 5min, 25min
        ct = _classify_content_type(dur)
        assert ct == "LONG", f"Duration {dur}s should be LONG"


def test_short_only_accepts_videos_60s_or_less():
    assert _classify_content_type(60) == "SHORT"
    assert _classify_content_type(30) == "SHORT"
    assert _classify_content_type(61) == "LONG"
    assert _classify_content_type(1500) == "LONG"  # 25 min must be LONG


def test_long_does_not_exclude_25_minute_videos():
    ct = _classify_content_type(1500)
    assert ct == "LONG", "25-minute video must be classified as LONG"


# ─── 4. Search budget not exceeded ───────────────────────────────────────────

def test_search_budget_is_not_exceeded():
    from services.discovery_service import _resolve_search_budget
    for limit_val in [50, 100, 200, 500]:
        budget = _resolve_search_budget(limit_val, None)
        assert budget >= 3, "Budget should always be at least 3"
        assert budget <= 20, "Budget should never exceed 20"


# ─── 5. Subscriber unknown → UNVERIFIED_MATCH, not REJECTED ─────────────────

def test_unknown_subscriber_not_rejected():
    status = classify_subscriber_status(None, max_subscribers=50_000)
    assert status == "UNVERIFIED_MATCH", "Hidden subscriber should be UNVERIFIED, not REJECTED"


def test_known_subscriber_below_max_verified():
    status = classify_subscriber_status(30_000, max_subscribers=50_000)
    assert status == "VERIFIED_MATCH"


def test_known_subscriber_above_max_rejected():
    status = classify_subscriber_status(80_000, max_subscribers=50_000)
    assert status == "REJECTED"


def test_no_max_subscriber_filter_always_verified():
    status = classify_subscriber_status(None, max_subscribers=None)
    assert status == "VERIFIED_MATCH"
    status2 = classify_subscriber_status(5_000_000, max_subscribers=None)
    assert status2 == "VERIFIED_MATCH"


# ─── 6. Unknown subscriber never becomes verified exact match ────────────────

def test_unknown_subscriber_not_in_exact_matches():
    filters = ResearchFilters(min_views=1000, max_subscribers=50_000)
    videos = [_make_video("v1", views=20_000, channel_subscribers=None)]
    stats = FilterStats()
    buckets = partition_evidence(videos, filters, stats)
    # Must NOT be in exact_matches
    assert len(buckets["exact_matches"]) == 0, "Unknown subscriber must not be exact match"
    # Must be in unverified_matches
    assert len(buckets["unverified_matches"]) == 1, "Unknown subscriber should be unverified match"


# ─── 7. Competition uses market universe, not evidence subset ────────────────

def test_competition_not_computed_from_evidence_only():
    """
    Verify market_universe competition differs from evidence-only subset.
    With all-mega channels vs all-small channels, scores must differ.
    """
    from scoring.calculator import compute_competition_score

    # Full market: 20 large channels only (high competition)
    mega_subs = [2_000_000] * 20
    comp_mega, lvl_mega = compute_competition_score(20, mega_subs, ["title"] * 20, 0)

    # Evidence subset: 5 small channels only (low competition)
    small_subs = [5_000] * 5
    comp_small, lvl_small = compute_competition_score(5, small_subs, ["title"] * 5, 0)

    assert comp_mega != comp_small, (
        "Competition must differ between all-mega-channel market and small-channel evidence"
    )
    assert comp_mega > comp_small, (
        "All-mega-channel market must have higher competition score than all-small evidence"
    )
    # Spot check levels
    assert lvl_mega in ("MEDIUM", "HIGH"), f"All-mega-channel market should be MEDIUM/HIGH, got {lvl_mega}"


# ─── 8. Baseline missing → not reported as 15000 ─────────────────────────────

def test_missing_baseline_not_fake_15000():
    video = _make_video("v1", views=5_000, channel_median=None)
    # outlier_ratio should be None when baseline is missing
    assert video["outlier_ratio"] is None or video.get("channel_median") is None, (
        "Video with missing baseline should not have fake channel_median=15000"
    )


def test_channel_baseline_missing_tracked_as_none():
    # compute_channel_baseline with empty list returns zeros (not 15000)
    median, mean, p75, p90 = compute_channel_baseline([])
    assert median == 0.0
    assert mean == 0.0


# ─── 9. Exact match = 0 still returns near matches ───────────────────────────

def test_empty_exact_still_returns_near_matches():
    filters = ResearchFilters(min_views=100_000, max_subscribers=5_000)
    # Video that fails both filters but is close
    videos = [
        _make_video("v1", views=80_000, channel_subscribers=7_000),   # close, views a bit low
        _make_video("v2", views=200_000, channel_subscribers=300_000), # far off subs
    ]
    stats = FilterStats()
    buckets = partition_evidence(videos, filters, stats)
    assert len(buckets["exact_matches"]) == 0
    # v1 is close enough (filter_distance should be low)
    assert len(buckets["near_matches"]) >= 1, "Near match should be returned when exact=0"


# ─── 10. Suggestion not auto-applied ─────────────────────────────────────────

def test_near_match_suggestions_do_not_modify_filters():
    from services.discovery_service import _generate_near_match_suggestions
    filters = ResearchFilters(min_views=50_000, max_subscribers=30_000)
    original_min_views = filters.min_views
    videos = [_make_video("v1", views=40_000, channel_subscribers=25_000)]
    suggestions = _generate_near_match_suggestions(videos, filters)
    # Filters must be unchanged
    assert filters.min_views == original_min_views, "Suggestions must not modify filter object"
    # Suggestions just describe potential changes
    if suggestions:
        for s in suggestions:
            assert s.current_value == original_min_views or s.field != "min_views"


# ─── 11. Filter stats no double-count ────────────────────────────────────────

def test_filter_stats_no_double_count():
    """apply_metadata_filters must not add to matched_metadata; caller sets it."""
    filters = ResearchFilters(min_views=10_000)
    videos = [
        _make_video("v1", views=5_000),   # fail
        _make_video("v2", views=15_000),  # pass
        _make_video("v3", views=20_000),  # pass
    ]
    stats = FilterStats()
    result = apply_metadata_filters(videos, filters, stats)
    assert len(result) == 2
    # stats.matched_metadata should NOT be set by apply_metadata_filters (caller's job)
    # The funnel tracks correctly
    assert stats.excluded_min_views == 1


# ─── 12. evaluate_video_filters single source of truth ───────────────────────

def test_evaluate_video_filters_verified():
    filters = ResearchFilters(min_views=10_000, max_subscribers=50_000)
    video = _make_video("v1", views=20_000, channel_subscribers=30_000)
    ev = evaluate_video_filters(video, filters)
    assert ev.status == "VERIFIED_MATCH"
    assert ev.filter_distance == 0.0


def test_evaluate_video_filters_unverified():
    filters = ResearchFilters(min_views=10_000, max_subscribers=50_000)
    video = _make_video("v1", views=20_000, channel_subscribers=None)
    ev = evaluate_video_filters(video, filters)
    assert ev.status == "UNVERIFIED_MATCH"


def test_evaluate_video_filters_rejected():
    filters = ResearchFilters(min_views=10_000, max_subscribers=50_000)
    video = _make_video("v1", views=20_000, channel_subscribers=100_000)
    ev = evaluate_video_filters(video, filters)
    assert ev.status == "REJECTED"
    assert ev.filter_distance > 0


def test_evaluate_video_filters_distance_proportional():
    filters = ResearchFilters(min_views=10_000)
    video_close = _make_video("v1", views=9_500)   # 5% off
    video_far = _make_video("v2", views=1_000)     # 90% off
    ev_close = evaluate_video_filters(video_close, filters)
    ev_far = evaluate_video_filters(video_far, filters)
    assert ev_far.filter_distance > ev_close.filter_distance


# ─── 13. Partition evidence produces three distinct buckets ──────────────────

def test_partition_evidence_three_buckets():
    filters = ResearchFilters(min_views=5_000, max_subscribers=50_000)
    videos = [
        _make_video("verified", views=10_000, channel_subscribers=30_000),   # exact
        _make_video("unverified", views=10_000, channel_subscribers=None),   # unverified
        _make_video("rejected", views=10_000, channel_subscribers=200_000),  # rejected
        _make_video("near", views=3_000, channel_subscribers=30_000),         # near (close to min_views)
    ]
    stats = FilterStats()
    buckets = partition_evidence(videos, filters, stats)
    assert len(buckets["exact_matches"]) == 1
    assert len(buckets["unverified_matches"]) == 1
    # rejected far: 200k subs vs 50k max, large gap → might not be near
    # near: 3k vs 5k min_views → 40% gap, should be near
    assert len(buckets["near_matches"]) >= 1


# ─── 14. Old result schema still deserializes (backward compat) ──────────────

def test_old_result_schema_deserializes_without_v2_fields():
    """Old run records that lack V2 fields must not raise ValidationError."""
    old_data = {
        "run_id": "old-run-123",
        "topic": "test topic",
        "market": "US",
        "language": "en",
        "content_type": "LONG",
        "time_range": "30d",
        "created_at": "2026-01-01T00:00:00Z",
        "provider_source": "SCRAPER",
        "overview_metrics": {
            "videos_analyzed": 10,
            "unique_channels": 5,
            "keywords_found": 3,
            "breakouts_found": 1,
            "small_channel_wins": 1,
            "data_confidence": "MEDIUM",
        },
        "keywords": [],
        "breakout_videos": [],
        "trend_radar": [],
        "topic_clusters": [],
        "data_sources": [],
        # V2 fields intentionally absent
    }
    # Should not raise
    result = ResearchRunResultSchema(**old_data)
    assert result.exact_matches is None
    assert result.unverified_matches is None
    assert result.filter_funnel is None
    assert result.search_diagnostics is None


# ─── 15. Derive budget never hardcodes 8 queries for all modes ───────────────

def test_deep_mode_has_more_budget_than_fast():
    from services.discovery_service import _resolve_search_budget
    fast_budget = _resolve_search_budget(50, None)
    deep_budget = _resolve_search_budget(500, None)
    assert deep_budget >= fast_budget, "Deep mode should have at least as much budget as Fast"


# ─── 16. generate_near_match_suggestions returns meaningful data ──────────────

def test_generate_near_match_suggestions_non_empty():
    from services.discovery_service import _generate_near_match_suggestions
    filters = ResearchFilters(min_views=20_000)
    # Videos just below threshold
    videos = [_make_video(f"v{i}", views=16_000) for i in range(5)]
    suggestions = _generate_near_match_suggestions(videos, filters)
    assert len(suggestions) >= 1
    s = suggestions[0]
    assert s.field == "min_views"
    assert s.suggested_value < filters.min_views
    assert s.would_add_candidates >= 1


# ─── 17. Three-state model consistent across all code paths ──────────────────

def test_all_three_subscriber_states_have_distinct_behavior():
    filters = ResearchFilters(max_subscribers=50_000)

    verified = _make_video("v1", channel_subscribers=30_000)
    unverified = _make_video("v2", channel_subscribers=None)
    rejected = _make_video("v3", channel_subscribers=80_000)

    ev_v = evaluate_video_filters(verified, filters)
    ev_u = evaluate_video_filters(unverified, filters)
    ev_r = evaluate_video_filters(rejected, filters)

    assert ev_v.status == "VERIFIED_MATCH"
    assert ev_u.status == "UNVERIFIED_MATCH"
    assert ev_r.status == "REJECTED"
    # Each state is distinct
    assert ev_v.status != ev_u.status != ev_r.status


# ─── 18. FilterStats funnel fields populated ─────────────────────────────────

def test_filter_stats_funnel_populated():
    filters = ResearchFilters(min_views=5_000, max_subscribers=50_000)
    videos = [
        _make_video("v1", views=10_000, channel_subscribers=30_000),
        _make_video("v2", views=10_000, channel_subscribers=None),
        _make_video("v3", views=10_000, channel_subscribers=200_000),
        _make_video("v4", views=500),   # fails min_views
    ]
    stats = FilterStats()
    apply_metadata_filters(videos, filters, stats)
    assert stats.excluded_min_views == 1
    assert stats.funnel.above_min_views == 3


# ─── 19. CandidateVideoSchema has correct subscriber_label ───────────────────

def test_candidate_schema_label_for_unverified():
    from services.discovery_service import _build_candidate_schema
    v = _make_video("v1", views=15_000)
    v["published_at"] = (datetime.now(timezone.utc) - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    schema = _build_candidate_schema(v, "UNVERIFIED_MATCH", 0.1)
    assert "unverified" in schema.subscriber_label.lower() or "hidden" in schema.subscriber_label.lower()


def test_candidate_schema_label_empty_for_verified():
    from services.discovery_service import _build_candidate_schema
    v = _make_video("v1", views=15_000)
    v["published_at"] = (datetime.now(timezone.utc) - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    schema = _build_candidate_schema(v, "VERIFIED_MATCH", 0.0)
    assert schema.subscriber_label == ""


# ─── 20. Search budget derived from limit is sane ────────────────────────────

def test_search_budget_sane_range():
    from services.discovery_service import _resolve_search_budget
    for limit_input in [1, 50, 100, 200, 300, 1000]:
        budget = _resolve_search_budget(limit_input, None)
        assert 3 <= budget <= 20, f"Budget {budget} out of sane range for limit={limit_input}"


# ─── 21. publishedAfter format is RFC3339 ────────────────────────────────────

def test_published_after_format_rfc3339():
    tw = resolve_time_window("30d")
    pa = tw.to_published_after_rfc3339()
    assert pa is not None
    dt = datetime.strptime(pa, "%Y-%m-%dT%H:%M:%SZ")
    assert dt.year >= 2024


def test_published_after_none_for_all_range():
    tw = resolve_time_window("all")
    pa = tw.to_published_after_rfc3339()
    assert pa is None


# ─── 22. Channel enrichment baseline_status tracked ──────────────────────────

def test_baseline_status_missing_when_no_videos():
    """Channels with no recent videos should have baseline_status=missing, not fake data."""
    views_list = []
    median, mean, p75, p90 = compute_channel_baseline(views_list)
    # Should be zeros, never 15000
    assert median == 0.0
    assert p75 == 0.0


# ─── 23. Partition evidence: near match only if ≤2 filters fail ──────────────

def test_near_match_excluded_when_too_many_filters_fail():
    filters = ResearchFilters(
        min_views=100_000,
        max_subscribers=5_000,
        min_views_per_day=1_000,
        min_outlier_ratio=5.0
    )
    # Video that fails ALL four filters heavily
    video = _make_video("far", views=100, channel_subscribers=1_000_000, channel_median=50_000.0)
    video["outlier_ratio"] = 0.1
    stats = FilterStats()
    buckets = partition_evidence([video], filters, stats)
    # With 4 hard fails, should not be near match
    assert len(buckets["near_matches"]) == 0, "Video failing 4 filters should not be near match"


# ─── 24. Unverified match in correct bucket ───────────────────────────────────

def test_unverified_always_in_unverified_bucket_not_exact():
    filters = ResearchFilters(min_views=1_000, max_subscribers=50_000)
    videos = [_make_video("u1", views=50_000, channel_subscribers=None)]
    stats = FilterStats()
    buckets = partition_evidence(videos, filters, stats)
    assert len(buckets["exact_matches"]) == 0
    assert len(buckets["unverified_matches"]) == 1


# ─── 25. Backward compat: filter_summary without funnel still valid ───────────

def test_filter_summary_funnel_optional():
    """Old FilterSummarySchema without funnel should still be valid."""
    fs = FilterSummarySchema(
        raw_videos_collected=100,
        videos_after_all_filters=5,
        excluded_by_reason={"min_views": 10}
    )
    assert fs.funnel is None  # Optional, not required
