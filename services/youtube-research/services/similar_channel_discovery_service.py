"""
similar_channel_discovery_service.py
Background service for discovering channels in the same niche as a competitor.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from core.logger import research_logger
from db.engine import SessionLocal
from models.entities import (
    SimilarChannelRun, SimilarChannelCandidate, SimilarChannelVideo, utcnow_str
)
from providers.fallback import ProviderFallbackManager
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
    rank_candidates,
    select_most_promising,
    build_most_promising_reasons,
    VIDEO_PASS_VIEWS,
    VIDEO_PASS_GROWTH_CONFIRMED,
    VIDEO_PASS_GROWTH_PROVISIONAL,
    VIDEO_PENDING_TOO_NEW,
    VIDEO_FAIL,
    VIDEO_EXCLUDED,
)
from workers.task_manager import task_manager
from schemas.research_schemas import ProgressStateSchema


import re
from collections import Counter


def _build_niche_fingerprint(
    channel_title: str,
    videos: List[Dict[str, Any]],
    competitor_data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Deterministic fingerprint from source channel videos."""
    stop = {
        "the","a","an","and","or","but","in","on","at","to","for","of","with",
        "is","are","was","were","be","been","have","has","do","does","did","i",
        "you","he","she","it","we","they","this","that","what","how","why",
        "which","not","no","so","if","as","my","your","video","youtube","watch",
    }

    word_freq: Counter = Counter()
    patterns: List[str] = []

    for v in videos:
        title = v.get("title", "")
        tokens = [w for w in re.findall(r"\b\w{3,}\b", title.lower()) if w not in stop]
        for tok in tokens:
            word_freq[tok] += 1
        low = title.lower()
        if "how" in low:
            patterns.append("how-to")
        elif "why" in low:
            patterns.append("why")
        elif any(q in low for q in ("vs", "versus", "compared")):
            patterns.append("comparison")
        elif "?" in title:
            patterns.append("question-hook")
        elif any(n in low for n in ["top", "best", "worst"]):
            patterns.append("list")

    common = [w for w, c in word_freq.most_common(25) if c >= 2]
    recurring_phrases = common[:12]
    recurring_entities = [w for w in common if len(w) > 4][:8]

    cluster_size = max(1, len(common) // 3)
    topic_clusters = [
        " ".join(common[i * cluster_size:(i + 1) * cluster_size])
        for i in range(min(4, len(common) // max(cluster_size, 1)))
    ]
    if not topic_clusters and common:
        topic_clusters = [" ".join(common[:5])]

    pattern_freq: Counter = Counter(patterns)
    dominant_formats = [fmt for fmt, _ in pattern_freq.most_common(3)]
    if not dominant_formats:
        dominant_formats = ["long-form-educational"]

    core_subject = " ".join(common[:3]) if common else channel_title
    audience_problem = " ".join(common[3:6]) if len(common) >= 6 else core_subject

    news_kw = {"today","now","breaking","latest","2024","2025","2026","reaction","news","live"}
    news_dep = sum(1 for v in videos if any(k in v.get("title","").lower() for k in news_kw))
    news_ratio = round(news_dep / max(len(videos), 1), 2)

    return {
        "core_subject": core_subject,
        "audience_problem": audience_problem,
        "viewer_promise": common[0] if common else "",
        "recurring_entities": recurring_entities,
        "recurring_phrases": recurring_phrases,
        "topic_clusters": topic_clusters,
        "adjacent_topics": common[12:18],
        "excluded_topics": [],
        "dominant_formats": dominant_formats,
        "target_market": competitor_data.get("market", "US") if competitor_data else "US",
        "target_language": competitor_data.get("language", "en") if competitor_data else "en",
        "evergreen_ratio": round(1.0 - news_ratio, 2),
        "news_dependency_ratio": news_ratio,
        "source_video_ids": [v.get("video_id", "") for v in videos[:15]],
        "extraction_provider": "deterministic",
        "extraction_confidence": "MEDIUM",
    }


def _build_search_queries(fp: Dict[str, Any], budget: int = 10) -> List[Dict[str, Any]]:
    """Generate diverse queries from niche fingerprint."""
    core = fp.get("core_subject", "")
    problem = fp.get("audience_problem", "")
    phrases = fp.get("recurring_phrases", [])
    entities = fp.get("recurring_entities", [])
    clusters = fp.get("topic_clusters", [])

    queries: List[Dict[str, Any]] = []

    if core:
        queries.append({"query": core, "query_type": "core_subject", "weight": 1.0})
    if problem and problem != core:
        queries.append({"query": problem, "query_type": "viewer_problem", "weight": 0.9})
    if phrases:
        queries.append({"query": f"how {phrases[0]}", "query_type": "question", "weight": 0.85})
        queries.append({"query": f"why {phrases[0]}", "query_type": "question_why", "weight": 0.80})
    for ent in entities[:2]:
        queries.append({"query": ent, "query_type": "entity", "weight": 0.75})
    for cluster in clusters[:3]:
        qs = cluster.strip()
        if qs and qs != core:
            queries.append({"query": qs, "query_type": "topic_cluster", "weight": 0.70})
    if phrases:
        queries.append({"query": f"truth about {phrases[0]}", "query_type": "evergreen", "weight": 0.65})
    if len(phrases) >= 2:
        queries.append({"query": f"{phrases[0]} vs {phrases[1]}", "query_type": "comparison", "weight": 0.60})
    if len(phrases) >= 3:
        queries.append({"query": f"{phrases[0]} {phrases[2]}", "query_type": "long_tail", "weight": 0.55})

    seen: set = set()
    deduped: List[Dict[str, Any]] = []
    for q in queries:
        key = q["query"].lower().strip()
        if key and key not in seen and len(key) >= 4:
            seen.add(key)
            deduped.append(q)

    return deduped[:budget]


class SimilarChannelDiscoveryService:
    def __init__(self, provider_mgr: ProviderFallbackManager):
        self.provider_mgr = provider_mgr
        self._semaphore = asyncio.Semaphore(3)

    def _is_cancelled(self, run_id: str) -> bool:
        return task_manager.is_cancelled(run_id)

    async def _emit(self, run_id: str, stage: str, pct: int, msg: str,
                    cand_vids: int = 0, cand_chans: int = 0,
                    enriched: int = 0, elapsed: int = 0) -> None:
        state = ProgressStateSchema(
            run_id=run_id, stage=stage, progress_percent=pct,
            message=msg, videos_collected=cand_vids,
            channels_analyzed=enriched, keywords_expanded=cand_chans,
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
                    setattr(obj, k, v)
                obj.updated_at = utcnow_str()
                db.commit()
        except Exception as e:
            research_logger.warning(f"[SimilarDisc] DB update failed: {e}")
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
        search_query_budget: int = 10,
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
        research_logger.info(f"[SimilarDisc] Started run {run_id} for {source_channel_id}")
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

        try:
            self._db_update_run(run_id, status="RUNNING", stage="STARTING", progress_percent=2)
            await self._emit(run_id, "STARTING", 2, "Initializing similar channel discovery...", elapsed=elapsed())

            window_end   = datetime.now(timezone.utc)
            window_start = window_end - timedelta(days=window_days)

            if self._is_cancelled(run_id):
                self._db_update_run(run_id, status="CANCELLED", stage="CANCELLED")
                await self._emit(run_id, "CANCELLED", 0, "Cancelled by user")
                return

            # 1: Niche Fingerprint
            self._db_update_run(run_id, stage="BUILDING_NICHE_FINGERPRINT", progress_percent=8)
            await self._emit(run_id, "BUILDING_NICHE_FINGERPRINT", 8,
                             "Building niche fingerprint from source channel...", elapsed=elapsed())
            fp = _build_niche_fingerprint(source_channel_title, source_videos)
            fp_json = json.dumps(fp, ensure_ascii=False)
            self._db_update_run(run_id, niche_fingerprint_json=fp_json)

            # 2: Search Queries
            await self._emit(run_id, "GENERATING_SEARCH_QUERIES", 14,
                             "Generating search queries from niche fingerprint...", elapsed=elapsed())
            queries = _build_search_queries(fp, budget=search_query_budget)
            research_logger.info(f"[SimilarDisc] {run_id}: {len(queries)} queries")

            if self._is_cancelled(run_id):
                self._db_update_run(run_id, status="CANCELLED", stage="CANCELLED")
                await self._emit(run_id, "CANCELLED", 14, "Cancelled by user")
                return

            # 3: Search
            await self._emit(run_id, "SEARCHING_CANDIDATE_VIDEOS", 18,
                             f"Searching {len(queries)} queries...", elapsed=elapsed())
            pa = window_start.strftime("%Y-%m-%dT%H:%M:%SZ")
            pb = window_end.strftime("%Y-%m-%dT%H:%M:%SZ")
            seen_vids: set = set()
            candidate_videos: List[Any] = []
            sort_orders = ["relevance", "viewCount", "date"]

            for q_idx, q_item in enumerate(queries):
                if self._is_cancelled(run_id):
                    break
                try:
                    async with self._semaphore:
                        results = await self.provider_mgr.search_videos(
                            query=q_item["query"], market=market, language=language,
                            content_type=content_type, time_range=f"{window_days}d",
                            limit=50, published_after=pa, published_before=pb,
                        )
                    for v in results:
                        vid = getattr(v, "video_id", None)
                        pub_str = getattr(v, "published_at", None) or ""
                        if not vid or vid in seen_vids:
                            continue
                        try:
                            dt = datetime.fromisoformat(pub_str.replace("Z", "+00:00"))
                            if dt.tzinfo is None:
                                dt = dt.replace(tzinfo=timezone.utc)
                            if window_start <= dt <= window_end:
                                seen_vids.add(vid)
                                candidate_videos.append(v)
                        except Exception:
                            pass
                except Exception as e:
                    research_logger.warning(f"[SimilarDisc] Search {q_item['query']}: {e}")

                pct = 18 + int((q_idx + 1) / max(len(queries), 1) * 16)
                await self._emit(run_id, "SEARCHING_CANDIDATE_VIDEOS", pct,
                                 f"Query {q_idx+1}/{len(queries)}: {len(seen_vids)} videos...",
                                 cand_vids=len(seen_vids), elapsed=elapsed())

            if self._is_cancelled(run_id):
                self._db_update_run(run_id, status="CANCELLED", stage="CANCELLED")
                await self._emit(run_id, "CANCELLED", 34, "Cancelled by user", cand_vids=len(seen_vids))
                return

            # 4: Group by channel
            await self._emit(run_id, "DEDUPLICATING_CHANNELS", 36,
                             "Grouping by channel...", cand_vids=len(candidate_videos), elapsed=elapsed())
            channel_video_map: Dict[str, List[Any]] = {}
            for v in candidate_videos:
                cid = getattr(v, "channel_id", None)
                if not cid or cid == source_channel_id:
                    continue
                channel_video_map.setdefault(cid, []).append(v)

            sorted_channels = sorted(channel_video_map.items(), key=lambda x: len(x[1]), reverse=True)
            top_channels = sorted_channels[:candidate_channel_limit]
            self._db_update_run(run_id, candidate_channels_found=len(top_channels),
                                candidate_videos_found=len(candidate_videos),
                                stage="ENRICHING_CHANNELS", progress_percent=40)

            # 5: Enrich
            await self._emit(run_id, "ENRICHING_CHANNELS", 40,
                             f"Enriching {len(top_channels)} channels...",
                             cand_vids=len(candidate_videos), cand_chans=len(top_channels), elapsed=elapsed())
            enriched_channels: List[Dict[str, Any]] = []
            limitations: List[str] = []

            for c_idx, (cid, cand_vids_list) in enumerate(top_channels):
                if self._is_cancelled(run_id):
                    break
                ch_info: Dict[str, Any] = {
                    "channel_id": cid,
                    "channel_title": getattr(cand_vids_list[0], "channel_title", cid),
                    "subscriber_count": None, "country": None,
                    "public_video_count": None, "enrichment_error": 0,
                    "recent_videos_raw": [],
                }
                try:
                    async with self._semaphore:
                        bl = await self.provider_mgr.get_channel_baseline(
                            channel_id=cid, content_type=content_type, max_videos=15)
                    ch_info["channel_title"] = bl.title or ch_info["channel_title"]
                    ch_info["subscriber_count"] = bl.subscriber_count
                    ch_info["country"] = bl.country
                    ch_info["public_video_count"] = bl.video_count
                    ch_info["recent_videos_raw"] = bl.recent_videos
                except Exception as err:
                    research_logger.warning(f"[SimilarDisc] Enrich {cid}: {err}")
                    ch_info["enrichment_error"] = 1
                    limitations.append(f"Channel {cid}: enrichment incomplete")

                ch_info["subscriber_status"] = classify_subscriber_status_similar(
                    ch_info.get("subscriber_count"), max_subscribers)
                enriched_channels.append(ch_info)
                pct = 40 + int((c_idx + 1) / max(len(top_channels), 1) * 30)
                await self._emit(run_id, "ENRICHING_CHANNELS", pct,
                                 f"Enriched {c_idx+1}/{len(top_channels)}...",
                                 cand_vids=len(candidate_videos),
                                 cand_chans=len(top_channels), enriched=c_idx+1, elapsed=elapsed())

            self._db_update_run(run_id, channels_enriched=len(enriched_channels),
                                stage="CALCULATING_GROWTH", progress_percent=72)

            # 6: Evaluate and score
            await self._emit(run_id, "CALCULATING_GROWTH", 74,
                             "Evaluating 90-day performance and scoring...",
                             cand_vids=len(candidate_videos), cand_chans=len(top_channels),
                             enriched=len(enriched_channels), elapsed=elapsed())

            candidate_dicts: List[Dict[str, Any]] = []
            for ch in enriched_channels:
                cid = ch["channel_id"]
                raw_bl = ch.get("recent_videos_raw", [])
                raw_sr = channel_video_map.get(cid, [])

                merged: Dict[str, Dict[str, Any]] = {}
                for v in raw_bl:
                    vid = getattr(v, "video_id", None)
                    if vid:
                        merged[vid] = {
                            "video_id": vid, "title": getattr(v, "title", ""),
                            "published_at": getattr(v, "published_at", ""),
                            "views": getattr(v, "views", 0),
                            "likes": getattr(v, "likes", None),
                            "comments": getattr(v, "comments", None),
                            "duration_seconds": getattr(v, "duration_seconds", None),
                        }
                for v in raw_sr:
                    vid = getattr(v, "video_id", None)
                    if vid and vid not in merged:
                        merged[vid] = {
                            "video_id": vid, "title": getattr(v, "title", ""),
                            "published_at": getattr(v, "published_at", ""),
                            "views": getattr(v, "views", 0),
                            "likes": None, "comments": None,
                            "duration_seconds": getattr(v, "duration_seconds", None),
                        }

                window_vids: List[Dict[str, Any]] = []
                for v in merged.values():
                    try:
                        dt = datetime.fromisoformat(v["published_at"].replace("Z", "+00:00"))
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        if window_start <= dt <= window_end:
                            window_vids.append(v)
                    except Exception:
                        pass

                empty_cand = lambda rej: {
                    "channel_id": cid, "channel_title": ch.get("channel_title", cid),
                    "channel_url": f"https://www.youtube.com/channel/{cid}",
                    "country": ch.get("country"), "subscriber_count": ch.get("subscriber_count"),
                    "subscriber_status": ch.get("subscriber_status", "HIDDEN_UNVERIFIED"),
                    "public_video_count": ch.get("public_video_count"),
                    "window_start": window_start.isoformat(), "window_end": window_end.isoformat(),
                    "recent_video_count": 0, "evaluable_video_count": 0, "pending_video_count": 0,
                    "passed_views_count": 0, "passed_growth_confirmed_count": 0,
                    "passed_growth_provisional_count": 0, "failed_video_count": 0,
                    "strict_success_ratio": 0.0, "provisional_success_ratio": 0.0,
                    "minimum_recent_views": None, "median_recent_views": None,
                    "mean_recent_views": None, "p25_recent_views": None,
                    "p75_recent_views": None, "maximum_recent_views": None,
                    "total_recent_views": 0, "single_hit_dependency": 0.0,
                    "niche_match_reason": rej, "matched_topics": [], "matched_video_ids": [],
                    "active_months_last_12": 0, "median_upload_cadence_days": None,
                    "maximum_upload_gap_days": None, "evergreen_ratio": None,
                    "topic_cluster_count": 0, "future_title_angle_count": 0,
                    "monetization_viability": "UNKNOWN", "monetization_evidence": [],
                    "policy_risk_flags": [], "data_confidence": "INSUFFICIENT",
                    "confidence_limitations": [rej], "qualification_reasons": [],
                    "rejection_reasons": [rej], "status": "REJECTED",
                    "is_most_promising": False, "most_promising_label": None,
                    "scores": {"niche_match_score": 0.0, "recent_consistency_score": 0.0,
                               "growth_quality_score": 0.0, "durability_score": 0.0,
                               "monetization_viability_score": 0.0, "data_confidence_score": 0.0,
                               "final_score": 0.0},
                    "recent_videos": [], "niche_match_score": 0.0, "median_recent_views": None,
                }

                if not window_vids:
                    candidate_dicts.append(empty_cand("No videos in 90-day window"))
                    continue

                # Evaluate each video
                ev_vids: List[Dict[str, Any]] = []
                for v in window_vids:
                    ev = evaluate_video(v, window_end=window_end, min_views=min_views)
                    pub_str = v.get("published_at", "")
                    try:
                        pub_dt = datetime.fromisoformat(pub_str.replace("Z", "+00:00"))
                        if pub_dt.tzinfo is None:
                            pub_dt = pub_dt.replace(tzinfo=timezone.utc)
                        age_d = (window_end - pub_dt).total_seconds() / 86400.0
                    except Exception:
                        age_d = 0.0
                    ns, _, _, _ = compute_niche_match_score(fp, [v])
                    ev_vids.append({
                        "video_id": v.get("video_id", ""),
                        "video_url": f"https://www.youtube.com/watch?v={v.get('video_id', '')}",
                        "title": v.get("title", ""), "published_at": pub_str,
                        "age_days": round(age_d, 2),
                        "duration_seconds": v.get("duration_seconds"),
                        "views": int(v.get("views", 0) or 0),
                        "likes": v.get("likes"), "comments": v.get("comments"),
                        "lifetime_views_per_day": ev["lifetime_vpd"],
                        "observed_views_per_day": ev.get("observed_vpd"),
                        "projected_day_90_views": ev.get("projected_day_90"),
                        "growth_status": ev["growth_status"],
                        "evaluation_status": ev["evaluation_status"],
                        "evaluation_reason": ev.get("evaluation_reason", ""),
                        "niche_similarity": ns,
                        "snapshot_count": ev.get("snapshot_count", 0),
                    })

                pv   = sum(1 for e in ev_vids if e["evaluation_status"] == VIDEO_PASS_VIEWS)
                pc   = sum(1 for e in ev_vids if e["evaluation_status"] == VIDEO_PASS_GROWTH_CONFIRMED)
                pp   = sum(1 for e in ev_vids if e["evaluation_status"] == VIDEO_PASS_GROWTH_PROVISIONAL)
                pend = sum(1 for e in ev_vids if e["evaluation_status"] == VIDEO_PENDING_TOO_NEW)
                fail = sum(1 for e in ev_vids if e["evaluation_status"] == VIDEO_FAIL)
                ev_count = pv + pc + pp + fail

                strict_r = (pv + pc) / max(ev_count, 1)
                prov_r   = (pv + pc + pp) / max(ev_count, 1)

                ev_views = [e["views"] for e in ev_vids
                            if e["evaluation_status"] not in (VIDEO_PENDING_TOO_NEW, VIDEO_EXCLUDED)]
                vs = compute_view_stats(ev_views)
                shd = vs.get("single_hit_dependency", 0.0)

                niche_s, niche_r, m_topics, m_ids = compute_niche_match_score(fp, window_vids)

                all_titles = [v.get("title", "") for v in window_vids]
                eg = compute_evergreen_ratio(all_titles)
                nc, na = compute_topic_clusters(all_titles)

                pub_dates: List[datetime] = []
                for v in window_vids:
                    try:
                        dt = datetime.fromisoformat(v["published_at"].replace("Z", "+00:00"))
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        pub_dates.append(dt)
                    except Exception:
                        pass
                active_m = len({(d.year, d.month) for d in pub_dates})

                med_cad = None
                max_gap = None
                if len(pub_dates) >= 2:
                    sd = sorted(pub_dates)
                    gaps = [(sd[i+1]-sd[i]).total_seconds()/86400.0 for i in range(len(sd)-1)]
                    gaps = [g for g in gaps if g > 0]
                    if gaps:
                        sg = sorted(gaps)
                        n = len(sg)
                        med_cad = sg[n//2] if n % 2 else (sg[n//2-1]+sg[n//2])/2
                        max_gap = max(gaps)

                avg_vpd = (sum(e["lifetime_views_per_day"] for e in ev_vids)
                           / max(len(ev_vids), 1))

                cons_s = compute_recent_consistency_score(pv, pc, pp, fail, ev_count, shd)
                grow_s = compute_growth_quality_score(pc, pp, pv, ev_count, avg_vpd)
                dur_s  = compute_durability_score(active_m, med_cad, max_gap, shd, eg, nc, na, len(window_vids))
                mono_s, mono_l, mono_e, p_flags = compute_monetization_viability_score(
                    all_titles, eg, nc, active_m, shd)
                sub_status = ch.get("subscriber_status", "HIDDEN_UNVERIFIED")
                has_snaps = any(e.get("snapshot_count", 0) > 0 for e in ev_vids)
                conf_l, conf_s, conf_lims = compute_data_confidence(
                    sub_status, ev_count, has_snaps, active_m >= 6,
                    ch.get("enrichment_error", 0))
                final_s = compute_final_score(niche_s, cons_s, grow_s, dur_s, mono_s, conf_s)
                cand_status, qual_r, rej_r = determine_candidate_status(
                    sub_status, niche_s, ev_count, strict_r, prov_r, pp > 0, final_s, conf_l)

                candidate_dicts.append({
                    "channel_id": cid,
                    "channel_title": ch.get("channel_title", cid),
                    "channel_url": f"https://www.youtube.com/channel/{cid}",
                    "country": ch.get("country"),
                    "subscriber_count": ch.get("subscriber_count"),
                    "subscriber_status": sub_status,
                    "public_video_count": ch.get("public_video_count"),
                    "window_start": window_start.isoformat(),
                    "window_end": window_end.isoformat(),
                    "recent_video_count": len(window_vids),
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
                    "active_months_last_12": active_m,
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
                    "median_recent_views": vs["median"],
                })

            # 7: Rank
            await self._emit(run_id, "RANKING_CANDIDATES", 88,
                             "Ranking candidates...", cand_chans=len(top_channels),
                             enriched=len(enriched_channels), elapsed=elapsed())

            candidate_dicts = rank_candidates(candidate_dicts)
            mp = select_most_promising(candidate_dicts)
            mp_reasons: List[str] = []
            if mp:
                mp_reasons = build_most_promising_reasons(mp)
                label = "#1 Most Promising Competitor" if mp["status"] == "QUALIFIED" else "Best Available Candidate"
                mp_cid = mp["channel_id"]
                for c in candidate_dicts:
                    if c["channel_id"] == mp_cid:
                        c["is_most_promising"] = True
                        c["most_promising_label"] = label
                        break

            qc = sum(1 for c in candidate_dicts if c["status"] == "QUALIFIED")
            gc = sum(1 for c in candidate_dicts if c["status"] == "GROWING")
            wc = sum(1 for c in candidate_dicts if c["status"] == "WATCHLIST")
            rc = sum(1 for c in candidate_dicts if c["status"] == "REJECTED")

            # 8: Persist
            await self._emit(run_id, "PERSISTING", 94, "Saving to database...", elapsed=elapsed())
            db = SessionLocal()
            try:
                obj = db.get(SimilarChannelRun, run_id)
                if obj:
                    obj.status = "COMPLETED"; obj.stage = "COMPLETED"; obj.progress_percent = 100
                    obj.candidate_videos_found = len(candidate_videos)
                    obj.candidate_channels_found = len(top_channels)
                    obj.channels_enriched = len(enriched_channels)
                    obj.qualified_count = qc; obj.growing_count = gc
                    obj.watchlist_count = wc; obj.rejected_count = rc
                    obj.most_promising_channel_id = mp["channel_id"] if mp else None
                    obj.most_promising_status = mp["status"] if mp else None
                    obj.most_promising_reason_json = json.dumps(mp_reasons)
                    obj.niche_fingerprint_json = fp_json
                    obj.limitations_json = json.dumps(limitations[:20])
                    obj.provider_summary_json = json.dumps({"search_queries_used": len(queries)})
                    obj.completed_at = utcnow_str()
                    obj.updated_at = utcnow_str()

                for cand in candidate_dicts:
                    cr = SimilarChannelCandidate(
                        run_id=run_id, rank=cand.get("rank", 0),
                        channel_id=cand["channel_id"], channel_title=cand["channel_title"],
                        channel_url=cand["channel_url"], country=cand.get("country"),
                        subscriber_count=cand.get("subscriber_count"),
                        subscriber_status=cand.get("subscriber_status", "HIDDEN_UNVERIFIED"),
                        public_video_count=cand.get("public_video_count"),
                        status=cand.get("status", "REJECTED"),
                        is_most_promising=cand.get("is_most_promising", False),
                        most_promising_label=cand.get("most_promising_label"),
                        window_start=cand.get("window_start", ""), window_end=cand.get("window_end", ""),
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
                        matched_topics_json=json.dumps(cand.get("matched_topics", [])),
                        matched_video_ids_json=json.dumps(cand.get("matched_video_ids", [])),
                        active_months_last_12=cand.get("active_months_last_12", 0),
                        median_upload_cadence_days=cand.get("median_upload_cadence_days"),
                        maximum_upload_gap_days=cand.get("maximum_upload_gap_days"),
                        evergreen_ratio=cand.get("evergreen_ratio"),
                        topic_cluster_count=cand.get("topic_cluster_count", 0),
                        future_title_angle_count=cand.get("future_title_angle_count", 0),
                        monetization_viability=cand.get("monetization_viability", "UNKNOWN"),
                        monetization_evidence_json=json.dumps(cand.get("monetization_evidence", [])),
                        policy_risk_flags_json=json.dumps(cand.get("policy_risk_flags", [])),
                        data_confidence=cand.get("data_confidence", "INSUFFICIENT"),
                        confidence_limitations_json=json.dumps(cand.get("confidence_limitations", [])),
                        qualification_reasons_json=json.dumps(cand.get("qualification_reasons", [])),
                        rejection_reasons_json=json.dumps(cand.get("rejection_reasons", [])),
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
                            run_id=run_id, channel_id=cand["channel_id"],
                            video_id=vid.get("video_id", ""),
                            video_url=vid.get("video_url", ""),
                            title=vid.get("title", ""),
                            published_at=vid.get("published_at", ""),
                            age_days=vid.get("age_days", 0.0),
                            duration_seconds=vid.get("duration_seconds"),
                            views=vid.get("views", 0), likes=vid.get("likes"),
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
                research_logger.error(f"[SimilarDisc] DB error: {db_err}", exc_info=True)
                db.rollback()
            finally:
                db.close()

            await self._emit(run_id, "COMPLETED", 100,
                             f"Complete: {qc} qualified, {gc} growing, {wc} watchlist, {rc} rejected.",
                             cand_vids=len(candidate_videos), cand_chans=len(top_channels),
                             enriched=len(enriched_channels), elapsed=elapsed())
            research_logger.info(f"[SimilarDisc] {run_id} DONE in {elapsed()}s Q={qc} G={gc} W={wc} R={rc}")

        except asyncio.CancelledError:
            self._db_update_run(run_id, status="CANCELLED", stage="CANCELLED")
            await self._emit(run_id, "CANCELLED", 0, "Task cancelled")
            raise
        except Exception as e:
            research_logger.error(f"[SimilarDisc] {run_id} FAILED: {e}", exc_info=True)
            self._db_update_run(run_id, status="FAILED", stage="FAILED", error=str(e)[:500])
            await self._emit(run_id, "FAILED", 0, f"Discovery failed: {str(e)[:200]}")
