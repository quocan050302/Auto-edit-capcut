"""
similar_channel_scoring.py — Deterministic scoring for similar-channel candidates.
"""
from __future__ import annotations
import re
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any, Tuple

CANDIDATE_STATUS_QUALIFIED = "QUALIFIED"
CANDIDATE_STATUS_GROWING   = "GROWING"
CANDIDATE_STATUS_WATCHLIST = "WATCHLIST"
CANDIDATE_STATUS_REJECTED  = "REJECTED"

SUBSCRIBER_VERIFIED_UNDER   = "VERIFIED_UNDER_LIMIT"
SUBSCRIBER_HIDDEN           = "HIDDEN_UNVERIFIED"
SUBSCRIBER_REJECTED_OVER    = "REJECTED_OVER_LIMIT"

VIDEO_PASS_VIEWS              = "PASS_VIEWS"
VIDEO_PASS_GROWTH_CONFIRMED   = "PASS_GROWTH_CONFIRMED"
VIDEO_PASS_GROWTH_PROVISIONAL = "PASS_GROWTH_PROVISIONAL"
VIDEO_PENDING_TOO_NEW         = "PENDING_TOO_NEW"
VIDEO_FAIL                    = "FAIL"
VIDEO_EXCLUDED                = "EXCLUDED"

CONFIDENCE_HIGH         = "HIGH"
CONFIDENCE_MEDIUM       = "MEDIUM"
CONFIDENCE_LOW          = "LOW"
CONFIDENCE_INSUFFICIENT = "INSUFFICIENT"

STOP_WORDS = {
    "the","a","an","and","or","but","in","on","at","to","for","of","with","is","are",
    "was","were","be","been","being","have","has","had","do","does","did","will","would",
    "could","should","may","might","shall","can","this","that","these","those","my","your",
    "his","her","its","our","their","i","you","he","she","it","we","they","what","which",
    "who","not","no","so","if","as","up","out","by","from","into","than","then","when",
    "how","why","where","about","after","before","more","most","also","just","now","new",
    "all","get","vs","video","youtube",
}

EVERGREEN_KEYWORDS = {"how","why","what","best","top","guide","tutorial","tips","learn",
    "truth","secret","never","always","history","science","explained","works","does",
    "should","really","actually","proven"}

NEWS_KEYWORDS = {"today","breaking","just","now","2024","2025","2026","latest","update",
    "news","reaction","responds","announces","official","season","episode","vs","match",
    "game","live"}

REUSE_SIGNALS = {"compilation","react","reacts","reaction","watch","watching","story time",
    "storytime","shorts compilation","clips","moments","funny moments","best moments",
    "top moments","tries","attempts"}

STATUS_PRIORITY = {
    CANDIDATE_STATUS_QUALIFIED: 4,
    CANDIDATE_STATUS_GROWING: 3,
    CANDIDATE_STATUS_WATCHLIST: 2,
    CANDIDATE_STATUS_REJECTED: 1,
}


def _tokenize(title: str) -> List[str]:
    words = re.findall(r"\b\w{3,}\b", title.lower())
    return [w for w in words if w not in STOP_WORDS]


def _parse_utc(iso_str: str) -> Optional[datetime]:
    if not iso_str:
        return None
    try:
        clean = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _clamp(val: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, val))


def _percentile(sorted_vals: List[float], p: float) -> Optional[float]:
    if not sorted_vals:
        return None
    idx = (len(sorted_vals) - 1) * p / 100.0
    lo = int(idx)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = idx - lo
    return sorted_vals[lo] + frac * (sorted_vals[hi] - sorted_vals[lo])


def evaluate_video(
    video: Dict[str, Any],
    window_end: datetime,
    min_views: int = 10_000,
    snapshots: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    published_at = _parse_utc(video.get("published_at", ""))
    if published_at is None:
        return {"evaluation_status": VIDEO_EXCLUDED, "growth_status": "UNKNOWN",
                "evaluation_reason": "Missing or invalid published_at",
                "lifetime_vpd": 0.0, "observed_vpd": None,
                "projected_day_90": None, "snapshot_count": 0}

    now = window_end
    age_days = (now - published_at).total_seconds() / 86400.0
    if age_days < 0:
        return {"evaluation_status": VIDEO_EXCLUDED, "growth_status": "UNKNOWN",
                "evaluation_reason": "Published date is in the future (data anomaly)",
                "lifetime_vpd": 0.0, "observed_vpd": None,
                "projected_day_90": None, "snapshot_count": 0}

    views = int(video.get("views", 0) or 0)
    lifetime_vpd = views / max(age_days, 1.0)
    snap_count = len(snapshots) if snapshots else 0

    if age_days < 3:
        return {"evaluation_status": VIDEO_PENDING_TOO_NEW, "growth_status": VIDEO_PENDING_TOO_NEW,
                "evaluation_reason": f"Video is only {age_days:.1f} days old; awaiting data maturity",
                "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": None,
                "projected_day_90": None, "snapshot_count": snap_count}

    if views >= min_views:
        return {"evaluation_status": VIDEO_PASS_VIEWS, "growth_status": VIDEO_PASS_VIEWS,
                "evaluation_reason": f"{views:,} views >= {min_views:,} threshold",
                "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": None,
                "projected_day_90": None, "snapshot_count": snap_count}

    remaining_days = max(90.0 - age_days, 7.0)
    required_vpd = max(100.0, (min_views - views) / remaining_days)
    projected_day_90 = None
    observed_vpd = None
    valid_snaps = []

    if snapshots and len(snapshots) >= 2:
        valid_snaps = sorted(
            [s for s in snapshots if s.get("view_count") is not None and s.get("captured_at")],
            key=lambda s: s["captured_at"])
        if len(valid_snaps) >= 2:
            oldest = valid_snaps[0]
            newest = valid_snaps[-1]
            dt_old = _parse_utc(oldest["captured_at"])
            dt_new = _parse_utc(newest["captured_at"])
            if dt_old and dt_new:
                elapsed = (dt_new - dt_old).total_seconds() / 86400.0
                delta_views = newest["view_count"] - oldest["view_count"]
                if elapsed >= 0.25 and delta_views >= 0:
                    observed_vpd = delta_views / elapsed
                    projected_day_90 = views + observed_vpd * remaining_days

    projected_lifetime = views + lifetime_vpd * remaining_days

    if observed_vpd is not None and projected_day_90 is not None:
        velocity_retention = observed_vpd / max(lifetime_vpd, 1.0)
        delta_views_recent = valid_snaps[-1]["view_count"] - valid_snaps[0]["view_count"] if valid_snaps else 0
        growth_confirmed = (
            projected_day_90 >= min_views
            and observed_vpd >= required_vpd * 1.20
            and observed_vpd >= 100.0
            and velocity_retention >= 0.80
            and delta_views_recent >= max(500, views * 0.05)
        )
        if growth_confirmed:
            return {"evaluation_status": VIDEO_PASS_GROWTH_CONFIRMED,
                    "growth_status": VIDEO_PASS_GROWTH_CONFIRMED,
                    "evaluation_reason": f"Observed VPD {observed_vpd:.0f} >= required {required_vpd:.0f}; projected day-90: {projected_day_90:,.0f} views",
                    "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": round(observed_vpd, 2),
                    "projected_day_90": round(projected_day_90, 1), "snapshot_count": snap_count}
        else:
            return {"evaluation_status": VIDEO_FAIL, "growth_status": VIDEO_FAIL,
                    "evaluation_reason": f"Observed VPD {observed_vpd:.0f} < required {required_vpd:.0f}",
                    "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": round(observed_vpd, 2),
                    "projected_day_90": round(projected_day_90, 1) if projected_day_90 else None,
                    "snapshot_count": snap_count}

    if age_days <= 30 and projected_lifetime >= min_views and lifetime_vpd >= required_vpd * 1.50:
        return {"evaluation_status": VIDEO_PASS_GROWTH_PROVISIONAL,
                "growth_status": VIDEO_PASS_GROWTH_PROVISIONAL,
                "evaluation_reason": f"Provisional: lifetime VPD {lifetime_vpd:.0f}, projected {projected_lifetime:,.0f} views by day-90",
                "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": None,
                "projected_day_90": round(projected_lifetime, 1), "snapshot_count": snap_count}

    return {"evaluation_status": VIDEO_FAIL, "growth_status": VIDEO_FAIL,
            "evaluation_reason": f"{views:,} views; projected {projected_lifetime:,.0f} < {min_views:,} threshold",
            "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": None,
            "projected_day_90": round(projected_lifetime, 1), "snapshot_count": snap_count}


def compute_niche_match_score(
    source_fingerprint: Dict[str, Any],
    candidate_videos: List[Dict[str, Any]],
) -> Tuple[float, str, List[str], List[str]]:
    if not source_fingerprint or not candidate_videos:
        return 0.0, "Insufficient data for niche comparison", [], []

    source_terms = set(source_fingerprint.get("recurring_phrases", []))
    source_entities = set(e.lower() for e in source_fingerprint.get("recurring_entities", []))
    source_clusters = set(c.lower() for c in source_fingerprint.get("topic_clusters", []))
    source_format = set(f.lower() for f in source_fingerprint.get("dominant_formats", []))
    core_subject = (source_fingerprint.get("core_subject") or "").lower()
    audience_problem = (source_fingerprint.get("audience_problem") or "").lower()

    candidate_tokens: List[set] = []
    matched_video_ids: List[str] = []
    matched_topics: List[str] = []
    per_video_sim: List[float] = []

    for v in candidate_videos:
        title_tokens = set(_tokenize(v.get("title", "")))
        candidate_tokens.append(title_tokens)
        if source_terms:
            hit = len(title_tokens & source_terms) / len(source_terms) * 100
        else:
            hit = 0.0
        per_video_sim.append(hit)

    s_score = sum(per_video_sim) / len(per_video_sim) if per_video_sim else 0.0

    all_cand_tokens = set().union(*candidate_tokens) if candidate_tokens else set()
    e_score = (len(all_cand_tokens & source_entities) / len(source_entities) * 100
               if source_entities else 50.0)

    cluster_hits = 0
    for tokens in candidate_tokens:
        for cluster in source_clusters:
            if any(w in tokens for w in cluster.split()):
                cluster_hits += 1
                matched_topics.append(cluster)
                break
    t_score = (min(cluster_hits / len(source_clusters) * 100, 100.0)
               if source_clusters else 50.0)

    core_terms = set(_tokenize(core_subject + " " + audience_problem))
    if core_terms:
        a_hits = sum(1 for tokens in candidate_tokens if tokens & core_terms)
        a_score = a_hits / len(candidate_tokens) * 100
    else:
        a_score = 50.0

    format_signal_words = {"tutorial", "guide", "how", "what", "why", "vs", "review", "explained"}
    if source_format:
        format_tokens = set().union(*(set(f.split()) for f in source_format))
        f_hits = sum(1 for tokens in candidate_tokens if tokens & format_tokens)
    else:
        f_hits = sum(1 for tokens in candidate_tokens if tokens & format_signal_words)
    f_score = f_hits / max(len(candidate_tokens), 1) * 100

    m_score = 80.0
    raw = (0.35*s_score + 0.20*e_score + 0.15*t_score + 0.10*a_score + 0.10*f_score + 0.10*m_score)
    score = _clamp(raw)

    reason_parts = []
    if s_score >= 60:
        reason_parts.append(f"Keyword similarity {s_score:.0f}/100")
    if cluster_hits >= 3:
        reason_parts.append(f"{cluster_hits} topic cluster matches")
    if not reason_parts:
        reason_parts.append(f"Partial keyword overlap; niche score {score:.0f}/100")
    reason = "; ".join(reason_parts[:3])

    for v, sim in zip(candidate_videos, per_video_sim):
        if sim >= 30 or (set(_tokenize(v.get("title", ""))) & core_terms):
            matched_video_ids.append(v.get("video_id", ""))

    return round(score, 2), reason, list(dict.fromkeys(matched_topics))[:8], matched_video_ids[:10]


def compute_recent_consistency_score(
    passed_views: int,
    passed_growth_confirmed: int,
    passed_growth_provisional: int,
    failed: int,
    evaluable: int,
    single_hit_dep: float,
) -> float:
    if evaluable == 0:
        return 0.0
    strict_pass = passed_views + passed_growth_confirmed
    strict_ratio = strict_pass / evaluable
    base = strict_ratio * 85.0
    if passed_growth_confirmed > 0 and evaluable > 0:
        base += (passed_growth_confirmed / evaluable) * 10.0
    if single_hit_dep > 0.45:
        base -= (single_hit_dep - 0.45) / 0.55 * 20.0
    if evaluable >= 6:
        base += 5.0
    return _clamp(base)


def compute_growth_quality_score(
    passed_growth_confirmed: int,
    passed_growth_provisional: int,
    passed_views: int,
    evaluable: int,
    avg_lifetime_vpd: float,
) -> float:
    if evaluable == 0:
        return 30.0
    base = (passed_growth_confirmed / evaluable) * 60.0
    base += (passed_growth_provisional / evaluable) * 10.0
    base += (passed_views / evaluable) * 20.0
    if avg_lifetime_vpd >= 500:
        base += 10.0
    elif avg_lifetime_vpd >= 200:
        base += 5.0
    return _clamp(base)


def compute_durability_score(
    active_months_last_12: int,
    median_cadence_days: Optional[float],
    max_gap_days: Optional[float],
    single_hit_dependency: float,
    evergreen_ratio: float,
    topic_cluster_count: int,
    future_title_angle_count: int,
    total_videos_last_12: int,
) -> float:
    if active_months_last_12 >= 10:
        continuity = 25.0
    elif active_months_last_12 >= 6:
        continuity = 18.0
    elif active_months_last_12 >= 3:
        continuity = 10.0
    elif active_months_last_12 >= 1:
        continuity = 5.0
    else:
        continuity = 0.0

    if max_gap_days and max_gap_days > 90:
        continuity = max(0.0, continuity - 8.0)
    elif max_gap_days and max_gap_days > 45:
        continuity = max(0.0, continuity - 4.0)
    if median_cadence_days and 3 <= median_cadence_days <= 21:
        continuity = min(25.0, continuity + 3.0)

    view_con = 25.0 * max(0.0, 1.0 - single_hit_dependency)
    low_viral = 20.0 * max(0.0, 1.0 - single_hit_dependency * 1.2)
    evergreen = evergreen_ratio * 15.0

    topic_supply = 0.0
    if topic_cluster_count >= 3:
        topic_supply += 8.0
    elif topic_cluster_count >= 2:
        topic_supply += 4.0
    if future_title_angle_count >= 20:
        topic_supply += 7.0
    elif future_title_angle_count >= 10:
        topic_supply += 4.0
    elif future_title_angle_count >= 5:
        topic_supply += 2.0
    topic_supply = min(15.0, topic_supply)

    return _clamp(continuity + view_con + low_viral + evergreen + topic_supply)


def compute_monetization_viability_score(
    titles: List[str],
    evergreen_ratio: float,
    topic_cluster_count: int,
    active_months_last_12: int,
    single_hit_dependency: float,
) -> Tuple[float, str, List[str], List[str]]:
    evidence: List[str] = []
    flags: List[str] = []
    reuse_hits = 0
    sensitive_hits = 0

    for title in titles:
        lower = title.lower()
        for sig in REUSE_SIGNALS:
            if sig in lower:
                reuse_hits += 1
                break
        for sensitive in {"death","tragedy","shooting","suicide","assault","abuse","murder"}:
            if sensitive in lower:
                sensitive_hits += 1
                break

    reuse_ratio = reuse_hits / len(titles) if titles else 0.0
    sens_ratio  = sensitive_hits / len(titles) if titles else 0.0

    if reuse_ratio >= 0.5:
        originality = 5.0
        flags.append("REUSED_CONTENT_RISK")
        evidence.append(f"{reuse_ratio:.0%} of titles have reuse/compilation signals")
    elif reuse_ratio >= 0.25:
        originality = 15.0
        flags.append("INAUTHENTIC_TEMPLATE_RISK")
    else:
        originality = 25.0
        evidence.append("Low reuse signal in title metadata")

    commercial = min(20.0, evergreen_ratio * 15.0 + min(topic_cluster_count, 4) * 1.25)

    if sens_ratio >= 0.3:
        advertiser = 5.0
        flags.append("SENSITIVE_ADVERTISER_RISK")
    elif sens_ratio >= 0.1:
        advertiser = 12.0
    else:
        advertiser = 20.0

    variation = min(15.0, topic_cluster_count * 4.0)
    affiliate = min(10.0, evergreen_ratio * 10.0)

    if active_months_last_12 >= 8:
        sustainability = 10.0
    elif active_months_last_12 >= 4:
        sustainability = 6.0
    elif active_months_last_12 >= 1:
        sustainability = 3.0
    else:
        sustainability = 0.0

    score = _clamp(originality + commercial + advertiser + variation + affiliate + sustainability)

    if score >= 70:
        label = "STRONG"
    elif score >= 50:
        label = "MODERATE"
    elif score >= 30:
        label = "RISKY"
    else:
        label = "UNKNOWN"

    if not evidence:
        evidence.append("Assessment based on public title/metadata analysis only.")
    evidence.append(
        "Monetization Viability Estimate — not a YPP status declaration. "
        "Watch hours, RPM, and revenue data are not publicly accessible."
    )
    if flags:
        evidence.append(f"Policy risk indicators: {', '.join(flags)}")

    return round(score, 2), label, evidence[:5], flags


def compute_data_confidence(
    subscriber_status: str,
    evaluable_count: int,
    has_snapshots: bool,
    has_12mo_history: bool,
    enrichment_errors: int,
) -> Tuple[str, float, List[str]]:
    limitations: List[str] = []

    if subscriber_status != SUBSCRIBER_VERIFIED_UNDER:
        limitations.append("Subscriber count is hidden or unverified.")

    if evaluable_count < 3:
        return CONFIDENCE_INSUFFICIENT, 10.0, limitations + ["Fewer than 3 evaluable videos."]

    score = 0.0
    if subscriber_status == SUBSCRIBER_VERIFIED_UNDER:
        score += 30.0
    else:
        limitations.append("Subscriber status unverified; channel may exceed 50K limit.")

    if evaluable_count >= 6:
        score += 25.0
    elif evaluable_count >= 3:
        score += 15.0
        limitations.append(f"Only {evaluable_count} evaluable videos; confidence is moderate.")

    score += 25.0 if has_snapshots else 5.0
    if not has_snapshots:
        limitations.append("No velocity snapshots available.")

    score += 20.0 if has_12mo_history else 5.0
    if not has_12mo_history:
        limitations.append("12-month upload history not fully available.")

    if enrichment_errors >= 2:
        score = max(0.0, score - 15.0)
        limitations.append(f"{enrichment_errors} enrichment errors reduced data completeness.")

    score = _clamp(score)
    if score >= 75:
        label = CONFIDENCE_HIGH
    elif score >= 45:
        label = CONFIDENCE_MEDIUM
    elif score >= 20:
        label = CONFIDENCE_LOW
    else:
        label = CONFIDENCE_INSUFFICIENT

    return label, round(score, 2), limitations


def compute_final_score(
    niche_match: float,
    recent_consistency: float,
    growth_quality: float,
    durability: float,
    monetization_viability: float,
    data_confidence: float,
) -> float:
    raw = (0.25*niche_match + 0.25*recent_consistency + 0.15*growth_quality
           + 0.20*durability + 0.10*monetization_viability + 0.05*data_confidence)
    return round(_clamp(raw), 2)


def determine_candidate_status(
    subscriber_status: str,
    niche_match_score: float,
    evaluable_count: int,
    strict_success_ratio: float,
    provisional_success_ratio: float,
    has_growth_provisional: bool,
    final_score: float,
    data_confidence: str,
) -> Tuple[str, List[str], List[str]]:
    qual: List[str] = []
    rej: List[str] = []

    if subscriber_status == SUBSCRIBER_REJECTED_OVER:
        rej.append("Subscriber count exceeds 50,000 verified limit.")
        return CANDIDATE_STATUS_REJECTED, qual, rej

    if niche_match_score < 65:
        rej.append(f"Niche Match Score {niche_match_score:.0f} is below minimum 65.")
        return CANDIDATE_STATUS_REJECTED, qual, rej

    if evaluable_count < 3:
        rej.append(f"Only {evaluable_count} evaluable video(s); minimum 3 required.")
        return CANDIDATE_STATUS_WATCHLIST, qual, rej

    if (subscriber_status == SUBSCRIBER_VERIFIED_UNDER
            and niche_match_score >= 75
            and strict_success_ratio >= 1.0
            and final_score >= 78
            and data_confidence in (CONFIDENCE_HIGH, CONFIDENCE_MEDIUM)):
        qual.append(f"All {evaluable_count} evaluable videos passed the 90-day threshold.")
        qual.append(f"Niche Match Score {niche_match_score:.0f} >= 75 with verified subscriber count.")
        qual.append(f"Final Score {final_score:.1f} meets QUALIFIED threshold (>=78).")
        return CANDIDATE_STATUS_QUALIFIED, qual, rej

    if (subscriber_status == SUBSCRIBER_VERIFIED_UNDER
            and niche_match_score >= 75
            and provisional_success_ratio >= 1.0
            and has_growth_provisional
            and final_score >= 70):
        qual.append("All evaluable videos pass with at least provisional growth confirmation.")
        qual.append(f"Niche Match Score {niche_match_score:.0f} >= 75.")
        rej.append("Growth confirmation is provisional; awaiting snapshot verification.")
        return CANDIDATE_STATUS_GROWING, qual, rej

    if niche_match_score >= 65:
        if subscriber_status == SUBSCRIBER_HIDDEN:
            rej.append("Subscriber count is hidden; cannot verify the 50K limit.")
        if strict_success_ratio < 0.80:
            rej.append(f"Strict success ratio {strict_success_ratio:.0%} is below 80%.")
        qual.append(f"Partial niche match (score {niche_match_score:.0f}) warrants monitoring.")
        return CANDIDATE_STATUS_WATCHLIST, qual, rej

    rej.append(f"Success ratio {strict_success_ratio:.0%} is below 80% minimum.")
    return CANDIDATE_STATUS_REJECTED, qual, rej


def compute_view_stats(view_list: List[int]) -> Dict[str, Any]:
    if not view_list:
        return {"minimum": None, "median": None, "mean": None, "p25": None,
                "p75": None, "maximum": None, "total": 0, "single_hit_dependency": 0.0}
    sv = sorted(float(v) for v in view_list)
    n = len(sv)
    total = sum(sv)
    median = _percentile(sv, 50) or 0.0
    return {
        "minimum": int(sv[0]),
        "median": round(median, 1),
        "mean": round(total / n, 1),
        "p25": round(_percentile(sv, 25) or 0.0, 1),
        "p75": round(_percentile(sv, 75) or 0.0, 1),
        "maximum": int(sv[-1]),
        "total": int(total),
        "single_hit_dependency": round(sv[-1] / max(total, 1.0), 4),
    }


def classify_subscriber_status_similar(
    subscriber_count: Optional[int],
    max_subscribers: int = 50_000,
) -> str:
    if subscriber_count is None:
        return SUBSCRIBER_HIDDEN
    if subscriber_count < max_subscribers:
        return SUBSCRIBER_VERIFIED_UNDER
    return SUBSCRIBER_REJECTED_OVER


def compute_evergreen_ratio(titles: List[str]) -> float:
    if not titles:
        return 0.5
    evergreen_count = sum(
        1 for t in titles
        if bool(set(_tokenize(t.lower())) & EVERGREEN_KEYWORDS)
        and not any(k in t.lower() for k in NEWS_KEYWORDS)
    )
    return round(evergreen_count / len(titles), 3)


def compute_topic_clusters(titles: List[str], min_freq: int = 2) -> Tuple[int, int]:
    from collections import Counter
    freq: Counter = Counter()
    for t in titles:
        for tok in _tokenize(t):
            freq[tok] += 1
    common = [w for w, c in freq.most_common(30) if c >= min_freq]
    return max(1, len(common) // 3), len(common) * 2


def rank_candidates(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    def sort_key(c: Dict[str, Any]):
        scores = c.get("scores", {})
        return (
            -STATUS_PRIORITY.get(c.get("status", "REJECTED"), 1),
            -(scores.get("final_score") or 0),
            -(c.get("strict_success_ratio") or 0),
            -(scores.get("data_confidence_score") or 0),
            -(scores.get("durability_score") or 0),
            -(scores.get("niche_match_score") or 0),
            (c.get("single_hit_dependency") or 1.0),
            -(c.get("median_recent_views") or 0),
            c.get("channel_id", ""),
        )
    sorted_c = sorted(candidates, key=sort_key)
    for i, c in enumerate(sorted_c):
        c["rank"] = i + 1
    return sorted_c


def select_most_promising(candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    qualified = [c for c in candidates if c.get("status") == CANDIDATE_STATUS_QUALIFIED]
    if qualified:
        return qualified[0]
    growing = [c for c in candidates if c.get("status") == CANDIDATE_STATUS_GROWING]
    if growing:
        return growing[0]
    return None


def build_most_promising_reasons(candidate: Dict[str, Any]) -> List[str]:
    reasons: List[str] = []
    ev = candidate.get("evaluable_video_count", 0)
    passed = (candidate.get("passed_views_count", 0)
              + candidate.get("passed_growth_confirmed_count", 0))
    if passed >= ev and ev > 0:
        reasons.append(f"All {ev} evaluable video(s) passed the 90-day performance threshold.")

    median_v = candidate.get("median_recent_views")
    subs = candidate.get("subscriber_count")
    if median_v and subs and subs > 0:
        reasons.append(f"Median 90-day views ({int(median_v):,}) are {median_v/subs:.1f}x the channel subscriber count.")
    elif median_v:
        reasons.append(f"Median 90-day views: {int(median_v):,} across evaluable uploads.")

    months = candidate.get("active_months_last_12", 0)
    shd = candidate.get("single_hit_dependency", 1.0)
    if months >= 6:
        dep_note = "with low single-hit dependency" if shd < 0.40 else ""
        reasons.append(f"Active {months}/12 months in the past year {dep_note}.")
    elif candidate.get("niche_match_score", 0) >= 80:
        reasons.append(f"Niche Match Score {candidate.get('niche_match_score', 0):.0f}/100 indicates strong topic alignment.")

    fallbacks = [
        f"Final Score: {candidate.get('scores', {}).get('final_score', 0):.1f}/100.",
        f"Status: {candidate.get('status', 'N/A')}.",
        f"Growth Quality: {candidate.get('scores', {}).get('growth_quality_score', 0):.1f}/100.",
    ]
    while len(reasons) < 3:
        reasons.append(fallbacks.pop(0) if fallbacks else "See detailed score breakdown.")
    return reasons[:3]
