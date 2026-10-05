"""
similar_channel_discovery_service.py
Background service for discovering channels in the same niche as a competitor.
Implements:
Progressive Discovery → Candidate Pool Expansion → Exact 90-Day Evaluation → Strict Qualification → Best Available Fallback → Explainable Ranking
"""
from __future__ import annotations

import asyncio
import json
import uuid
import re
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
from collections import Counter

from core.logger import research_logger
from db.engine import SessionLocal
from models.entities import (
    SimilarChannelRun, SimilarChannelCandidate, SimilarChannelVideo, VideoSnapshot, utcnow_str
)
from repositories.research_repo import ResearchRepository
from providers.fallback import ProviderFallbackManager
from providers.scraper import is_synthetic_channel_id
from utils.parsers import parse_published_date_with_quality
from scoring.similar_channel_scoring import (
    evaluate_video,
    compute_niche_match_score,
    compute_recent_consistency_score,
    compute_growth_quality_score,
    compute_durability_score,
    compute_monetization_viability_score,
    compute_data_confidence,
    compute_final_score,
    determine_candidate_status,
    compute_view_stats,
    classify_subscriber_status_similar,
    compute_evergreen_ratio,
    compute_topic_clusters,
    compute_qualification_gap_score,
    rank_candidates,
    select_best_available_and_recommendations,
    build_most_promising_reasons,
    VIDEO_PASS_VIEWS,
    VIDEO_PASS_GROWTH_CONFIRMED,
    VIDEO_PASS_GROWTH_PROVISIONAL,
    VIDEO_PENDING_TOO_NEW,
    VIDEO_FAIL,
    VIDEO_EXCLUDED,
    SUBSCRIBER_VERIFIED_UNDER,
    SUBSCRIBER_HIDDEN,
    SUBSCRIBER_REJECTED_OVER,
    TIER_STRICT_MATCH,
    TIER_BEST_AVAILABLE,
    TIER_MONITOR,
    TIER_NOT_RECOMMENDED,
)
from workers.task_manager import task_manager
from schemas.research_schemas import ProgressStateSchema

STOP_WORDS = {
    "the","a","an","and","or","but","in","on","at","to","for","of","with",
    "is","are","was","were","be","been","have","has","do","does","did","i",
    "you","he","she","it","we","they","this","that","what","how","why",
    "which","not","no","so","if","as","my","your","video","youtube","watch",
}

GENERIC_DISCOVERY_TERMS = {
    "video", "videos", "youtube", "watch", "channel", "new", "best", "top",
    "part", "episode", "full", "latest", "today", "official", "update",
    "2023", "2024", "2025", "2026", "review", "free", "viral",
}


def _build_niche_fingerprint(
    channel_title: str,
    videos: List[Dict[str, Any]],
    competitor_data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Build weighted source fingerprint from competitor channel videos.
    Downweights generic YouTube words, identifies core subject, entities,
    phrases, topic clusters, audience problems, and formats.
    """
    word_freq: Counter = Counter()
    bigram_freq: Counter = Counter()
    patterns: List[str] = []
    source_titles: List[str] = []

    for v in videos:
        title = v.get("title", "")
        if not title:
            continue
        source_titles.append(title)
        tokens = [w for w in re.findall(r"\b\w{3,}\b", title.lower()) if w not in STOP_WORDS]
        for tok in tokens:
            word_freq[tok] += 1
        for i in range(len(tokens) - 1):
            bg = f"{tokens[i]} {tokens[i+1]}"
            if not any(g in bg for g in GENERIC_DISCOVERY_TERMS):
                bigram_freq[bg] += 1

        low = title.lower()
        if "how" in low or "tutorial" in low:
            patterns.append("how-to")
        elif "why" in low:
            patterns.append("why")
        elif any(q in low for q in ("vs", "versus", "compared")):
            patterns.append("comparison")
        elif "?" in title:
            patterns.append("question-hook")
        elif any(n in low for n in ["top", "best", "worst"]):
            patterns.append("list")
        elif any(d in low for d in ["explained", "breakdown", "case study", "deep dive"]):
            patterns.append("deep-dive")

    # Filter out generic words for core domain phrases
    common_words = [
        w for w, c in word_freq.most_common(40)
        if c >= 2 and w not in GENERIC_DISCOVERY_TERMS
    ]
    common_bigrams = [
        bg for bg, c in bigram_freq.most_common(20)
        if c >= 2
    ]

    recurring_phrases = common_bigrams[:8] if common_bigrams else common_words[:8]
    recurring_entities = [w for w in common_words if len(w) > 4][:8]

    # Topic clusters
    cluster_size = max(1, len(common_words) // 3)
    topic_clusters = [
        " ".join(common_words[i * cluster_size : (i + 1) * cluster_size])
        for i in range(min(4, len(common_words) // max(cluster_size, 1)))
    ]
    if not topic_clusters and common_words:
        topic_clusters = [" ".join(common_words[:4])]

    pattern_freq: Counter = Counter(patterns)
    dominant_formats = [fmt for fmt, _ in pattern_freq.most_common(3)]
    if not dominant_formats:
        dominant_formats = ["long-form-educational"]

    core_subject = " ".join(common_words[:3]) if common_words else channel_title
    audience_problem = " ".join(common_words[3:6]) if len(common_words) >= 6 else core_subject

    # Weighted terms list (Section VIII.1)
    weighted_terms: List[Dict[str, Any]] = []
    if core_subject:
        weighted_terms.append({
            "term": core_subject,
            "weight": 1.0,
            "source_video_coverage": 1.0,
            "type": "core"
        })
    for ent in recurring_entities[:6]:
        cov = word_freq[ent] / max(len(videos), 1)
        weighted_terms.append({
            "term": ent,
            "weight": 0.90,
            "source_video_coverage": round(cov, 2),
            "type": "entity"
        })
    for phr in recurring_phrases[:6]:
        cov = bigram_freq[phr] / max(len(videos), 1) if phr in bigram_freq else 0.5
        weighted_terms.append({
            "term": phr,
            "weight": 0.85,
            "source_video_coverage": round(cov, 2),
            "type": "phrase"
        })
    for cl in topic_clusters[:4]:
        weighted_terms.append({
            "term": cl,
            "weight": 0.75,
            "source_video_coverage": 0.4,
            "type": "cluster"
        })
    for w in common_words[6:14]:
        cov = word_freq[w] / max(len(videos), 1)
        weighted_terms.append({
            "term": w,
            "weight": 0.60,
            "source_video_coverage": round(cov, 2),
            "type": "supporting"
        })

    news_kw = {"today","now","breaking","latest","2024","2025","2026","reaction","news","live"}
    news_dep = sum(1 for v in videos if any(k in v.get("title","").lower() for k in news_kw))
    news_ratio = round(news_dep / max(len(videos), 1), 2)

    return {
        "core_subject": core_subject,
        "audience_problem": audience_problem,
        "viewer_promise": common_words[0] if common_words else channel_title,
        "recurring_entities": recurring_entities,
        "recurring_phrases": recurring_phrases,
        "topic_clusters": topic_clusters,
        "adjacent_topics": common_words[14:20],
        "excluded_topics": [],
        "dominant_formats": dominant_formats,
        "target_market": competitor_data.get("market", "US") if competitor_data else "US",
        "target_language": competitor_data.get("language", "en") if competitor_data else "en",
        "evergreen_ratio": round(1.0 - news_ratio, 2),
        "news_dependency_ratio": news_ratio,
        "weighted_terms": weighted_terms,
        "source_video_titles": source_titles[:15],
        "source_video_ids": [v.get("video_id", "") for v in videos[:15]],
        "extraction_provider": "deterministic",
        "extraction_confidence": "HIGH" if len(videos) >= 5 else "MEDIUM",
    }


def _clean_title_for_query(title: str) -> str:
    """Clean clickbait brackets and punctuation to create natural search queries."""
    clean = re.sub(r"\[.*?\]|\(.*?\)", "", title)
    clean = re.sub(r"[#|\-:!]", " ", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    words = clean.split()
    return " ".join(words[:7]) if len(words) > 7 else clean


def _generate_pass_queries(
    fp: Dict[str, Any],
    source_videos: List[Dict[str, Any]],
    pass_number: int,
    seen_query_texts: set,
) -> List[Dict[str, Any]]:
    """
    Generate meaningful queries for specific discovery pass (Section III).
    Pass 1: Exact niche queries (relevance)
    Pass 2: Performance queries (viewCount, date)
    Pass 3: Long-tail expansion (autocomplete, entities, outlier titles)
    Pass 4: Adjacent-topic retrieval
    """
    core = fp.get("core_subject", "")
    problem = fp.get("audience_problem", "")
    phrases = fp.get("recurring_phrases", [])
    entities = fp.get("recurring_entities", [])
    clusters = fp.get("topic_clusters", [])
    adjacent = fp.get("adjacent_topics", [])

    raw_pass_queries: List[Dict[str, Any]] = []

    if pass_number == 1:
        # Pass 1 — Exact niche queries
        if core:
            raw_pass_queries.append({"query": core, "order": "relevance", "pass": 1, "type": "core_subject"})
        if problem and problem != core:
            raw_pass_queries.append({"query": problem, "order": "relevance", "pass": 1, "type": "audience_problem"})
        for p in phrases[:3]:
            raw_pass_queries.append({"query": f"how to {p}", "order": "relevance", "pass": 1, "type": "how_question"})
            raw_pass_queries.append({"query": f"why {p}", "order": "relevance", "pass": 1, "type": "why_question"})
        for e in entities[:2]:
            raw_pass_queries.append({"query": e, "order": "relevance", "pass": 1, "type": "entity"})
        for cl in clusters[:2]:
            if cl and cl != core:
                raw_pass_queries.append({"query": cl, "order": "relevance", "pass": 1, "type": "cluster"})
        if phrases:
            raw_pass_queries.append({"query": f"what happens when {phrases[0]}", "order": "relevance", "pass": 1, "type": "what_happens"})
        # Outlier titles from source channel
        sorted_src = sorted(source_videos, key=lambda v: v.get("views", 0), reverse=True)
        for sv in sorted_src[:2]:
            t = sv.get("title", "")
            cleaned = _clean_title_for_query(t)
            if cleaned and len(cleaned) >= 10:
                raw_pass_queries.append({"query": cleaned, "order": "relevance", "pass": 1, "type": "outlier_title"})

    elif pass_number == 2:
        # Pass 2 — Performance queries (viewCount & date on strongest niche seeds)
        if core:
            raw_pass_queries.append({"query": core, "order": "viewCount", "pass": 2, "type": "perf_viewcount"})
            raw_pass_queries.append({"query": core, "order": "date", "pass": 2, "type": "perf_date"})
        if phrases:
            raw_pass_queries.append({"query": phrases[0], "order": "viewCount", "pass": 2, "type": "perf_phrase_views"})
            raw_pass_queries.append({"query": phrases[0], "order": "date", "pass": 2, "type": "perf_phrase_date"})
        if clusters:
            raw_pass_queries.append({"query": clusters[0], "order": "viewCount", "pass": 2, "type": "perf_cluster_views"})

    elif pass_number == 3:
        # Pass 3 — Long-tail expansion
        for ent in entities[2:5]:
            raw_pass_queries.append({"query": ent, "order": "relevance", "pass": 3, "type": "long_tail_entity"})
        if len(phrases) >= 2:
            raw_pass_queries.append({"query": f"{phrases[0]} vs {phrases[1]}", "order": "relevance", "pass": 3, "type": "comparison"})
        for cl in clusters[2:4]:
            raw_pass_queries.append({"query": cl, "order": "relevance", "pass": 3, "type": "long_tail_cluster"})
        if phrases:
            raw_pass_queries.append({"query": f"truth about {phrases[0]}", "order": "relevance", "pass": 3, "type": "evergreen_angle"})
        # 3rd and 4th strongest video titles
        sorted_src = sorted(source_videos, key=lambda v: v.get("views", 0), reverse=True)
        for sv in sorted_src[2:4]:
            t = sv.get("title", "")
            cleaned = _clean_title_for_query(t)
            if cleaned and len(cleaned) >= 10:
                raw_pass_queries.append({"query": cleaned, "order": "relevance", "pass": 3, "type": "long_tail_title"})

    elif pass_number == 4:
        # Pass 4 — Adjacent-topic retrieval (used only when pool is small)
        for adj in adjacent[:4]:
            raw_pass_queries.append({"query": adj, "order": "relevance", "pass": 4, "type": "adjacent_topic"})
        if core and adjacent:
            raw_pass_queries.append({"query": f"{core} {adjacent[0]}", "order": "relevance", "pass": 4, "type": "adjacent_combo"})

    deduped: List[Dict[str, Any]] = []
    for q in raw_pass_queries:
        text = q["query"].lower().strip()
        if text and len(text) >= 4 and text not in seen_query_texts:
            seen_query_texts.add(text)
            deduped.append(q)

    return deduped


class SimilarChannelDiscoveryService:
    def __init__(self, provider_mgr: ProviderFallbackManager):
        self.provider_mgr = provider_mgr
        self._semaphore = asyncio.Semaphore(4)

    def _is_cancelled(self, run_id: str) -> bool:
        return task_manager.is_cancelled(run_id)

    async def _emit(
        self,
        run_id: str,
        stage: str,
        pct: int,
        msg: str,
        cand_vids: int = 0,
        cand_chans: int = 0,
        enriched: int = 0,
        elapsed: int = 0,
    ) -> None:
        state = ProgressStateSchema(
            run_id=run_id,
            stage=stage,
            progress_percent=pct,
            message=msg,
            videos_collected=cand_vids,
            channels_analyzed=enriched,
            keywords_expanded=cand_chans,
            elapsed_seconds=elapsed,
            can_cancel=stage not in ("COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"),
        )
        await task_manager.emit_progress(state)

    def _db_update_run(self, run_id: str, **kwargs: Any) -> None:
        db = SessionLocal()
        try:
            obj = db.get(SimilarChannelRun, run_id)
            if obj:
                for k, v in kwargs.items():
                    if hasattr(obj, k):
                        setattr(obj, k, v)
                obj.updated_at = utcnow_str()
                db.commit()
        except Exception as e:
            research_logger.warning(f"[SimilarDisc] DB update failed for {run_id}: {e}")
            db.rollback()
        finally:
            db.close()

    async def start(
        self,
        source_channel_id: str,
        source_channel_title: str,
        source_videos: List[Dict[str, Any]],
        market: str = "US",
        language: str = "en",
        content_type: str = "LONG",
        window_days: int = 90,
        min_views: int = 10_000,
        max_subscribers: int = 50_000,
        min_evaluable_videos: int = 3,
        candidate_channel_limit: int = 40,
        search_query_budget: int = 18,
    ) -> str:
        """Start background discovery. Returns run_id immediately."""
        run_id = f"sc_{uuid.uuid4().hex[:12]}"

        db = SessionLocal()
        try:
            run_rec = SimilarChannelRun(
                run_id=run_id,
                source_channel_id=source_channel_id,
                source_channel_title=source_channel_title,
                market=market,
                language=language,
                content_type=content_type,
                window_days=window_days,
                min_views=min_views,
                max_subscribers=max_subscribers,
                min_evaluable_videos=min_evaluable_videos,
                status="QUEUED",
                stage="STARTING",
                progress_percent=0,
            )
            db.add(run_rec)
            db.commit()
        finally:
            db.close()

        task = asyncio.create_task(
            self._run(
                run_id=run_id,
                source_channel_id=source_channel_id,
                source_channel_title=source_channel_title,
                source_videos=source_videos,
                market=market,
                language=language,
                content_type=content_type,
                window_days=window_days,
                min_views=min_views,
                max_subscribers=max_subscribers,
                min_evaluable_videos=min_evaluable_videos,
                candidate_channel_limit=candidate_channel_limit,
                search_query_budget=search_query_budget,
            )
        )
        task_manager.register_run(run_id, task)
        research_logger.info(f"[SimilarDisc] Started run {run_id} for source channel {source_channel_id}")
        return run_id

    async def _run(
        self,
        run_id: str,
        source_channel_id: str,
        source_channel_title: str,
        source_videos: List[Dict[str, Any]],
        market: str,
        language: str,
        content_type: str,
        window_days: int,
        min_views: int,
        max_subscribers: int,
        min_evaluable_videos: int,
        candidate_channel_limit: int,
        search_query_budget: int,
    ) -> None:
        import time
        start_t = time.time()
        elapsed = lambda: int(time.time() - start_t)

        minimum_candidate_target = 10
        preferred_candidate_target = 20
        maximum_search_calls = min(search_query_budget, 18)

        # Diagnostics collection (Section III)
        diagnostics: Dict[str, Any] = {
            "discovery_passes_run": [],
            "queries_generated": 0,
            "queries_executed": 0,
            "search_calls_used": 0,
            "raw_videos_found": 0,
            "unique_videos_found": 0,
            "videos_with_verified_dates": 0,
            "videos_with_approximate_dates": 0,
            "videos_with_unknown_dates": 0,
            "unique_channels_found": 0,
            "synthetic_channel_ids_found": 0,
            "resolved_channel_ids": 0,
            "unresolved_channel_ids": 0,
            "channels_enriched": 0,
            "channels_under_subscriber_limit": 0,
            "channels_matching_niche": 0,
            "provider_breakdown": {},
            "stop_reason": "",
        }

        try:
            self._db_update_run(run_id, status="RUNNING", stage="STARTING", progress_percent=2)
            await self._emit(run_id, "STARTING", 2, "Initializing similar channel discovery...", elapsed=elapsed())

            window_end = datetime.now(timezone.utc)
            window_start = window_end - timedelta(days=window_days)
            pa_iso = window_start.strftime("%Y-%m-%dT%H:%M:%SZ")
            pb_iso = window_end.strftime("%Y-%m-%dT%H:%M:%SZ")

            if self._is_cancelled(run_id):
                self._db_update_run(run_id, status="CANCELLED", stage="CANCELLED")
                await self._emit(run_id, "CANCELLED", 0, "Cancelled by user")
                return

            # ── 1. Niche Fingerprint ───────────────────────────────────────────
            self._db_update_run(run_id, stage="BUILDING_NICHE_FINGERPRINT", progress_percent=6)
            await self._emit(run_id, "BUILDING_NICHE_FINGERPRINT", 6,
                             "Building weighted niche fingerprint from source channel...", elapsed=elapsed())

            fp = _build_niche_fingerprint(source_channel_title, source_videos, {"market": market, "language": language})
            fp_json = json.dumps(fp, ensure_ascii=False)
            self._db_update_run(run_id, niche_fingerprint_json=fp_json)

            # ── 2. Progressive Discovery Passes ────────────────────────────────
            seen_query_texts: set = set()
            seen_video_ids: set = set()
            candidate_channel_videos: Dict[str, List[Any]] = {}
            provider_counter: Counter = Counter()

            for pass_num in range(1, 5):
                if self._is_cancelled(run_id):
                    break

                # Early stopping condition
                if len(candidate_channel_videos) >= preferred_candidate_target:
                    diagnostics["stop_reason"] = "REACHED_PREFERRED_TARGET"
                    break
                if pass_num >= 3 and len(candidate_channel_videos) >= minimum_candidate_target:
                    diagnostics["stop_reason"] = "REACHED_MINIMUM_TARGET"
                    break
                if diagnostics["search_calls_used"] >= maximum_search_calls:
                    diagnostics["stop_reason"] = "MAX_SEARCH_CALLS_REACHED"
                    break

                pass_name = f"PASS_{pass_num}"
                diagnostics["discovery_passes_run"].append(pass_name)

                # Set stage label
                stage_name = "SEARCHING_EXACT_MATCHES" if pass_num == 1 else (
                    "SEARCHING_PERFORMANCE_RESULTS" if pass_num == 2 else "EXPANDING_SEARCH_QUERIES"
                )
                self._db_update_run(run_id, stage=stage_name)

                queries = _generate_pass_queries(fp, source_videos, pass_num, seen_query_texts)
                diagnostics["queries_generated"] += len(queries)

                for q_idx, q_item in enumerate(queries):
                    if self._is_cancelled(run_id):
                        break
                    if diagnostics["search_calls_used"] >= maximum_search_calls:
                        diagnostics["stop_reason"] = "MAX_SEARCH_CALLS_REACHED"
                        break

                    query_str = q_item["query"]
                    order_val = q_item["order"]

                    await self._emit(
                        run_id, stage_name,
                        min(35, 8 + int(diagnostics["search_calls_used"] / max(maximum_search_calls, 1) * 26)),
                        f"Pass {pass_num}/4 · {len(seen_video_ids)} videos · {len(candidate_channel_videos)} unique channels (query: '{query_str[:25]}...')",
                        cand_vids=len(seen_video_ids), cand_chans=len(candidate_channel_videos), elapsed=elapsed()
                    )

                    try:
                        async with self._semaphore:
                            results = await self.provider_mgr.search_videos(
                                query=query_str, market=market, language=language,
                                content_type=content_type, time_range=f"{window_days}d",
                                limit=50, published_after=pa_iso, published_before=pb_iso,
                                order=order_val, merge_sources=True,
                            )
                        diagnostics["search_calls_used"] += 1
                        diagnostics["queries_executed"] += 1

                        for v in results:
                            vid = getattr(v, "video_id", None)
                            if not vid:
                                continue
                            diagnostics["raw_videos_found"] += 1
                            provider_counter[getattr(v, "provider", "UNKNOWN")] += 1

                            # Date quality parsing
                            pub_raw = getattr(v, "published_at", "")
                            dq = parse_published_date_with_quality(pub_raw)
                            if dq["date_quality"] == "VERIFIED":
                                diagnostics["videos_with_verified_dates"] += 1
                            elif dq["date_quality"] == "APPROXIMATED":
                                diagnostics["videos_with_approximate_dates"] += 1
                            else:
                                diagnostics["videos_with_unknown_dates"] += 1

                            if vid in seen_video_ids:
                                continue
                            seen_video_ids.add(vid)
                            diagnostics["unique_videos_found"] += 1

                            # Synthetic channel ID resolution (Section II.3)
                            cid = getattr(v, "channel_id", "")
                            if is_synthetic_channel_id(cid):
                                diagnostics["synthetic_channel_ids_found"] += 1
                                # Resolve via watch page or official API
                                resolved_cid = await self.provider_mgr.resolve_channel_id(vid)
                                if resolved_cid and not is_synthetic_channel_id(resolved_cid):
                                    cid = resolved_cid
                                    v.channel_id = resolved_cid
                                    diagnostics["resolved_channel_ids"] += 1
                                else:
                                    diagnostics["unresolved_channel_ids"] += 1
                                    continue  # Skip unresolved synthetic channel IDs!

                            if cid and cid != source_channel_id:
                                candidate_channel_videos.setdefault(cid, []).append(v)

                    except Exception as err:
                        research_logger.warning(f"[SimilarDisc] Error in search query '{query_str}': {err}")

                    # Check early break within pass
                    if len(candidate_channel_videos) >= preferred_candidate_target:
                        break

            if not diagnostics["stop_reason"]:
                diagnostics["stop_reason"] = "ALL_PASSES_COMPLETED"
            diagnostics["unique_channels_found"] = len(candidate_channel_videos)
            diagnostics["provider_breakdown"] = dict(provider_counter)

            if self._is_cancelled(run_id):
                self._db_update_run(run_id, status="CANCELLED", stage="CANCELLED")
                await self._emit(run_id, "CANCELLED", 35, "Cancelled by user")
                return

            # ── 3. Group and select candidate channels ────────────────────────
            sorted_candidates = sorted(
                candidate_channel_videos.items(),
                key=lambda x: len(x[1]),
                reverse=True
            )
            top_channel_tuples = sorted_candidates[:candidate_channel_limit]

            self._db_update_run(
                run_id,
                candidate_videos_found=len(seen_video_ids),
                candidate_channels_found=len(top_channel_tuples),
                stage="ENRICHING_90_DAY_WINDOW",
                progress_percent=38,
            )

            # ── 4. Channel Enrichment (90d window & 365d history) ─────────────
            await self._emit(
                run_id, "ENRICHING_90_DAY_WINDOW", 40,
                f"Enriching {len(top_channel_tuples)} candidate channels in exact 90-day window...",
                cand_vids=len(seen_video_ids), cand_chans=len(top_channel_tuples), elapsed=elapsed()
            )

            enriched_channels: List[Dict[str, Any]] = []
            run_limitations: List[str] = []

            for c_idx, (cid, search_vids) in enumerate(top_channel_tuples):
                if self._is_cancelled(run_id):
                    break

                ch_record: Dict[str, Any] = {
                    "channel_id": cid,
                    "channel_title": getattr(search_vids[0], "channel_title", cid),
                    "channel_url": f"https://www.youtube.com/channel/{cid}",
                    "subscriber_count": None,
                    "country": None,
                    "public_video_count": None,
                    "performance_videos_90d": [],
                    "history_videos_365d": [],
                    "window_coverage": "UNKNOWN",
                    "history_coverage": "UNKNOWN",
                    "enrichment_error": 0,
                }

                # Step 4a: Get exact 90-day window videos
                try:
                    async with self._semaphore:
                        vids_90d, coverage_90d = await self.provider_mgr.get_channel_videos_in_window(
                            channel_id=cid, content_type=content_type,
                            published_after=window_start, published_before=window_end, max_videos=100
                        )
                    ch_record["performance_videos_90d"] = vids_90d
                    ch_record["window_coverage"] = coverage_90d
                except Exception as err:
                    research_logger.warning(f"[SimilarDisc] Error getting 90d window for {cid}: {err}")
                    ch_record["enrichment_error"] += 1

                # Step 4b: Get channel metadata and 365d history for durability
                try:
                    async with self._semaphore:
                        bl = await self.provider_mgr.get_channel_baseline(
                            channel_id=cid, content_type=content_type, max_videos=45
                        )
                    if bl:
                        ch_record["channel_title"] = bl.title or ch_record["channel_title"]
                        ch_record["subscriber_count"] = bl.subscriber_count
                        ch_record["country"] = bl.country
                        ch_record["public_video_count"] = bl.video_count

                        # Extract 365-day history
                        history_365 = []
                        history_cut = window_end - timedelta(days=365)
                        for hv in (bl.recent_videos or []):
                            pub_str = getattr(hv, "published_at", "")
                            p_info = parse_published_date_with_quality(pub_str)
                            h_dt = p_info.get("published_at")
                            if h_dt and history_cut <= h_dt <= window_end:
                                history_365.append(hv)
                        ch_record["history_videos_365d"] = history_365
                        ch_record["history_coverage"] = "COMPLETE" if len(history_365) >= 5 else "PARTIAL"
                except Exception as err:
                    research_logger.warning(f"[SimilarDisc] Error getting channel baseline for {cid}: {err}")
                    ch_record["enrichment_error"] += 1
                    run_limitations.append(f"Channel {cid}: metadata enrichment degraded")

                # Merge search videos if window videos came back sparse
                merged_90d: Dict[str, Any] = {}
                for v in ch_record["performance_videos_90d"]:
                    vid = getattr(v, "video_id", None)
                    if vid:
                        merged_90d[vid] = v
                for v in search_vids:
                    vid = getattr(v, "video_id", None)
                    if vid and vid not in merged_90d:
                        p_info = parse_published_date_with_quality(getattr(v, "published_at", ""))
                        v_dt = p_info.get("published_at")
                        if v_dt and window_start <= v_dt <= window_end:
                            merged_90d[vid] = v
                ch_record["performance_videos_90d"] = list(merged_90d.values())

                ch_record["subscriber_status"] = classify_subscriber_status_similar(
                    ch_record["subscriber_count"], max_subscribers
                )
                if ch_record["subscriber_status"] == SUBSCRIBER_VERIFIED_UNDER:
                    diagnostics["channels_under_subscriber_limit"] += 1

                enriched_channels.append(ch_record)
                diagnostics["channels_enriched"] += 1

                pct = 40 + int((c_idx + 1) / max(len(top_channel_tuples), 1) * 28)
                await self._emit(
                    run_id, "ENRICHING_90_DAY_WINDOW", pct,
                    f"Enriching channel {c_idx+1}/{len(top_channel_tuples)}: {ch_record['channel_title']}...",
                    cand_vids=len(seen_video_ids), cand_chans=len(top_channel_tuples),
                    enriched=c_idx+1, elapsed=elapsed()
                )

            # ── 5. Snapshot loading & Video Evaluation ────────────────────────
            self._db_update_run(run_id, channels_enriched=len(enriched_channels), stage="LOADING_GROWTH_SNAPSHOTS", progress_percent=70)
            await self._emit(
                run_id, "LOADING_GROWTH_SNAPSHOTS", 70,
                f"Loading snapshots and evaluating videos for {len(enriched_channels)} channels...",
                cand_vids=len(seen_video_ids), cand_chans=len(top_channel_tuples),
                enriched=len(enriched_channels), elapsed=elapsed()
            )

            repo_db = SessionLocal()
            research_repo = ResearchRepository(repo_db)
            candidate_dicts: List[Dict[str, Any]] = []

            try:
                for ch in enriched_channels:
                    cid = ch["channel_id"]
                    raw_90d = ch["performance_videos_90d"]
                    raw_365 = ch["history_videos_365d"]

                    # Evaluate each 90-day video
                    ev_vids: List[Dict[str, Any]] = []
                    for v in raw_90d:
                        vid = getattr(v, "video_id", "")
                        pub_str = getattr(v, "published_at", "")
                        views_val = int(getattr(v, "views", 0) or 0)
                        likes_val = getattr(v, "likes", None)
                        comm_val = getattr(v, "comments", None)

                        # Query existing snapshots from DB (Section VII)
                        snaps = research_repo.get_video_snapshots(vid)

                        v_dict = {
                            "video_id": vid, "title": getattr(v, "title", ""),
                            "published_at": pub_str, "views": views_val,
                            "likes": likes_val, "comments": comm_val,
                            "duration_seconds": getattr(v, "duration_seconds", None),
                        }
                        ev = evaluate_video(v_dict, window_end=window_end, min_views=min_views, snapshots=snaps)

                        # Record new snapshot to DB so subsequent runs can confirm growth
                        try:
                            research_repo.add_snapshot_if_eligible(
                                video_id=vid, views=views_val, likes=likes_val,
                                comments=comm_val, min_interval_hours=2
                            )
                        except Exception:
                            pass

                        p_date = parse_published_date_with_quality(pub_str)
                        dt = p_date.get("published_at")
                        age_d = round((window_end - dt).total_seconds() / 86400.0, 2) if dt else 0.0

                        ev_vids.append({
                            "video_id": vid,
                            "video_url": f"https://www.youtube.com/watch?v={vid}",
                            "title": getattr(v, "title", ""),
                            "published_at": pub_str,
                            "date_quality": p_date.get("date_quality", "APPROXIMATED"),
                            "age_days": age_d,
                            "duration_seconds": getattr(v, "duration_seconds", None),
                            "views": views_val,
                            "likes": likes_val,
                            "comments": comm_val,
                            "lifetime_views_per_day": ev["lifetime_vpd"],
                            "observed_views_per_day": ev.get("observed_vpd"),
                            "projected_day_90_views": ev.get("projected_day_90"),
                            "growth_status": ev["growth_status"],
                            "evaluation_status": ev["evaluation_status"],
                            "evaluation_reason": ev.get("evaluation_reason", ""),
                            "niche_similarity": 0.0,
                            "snapshot_count": len(snaps),
                        })

                    # Counts
                    pv   = sum(1 for e in ev_vids if e["evaluation_status"] == VIDEO_PASS_VIEWS)
                    pc   = sum(1 for e in ev_vids if e["evaluation_status"] == VIDEO_PASS_GROWTH_CONFIRMED)
                    pp   = sum(1 for e in ev_vids if e["evaluation_status"] == VIDEO_PASS_GROWTH_PROVISIONAL)
                    pend = sum(1 for e in ev_vids if e["evaluation_status"] == VIDEO_PENDING_TOO_NEW)
                    fail = sum(1 for e in ev_vids if e["evaluation_status"] == VIDEO_FAIL)
                    ev_count = pv + pc + pp + fail

                    strict_r = (pv + pc) / max(ev_count, 1)
                    prov_r   = (pv + pc + pp) / max(ev_count, 1)

                    ev_views = [e["views"] for e in ev_vids if e["evaluation_status"] not in (VIDEO_PENDING_TOO_NEW, VIDEO_EXCLUDED)]
                    vs = compute_view_stats(ev_views)
                    shd = vs.get("single_hit_dependency", 0.0)

                    # Niche Match Score (Section VIII)
                    v_dicts_for_niche = [{"title": e["title"], "video_id": e["video_id"]} for e in ev_vids]
                    niche_res = compute_niche_match_score(fp, v_dicts_for_niche, candidate_country=ch.get("country"))
                    niche_s = niche_res.score
                    niche_r = niche_res.reason
                    m_topics = niche_res.matched_topics
                    m_ids = niche_res.matched_video_ids
                    niche_evidence = niche_res.evidence

                    if niche_s >= 65.0:
                        diagnostics["channels_matching_niche"] += 1

                    # Update video niche similarity
                    for ev_item in ev_vids:
                        if ev_item["video_id"] in m_ids:
                            ev_item["niche_similarity"] = niche_s

                    # 365-day history metrics (Section VI)
                    history_titles = [getattr(hv, "title", "") for hv in raw_365] if raw_365 else [e["title"] for e in ev_vids]
                    eg = compute_evergreen_ratio(history_titles)
                    nc, na = compute_topic_clusters(history_titles)

                    # Active months in last 12 months using 365d history
                    history_pub_dates = []
                    for hv in (raw_365 if raw_365 else raw_90d):
                        p_dt = parse_published_date_with_quality(getattr(hv, "published_at", "")).get("published_at")
                        if p_dt:
                            history_pub_dates.append(p_dt)

                    active_months = len({(d.year, d.month) for d in history_pub_dates})

                    med_cad = None
                    max_gap = None
                    if len(history_pub_dates) >= 2:
                        sd = sorted(history_pub_dates)
                        gaps = [(sd[i+1] - sd[i]).total_seconds() / 86400.0 for i in range(len(sd)-1)]
                        gaps = [g for g in gaps if g > 0]
                        if gaps:
                            sg = sorted(gaps)
                            n = len(sg)
                            med_cad = sg[n//2] if n % 2 else (sg[n//2-1] + sg[n//2]) / 2.0
                            max_gap = max(gaps)

                    avg_vpd = (sum(e["lifetime_views_per_day"] for e in ev_vids) / max(len(ev_vids), 1))

                    cons_s = compute_recent_consistency_score(pv, pc, pp, fail, ev_count, shd)
                    grow_s = compute_growth_quality_score(pc, pp, pv, ev_count, avg_vpd)
                    dur_s  = compute_durability_score(
                        active_months, med_cad, max_gap, shd, eg, nc, na, len(history_pub_dates)
                    )
                    mono_s, mono_l, mono_e, p_flags = compute_monetization_viability_score(
                        history_titles, eg, nc, active_months, shd
                    )
                    sub_status = ch["subscriber_status"]
                    has_snaps = any(e.get("snapshot_count", 0) > 0 for e in ev_vids)
                    conf_l, conf_s, conf_lims = compute_data_confidence(
                        sub_status, ev_count, has_snaps, bool(raw_365 and len(raw_365) >= 5),
                        ch.get("enrichment_error", 0), window_coverage=ch["window_coverage"]
                    )
                    final_s = compute_final_score(niche_s, cons_s, grow_s, dur_s, mono_s, conf_s)

                    cand_status, qual_r, rej_r = determine_candidate_status(
                        sub_status, niche_s, ev_count, strict_r, prov_r, pp > 0, final_s, conf_l,
                        window_coverage=ch["window_coverage"]
                    )

                    candidate_dicts.append({
                        "channel_id": cid,
                        "channel_title": ch["channel_title"],
                        "channel_url": ch["channel_url"],
                        "country": ch.get("country"),
                        "subscriber_count": ch.get("subscriber_count"),
                        "subscriber_status": sub_status,
                        "public_video_count": ch.get("public_video_count"),
                        "window_start": window_start.isoformat(),
                        "window_end": window_end.isoformat(),
                        "recent_video_count": len(ev_vids),
                        "evaluable_video_count": ev_count,
                        "pending_video_count": pend,
                        "passed_views_count": pv,
                        "passed_growth_confirmed_count": pc,
                        "passed_growth_provisional_count": pp,
                        "failed_video_count": fail,
                        "strict_success_ratio": round(strict_r, 4),
                        "provisional_success_ratio": round(prov_r, 4),
                        "minimum_recent_views": vs["minimum"],
                        "median_recent_views": vs["median"],
                        "mean_recent_views": vs["mean"],
                        "p25_recent_views": vs["p25"],
                        "p75_recent_views": vs["p75"],
                        "maximum_recent_views": vs["maximum"],
                        "total_recent_views": vs["total"],
                        "single_hit_dependency": shd,
                        "niche_match_reason": niche_r,
                        "matched_topics": m_topics,
                        "matched_video_ids": m_ids,
                        "active_months_last_12": active_months,
                        "median_upload_cadence_days": round(med_cad, 1) if med_cad else None,
                        "maximum_upload_gap_days": round(max_gap, 1) if max_gap else None,
                        "evergreen_ratio": eg,
                        "topic_cluster_count": nc,
                        "future_title_angle_count": na,
                        "monetization_viability": mono_l,
                        "monetization_evidence": mono_e,
                        "policy_risk_flags": p_flags,
                        "data_confidence": conf_l,
                        "confidence_limitations": conf_lims,
                        "qualification_reasons": qual_r,
                        "rejection_reasons": rej_r,
                        "status": cand_status,
                        "is_most_promising": False,
                        "most_promising_label": None,
                        "window_coverage": ch["window_coverage"],
                        "history_coverage": ch["history_coverage"],
                        "source_coverage": niche_evidence.get("source_coverage", 0.0),
                        "candidate_precision": niche_evidence.get("candidate_precision", 0.0),
                        "median_title_similarity": niche_evidence.get("median_title_similarity", 0.0),
                        "matched_terms": niche_evidence.get("matched_terms", []),
                        "matched_entities": niche_evidence.get("matched_entities", []),
                        "matched_clusters": niche_evidence.get("matched_clusters", []),
                        "date_quality": "VERIFIED" if any(e.get("date_quality") == "VERIFIED" for e in ev_vids) else "APPROXIMATED",
                        "scores": {
                            "niche_match_score": niche_s,
                            "recent_consistency_score": cons_s,
                            "growth_quality_score": grow_s,
                            "durability_score": dur_s,
                            "monetization_viability_score": mono_s,
                            "data_confidence_score": conf_s,
                            "final_score": final_s,
                        },
                        "recent_videos": ev_vids,
                        "niche_match_score": niche_s,
                        "final_score": final_s,
                    })

            finally:
                repo_db.close()

            # ── 6. Ranking & Best Available Selection (Section X & XI) ────────
            self._db_update_run(run_id, stage="SELECTING_BEST_AVAILABLE", progress_percent=86)
            await self._emit(
                run_id, "SELECTING_BEST_AVAILABLE", 86,
                "Ranking candidates and computing Best Available fallback recommendations...",
                cand_vids=len(seen_video_ids), cand_chans=len(top_channel_tuples),
                enriched=len(enriched_channels), elapsed=elapsed()
            )

            candidate_dicts = rank_candidates(candidate_dicts)
            most_promising, best_available_cands, rec_mode = select_best_available_and_recommendations(candidate_dicts)

            mp_reasons: List[str] = []
            if most_promising:
                mp_reasons = build_most_promising_reasons(most_promising)

            qc = sum(1 for c in candidate_dicts if c["status"] == "QUALIFIED")
            gc = sum(1 for c in candidate_dicts if c["status"] == "GROWING")
            wc = sum(1 for c in candidate_dicts if c["status"] == "WATCHLIST")
            rc = sum(1 for c in candidate_dicts if c["status"] == "REJECTED")

            # ── 7. Persist to DB ──────────────────────────────────────────────
            self._db_update_run(run_id, stage="PERSISTING", progress_percent=94)
            await self._emit(
                run_id, "PERSISTING", 94,
                f"Saving {len(candidate_dicts)} candidates ({qc} qualified, {gc} growing, {wc} watchlist, {rc} rejected)...",
                elapsed=elapsed()
            )

            db = SessionLocal()
            try:
                run_obj = db.get(SimilarChannelRun, run_id)
                if run_obj:
                    run_obj.status = "COMPLETED"
                    run_obj.stage = "COMPLETED"
                    run_obj.progress_percent = 100
                    run_obj.candidate_videos_found = len(seen_video_ids)
                    run_obj.candidate_channels_found = len(top_channel_tuples)
                    run_obj.channels_enriched = len(enriched_channels)
                    run_obj.qualified_count = qc
                    run_obj.growing_count = gc
                    run_obj.watchlist_count = wc
                    run_obj.rejected_count = rc
                    run_obj.most_promising_channel_id = most_promising["channel_id"] if most_promising else None
                    run_obj.most_promising_status = most_promising["status"] if most_promising else None
                    run_obj.most_promising_reason_json = json.dumps(mp_reasons, ensure_ascii=False)
                    run_obj.best_available_channel_id = most_promising["channel_id"] if most_promising else None
                    run_obj.best_available_status = most_promising["status"] if most_promising else None
                    run_obj.best_available_reason_json = json.dumps(mp_reasons, ensure_ascii=False)
                    run_obj.best_available_candidates_json = json.dumps([
                        {
                            "channel_id": bc["channel_id"],
                            "channel_title": bc["channel_title"],
                            "status": bc["status"],
                            "recommendation_tier": bc.get("recommendation_tier"),
                            "best_available_rank": bc.get("best_available_rank"),
                            "final_score": bc["scores"]["final_score"],
                            "gap_score": bc.get("qualification_gap_score", 0.0),
                            "unmet_criteria": bc.get("unmet_criteria", []),
                        }
                        for bc in best_available_cands
                    ], ensure_ascii=False)
                    run_obj.recommendation_tier = most_promising.get("recommendation_tier") if most_promising else TIER_NOT_RECOMMENDED
                    run_obj.discovery_diagnostics_json = json.dumps(diagnostics, ensure_ascii=False)
                    run_obj.niche_fingerprint_json = fp_json
                    run_obj.limitations_json = json.dumps(run_limitations[:20], ensure_ascii=False)
                    run_obj.provider_summary_json = json.dumps(diagnostics["provider_breakdown"], ensure_ascii=False)
                    run_obj.completed_at = utcnow_str()
                    run_obj.updated_at = utcnow_str()

                for cand in candidate_dicts:
                    cr = SimilarChannelCandidate(
                        run_id=run_id,
                        rank=cand.get("rank", 0),
                        channel_id=cand["channel_id"],
                        channel_title=cand["channel_title"],
                        channel_url=cand["channel_url"],
                        country=cand.get("country"),
                        subscriber_count=cand.get("subscriber_count"),
                        subscriber_status=cand.get("subscriber_status", "HIDDEN_UNVERIFIED"),
                        public_video_count=cand.get("public_video_count"),
                        status=cand.get("status", "REJECTED"),
                        is_most_promising=cand.get("is_most_promising", False),
                        most_promising_label=cand.get("most_promising_label"),
                        recommendation_tier=cand.get("recommendation_tier", TIER_MONITOR),
                        best_available_rank=cand.get("best_available_rank"),
                        is_best_available=cand.get("is_best_available", False),
                        qualification_gap_score=cand.get("qualification_gap_score", 0.0),
                        unmet_criteria_json=json.dumps(cand.get("unmet_criteria", []), ensure_ascii=False),
                        window_coverage=cand.get("window_coverage", "UNKNOWN"),
                        history_coverage=cand.get("history_coverage", "UNKNOWN"),
                        date_quality=cand.get("date_quality", "APPROXIMATED"),
                        source_coverage=cand.get("source_coverage", 0.0),
                        candidate_precision=cand.get("candidate_precision", 0.0),
                        median_title_similarity=cand.get("median_title_similarity", 0.0),
                        matched_terms_json=json.dumps(cand.get("matched_terms", []), ensure_ascii=False),
                        matched_entities_json=json.dumps(cand.get("matched_entities", []), ensure_ascii=False),
                        matched_clusters_json=json.dumps(cand.get("matched_clusters", []), ensure_ascii=False),
                        window_start=cand.get("window_start", ""),
                        window_end=cand.get("window_end", ""),
                        recent_video_count=cand.get("recent_video_count", 0),
                        evaluable_video_count=cand.get("evaluable_video_count", 0),
                        pending_video_count=cand.get("pending_video_count", 0),
                        passed_views_count=cand.get("passed_views_count", 0),
                        passed_growth_confirmed_count=cand.get("passed_growth_confirmed_count", 0),
                        passed_growth_provisional_count=cand.get("passed_growth_provisional_count", 0),
                        failed_video_count=cand.get("failed_video_count", 0),
                        strict_success_ratio=cand.get("strict_success_ratio", 0.0),
                        provisional_success_ratio=cand.get("provisional_success_ratio", 0.0),
                        minimum_recent_views=cand.get("minimum_recent_views"),
                        median_recent_views=cand.get("median_recent_views"),
                        mean_recent_views=cand.get("mean_recent_views"),
                        p25_recent_views=cand.get("p25_recent_views"),
                        p75_recent_views=cand.get("p75_recent_views"),
                        maximum_recent_views=cand.get("maximum_recent_views"),
                        total_recent_views=cand.get("total_recent_views", 0),
                        single_hit_dependency=cand.get("single_hit_dependency", 0.0),
                        niche_match_reason=cand.get("niche_match_reason", ""),
                        matched_topics_json=json.dumps(cand.get("matched_topics", []), ensure_ascii=False),
                        matched_video_ids_json=json.dumps(cand.get("matched_video_ids", []), ensure_ascii=False),
                        active_months_last_12=cand.get("active_months_last_12", 0),
                        median_upload_cadence_days=cand.get("median_upload_cadence_days"),
                        maximum_upload_gap_days=cand.get("maximum_upload_gap_days"),
                        evergreen_ratio=cand.get("evergreen_ratio"),
                        topic_cluster_count=cand.get("topic_cluster_count", 0),
                        future_title_angle_count=cand.get("future_title_angle_count", 0),
                        monetization_viability=cand.get("monetization_viability", "UNKNOWN"),
                        monetization_evidence_json=json.dumps(cand.get("monetization_evidence", []), ensure_ascii=False),
                        policy_risk_flags_json=json.dumps(cand.get("policy_risk_flags", []), ensure_ascii=False),
                        data_confidence=cand.get("data_confidence", "INSUFFICIENT"),
                        confidence_limitations_json=json.dumps(cand.get("confidence_limitations", []), ensure_ascii=False),
                        qualification_reasons_json=json.dumps(cand.get("qualification_reasons", []), ensure_ascii=False),
                        rejection_reasons_json=json.dumps(cand.get("rejection_reasons", []), ensure_ascii=False),
                        niche_match_score=cand["scores"]["niche_match_score"],
                        recent_consistency_score=cand["scores"]["recent_consistency_score"],
                        growth_quality_score=cand["scores"]["growth_quality_score"],
                        durability_score=cand["scores"]["durability_score"],
                        monetization_viability_score=cand["scores"]["monetization_viability_score"],
                        data_confidence_score=cand["scores"]["data_confidence_score"],
                        final_score=cand["scores"]["final_score"],
                    )
                    db.add(cr)

                    for vid in cand.get("recent_videos", []):
                        db.add(SimilarChannelVideo(
                            run_id=run_id,
                            channel_id=cand["channel_id"],
                            video_id=vid.get("video_id", ""),
                            video_url=vid.get("video_url", ""),
                            title=vid.get("title", ""),
                            published_at=vid.get("published_at", ""),
                            date_quality=vid.get("date_quality", "APPROXIMATED"),
                            age_days=vid.get("age_days", 0.0),
                            duration_seconds=vid.get("duration_seconds"),
                            views=vid.get("views", 0),
                            likes=vid.get("likes"),
                            comments=vid.get("comments"),
                            lifetime_views_per_day=vid.get("lifetime_views_per_day", 0.0),
                            observed_views_per_day=vid.get("observed_views_per_day"),
                            projected_day_90_views=vid.get("projected_day_90_views"),
                            growth_status=vid.get("growth_status", "UNKNOWN"),
                            evaluation_status=vid.get("evaluation_status", "PENDING"),
                            evaluation_reason=vid.get("evaluation_reason", ""),
                            niche_similarity=vid.get("niche_similarity", 0.0),
                            snapshot_count=vid.get("snapshot_count", 0),
                        ))

                db.commit()
            except Exception as db_err:
                research_logger.error(f"[SimilarDisc] DB persistence error for {run_id}: {db_err}", exc_info=True)
                db.rollback()
            finally:
                db.close()

            status_msg = f"{len(top_channel_tuples)} channels discovered · {len(enriched_channels)} enriched · {len(best_available_cands)} recommended"
            await self._emit(
                run_id, "COMPLETED", 100, status_msg,
                cand_vids=len(seen_video_ids), cand_chans=len(top_channel_tuples),
                enriched=len(enriched_channels), elapsed=elapsed()
            )
            research_logger.info(f"[SimilarDisc] {run_id} DONE in {elapsed()}s — Q={qc} G={gc} W={wc} R={rc} ({status_msg})")

        except asyncio.CancelledError:
            self._db_update_run(run_id, status="CANCELLED", stage="CANCELLED")
            await self._emit(run_id, "CANCELLED", 0, "Task cancelled")
            raise
        except Exception as e:
            research_logger.error(f"[SimilarDisc] {run_id} FAILED: {e}", exc_info=True)
            self._db_update_run(run_id, status="FAILED", stage="FAILED", error=str(e)[:500])
            await self._emit(run_id, "FAILED", 0, f"Discovery failed: {str(e)[:200]}")
