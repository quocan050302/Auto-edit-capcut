import math
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Tuple
from core.config import ScoringWeights
from utils.parsers import calculate_age_days

def calculate_lifetime_velocity(views: int, published_at: str) -> float:
    age_days = calculate_age_days(published_at)
    return float(views) / max(age_days, 0.04)

def calculate_observed_velocity(
    views_new: int,
    time_new_iso: str,
    views_old: int,
    time_old_iso: str
) -> Optional[float]:
    try:
        t_new = datetime.fromisoformat(time_new_iso.replace("Z", "+00:00"))
        t_old = datetime.fromisoformat(time_old_iso.replace("Z", "+00:00"))
        elapsed_hours = (t_new - t_old).total_seconds() / 3600.0
        if elapsed_hours <= 0.1:
            return None
        delta_views = max(0, views_new - views_old)
        # return views per day observed
        return (delta_views / elapsed_hours) * 24.0
    except Exception:
        return None

def compute_channel_baseline(views_list: List[int]) -> Tuple[float, float, float, float]:
    if not views_list:
        return 0.0, 0.0, 0.0, 0.0

    sorted_views = sorted(views_list)
    n = len(sorted_views)

    # Median
    if n % 2 == 1:
        median = float(sorted_views[n // 2])
    else:
        median = (sorted_views[n // 2 - 1] + sorted_views[n // 2]) / 2.0

    mean = sum(sorted_views) / float(n)

    # P75
    idx_p75 = int(math.ceil(0.75 * n)) - 1
    p75 = float(sorted_views[max(0, min(idx_p75, n - 1))])

    # P90
    idx_p90 = int(math.ceil(0.90 * n)) - 1
    p90 = float(sorted_views[max(0, min(idx_p90, n - 1))])

    return median, mean, p75, p90

def compute_outlier_ratio(video_views: int, channel_median_views: float) -> float:
    baseline = max(channel_median_views, 1.0)
    return round(float(video_views) / baseline, 2)

def normalize_outlier_score(outlier_ratio: float) -> float:
    # 1.0x -> ~20
    # 2.0x -> ~45
    # 5.0x -> ~72
    # 10.0x -> ~85
    # 20.0x+ -> ~95-100
    if outlier_ratio <= 0.2:
        return 5.0
    val = (math.log10(max(outlier_ratio, 0.2)) - math.log10(0.2)) / (math.log10(25.0) - math.log10(0.2)) * 100.0
    return round(max(0.0, min(100.0, val)), 1)

def is_small_channel_breakout(
    views: int,
    outlier_ratio: float,
    channel_subscribers: Optional[int],
    published_at: str,
    channel_median_views: Optional[float] = None
) -> bool:
    age_days = calculate_age_days(published_at)
    
    # Must be relatively fresh (< 120 days)
    if age_days > 120:
        return False

    # Outlier must be at least 4.0x
    if outlier_ratio < 4.0:
        return False

    # Video must have meaningful views
    if views < 30_000:
        return False

    # If subscribers public, must be < 100k
    if channel_subscribers is not None:
        return channel_subscribers < 100_000 and views >= 30_000

    # If subscribers hidden, check channel median views
    if channel_median_views is not None and channel_median_views < 25_000:
        return True

    # Fallback: high outlier (>8x) on decent view count
    return outlier_ratio >= 8.0 and views >= 50_000

def compute_demand_score(views_list: List[int], views_per_day_list: List[float]) -> float:
    if not views_list:
        return 10.0

    # Winsorize top 5% extreme values
    sorted_views = sorted(views_list)
    cutoff_idx = int(len(sorted_views) * 0.95)
    winsorized = sorted_views[:max(1, cutoff_idx)]
    
    median_views = winsorized[len(winsorized) // 2]
    median_vpd = sorted(views_per_day_list)[len(views_per_day_list) // 2] if views_per_day_list else 100.0

    # Log scaling on median views
    # 1,000 views -> 20
    # 50,000 views -> 60
    # 500,000 views -> 85
    # 2,000,000+ views -> 95-100
    score_views = (math.log10(max(median_views, 100)) - 2.0) / (6.3 - 2.0) * 100.0
    score_vpd = (math.log10(max(median_vpd, 10)) - 1.0) / (5.0 - 1.0) * 100.0

    combined = 0.6 * score_views + 0.4 * score_vpd
    return round(max(5.0, min(100.0, combined)), 1)

def compute_velocity_score(views_per_day_list: List[float]) -> float:
    if not views_per_day_list:
        return 10.0

    sorted_vpd = sorted(views_per_day_list)
    # Use P75 to capture rising momentum without being wrecked by a single viral mega-hit
    idx_p75 = int(math.ceil(0.75 * len(sorted_vpd))) - 1
    p75_vpd = sorted_vpd[max(0, min(idx_p75, len(sorted_vpd) - 1))]

    # 100 vpd -> 20
    # 1,000 vpd -> 45
    # 10,000 vpd -> 70
    # 100,000+ vpd -> 95-100
    score = (math.log10(max(p75_vpd, 10)) - 1.0) / (5.2 - 1.0) * 100.0
    return round(max(5.0, min(100.0, score)), 1)

def compute_cross_channel_validation(
    channel_ids: List[str],
    views_list: List[int],
    median_threshold: float = 15_000.0
) -> Tuple[float, int, int]:
    if not channel_ids:
        return 10.0, 0, 0

    unique_channels = len(set(channel_ids))
    total_videos = len(channel_ids)

    # Count high-performing unique channels
    high_perf_channels = set()
    for cid, views in zip(channel_ids, views_list):
        if views >= median_threshold:
            high_perf_channels.add(cid)

    unique_ratio = unique_channels / max(total_videos, 1)
    
    # Score based on unique channels and high performing unique channels
    raw_score = (min(unique_channels, 15) / 15.0) * 50.0 + (min(len(high_perf_channels), 8) / 8.0) * 50.0
    return round(max(10.0, min(100.0, raw_score * unique_ratio)), 1), unique_channels, len(high_perf_channels)

def compute_competition_score(
    video_count: int,
    channel_subscribers: List[Optional[int]],
    titles: List[str],
    small_channel_breakout_count: int
) -> Tuple[float, str]:
    # Factor 1: Share of mega channels (>500k subs)
    known_subs = [s for s in channel_subscribers if s is not None]
    mega_share = sum(1 for s in known_subs if s > 500_000) / max(len(known_subs), 1) if known_subs else 0.4
    
    # Factor 2: Video volume saturation
    vol_factor = min(video_count, 100) / 100.0

    # Factor 3: Breakout presence reduces effective barrier to entry
    breakout_relief = min(small_channel_breakout_count * 8.0, 30.0)

    raw_comp = (mega_share * 50.0 + vol_factor * 50.0) - breakout_relief
    comp_score = round(max(10.0, min(95.0, raw_comp)), 1)

    if comp_score < 40.0:
        level = "LOW"
    elif comp_score < 70.0:
        level = "MEDIUM"
    else:
        level = "HIGH"

    return comp_score, level

def compute_freshness(published_dates: List[str]) -> Tuple[float, str, int, int, int]:
    count_24h = 0
    count_7d = 0
    count_30d = 0

    for pub_str in published_dates:
        age_days = calculate_age_days(pub_str)
        if age_days <= 1.0:
            count_24h += 1
        if age_days <= 7.0:
            count_7d += 1
        if age_days <= 30.0:
            count_30d += 1

    total = max(len(published_dates), 1)
    ratio_7d = count_7d / total
    ratio_30d = count_30d / total

    if count_24h >= 2 or ratio_7d >= 0.35:
        state = "Emerging"
        score = 90.0
    elif count_7d >= 3 or ratio_30d >= 0.50:
        state = "Rising"
        score = 80.0
    elif count_30d >= 2:
        state = "Stable"
        score = 55.0
    else:
        state = "Cooling"
        score = 30.0

    return score, state, count_24h, count_7d, count_30d

def compute_market_fit(
    target_market: str,
    target_language: str,
    video_languages: List[str],
    channel_countries: List[Optional[str]]
) -> Tuple[float, str]:
    # Default signal weights:
    # Target Language Match: 50%
    # Channel Market Signal: 50% (if country available)
    # Note: Labeled "Estimated", no fake private viewer data!

    lang_matches = sum(1 for l in video_languages if l.lower().startswith(target_language.lower()))
    lang_ratio = lang_matches / max(len(video_languages), 1) if video_languages else 0.8

    known_countries = [c.upper() for c in channel_countries if c]
    if known_countries:
        country_matches = sum(1 for c in known_countries if c == target_market.upper())
        country_ratio = country_matches / len(known_countries)
        market_score = (lang_ratio * 0.55 + country_ratio * 0.45) * 100.0
        confidence = "HIGH" if len(known_countries) >= 5 else "MEDIUM"
    else:
        # Dynamic reweighting when channel country is omitted by YouTube
        market_score = lang_ratio * 90.0
        confidence = "MEDIUM" if lang_ratio >= 0.7 else "LOW"

    return round(max(15.0, min(98.0, market_score)), 1), confidence

def compute_opportunity_score(
    demand: float,
    velocity: float,
    outlier: float,
    cross_channel: float,
    market_fit: float,
    freshness: float,
    competition: float,
    weights: Optional[ScoringWeights] = None
) -> float:
    w = weights or ScoringWeights()
    inverse_competition = max(0.0, 100.0 - competition)

    opp = (
        w.demand * demand
        + w.velocity * velocity
        + w.outlier * outlier
        + w.cross_channel * cross_channel
        + w.market_fit * market_fit
        + w.freshness * freshness
        + w.competition * inverse_competition
    )
    return round(max(0.0, min(100.0, opp)), 1)

def compute_confidence_level(
    sample_size: int,
    unique_channels: int,
    has_snapshots: bool,
    provider_source: str
) -> Tuple[str, float]:
    score = 0.0

    # Sample size points (max 40)
    score += min(sample_size / 40.0, 1.0) * 40.0

    # Unique channels points (max 30)
    score += min(unique_channels / 12.0, 1.0) * 30.0

    # Snapshot availability (max 15)
    if has_snapshots:
        score += 15.0
    else:
        score += 5.0

    # Provider reliability (max 15)
    if provider_source in ("OFFICIAL", "MIXED"):
        score += 15.0
    else:
        score += 10.0

    if score >= 75.0:
        return "HIGH", score
    elif score >= 45.0:
        return "MEDIUM", score
    else:
        return "LOW", score
