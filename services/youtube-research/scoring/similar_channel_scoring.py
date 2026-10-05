"""
similar_channel_scoring.py — Deterministic scoring for similar-channel candidates.
Overhauled with Channel-Level Niche Matching, Exact 90-Day Evaluation,
Snapshot Growth Confirmation, Strict Qualification, and Best Available Fallback.
"""
from __future__ import annotations
from collections import Counter
import difflib
import re
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any, Tuple

CANDIDATE_STATUS_QUALIFIED = "QUALIFIED"
CANDIDATE_STATUS_GROWING   = "GROWING"
CANDIDATE_STATUS_WATCHLIST = "WATCHLIST"
CANDIDATE_STATUS_REJECTED  = "REJECTED"

TIER_STRICT_MATCH    = "STRICT_MATCH"
TIER_BEST_AVAILABLE   = "BEST_AVAILABLE"
TIER_MONITOR          = "MONITOR"
TIER_NOT_RECOMMENDED  = "NOT_RECOMMENDED"

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

GENERIC_TERMS = {
    "video", "videos", "youtube", "watch", "channel", "new", "best", "top",
    "part", "episode", "full", "latest", "today", "official", "update",
    "2023", "2024", "2025", "2026", "review", "free", "viral",
}

EVERGREEN_KEYWORDS = {
    "how","why","what","best","top","guide","tutorial","tips","learn",
    "truth","secret","never","always","history","science","explained","works","does",
    "should","really","actually","proven"
}

NEWS_KEYWORDS = {
    "today","breaking","just","now","2024","2025","2026","latest","update",
    "news","reaction","responds","announces","official","season","episode","vs","match",
    "game","live"
}

REUSE_SIGNALS = {
    "compilation","react","reacts","reaction","watch","watching","story time",
    "storytime","shorts compilation","clips","moments","funny moments","best moments",
    "top moments","tries","attempts"
}

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
        else:
            dt = dt.astimezone(timezone.utc)
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


def _snap_field(s: Any, field: str, default: Any = None) -> Any:
    if isinstance(s, dict):
        val = s.get(field, default)
        if val is None and field == "view_count":
            val = s.get("views", default)
        return val
    val = getattr(s, field, default)
    if val is None and field == "view_count":
        val = getattr(s, "views", default)
    return val


def evaluate_video(
    video: Dict[str, Any],
    window_end: datetime,
    min_views: int = 10_000,
    snapshots: Optional[List[Any]] = None,
) -> Dict[str, Any]:
    """
    Evaluate a candidate video for 90-day performance.
    Statuses:
      - PASS_VIEWS: views >= min_views
      - PASS_GROWTH_CONFIRMED: confirmed by >= 2 snapshots meeting velocity criteria
      - PASS_GROWTH_PROVISIONAL: <= 30d old with strong lifetime velocity, awaiting 2nd snapshot
      - PENDING_TOO_NEW: age < 3 days (not counted in denominator)
      - FAIL: evaluable video failing threshold
      - EXCLUDED: missing/future date
    """
    published_at = _parse_utc(video.get("published_at", ""))
    if published_at is None:
        return {
            "evaluation_status": VIDEO_EXCLUDED, "growth_status": "UNKNOWN",
            "evaluation_reason": "Missing or invalid published_at",
            "lifetime_vpd": 0.0, "observed_vpd": None,
            "projected_day_90": None, "snapshot_count": 0
        }

    now = window_end
    age_days = (now - published_at).total_seconds() / 86400.0
    if age_days < 0:
        return {
            "evaluation_status": VIDEO_EXCLUDED, "growth_status": "UNKNOWN",
            "evaluation_reason": "Published date is in the future (data anomaly)",
            "lifetime_vpd": 0.0, "observed_vpd": None,
            "projected_day_90": None, "snapshot_count": 0
        }

    views = int(video.get("views", 0) or 0)
    lifetime_vpd = views / max(age_days, 1.0)
    snap_count = len(snapshots) if snapshots else 0

    # Under 3 days: PENDING_TOO_NEW, not counted in evaluable denominator
    if age_days < 3:
        return {
            "evaluation_status": VIDEO_PENDING_TOO_NEW, "growth_status": VIDEO_PENDING_TOO_NEW,
            "evaluation_reason": f"Video is only {age_days:.1f} days old; awaiting data maturity",
            "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": None,
            "projected_day_90": None, "snapshot_count": snap_count
        }

    # Reached view threshold: PASS_VIEWS
    if views >= min_views:
        return {
            "evaluation_status": VIDEO_PASS_VIEWS, "growth_status": VIDEO_PASS_VIEWS,
            "evaluation_reason": f"{views:,} views >= {min_views:,} threshold",
            "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": None,
            "projected_day_90": None, "snapshot_count": snap_count
        }

    remaining_days = max(90.0 - age_days, 7.0)
    required_vpd = max(100.0, (min_views - views) / remaining_days)
    projected_day_90 = None
    observed_vpd = None

    # Check snapshots for confirmed growth
    if snapshots and len(snapshots) >= 2:
        valid_snaps = []
        for s in snapshots:
            vc = _snap_field(s, "view_count")
            ca = _snap_field(s, "captured_at")
            if vc is not None and ca:
                valid_snaps.append({"view_count": int(vc), "captured_at": str(ca)})

        valid_snaps.sort(key=lambda x: x["captured_at"])
        if len(valid_snaps) >= 2:
            oldest = valid_snaps[0]
            newest = valid_snaps[-1]
            dt_old = _parse_utc(oldest["captured_at"])
            dt_new = _parse_utc(newest["captured_at"])
            if dt_old and dt_new:
                elapsed = (dt_new - dt_old).total_seconds() / 86400.0
                delta_views = newest["view_count"] - oldest["view_count"]
                if elapsed >= 0.20 and delta_views >= 0:
                    observed_vpd = delta_views / elapsed
                    projected_day_90 = views + observed_vpd * remaining_days

    projected_lifetime = views + lifetime_vpd * remaining_days

    # Evaluation with snapshots: confirmed growth
    if observed_vpd is not None and projected_day_90 is not None:
        velocity_retention = observed_vpd / max(lifetime_vpd, 1.0)
        delta_views_recent = (
            valid_snaps[-1]["view_count"] - valid_snaps[0]["view_count"] if len(valid_snaps) >= 2 else 0
        )
        growth_confirmed = (
            projected_day_90 >= min_views
            and observed_vpd >= required_vpd * 1.15
            and observed_vpd >= 80.0
            and velocity_retention >= 0.75
            and delta_views_recent >= max(300, views * 0.03)
        )
        if growth_confirmed:
            return {
                "evaluation_status": VIDEO_PASS_GROWTH_CONFIRMED,
                "growth_status": VIDEO_PASS_GROWTH_CONFIRMED,
                "evaluation_reason": f"Observed VPD {observed_vpd:.0f} >= required {required_vpd:.0f}; projected day-90: {projected_day_90:,.0f} views",
                "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": round(observed_vpd, 2),
                "projected_day_90": round(projected_day_90, 1), "snapshot_count": snap_count
            }
        else:
            return {
                "evaluation_status": VIDEO_FAIL, "growth_status": VIDEO_FAIL,
                "evaluation_reason": f"Observed VPD {observed_vpd:.0f} < required {required_vpd:.0f}",
                "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": round(observed_vpd, 2),
                "projected_day_90": round(projected_day_90, 1) if projected_day_90 else None,
                "snapshot_count": snap_count
            }

    # No multi-snapshot: provisional growth if video is <= 30d and pacing strongly
    if age_days <= 30 and projected_lifetime >= min_views and lifetime_vpd >= required_vpd * 1.40:
        return {
            "evaluation_status": VIDEO_PASS_GROWTH_PROVISIONAL,
            "growth_status": VIDEO_PASS_GROWTH_PROVISIONAL,
            "evaluation_reason": f"Provisional: lifetime VPD {lifetime_vpd:.0f}, projected {projected_lifetime:,.0f} views by day-90",
            "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": None,
            "projected_day_90": round(projected_lifetime, 1), "snapshot_count": snap_count
        }

    return {
        "evaluation_status": VIDEO_FAIL, "growth_status": VIDEO_FAIL,
        "evaluation_reason": f"{views:,} views; projected {projected_lifetime:,.0f} < {min_views:,} threshold",
        "lifetime_vpd": round(lifetime_vpd, 2), "observed_vpd": None,
        "projected_day_90": round(projected_lifetime, 1), "snapshot_count": snap_count
    }


class NicheMatchResult(tuple):
    """
    Subclasses tuple to return (score, reason, matched_topics, matched_video_ids)
    for 100% backward-compatibility, while exposing .evidence dictionary.
    """
    def __new__(cls, score: float, reason: str, matched_topics: List[str], matched_video_ids: List[str], evidence: Optional[Dict[str, Any]] = None):
        return super().__new__(cls, (score, reason, matched_topics, matched_video_ids))

    def __init__(self, score: float, reason: str, matched_topics: List[str], matched_video_ids: List[str], evidence: Optional[Dict[str, Any]] = None):
        self.score = score
        self.reason = reason
        self.matched_topics = matched_topics
        self.matched_video_ids = matched_video_ids
        self.evidence = evidence or {}


def compute_niche_match_score(
    source_fingerprint: Dict[str, Any],
    candidate_videos: List[Dict[str, Any]],
    candidate_country: Optional[str] = None,
) -> NicheMatchResult:
    """
    Channel-level Niche Match Score (0 - 100):
      - 30% Semantic / Title similarity (median of top-k best title matches against source titles)
      - 20% Weighted source fingerprint coverage (Lexical F1 on weighted terms)
      - 15% Entity overlap
      - 15% Topic-cluster coverage
      - 10% Audience-problem similarity
      - 5% Format compatibility
      - 5% Market/language compatibility
    """
    empty_evidence = {
        "source_coverage": 0.0, "candidate_precision": 0.0,
        "median_title_similarity": 0.0, "matched_terms": [],
        "matched_entities": [], "matched_clusters": [],
        "niche_match_reason": "Insufficient data for niche comparison",
    }
    if not source_fingerprint or not candidate_videos:
        return NicheMatchResult(0.0, "Insufficient data for niche comparison", [], [], empty_evidence)

    cand_titles = [v.get("title", "") for v in candidate_videos if v.get("title")]
    if not cand_titles:
        return NicheMatchResult(0.0, "No valid titles for niche comparison", [], [], empty_evidence)

    source_titles = source_fingerprint.get("source_video_titles") or source_fingerprint.get("source_titles") or []
    core_subject = (source_fingerprint.get("core_subject") or "").lower()
    audience_problem = (source_fingerprint.get("audience_problem") or "").lower()
    source_entities = [e.lower() for e in source_fingerprint.get("recurring_entities", [])]
    source_clusters = [c.lower() for c in source_fingerprint.get("topic_clusters", [])]
    source_formats = [f.lower() for f in source_fingerprint.get("dominant_formats", [])]

    # ── 1. Semantic / Title Similarity (30%) ─────────────────────────────────
    # For each candidate title, find its best matching source title
    best_sims: List[float] = []
    comparison_targets = source_titles if source_titles else (
        source_clusters + [core_subject, audience_problem] + source_entities
    )
    comparison_targets = [t for t in comparison_targets if t and len(t) >= 3]

    for ct in cand_titles:
        ct_toks = set(_tokenize(ct))
        best_for_ct = 0.0
        for st in comparison_targets:
            st_toks = set(_tokenize(st))
            jaccard = len(ct_toks & st_toks) / max(len(ct_toks | st_toks), 1)
            seq = difflib.SequenceMatcher(None, ct.lower(), st.lower()).ratio()
            sim = (0.55 * jaccard + 0.45 * seq) * 100.0
            if sim > best_for_ct:
                best_for_ct = sim
        best_sims.append(best_for_ct)

    k = min(len(best_sims), 8)
    top_k_sims = sorted(best_sims, reverse=True)[:k]
    median_title_sim = _percentile(sorted(top_k_sims), 50) if top_k_sims else 0.0

    # ── 2. Weighted Fingerprint Coverage & Lexical F1 (20%) ──────────────────
    weighted_terms = source_fingerprint.get("weighted_terms")
    if not weighted_terms:
        # Construct fallback weighted terms from phrases, entities, clusters
        weighted_terms = []
        if core_subject:
            weighted_terms.append({"term": core_subject, "weight": 1.0, "type": "core"})
        for p in source_fingerprint.get("recurring_phrases", [])[:8]:
            w = 0.85 if p not in GENERIC_TERMS else 0.3
            weighted_terms.append({"term": p, "weight": w, "type": "phrase"})
        for e in source_entities[:6]:
            w = 0.90 if e not in GENERIC_TERMS else 0.3
            weighted_terms.append({"term": e, "weight": w, "type": "entity"})
        for cl in source_clusters[:4]:
            weighted_terms.append({"term": cl, "weight": 0.75, "type": "cluster"})

    matched_terms: List[str] = []
    matched_src_wt = 0.0
    total_src_wt = 0.0

    all_cand_text = " ".join(cand_titles).lower()
    all_cand_tokens = set()
    for ct in cand_titles:
        all_cand_tokens.update(_tokenize(ct))

    for item in weighted_terms:
        term = str(item.get("term", "")).lower().strip()
        weight = float(item.get("weight", 0.5))
        total_src_wt += weight

        is_match = False
        if " " in term:
            if term in all_cand_text:
                is_match = True
            else:
                toks = set(_tokenize(term))
                if toks and len(toks & all_cand_tokens) >= max(1, len(toks) - 1):
                    is_match = True
        else:
            if term in all_cand_tokens or term in all_cand_text:
                is_match = True

        if is_match:
            matched_src_wt += weight
            matched_terms.append(term)

    source_cov = matched_src_wt / max(total_src_wt, 0.001)

    cand_tok_count = Counter()
    for ct in cand_titles:
        for t in _tokenize(ct):
            cand_tok_count[t] += 1
    freq_cand_tokens = [t for t, c in cand_tok_count.items() if c >= 2]
    matched_cand_count = sum(1 for t in freq_cand_tokens if any(t in str(item.get("term","")).lower() for item in weighted_terms))
    cand_prec = matched_cand_count / max(len(freq_cand_tokens), 1)

    lexical_f1 = (2.0 * source_cov * cand_prec) / max(source_cov + cand_prec, 0.001)
    lexical_f1_score = _clamp(lexical_f1 * 100.0)

    # ── 3. Entity Overlap (15%) ──────────────────────────────────────────────
    matched_entities = []
    if source_entities:
        for ent in source_entities:
            if ent in all_cand_text or ent in all_cand_tokens:
                matched_entities.append(ent)
        entity_score = (len(matched_entities) / max(len(source_entities), 1)) * 100.0
    else:
        entity_score = 65.0

    # ── 4. Topic Cluster Coverage (15%) ──────────────────────────────────────
    matched_clusters = []
    if source_clusters:
        for cl in source_clusters:
            cl_words = set(_tokenize(cl))
            if any(bool(set(_tokenize(ct)) & cl_words) for ct in cand_titles):
                matched_clusters.append(cl)
        cluster_score = (len(matched_clusters) / max(len(source_clusters), 1)) * 100.0
    else:
        cluster_score = 65.0

    # ── 5. Audience Problem Similarity (10%) ─────────────────────────────────
    core_prob_terms = set(_tokenize(core_subject + " " + audience_problem))
    if core_prob_terms:
        prob_hits = sum(1 for ct in cand_titles if bool(set(_tokenize(ct)) & core_prob_terms))
        prob_score = min(100.0, (prob_hits / max(len(cand_titles), 1)) * 135.0)
    else:
        prob_score = 65.0

    # ── 6. Format Compatibility (5%) ─────────────────────────────────────────
    fmt_signals = {"how", "why", "what", "tutorial", "guide", "vs", "review", "explained", "case study", "deep dive"}
    target_fmts = set(source_formats) if source_formats else fmt_signals
    cand_fmt_matches = sum(1 for ct in cand_titles if any(f in ct.lower() for f in target_fmts))
    fmt_score = min(100.0, (cand_fmt_matches / max(len(cand_titles), 1)) * 140.0)

    # ── 7. Market / Language Compatibility (5%) ──────────────────────────────
    src_market = str(source_fingerprint.get("target_market", "US")).upper()
    if candidate_country:
        market_score = 100.0 if candidate_country.upper() == src_market else 55.0
    else:
        market_score = 80.0

    # ── Overall Formula ──────────────────────────────────────────────────────
    raw_niche = (
        0.30 * median_title_sim
        + 0.20 * lexical_f1_score
        + 0.15 * entity_score
        + 0.15 * cluster_score
        + 0.10 * prob_score
        + 0.05 * fmt_score
        + 0.05 * market_score
    )
    final_niche = round(_clamp(raw_niche), 2)

    # Matched Video IDs
    matched_video_ids = []
    for v in candidate_videos:
        t = v.get("title", "")
        toks = set(_tokenize(t))
        if (toks & core_prob_terms) or any(c in t.lower() for c in matched_clusters):
            vid = v.get("video_id")
            if vid and vid not in matched_video_ids:
                matched_video_ids.append(vid)

    # Explainable Reason
    reason_parts = []
    if median_title_sim >= 40:
        reason_parts.append(f"Title alignment {median_title_sim:.0f}/100")
    if matched_terms:
        reason_parts.append(f"{len(matched_terms)} key term matches ({', '.join(matched_terms[:3])})")
    if matched_clusters:
        reason_parts.append(f"{len(matched_clusters)} topic cluster matches")
    if not reason_parts:
        reason_parts.append(f"Broad niche affinity; score {final_niche:.0f}/100")
    reason_str = "; ".join(reason_parts[:3])

    evidence_dict = {
        "source_coverage": round(source_cov, 4),
        "candidate_precision": round(cand_prec, 4),
        "median_title_similarity": round(median_title_sim, 2),
        "matched_terms": matched_terms[:10],
        "matched_entities": matched_entities[:8],
        "matched_clusters": matched_clusters[:6],
        "niche_match_reason": reason_str,
    }

    return NicheMatchResult(final_niche, reason_str, matched_clusters[:8], matched_video_ids[:10], evidence_dict)


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
    base = strict_ratio * 80.0
    if passed_growth_confirmed > 0:
        base += min(10.0, (passed_growth_confirmed / evaluable) * 10.0)
    if passed_growth_provisional > 0:
        base += min(5.0, (passed_growth_provisional / evaluable) * 5.0)
    if single_hit_dep > 0.45:
        base -= (single_hit_dep - 0.45) / 0.55 * 18.0
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
    base = (passed_growth_confirmed / evaluable) * 55.0
    base += (passed_growth_provisional / evaluable) * 15.0
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
        "Watch hours, RPM, CPM, and revenue data are not publicly accessible."
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
    window_coverage: str = "COMPLETE",
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

    score += 20.0 if has_snapshots else 5.0
    if not has_snapshots:
        limitations.append("No multi-point velocity snapshots available.")

    score += 15.0 if has_12mo_history else 5.0
    if not has_12mo_history:
        limitations.append("12-month upload history not fully available.")

    if window_coverage != "COMPLETE":
        score = max(0.0, score - 10.0)
        limitations.append("90-day window coverage is partial or unconfirmed.")

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
    raw = (
        0.25 * niche_match
        + 0.25 * recent_consistency
        + 0.15 * growth_quality
        + 0.20 * durability
        + 0.10 * monetization_viability
        + 0.05 * data_confidence
    )
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
    window_coverage: str = "COMPLETE",
) -> Tuple[str, List[str], List[str]]:
    """
    Classify candidate into QUALIFIED, GROWING, WATCHLIST, or REJECTED.
    Keeps QUALIFIED standard strictly high per Section IX.
    Never throws an eligible <50K channel with ~70% pass rate into REJECTED.
    """
    qual: List[str] = []
    rej: List[str] = []

    # Disqualification Rule 1: Verified subscribers exceed 50,000
    if subscriber_status == SUBSCRIBER_REJECTED_OVER:
        rej.append("Subscriber count exceeds 50,000 verified limit.")
        return CANDIDATE_STATUS_REJECTED, qual, rej

    # Disqualification Rule 2: Niche Match is too low
    if niche_match_score < 50.0:
        rej.append(f"Niche Match Score {niche_match_score:.0f} is below minimum 50.")
        return CANDIDATE_STATUS_REJECTED, qual, rej

    # Disqualification Rule 3: Zero evaluable videos
    if evaluable_count == 0:
        rej.append("No evaluable videos in the 90-day window.")
        return CANDIDATE_STATUS_REJECTED, qual, rej

    # QUALIFIED: Strict qualification criteria
    is_qualified = (
        subscriber_status == SUBSCRIBER_VERIFIED_UNDER
        and niche_match_score >= 75.0
        and evaluable_count >= 3
        and strict_success_ratio >= 1.0
        and final_score >= 78.0
        and data_confidence in (CONFIDENCE_HIGH, CONFIDENCE_MEDIUM)
        and window_coverage == "COMPLETE"
    )
    if is_qualified:
        qual.append(f"All {evaluable_count} evaluable videos passed the 90-day performance threshold.")
        qual.append(f"Niche Match Score {niche_match_score:.0f} >= 75 with verified subscriber count.")
        qual.append(f"Final Score {final_score:.1f} meets QUALIFIED threshold (>=78).")
        return CANDIDATE_STATUS_QUALIFIED, qual, rej

    # GROWING: Provisional growth qualification
    is_growing = (
        subscriber_status == SUBSCRIBER_VERIFIED_UNDER
        and niche_match_score >= 75.0
        and evaluable_count >= 3
        and provisional_success_ratio >= 1.0
        and has_growth_provisional
        and final_score >= 70.0
    )
    if is_growing:
        qual.append("All evaluable videos pass with at least provisional growth confirmation.")
        qual.append(f"Niche Match Score {niche_match_score:.0f} >= 75.")
        rej.append("Growth confirmation is provisional; awaiting snapshot verification.")
        return CANDIDATE_STATUS_GROWING, qual, rej

    # WATCHLIST: Candidates worth monitoring (Section IX)
    # Channel under 50K with ~70% pass rate, good median views, or reasonable niche match
    is_watchlist = (
        niche_match_score >= 60.0
        or strict_success_ratio >= 0.65
        or final_score >= 48.0
    )
    if is_watchlist:
        if subscriber_status == SUBSCRIBER_HIDDEN:
            rej.append("Subscriber count is hidden / unverified; cannot confirm the 50K limit.")
        if strict_success_ratio < 1.0:
            rej.append(f"Strict pass rate is {strict_success_ratio:.0%}; 100% required for Qualified.")
        if niche_match_score < 75.0:
            rej.append(f"Niche Match Score is {niche_match_score:.0f}; 75 required for Qualified.")
        if evaluable_count < 3:
            rej.append(f"Only {evaluable_count} evaluable video(s); minimum 3 required for Qualified.")
        if window_coverage != "COMPLETE":
            rej.append(f"90-day window coverage is {window_coverage}; complete coverage required for Qualified.")
        qual.append(f"Candidate has Niche Match {niche_match_score:.0f} and Pass Rate {strict_success_ratio:.0%}.")
        return CANDIDATE_STATUS_WATCHLIST, qual, rej

    # Otherwise REJECTED with specific reason
    rej.append(f"Candidate does not meet minimum thresholds (Niche {niche_match_score:.0f}, Pass Rate {strict_success_ratio:.0%}).")
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


def compute_qualification_gap_score(candidate: Dict[str, Any]) -> float:
    """
    Computes a distance/gap score to Qualified status.
    Lower score = closer to Qualified.
    Candidates with verified subscribers > 50K receive maximum gap penalty (999.0).
    """
    sub_status = candidate.get("subscriber_status", "")
    if sub_status == SUBSCRIBER_REJECTED_OVER:
        return 999.0

    gap = 0.0
    scores = candidate.get("scores", {})
    final_s = scores.get("final_score", candidate.get("final_score", 0.0))
    niche_s = scores.get("niche_match_score", candidate.get("niche_match_score", 0.0))
    strict_r = candidate.get("strict_success_ratio", 0.0)
    evaluable = candidate.get("evaluable_video_count", 0)

    if sub_status == SUBSCRIBER_HIDDEN:
        gap += 12.0

    if strict_r < 1.0:
        gap += (1.0 - strict_r) * 45.0

    if niche_s < 75.0:
        gap += (75.0 - niche_s) * 0.40

    if final_s < 78.0:
        gap += (78.0 - final_s) * 0.25

    if evaluable < 3:
        gap += (3 - evaluable) * 12.0

    cov = candidate.get("window_coverage", "UNKNOWN")
    if cov != "COMPLETE":
        gap += 4.0

    return round(max(0.0, gap), 2)


def rank_candidates(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Sort candidates per Section XI tie-break rules:
      1. Status priority
      2. Final score
      3. Strict success ratio
      4. Data confidence score
      5. Durability score
      6. Niche Match score
      7. Lower single-hit dependency
      8. Higher median recent views
      9. Channel ID for deterministic tie-break
    """
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


def select_best_available_and_recommendations(
    candidates: List[Dict[str, Any]]
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]], str]:
    """
    Section X: Best Available Fallback.
    Assigns:
      - recommendation_tier: STRICT_MATCH | BEST_AVAILABLE | MONITOR | NOT_RECOMMENDED
      - unmet_criteria: List[str]
      - is_best_available: bool
      - best_available_rank: Optional[int]
      - qualification_gap_score: float

    Selection hierarchy:
      1. Qualified -> Highlight #1 Qualified (STRICT_MATCH)
      2. Growing -> Highlight #1 Growing (STRICT_MATCH)
      3. Watchlist -> Highlight closest available candidate (BEST_AVAILABLE)
    """
    # 1. Compute unmet criteria and gap score for each candidate
    for c in candidates:
        unmet: List[str] = []
        strict_r = c.get("strict_success_ratio", 0.0)
        if strict_r < 1.0:
            unmet.append(f"Pass rate is {strict_r:.0%}; strict requirement is 100%")

        niche_s = c.get("scores", {}).get("niche_match_score", c.get("niche_match_score", 0.0))
        if niche_s < 75.0:
            unmet.append(f"Niche Match is {niche_s:.0f}; Qualified requirement is 75")

        eval_v = c.get("evaluable_video_count", 0)
        if eval_v < 3:
            unmet.append(f"Only {eval_v} evaluable video(s); minimum 3 required")

        sub_s = c.get("subscriber_status", "")
        if sub_s == SUBSCRIBER_HIDDEN:
            unmet.append("Subscriber count is hidden; cannot verify the 50K limit")
        elif sub_s == SUBSCRIBER_REJECTED_OVER:
            unmet.append("Subscriber count exceeds 50,000 verified limit")

        cov = c.get("window_coverage", "UNKNOWN")
        if cov != "COMPLETE":
            unmet.append(f"Window coverage is {cov.lower()}; complete window required")

        has_multi_snap = any(v.get("snapshot_count", 0) >= 2 for v in c.get("recent_videos", []))
        if not has_multi_snap and c.get("status") != CANDIDATE_STATUS_QUALIFIED:
            unmet.append("Only single data snapshot available; growth unconfirmed")

        final_s = c.get("scores", {}).get("final_score", c.get("final_score", 0.0))
        if final_s < 78.0:
            unmet.append(f"Final score is {final_s:.1f}; Qualified requirement is 78.0")

        c["unmet_criteria"] = unmet
        c["qualification_gap_score"] = compute_qualification_gap_score(c)
        c["is_best_available"] = False
        c["best_available_rank"] = None
        c["recommendation_tier"] = TIER_MONITOR if c.get("status") != CANDIDATE_STATUS_REJECTED else TIER_NOT_RECOMMENDED

    # 2. Check for Qualified
    qualified = [c for c in candidates if c.get("status") == CANDIDATE_STATUS_QUALIFIED]
    if qualified:
        for q in qualified:
            q["recommendation_tier"] = TIER_STRICT_MATCH
        for g in candidates:
            if g.get("status") == CANDIDATE_STATUS_GROWING:
                g["recommendation_tier"] = TIER_STRICT_MATCH
        top_qual = qualified[0]
        top_qual["is_most_promising"] = True
        top_qual["most_promising_label"] = "#1 MOST PROMISING COMPETITOR"
        return top_qual, qualified[:5], TIER_STRICT_MATCH

    # 3. Check for Growing
    growing = [c for c in candidates if c.get("status") == CANDIDATE_STATUS_GROWING]
    if growing:
        for g in growing:
            g["recommendation_tier"] = TIER_STRICT_MATCH
        top_grow = growing[0]
        top_grow["is_most_promising"] = True
        top_grow["most_promising_label"] = "BEST GROWING CANDIDATE"
        return top_grow, growing[:5], TIER_STRICT_MATCH

    # 4. Fallback to Best Available (from Watchlist / eligible candidates)
    # Must NOT have verified subscribers > 50K, must have evaluable >= 1, niche match >= 50
    eligible = [
        c for c in candidates
        if c.get("subscriber_status") != SUBSCRIBER_REJECTED_OVER
        and c.get("evaluable_video_count", 0) >= 1
        and (c.get("scores", {}).get("niche_match_score", c.get("niche_match_score", 0.0))) >= 50.0
    ]
    # Sort eligible by qualification_gap_score ascending, then final_score descending
    eligible.sort(key=lambda c: (
        c.get("qualification_gap_score", 999.0),
        -(c.get("scores", {}).get("final_score") or 0),
        -(c.get("strict_success_ratio") or 0),
    ))

    if eligible:
        best_cands = eligible[:5]
        for idx, bc in enumerate(best_cands):
            bc["is_best_available"] = True
            bc["best_available_rank"] = idx + 1
            bc["recommendation_tier"] = TIER_BEST_AVAILABLE

        top_best = best_cands[0]
        top_best["is_most_promising"] = True
        top_best["most_promising_label"] = "BEST AVAILABLE CANDIDATE"
        return top_best, best_cands, "BEST_AVAILABLE"

    return None, [], "NONE"


def select_most_promising(candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Legacy helper maintained for backward compatibility."""
    top, _, _ = select_best_available_and_recommendations(candidates)
    return top


def build_most_promising_reasons(candidate: Dict[str, Any]) -> List[str]:
    reasons: List[str] = []
    ev = candidate.get("evaluable_video_count", 0)
    passed = (candidate.get("passed_views_count", 0)
              + candidate.get("passed_growth_confirmed_count", 0))
    if passed >= ev and ev > 0:
        reasons.append(f"All {ev} evaluable video(s) passed the 90-day performance threshold.")
    elif ev > 0:
        reasons.append(f"{passed}/{ev} evaluable video(s) passed 10K+ view threshold ({candidate.get('strict_success_ratio', 0.0):.0%} pass rate).")

    median_v = candidate.get("median_recent_views")
    subs = candidate.get("subscriber_count")
    if median_v and subs and subs > 0:
        reasons.append(f"Median 90-day views ({int(median_v):,}) are {median_v/subs:.1f}x the channel subscriber count.")
    elif median_v:
        reasons.append(f"Median 90-day views: {int(median_v):,} across evaluable uploads.")

    niche_s = candidate.get("scores", {}).get("niche_match_score", candidate.get("niche_match_score", 0))
    months = candidate.get("active_months_last_12", 0)
    if months >= 6:
        shd = candidate.get("single_hit_dependency", 1.0)
        dep_note = "with low single-hit dependency" if shd < 0.40 else ""
        reasons.append(f"Active {months}/12 months in the past year {dep_note}.")
    elif niche_s >= 65:
        reasons.append(f"Niche Match Score {niche_s:.0f}/100 indicates strong topic alignment.")

    fallbacks = [
        f"Final Score: {candidate.get('scores', {}).get('final_score', 0):.1f}/100.",
        f"Durability Score: {candidate.get('scores', {}).get('durability_score', 0):.1f}/100.",
        f"Recommendation Tier: {candidate.get('recommendation_tier', candidate.get('status', 'N/A'))}.",
    ]
    while len(reasons) < 3:
        reasons.append(fallbacks.pop(0) if fallbacks else "See score breakdown for details.")
    return reasons[:3]
