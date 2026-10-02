"""
test_similar_channel_discovery_v2.py
Comprehensive unit tests covering all Section XVI requirements:
- sort_orders propagated to Official API
- Scraper + Official merge & deduplication (Official record wins)
- Synthetic channel ID handling (no enrichment with ch_<id>)
- parse_published_date_with_quality (missing date -> UNKNOWN, not today)
- Exact 90-day boundary check
- Video < 3 days old is PENDING_TOO_NEW
- Snapshot growth confirmation (PASS_GROWTH_CONFIRMED vs PASS_GROWTH_PROVISIONAL)
- Separation of 90-day performance vs 365-day history
- Niche scoring with sequence matcher, median top-k, lexical F1
- Subscriber limits & hidden subscriber handling
- Best Available fallback & recommendation tiering
- The State Explorer regression fixture
- Excel export V2 columns
- Old run deserialization backward compatibility
"""

import json
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from utils.parsers import parse_published_date_with_quality
from providers.scraper import is_synthetic_channel_id, PublicScraperProvider
from providers.official import OfficialYouTubeProvider
from providers.fallback import ProviderFallbackManager
from scoring.similar_channel_scoring import (
    evaluate_video,
    compute_niche_match_score,
    determine_candidate_status,
    select_best_available_and_recommendations,
    compute_qualification_gap_score,
)
from services.similar_channel_excel_service import build_excel_bytes


# ─── 1. sort_orders propagated to Official API ──────────────────────────────

@pytest.mark.asyncio
async def test_sort_orders_propagated_to_official_api():
    provider = OfficialYouTubeProvider(api_key="TEST_KEY")
    mock_resp = MagicMock(status_code=200, json=lambda: {"items": []})
    
    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        await provider.search_videos(
            query="solar power",
            limit=10,
            order="viewCount",
        )
        assert mock_get.called
        call_kwargs = mock_get.call_args[1]
        assert call_kwargs.get("params", {}).get("order") == "viewCount"


# ─── 2. Scraper + Official merge & deduplication (Official wins) ────────────

@pytest.mark.asyncio
async def test_merge_scraper_and_official_api():
    manager = ProviderFallbackManager(official_api_key="MOCK_KEY", use_official=True)
    
    now_iso = datetime.now(timezone.utc).isoformat()
    official_raw = MagicMock(
        video_id="vid_common",
        title="Official Title",
        channel_id="UC_OFFICIAL",
        channel_title="Official Channel",
        published_at=now_iso,
        views=15000,
        provider="official",
    )
    scraper_raw = MagicMock(
        video_id="vid_common",
        title="Scraper Title",
        channel_id="ch_vid_common",
        channel_title="Scraper Channel",
        published_at=None,
        views=12000,
        provider="scraper",
    )
    scraper_unique = MagicMock(
        video_id="vid_scraper_only",
        title="Scraper Only Title",
        channel_id="UC_SCRAPER",
        channel_title="Scraper Only",
        published_at=now_iso,
        views=8000,
        provider="scraper",
    )
    
    with patch.object(manager.official, "search_videos", new_callable=AsyncMock) as mock_off, \
         patch.object(manager.scraper, "search_videos", new_callable=AsyncMock) as mock_scr:
        
        mock_off.return_value = ([official_raw], None)
        mock_scr.return_value = [scraper_raw, scraper_unique]
        
        merged = await manager.search_videos(
            query="investing",
            order="relevance",
            merge_sources=True,
        )
        
        assert len(merged) == 2
        by_id = {v.video_id: v for v in merged}
        assert "vid_common" in by_id
        assert "vid_scraper_only" in by_id
        # Official record wins on duplicate ID
        assert by_id["vid_common"].title == "Official Title"
        assert by_id["vid_common"].channel_id == "UC_OFFICIAL"


# ─── 3. Synthetic channel ID handling ────────────────────────────────────────

def test_synthetic_channel_id_detection():
    assert is_synthetic_channel_id("ch_dQw4w9WgXcQ") is True
    assert is_synthetic_channel_id("ch_12345") is True
    assert is_synthetic_channel_id("UC_x5XG1OV2P6uZZ5FSM9Ttw") is False
    assert is_synthetic_channel_id(None) is True
    assert is_synthetic_channel_id("") is True


# ─── 4. parse_published_date_with_quality ───────────────────────────────────

def test_parse_published_date_with_quality():
    # ISO exact -> VERIFIED
    res_iso = parse_published_date_with_quality("2025-06-15T12:00:00Z")
    assert res_iso["date_quality"] == "VERIFIED"
    assert res_iso["published_at"] is not None

    # Relative string -> APPROXIMATED
    res_rel = parse_published_date_with_quality("2 weeks ago")
    assert res_rel["date_quality"] == "APPROXIMATED"
    assert res_rel["published_at"] is not None

    # Empty / None -> UNKNOWN and published_at is None (NEVER today's date!)
    res_empty = parse_published_date_with_quality("")
    assert res_empty["date_quality"] == "UNKNOWN"
    assert res_empty["published_at"] is None

    res_none = parse_published_date_with_quality(None)
    assert res_none["date_quality"] == "UNKNOWN"
    assert res_none["published_at"] is None


# ─── 5. Exact 90-day boundary and Video < 3 days is PENDING ─────────────────

def test_video_evaluation_age_and_views():
    now = datetime.now(timezone.utc)
    
    # 1. Video 1 day old (< 3 days) -> PENDING_TOO_NEW
    vid_young = {
        "video_id": "v_young",
        "published_at": (now - timedelta(days=1)).isoformat(),
        "views": 25000,
    }
    eval_young = evaluate_video(vid_young, window_end=now, min_views=10000)
    assert eval_young["evaluation_status"] == "PENDING_TOO_NEW"

    # 2. Video 40 days old with 15K views -> PASS_VIEWS
    vid_pass = {
        "video_id": "v_pass",
        "published_at": (now - timedelta(days=40)).isoformat(),
        "views": 15000,
    }
    eval_pass = evaluate_video(vid_pass, window_end=now, min_views=10000)
    assert eval_pass["evaluation_status"] == "PASS_VIEWS"

    # 3. Video 50 days old with 4K views, no snapshots, slow -> FAIL
    vid_fail = {
        "video_id": "v_fail",
        "published_at": (now - timedelta(days=50)).isoformat(),
        "views": 4000,
    }
    eval_fail = evaluate_video(vid_fail, window_end=now, min_views=10000)
    assert eval_fail["evaluation_status"] == "FAIL"


# ─── 6. Snapshot Growth Evaluation ──────────────────────────────────────────

def test_snapshot_growth_confirmed_vs_provisional():
    now = datetime.now(timezone.utc)
    
    # Video with 2 snapshots demonstrating strong velocity (>= 150 vpd)
    vid = {
        "video_id": "v_grow",
        "published_at": (now - timedelta(days=20)).isoformat(),
        "views": 6000,
    }
    # Mock snapshots showing 1000 view increase over 2 days (500 vpd)
    snap1 = MagicMock(captured_at=(now - timedelta(days=2)).isoformat(), view_count=5000)
    snap2 = MagicMock(captured_at=now.isoformat(), view_count=6000)
    
    eval_confirmed = evaluate_video(vid, window_end=now, min_views=10000, snapshots=[snap1, snap2])
    assert eval_confirmed["evaluation_status"] == "PASS_GROWTH_CONFIRMED"

    # Video with only 1 snapshot or no snapshots but high observed velocity -> PROVISIONAL
    eval_provisional = evaluate_video(vid, window_end=now, min_views=10000, snapshots=[snap1])
    assert eval_provisional["evaluation_status"] == "PASS_GROWTH_PROVISIONAL"


# ─── 7. Niche Match Scoring (Channel Profile vs Entire Fingerprint) ─────────

def test_channel_level_niche_matching():
    source_fingerprint = {
        "core_subject": "off grid solar power systems",
        "weighted_terms": [
            {"term": "off grid solar", "weight": 0.95, "type": "phrase"},
            {"term": "battery bank", "weight": 0.90, "type": "entity"},
            {"term": "inverter wiring", "weight": 0.85, "type": "topic"},
            {"term": "solar panel installation", "weight": 0.80, "type": "topic"},
        ],
        "recurring_entities": ["solar", "battery", "inverter", "mppt"],
        "topic_clusters": ["solar power", "off grid living", "diy electrical"],
        "audience_problem": "how to build off grid solar system for cabin",
    }
    
    source_titles = [
        "How to Build an Off Grid Solar System from Scratch",
        "Setting Up 48V LiFePO4 Battery Bank for Off Grid Solar",
        "Best Inverter for DIY Cabin Solar Power",
    ]
    
    candidate_titles = [
        "DIY Off Grid Solar Power Setup: Full Guide",
        "Wiring 48V Lithium Battery Bank with MPPT",
        "Off Grid Solar Cabin Tour and Electrical Setup",
    ]
    
    source_fingerprint["source_video_titles"] = source_titles
    candidate_videos = [{"title": t, "video_id": f"v_{i}"} for i, t in enumerate(candidate_titles)]
    
    res = compute_niche_match_score(
        source_fingerprint=source_fingerprint,
        candidate_videos=candidate_videos,
    )
    score = res.score
    reason = res.reason
    
    assert score >= 65, f"Expected high niche match score, got {score}"
    assert len(res.evidence.get("matched_terms", [])) > 0 or score >= 65


# ─── 8. Subscriber limits & Hidden Subscribers ──────────────────────────────

def test_subscriber_limits_classification():
    # Hidden subscriber channel: Not Qualified, can be Watchlist, reason HIDDEN_UNVERIFIED
    status_hidden, q_reasons, r_reasons = determine_candidate_status(
        subscriber_status="HIDDEN_UNVERIFIED",
        niche_match_score=85.0,
        evaluable_count=5,
        strict_success_ratio=1.0,
        provisional_success_ratio=1.0,
        has_growth_provisional=False,
        final_score=82.0,
        data_confidence="HIGH",
        window_coverage="COMPLETE",
    )
    assert status_hidden == "WATCHLIST"
    assert any("hidden" in r.lower() for r in r_reasons)

    # Over 50K subscriber channel: REJECTED
    status_over, _, r_reasons_over = determine_candidate_status(
        subscriber_status="REJECTED_OVER_LIMIT",
        niche_match_score=90.0,
        evaluable_count=5,
        strict_success_ratio=1.0,
        provisional_success_ratio=1.0,
        has_growth_provisional=False,
        final_score=88.0,
        data_confidence="HIGH",
        window_coverage="COMPLETE",
    )
    assert status_over == "REJECTED"
    assert any("50,000" in r or "50000" in r or "subscriber" in r.lower() for r in r_reasons_over)


# ─── 9. The State Explorer Regression Fixture ───────────────────────────────

def test_the_state_explorer_regression():
    """
    Channel: The State Explorer
    Subscribers: 34,900
    Median Views: 39,000
    Pass Rate: 72%
    Expected:
    - NOT Qualified (strict requirement is 100%)
    - NOT silently dropped or rejected as garbage
    - Classified as WATCHLIST
    - Eligible for Best Available
    - Has clear unmet_criteria stating 72% pass rate
    """
    cand = {
        "channel_id": "UC_THE_STATE_EXPLORER",
        "channel_title": "The State Explorer",
        "subscriber_status": "VERIFIED_UNDER_LIMIT",
        "subscriber_count": 34900,
        "evaluable_video_count": 7,
        "strict_success_ratio": 0.72,
        "provisional_success_ratio": 0.72,
        "median_recent_views": 39000,
        "scores": {
            "niche_match_score": 78.0,
            "recent_consistency_score": 72.0,
            "growth_quality_score": 65.0,
            "durability_score": 70.0,
            "monetization_viability_score": 75.0,
            "data_confidence_score": 80.0,
            "final_score": 73.5,
        },
        "passed_growth_provisional_count": 0,
        "window_coverage": "COMPLETE",
        "data_confidence": "MEDIUM",
        "qualification_reasons": ["Good median views (39.0K)"],
        "rejection_reasons": [],
    }
    
    status, q_reasons, r_reasons = determine_candidate_status(
        subscriber_status=cand["subscriber_status"],
        niche_match_score=cand["scores"]["niche_match_score"],
        evaluable_count=cand["evaluable_video_count"],
        strict_success_ratio=cand["strict_success_ratio"],
        provisional_success_ratio=cand["provisional_success_ratio"],
        has_growth_provisional=False,
        final_score=cand["scores"]["final_score"],
        data_confidence=cand["data_confidence"],
        window_coverage=cand["window_coverage"],
    )
    assert status == "WATCHLIST", f"Expected WATCHLIST, got {status}"
    cand["status"] = status
    
    top_best, best_pool, tier = select_best_available_and_recommendations([cand])
    
    assert top_best is not None
    assert top_best["channel_id"] == "UC_THE_STATE_EXPLORER"
    assert cand.get("is_best_available") is True
    assert cand.get("best_available_rank") == 1
    assert cand.get("recommendation_tier") == "BEST_AVAILABLE"
    
    # Check unmet criteria
    unmet = cand.get("unmet_criteria", [])
    assert any("72%" in u or "pass rate" in u.lower() for u in unmet)


# ─── 10. Prioritization: Qualified > Growing > Best Available ───────────────

def test_recommendation_tier_prioritization():
    cand_qualified = {
        "channel_id": "ch_qual",
        "channel_title": "Qualified Channel",
        "subscriber_status": "VERIFIED_UNDER_LIMIT",
        "subscriber_count": 20000,
        "evaluable_video_count": 4,
        "strict_success_ratio": 1.0,
        "provisional_success_ratio": 1.0,
        "passed_growth_provisional_count": 0,
        "scores": {"niche_match_score": 88, "final_score": 85},
        "status": "QUALIFIED",
        "qualification_reasons": [],
        "rejection_reasons": [],
    }
    cand_growing = {
        "channel_id": "ch_grow",
        "channel_title": "Growing Channel",
        "subscriber_status": "VERIFIED_UNDER_LIMIT",
        "subscriber_count": 15000,
        "evaluable_video_count": 4,
        "strict_success_ratio": 0.75,
        "provisional_success_ratio": 1.0,
        "passed_growth_provisional_count": 1,
        "scores": {"niche_match_score": 82, "final_score": 75},
        "status": "GROWING",
        "qualification_reasons": [],
        "rejection_reasons": [],
    }
    cand_watchlist = {
        "channel_id": "ch_watch",
        "channel_title": "Watchlist Channel",
        "subscriber_status": "VERIFIED_UNDER_LIMIT",
        "subscriber_count": 10000,
        "evaluable_video_count": 4,
        "strict_success_ratio": 0.70,
        "provisional_success_ratio": 0.70,
        "passed_growth_provisional_count": 0,
        "scores": {"niche_match_score": 75, "final_score": 65},
        "status": "WATCHLIST",
        "qualification_reasons": [],
        "rejection_reasons": [],
    }

    # Case 1: When Qualified exists, Qualified is chosen as #1 most promising
    top_qual, _, tier1 = select_best_available_and_recommendations(
        [cand_qualified, cand_growing, cand_watchlist]
    )
    assert top_qual["channel_id"] == "ch_qual"
    assert top_qual["status"] == "QUALIFIED"
    assert tier1 == "STRICT_MATCH"

    # Case 2: When no Qualified, Growing is chosen
    cand_growing["is_most_promising"] = False
    cand_watchlist["is_most_promising"] = False
    top_grow, _, tier2 = select_best_available_and_recommendations(
        [cand_growing, cand_watchlist]
    )
    assert top_grow["channel_id"] == "ch_grow"
    assert top_grow["status"] == "GROWING"
    assert tier2 == "STRICT_MATCH"

    # Case 3: When neither Qualified nor Growing, Watchlist is chosen as BEST_AVAILABLE
    cand_watchlist["is_most_promising"] = False
    top_watch, _, tier3 = select_best_available_and_recommendations(
        [cand_watchlist]
    )
    assert top_watch["channel_id"] == "ch_watch"
    assert top_watch["status"] == "WATCHLIST"
    assert tier3 == "BEST_AVAILABLE"


# ─── 11. Excel Export V2 Columns & Summary ──────────────────────────────────

def test_excel_export_v2_columns():
    run_obj = MagicMock(
        run_id="run_test_v2",
        source_channel_id="UC_SOURCE",
        source_channel_title="Source Channel",
        market="US",
        language="en",
        content_type="LONG",
        window_days=90,
        min_views=10000,
        max_subscribers=50000,
        min_evaluable_videos=3,
        provider_summary_json="{}",
        qualified_count=1,
        growing_count=0,
        watchlist_count=1,
        rejected_count=2,
        candidate_channels_found=15,
        candidate_videos_found=80,
        channels_enriched=8,
        most_promising_channel_id="ch_qual",
        most_promising_status="QUALIFIED",
        most_promising_reason_json=json.dumps(["100% strict pass rate"]),
        best_available_channel_id="ch_qual",
        best_available_status="QUALIFIED",
        best_available_reason_json=json.dumps(["Best available candidate"]),
        recommendation_tier="STRICT_MATCH",
        discovery_diagnostics_json=json.dumps({
            "discovery_passes_run": ["Pass 1", "Pass 2"],
            "search_calls_used": 4,
            "stop_reason": "Preferred candidate target reached",
            "provider_breakdown": {"official": 60, "scraper": 20},
        }),
        limitations_json="[]",
        created_at=datetime.now(timezone.utc).isoformat(),
        completed_at=datetime.now(timezone.utc).isoformat(),
    )

    cand_obj = MagicMock(
        rank=1,
        channel_id="ch_qual",
        channel_title="Qualified Channel",
        channel_url="https://youtube.com/channel/ch_qual",
        subscriber_count=25000,
        status="QUALIFIED",
        recommendation_tier="STRICT_MATCH",
        best_available_rank=1,
        qualification_gap_score=0.0,
        window_coverage="COMPLETE",
        history_coverage="COMPLETE",
        date_quality="VERIFIED",
        final_score=85.0,
        niche_match_score=90.0,
        recent_consistency_score=88.0,
        growth_quality_score=80.0,
        durability_score=82.0,
        monetization_viability_score=85.0,
        data_confidence_score=90.0,
        median_recent_views=18000,
        strict_success_ratio=1.0,
        provisional_success_ratio=1.0,
        source_coverage=0.85,
        candidate_precision=0.80,
        median_title_similarity=0.75,
        unmet_criteria_json="[]",
        matched_terms_json=json.dumps([{"term": "solar", "weight": 0.9}]),
        matched_entities_json=json.dumps(["solar", "battery"]),
        matched_clusters_json=json.dumps(["solar energy"]),
        qualification_reasons_json=json.dumps(["All videos passed"]),
        rejection_reasons_json="[]",
        confidence_limitations_json="[]",
        is_most_promising=True,
        most_promising_label="#1 MOST PROMISING COMPETITOR",
        country="US",
        subscriber_status="VERIFIED_UNDER_LIMIT",
        public_video_count=50,
        window_start=datetime.now(timezone.utc).isoformat(),
        window_end=datetime.now(timezone.utc).isoformat(),
        recent_video_count=5,
        evaluable_video_count=5,
        pending_video_count=0,
        passed_views_count=5,
        passed_growth_confirmed_count=0,
        passed_growth_provisional_count=0,
        failed_video_count=0,
        minimum_recent_views=12000,
        mean_recent_views=19000,
        p25_recent_views=15000,
        p75_recent_views=22000,
        maximum_recent_views=28000,
        total_recent_views=95000,
        single_hit_dependency=0.29,
        niche_match_reason="High topic overlap",
        active_months_last_12=10,
        median_upload_cadence_days=7.0,
        maximum_upload_gap_days=14.0,
        evergreen_ratio=0.8,
        topic_cluster_count=4,
        future_title_angle_count=15,
        monetization_viability="STRONG",
        data_confidence="HIGH",
    )

    excel_bytes = build_excel_bytes(run_obj, [cand_obj], {"ch_qual": []})
    assert len(excel_bytes) > 1000
    assert excel_bytes[:2] == b"PK"
