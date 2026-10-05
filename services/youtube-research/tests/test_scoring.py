import pytest
from datetime import datetime, timezone, timedelta
from scoring.calculator import (
    calculate_lifetime_velocity,
    calculate_observed_velocity,
    compute_channel_baseline,
    compute_outlier_ratio,
    normalize_outlier_score,
    is_small_channel_breakout,
    compute_demand_score,
    compute_velocity_score,
    compute_cross_channel_validation,
    compute_competition_score,
    compute_freshness,
    compute_market_fit,
    compute_opportunity_score,
    compute_confidence_level
)

def test_channel_baseline():
    views = [10_000, 20_000, 30_000, 40_000, 50_000]
    median, mean, p75, p90 = compute_channel_baseline(views)
    assert median == 30_000.0
    assert mean == 30_000.0
    assert p75 == 40_000.0
    assert p90 == 50_000.0

def test_outlier_ratio_and_score():
    ratio = compute_outlier_ratio(400_000, 20_000.0)
    assert ratio == 20.0
    score = normalize_outlier_score(ratio)
    assert score >= 90.0

def test_golden_small_channel_breakout():
    # Prompt golden test:
    # Channel: 10K subscribers, median 20K views
    # Video: 400K views, 3 days old
    # Expected: Outlier 20x, approx 133k views/day, Small Channel Breakout = True
    now = datetime.now(timezone.utc)
    pub_3d = (now - timedelta(days=3)).isoformat()
    
    vpd = calculate_lifetime_velocity(400_000, pub_3d)
    assert 130_000 <= vpd <= 135_000

    outlier = compute_outlier_ratio(400_000, 20_000.0)
    assert outlier == 20.0

    breakout = is_small_channel_breakout(
        views=400_000,
        outlier_ratio=outlier,
        channel_subscribers=10_000,
        published_at=pub_3d,
        channel_median_views=20_000.0
    )
    assert breakout is True

def test_observed_vs_lifetime_velocity():
    # Lifetime velocity
    now = datetime.now(timezone.utc)
    pub_3d = (now - timedelta(days=3)).isoformat()
    lifetime_vpd = calculate_lifetime_velocity(180_000, pub_3d)
    assert 59_000 <= lifetime_vpd <= 61_000

    # Observed velocity between two snapshots:
    # 09:00 -> 120,000 views
    # 21:00 -> 180,000 views (delta = 60,000 in 12 hours -> 5,000 views/hr = 120,000 views/day)
    time_09 = "2026-10-01T09:00:00+00:00"
    time_21 = "2026-10-01T21:00:00+00:00"
    observed_vpd = calculate_observed_velocity(
        views_new=180_000,
        time_new_iso=time_21,
        views_old=120_000,
        time_old_iso=time_09
    )
    assert observed_vpd == 120_000.0

def test_cross_channel_validation():
    # 10 videos all from 1 channel
    single_c = ["ch_1"] * 10
    score_single, u_ch1, _ = compute_cross_channel_validation(single_c, [50_000]*10)
    
    # 10 videos across 8 independent channels
    multi_c = [f"ch_{i}" for i in range(8)] + ["ch_0", "ch_1"]
    score_multi, u_ch2, _ = compute_cross_channel_validation(multi_c, [50_000]*10)

    assert u_ch1 == 1
    assert u_ch2 == 8
    assert score_multi > score_single

def test_competition_scoring():
    # Low competition with small breakouts
    comp_low, lvl_low = compute_competition_score(
        video_count=15,
        channel_subscribers=[50_000, 20_000, 10_000],
        titles=["test 1", "test 2"],
        small_channel_breakout_count=3
    )
    assert lvl_low == "LOW"
    assert comp_low < 40.0

def test_freshness_classification():
    now = datetime.now(timezone.utc)
    dates_emerging = [(now - timedelta(hours=i*3)).isoformat() for i in range(5)]
    score, state, c24, c7, c30 = compute_freshness(dates_emerging)
    assert state == "Emerging"
    assert c24 >= 2

def test_opportunity_formula():
    opp = compute_opportunity_score(
        demand=80.0,
        velocity=85.0,
        outlier=90.0,
        cross_channel=75.0,
        market_fit=90.0,
        freshness=80.0,
        competition=30.0 # inverse competition = 70.0
    )
    # Expected: 0.2*80 + 0.2*85 + 0.2*90 + 0.1*75 + 0.1*90 + 0.1*80 + 0.1*70
    # = 16 + 17 + 18 + 7.5 + 9.0 + 8.0 + 7.0 = 82.5
    assert opp == 82.5
