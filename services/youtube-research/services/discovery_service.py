"""
Discovery Service — Micro-Niche Intelligence V2

Key design changes from V1:
1. `limit` from UI controls real target unique-video count.
2. Search budget (max API calls) derived from depth/limit, not hardcoded.
3. ALL candidate channels enriched (not just first 15).
4. market_universe: ALL matching videos → competition/demand/supply.
5. matching_evidence: only videos passing advanced filters.
6. Three-state subscriber model: VERIFIED / UNVERIFIED / REJECTED.
7. Near-match recovery when exact_matches == 0.
8. Search diagnostics logged and returned.
9. Backward-compatible response schema (old fields still present).
"""

import asyncio
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple
import json

from core.logger import research_logger
from core.config import settings
from db.engine import SessionLocal
from models.entities import (
    ResearchRun,
    Video,
    Keyword,
    KeywordRun,
    KeywordScore,
    VideoSnapshot,
    TopicCluster,
    AiReport,
    utcnow_str
)
from repositories.research_repo import ResearchRepository
from providers.fallback import ProviderFallbackManager
from providers.autocomplete import keyword_expander
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
from services.clustering_service import clustering_service
from services.competitor_service import CompetitorService
from ai.engine import ai_engine
from workers.task_manager import task_manager
from schemas.research_schemas import (
    ProgressStateSchema,
    ResearchRunResultSchema,
    KeywordRecordSchema,
    BreakoutVideoSchema,
    TrendRadarSchema,
    TopicClusterSchema,
    AiReportSchema,
    TopOpportunitySchema,
    OverviewMetricsSchema,
    DataSourceSchema,
    ResearchFilters,
    FilterSummarySchema,
    FilterFunnelSchema,
    CandidateVideoSchema,
    NearMatchSuggestionSchema,
    SearchDiagnosticsSchema,
)
from utils.parsers import calculate_age_days
from services.filter_service import (
    FilterStats,
    FilterFunnel,
    get_active_filters,
    apply_metadata_filters,
    apply_enriched_video_filters,
    apply_keyword_filters,
    partition_evidence,
    evaluate_video_filters,
    classify_subscriber_status,
)


# ─── Search Budget by limit ───────────────────────────────────────────────────

def _derive_search_budget(limit: int) -> Tuple[int, int]:
    """
    Map UI limit → (target_unique_videos, max_search_calls).
    Returns (target, budget).
    """
    if limit <= 60:
        return 100, 8       # Fast
    elif limit <= 200:
        return 250, 16      # Balanced
    else:
        return 500, 28      # Deep


# ─── Near-match suggestion generator ─────────────────────────────────────────

def _generate_near_match_suggestions(
    all_enriched: List[Dict[str, Any]],
    filters: ResearchFilters,
) -> List[NearMatchSuggestionSchema]:
    """Suggest relaxed filter values that would add candidates."""
    suggestions: List[NearMatchSuggestionSchema] = []

    # Suggest relaxing min_views
    if filters.min_views and filters.min_views > 0:
        views_list = sorted([v.get("views", 0) for v in all_enriched], reverse=True)
        candidates_at_80pct = sum(1 for vv in views_list if vv >= filters.min_views * 0.8)
        if candidates_at_80pct > 0:
            suggested = int(filters.min_views * 0.8)
            suggestions.append(NearMatchSuggestionSchema(
                field="min_views",
                current_value=filters.min_views,
                suggested_value=suggested,
                would_add_candidates=candidates_at_80pct,
                description=f"Minimum Views {filters.min_views:,} → {suggested:,} would add {candidates_at_80pct} candidates"
            ))

    # Suggest relaxing max_subscribers
    if filters.max_subscribers and filters.max_subscribers > 0:
        relaxed = int(filters.max_subscribers * 1.5)
        candidates_relaxed = sum(
            1 for v in all_enriched
            if v.get("channel_subscribers") is not None
            and v["channel_subscribers"] <= relaxed
            and (filters.min_views is None or v.get("views", 0) >= filters.min_views)
        )
        if candidates_relaxed > 0:
            suggestions.append(NearMatchSuggestionSchema(
                field="max_subscribers",
                current_value=filters.max_subscribers,
                suggested_value=relaxed,
                would_add_candidates=candidates_relaxed,
                description=f"Maximum Subscribers {filters.max_subscribers:,} → {relaxed:,} would add {candidates_relaxed} candidates"
            ))

    return suggestions[:3]


# ─── Build CandidateVideoSchema list ─────────────────────────────────────────

def _build_candidate_schema(
    v: Dict[str, Any],
    subscriber_status: str,
    filter_distance: float = 0.0,
) -> CandidateVideoSchema:
    views = v.get("views", 0)
    published_at = v.get("published_at", "")
    age_days = calculate_age_days(published_at) if published_at else 0
    vpd = calculate_lifetime_velocity(views, published_at) if published_at else 0.0
    subs = v.get("channel_subscribers")
    label = "Subscriber hidden / unverified" if subscriber_status == "UNVERIFIED_MATCH" else ""

    return CandidateVideoSchema(
        video_id=v.get("video_id", ""),
        url=v.get("url", ""),
        title=v.get("title", ""),
        channel_id=v.get("channel_id", ""),
        channel_title=v.get("channel_title", ""),
        published_at=published_at,
        age_days=round(age_days, 1),
        views=views,
        views_per_day=round(vpd, 1),
        channel_subscribers=subs,
        outlier_ratio=v.get("outlier_ratio"),
        subscriber_status=subscriber_status,
        subscriber_label=label,
        filter_distance=filter_distance,
        source_provider=v.get("provider", ""),
        thumbnail_url=v.get("thumbnail_url", ""),
    )


class DiscoveryService:
    def __init__(self, provider_mgr: ProviderFallbackManager):
        self.provider_mgr = provider_mgr
        self.competitor_svc = CompetitorService(provider_mgr)

    async def execute_discovery_run(
        self,
        run_id: str,
        topic: str,
        market: str = "US",
        language: str = "en",
        content_type: str = "LONG",
        time_range: str = "30d",
        limit: int = 50,
        filters: Optional[ResearchFilters] = None
    ) -> None:
        if filters is None:
            filters = ResearchFilters()

        start_time = time.time()
        db = SessionLocal()
        repo = ResearchRepository(db)
        filter_stats = FilterStats()
        diag = SearchDiagnosticsSchema()

        target_unique_videos, search_budget = _derive_search_budget(limit)
        diag.search_budget_total = search_budget

        async def update_progress(
            stage: str,
            progress_percent: Optional[int] = None,
            message: str = "",
            videos_collected: int = 0,
            channels_analyzed: int = 0,
            keywords_expanded: int = 0,
            error: Optional[str] = None
        ):
            latest = task_manager.latest_progress.get(run_id)
            if stage in ("FAILED", "CANCELLED", "INTERRUPTED"):
                if progress_percent is None or progress_percent == 100:
                    progress_percent = latest.progress_percent if latest else 0
                if videos_collected == 0 and latest:
                    videos_collected = latest.videos_collected
                if channels_analyzed == 0 and latest:
                    channels_analyzed = latest.channels_analyzed
                if keywords_expanded == 0 and latest:
                    keywords_expanded = latest.keywords_expanded

            if progress_percent is None:
                progress_percent = 0

            elapsed = int(time.time() - start_time)
            try:
                repo.update_run_stage(
                    run_id=run_id,
                    stage=stage,
                    progress_percent=progress_percent,
                    message=message,
                    videos_collected=videos_collected,
                    channels_analyzed=channels_analyzed,
                    keywords_expanded=keywords_expanded,
                    error=error
                )
            except Exception as db_err:
                research_logger.warning(f"[Discovery] Failed to update stage ({db_err}), retrying...")
                try:
                    db.rollback()
                except Exception:
                    pass
                try:
                    fresh_db = SessionLocal()
                    try:
                        fresh_repo = ResearchRepository(fresh_db)
                        fresh_repo.update_run_stage(
                            run_id=run_id, stage=stage, progress_percent=progress_percent,
                            message=message, videos_collected=videos_collected,
                            channels_analyzed=channels_analyzed, keywords_expanded=keywords_expanded,
                            error=error
                        )
                    finally:
                        fresh_db.close()
                except Exception as final_db_err:
                    research_logger.error(f"[Discovery] Fallback session also failed: {final_db_err}")

            state = ProgressStateSchema(
                run_id=run_id,
                stage=stage,
                progress_percent=progress_percent,
                message=message,
                videos_collected=videos_collected,
                channels_analyzed=channels_analyzed,
                keywords_expanded=keywords_expanded,
                elapsed_seconds=elapsed,
                can_cancel=stage not in ("COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"),
                error=error
            )
            try:
                await task_manager.emit_progress(state)
            except Exception as emit_err:
                research_logger.warning(f"[Discovery] Failed to emit progress: {emit_err}")

        try:
            research_logger.info(
                f"[Discovery] Starting run {run_id} topic={topic} market={market} "
                f"limit={limit} budget={search_budget} target={target_unique_videos}"
            )
            await update_progress("QUEUED", 5, "Initializing research run...")

            if task_manager.is_cancelled(run_id):
                await update_progress("CANCELLED", None, "Research cancelled by user")
                return

            # ── Stage 1: EXPANDING_KEYWORDS ───────────────────────────────────
            await update_progress("EXPANDING_KEYWORDS", 15, f"Expanding keyword queries for '{topic}'...")

            async def on_expand_progress(pct: int, msg: str):
                await update_progress("EXPANDING_KEYWORDS", pct, msg)

            try:
                expanded_keywords, sources = await asyncio.wait_for(
                    keyword_expander.expand_keywords(
                        seed=topic,
                        market=market,
                        language=language,
                        max_keywords=settings.max_expanded_keywords,
                        progress_callback=on_expand_progress
                    ),
                    timeout=22.0
                )
            except asyncio.TimeoutError:
                research_logger.warning(f"[Discovery] Keyword expand timeout, using rule fallback run_id={run_id}")
                expanded_keywords, sources = keyword_expander.build_rule_based_fallback(
                    seed=topic, max_keywords=settings.max_expanded_keywords
                )
            except Exception as expand_err:
                research_logger.warning(f"[Discovery] Keyword expander error ({expand_err}), rule fallback")
                expanded_keywords, sources = keyword_expander.build_rule_based_fallback(
                    seed=topic, max_keywords=settings.max_expanded_keywords
                )

            keywords_count = len(expanded_keywords)
            diag.queries_generated = keywords_count
            research_logger.info(f"[Discovery] Keywords expanded: {keywords_count}")

            if task_manager.is_cancelled(run_id):
                await update_progress("CANCELLED", None, "Research cancelled by user")
                return

            # ── Stage 2: SEARCHING — adaptive with early stop ─────────────────
            await update_progress(
                "SEARCHING", 30,
                f"Searching YouTube across {keywords_count} queries (budget={search_budget})...",
                keywords_expanded=keywords_count
            )

            # market_universe: ALL videos matching topic/time/format
            # (NOT filtered by advanced user filters — preserves competition/demand accuracy)
            market_universe_videos: List[Any] = []
            seen_video_ids: set = set()
            keyword_to_videos: Dict[str, List[Any]] = {}

            search_calls_used = 0
            stop_reason = "budget_exhausted"

            for idx, kw in enumerate(expanded_keywords):
                if task_manager.is_cancelled(run_id):
                    await update_progress("CANCELLED", None, "Research cancelled by user")
                    return

                # Early stop: budget exhausted
                if search_calls_used >= search_budget:
                    stop_reason = "budget_exhausted"
                    break

                # Early stop: target reached
                if len(seen_video_ids) >= target_unique_videos:
                    stop_reason = "target_reached"
                    break

                res_videos = await self.provider_mgr.search_videos(
                    query=kw,
                    market=market,
                    language=language,
                    content_type=content_type,
                    time_range=time_range,
                    limit=50
                )
                search_calls_used += 1
                diag.raw_results += len(res_videos)

                # Dedup and add to market universe
                kw_new = []
                for v in res_videos:
                    if v.video_id not in seen_video_ids:
                        seen_video_ids.add(v.video_id)
                        market_universe_videos.append(v)
                        kw_new.append(v)
                    # If already seen, still track for keyword association
                if kw_new:
                    keyword_to_videos[kw] = kw_new

                pct = 30 + int((idx + 1) / max(len(expanded_keywords), 1) * 20)
                await update_progress(
                    "FETCHING_METADATA", pct,
                    f"Collected {len(seen_video_ids)} unique videos...",
                    videos_collected=len(seen_video_ids),
                    keywords_expanded=keywords_count
                )

            diag.queries_searched = search_calls_used
            diag.search_budget_used = search_calls_used
            diag.unique_videos = len(seen_video_ids)
            diag.duplicate_rate = round(
                1.0 - len(seen_video_ids) / max(diag.raw_results, 1), 3
            )
            diag.search_stop_reason = stop_reason

            research_logger.info(
                f"[Discovery] Search done: {len(seen_video_ids)} unique / {diag.raw_results} raw "
                f"queries={search_calls_used}/{search_budget} stop={stop_reason}"
            )

            if task_manager.is_cancelled(run_id):
                await update_progress("CANCELLED", None, "Research cancelled by user")
                return

            # ── Stage 3: BASIC_SCORING ────────────────────────────────────────
            await update_progress(
                "BASIC_SCORING", 55,
                "Computing preliminary velocity & age metrics...",
                videos_collected=len(market_universe_videos),
                keywords_expanded=keywords_count
            )

            # ── Stage 4: ENRICHING_CANDIDATES — ALL channels, not just 15 ────
            await update_progress(
                "ENRICHING_CANDIDATES", 62,
                "Enriching all candidate channels for subscriber data...",
                videos_collected=len(market_universe_videos),
                keywords_expanded=keywords_count
            )

            unique_channel_ids = list(dict.fromkeys(
                [v.channel_id for v in market_universe_videos if v.channel_id]
            ))
            diag.channels_discovered = len(unique_channel_ids)
            channel_baselines: Dict[str, Dict[str, Any]] = {}

            # Enrich ALL unique channels (prioritise by candidate video count)
            # Sort channels by number of candidate videos (most appearing first)
            channel_video_count = {}
            for v in market_universe_videos:
                channel_video_count[v.channel_id] = channel_video_count.get(v.channel_id, 0) + 1
            sorted_channels = sorted(
                unique_channel_ids,
                key=lambda cid: channel_video_count.get(cid, 0),
                reverse=True
            )

            for c_idx, cid in enumerate(sorted_channels):
                if task_manager.is_cancelled(run_id):
                    await update_progress("CANCELLED", None, "Research cancelled by user")
                    return

                # Use repo cache first (saves API quota)
                cached_ch = repo.get_channel(cid)
                if cached_ch and cached_ch.median_recent_views > 0:
                    channel_baselines[cid] = {
                        "median": cached_ch.median_recent_views,
                        "mean": cached_ch.mean_recent_views,
                        "p75": cached_ch.p75_views,
                        "p90": cached_ch.p90_views,
                        "subs": cached_ch.subscriber_count,
                        "title": cached_ch.title,
                        "country": cached_ch.country,
                        "baseline_status": "cached",
                    }
                else:
                    try:
                        c_data = await self.provider_mgr.get_channel_baseline(
                            cid, content_type=content_type, max_videos=20
                        )
                        views_list = [v.views for v in c_data.recent_videos]
                        median_v, mean_v, p75_v, p90_v = compute_channel_baseline(views_list)

                        repo.upsert_channel_baseline(
                            channel_id=cid,
                            title=c_data.title,
                            subscriber_count=c_data.subscriber_count,
                            median_views=median_v,
                            mean_views=mean_v,
                            p75=p75_v,
                            p90=p90_v,
                            sample_size=len(views_list),
                            country=c_data.country
                        )
                        baseline_status = "enriched" if views_list else "missing"
                        channel_baselines[cid] = {
                            "median": median_v if views_list else None,
                            "mean": mean_v,
                            "p75": p75_v,
                            "p90": p90_v,
                            "subs": c_data.subscriber_count,
                            "title": c_data.title,
                            "country": c_data.country,
                            "baseline_status": baseline_status,
                        }
                    except Exception as ch_err:
                        research_logger.warning(f"[Discovery] Channel baseline error {cid}: {ch_err}")
                        channel_baselines[cid] = {
                            "median": None,
                            "subs": None,
                            "baseline_status": "missing",
                        }

                pct = 62 + int((c_idx + 1) / max(len(sorted_channels), 1) * 15)
                await update_progress(
                    "LOADING_CHANNEL_BASELINES", pct,
                    f"Analyzed baseline for {c_idx + 1}/{len(sorted_channels)} channels...",
                    videos_collected=len(market_universe_videos),
                    channels_analyzed=c_idx + 1,
                    keywords_expanded=keywords_count
                )

            diag.channels_enriched = len([c for c in channel_baselines.values() if c.get("baseline_status") != "missing"])

            # Subscriber coverage stats
            known_subs = sum(1 for c in channel_baselines.values() if c.get("subs") is not None)
            diag.subscriber_known_pct = round(known_subs / max(len(channel_baselines), 1) * 100, 1)
            baseline_ok = sum(1 for c in channel_baselines.values() if c.get("median") is not None)
            diag.baseline_coverage_pct = round(baseline_ok / max(len(channel_baselines), 1) * 100, 1)

            if task_manager.is_cancelled(run_id):
                await update_progress("CANCELLED", None, "Research cancelled by user")
                return

            # ── Stage 5: CALCULATING_ADVANCED_METRICS ─────────────────────────
            await update_progress(
                "CALCULATING_ADVANCED_METRICS", 80,
                "Calculating opportunity scores, breakouts, and market signals...",
                videos_collected=len(market_universe_videos),
                channels_analyzed=len(channel_baselines),
                keywords_expanded=keywords_count
            )

            breakout_items: List[BreakoutVideoSchema] = []
            # market_universe_enriched: ALL videos with computed metrics (no filter applied)
            market_universe_enriched: List[Dict[str, Any]] = []

            for v in market_universe_videos:
                c_info = channel_baselines.get(v.channel_id, {})
                # Use None if baseline is missing — do NOT use fake 15000 fallback
                median_v = c_info.get("median")
                baseline_status = c_info.get("baseline_status", "missing")
                sub_count = c_info.get("subs")

                if median_v is not None:
                    ratio = compute_outlier_ratio(v.views, median_v)
                else:
                    # Mark baseline missing — do not compute fake outlier
                    ratio = None

                age_days = calculate_age_days(v.published_at)
                vpd = calculate_lifetime_velocity(v.views, v.published_at)

                # Snapshot logic
                repo.add_snapshot_if_eligible(
                    video_id=v.video_id,
                    views=v.views,
                    likes=v.likes,
                    comments=v.comments,
                    min_interval_hours=settings.snapshot_policy_hours
                )

                snaps = repo.get_video_snapshots(v.video_id)
                observed_vel = None
                if len(snaps) >= 2:
                    observed_vel = calculate_observed_velocity(
                        views_new=snaps[-1].view_count,
                        time_new_iso=snaps[-1].captured_at,
                        views_old=snaps[0].view_count,
                        time_old_iso=snaps[0].captured_at
                    )

                is_breakout = is_small_channel_breakout(
                    views=v.views,
                    outlier_ratio=ratio or 0.0,
                    channel_subscribers=sub_count,
                    published_at=v.published_at,
                    channel_median_views=median_v
                )

                enriched_dict = {
                    **v.model_dump(),
                    "outlier_ratio": ratio,
                    "views_per_day": vpd,
                    "observed_velocity": observed_vel,
                    "is_breakout": is_breakout,
                    "channel_median": median_v,
                    "channel_median_views": median_v,
                    "channel_subscribers": sub_count,
                    "baseline_status": baseline_status,
                }
                market_universe_enriched.append(enriched_dict)

                if ratio is not None and (ratio >= 2.5 or is_breakout or v.views >= 50_000):
                    b_schema = BreakoutVideoSchema(
                        video_id=v.video_id,
                        url=v.url,
                        title=v.title,
                        channel_id=v.channel_id,
                        channel_title=v.channel_title,
                        published_at=v.published_at,
                        age_days=round(age_days, 1),
                        views=v.views,
                        views_per_day=round(vpd, 1),
                        observed_velocity=round(observed_vel, 1) if observed_vel else None,
                        channel_subscribers=sub_count,
                        channel_median_views=round(median_v, 1) if median_v else None,
                        outlier_ratio=ratio,
                        market_signal=f"{market} Relevance Signal",
                        source_provider=v.provider,
                        thumbnail_url=v.thumbnail_url,
                        is_small_channel_breakout=is_breakout
                    )
                    breakout_items.append(b_schema)

            # ── Partition evidence from market_universe_enriched ───────────────
            # matching_evidence: videos that pass the advanced user filters
            filter_stats.raw_videos = len(market_universe_enriched)
            filter_stats.funnel.raw_collected = len(market_universe_enriched)
            filter_stats.funnel.unique_after_dedupe = len(market_universe_enriched)

            # Apply metadata filters to get market_universe base (min_views, min_vpd only)
            # This is NOT the evidence set — used for keyword scoring
            market_filtered = apply_metadata_filters(market_universe_enriched, filters, filter_stats)
            filter_stats.matched_metadata = len(market_filtered)
            filter_stats.funnel.above_min_views = len(market_filtered)

            # Partition into exact / unverified / near from market_universe_enriched
            evidence_buckets = partition_evidence(market_universe_enriched, filters, filter_stats)
            exact_matches_dicts = evidence_buckets["exact_matches"]
            unverified_matches_dicts = evidence_buckets["unverified_matches"]
            near_matches_dicts = evidence_buckets["near_matches"]

            # Build CandidateVideoSchema lists for response
            exact_candidates = [
                _build_candidate_schema(v, "VERIFIED_MATCH", 0.0)
                for v in exact_matches_dicts
            ]
            unverified_candidates = [
                _build_candidate_schema(v, "UNVERIFIED_MATCH", 0.0)
                for v in unverified_matches_dicts
            ]
            near_candidates = []
            for v in near_matches_dicts:
                ev = evaluate_video_filters(v, filters)
                near_candidates.append(_build_candidate_schema(v, "REJECTED", ev.filter_distance))

            # For keyword scoring: use market_filtered (full market minus metadata-failed)
            # Competition must use market_universe, not evidence set
            valid_video_ids_for_keywords = {v["video_id"] for v in market_filtered}

            # Update keyword_to_videos based on market_filtered
            for kw in list(keyword_to_videos.keys()):
                keyword_to_videos[kw] = [
                    v for v in keyword_to_videos[kw]
                    if v.video_id in valid_video_ids_for_keywords
                ]

            # Filter breakouts to only those in market_filtered
            breakout_items = [
                b for b in breakout_items if b.video_id in valid_video_ids_for_keywords
            ]
            breakout_items.sort(key=lambda x: (x.is_small_channel_breakout, x.outlier_ratio), reverse=True)

            # ── Stage 6: Keyword Scoring (from market universe) ───────────────
            keyword_records: List[KeywordRecordSchema] = []
            trend_radar_items: List[TrendRadarSchema] = []

            for kw, k_videos in keyword_to_videos.items():
                if not k_videos:
                    continue

                k_views = [kv.views for kv in k_videos]
                k_vpds = [calculate_lifetime_velocity(kv.views, kv.published_at) for kv in k_videos]
                k_channels = [kv.channel_id for kv in k_videos]
                k_pubs = [kv.published_at for kv in k_videos]
                k_titles = [kv.title for kv in k_videos]
                k_subs = [channel_baselines.get(cid, {}).get("subs") for cid in k_channels]
                k_countries = [channel_baselines.get(cid, {}).get("country") for cid in k_channels]

                d_score = compute_demand_score(k_views, k_vpds)
                v_score = compute_velocity_score(k_vpds)

                # Outlier only computed where baseline is not missing
                kw_outliers = []
                for kv in k_videos:
                    bl = channel_baselines.get(kv.channel_id, {}).get("median")
                    if bl is not None:
                        kw_outliers.append(compute_outlier_ratio(kv.views, bl))

                median_outlier = sorted(kw_outliers)[len(kw_outliers) // 2] if kw_outliers else 1.0
                best_outlier = max(kw_outliers) if kw_outliers else 1.0
                outlier_norm = normalize_outlier_score(best_outlier)

                cc_score, u_chan, high_chan = compute_cross_channel_validation(k_channels, k_views)

                # Competition must be computed from market universe (all market_filtered for this kw)
                comp_score, comp_lvl = compute_competition_score(
                    len(k_videos), k_subs, k_titles,
                    sum(1 for o in kw_outliers if o >= 4.0)
                )
                fresh_score, fresh_state, c24, c7, c30 = compute_freshness(k_pubs)
                mkt_score, mkt_conf = compute_market_fit(
                    market, language, [language] * len(k_videos), k_countries
                )

                opp_score = compute_opportunity_score(
                    demand=d_score,
                    velocity=v_score,
                    outlier=outlier_norm,
                    cross_channel=cc_score,
                    market_fit=mkt_score,
                    freshness=fresh_score,
                    competition=comp_score,
                    weights=settings.scoring_weights
                )

                conf_lvl, conf_score = compute_confidence_level(
                    sample_size=len(k_videos),
                    unique_channels=u_chan,
                    has_snapshots=False,
                    provider_source=self.provider_mgr.last_provenance
                )

                median_v = sorted(k_views)[len(k_views) // 2] if k_views else 0
                median_vpd = sorted(k_vpds)[len(k_vpds) // 2] if k_vpds else 0
                p75_views = k_views[int(len(k_views) * 0.75)] if k_views else 0

                k_rec = KeywordRecordSchema(
                    keyword=kw,
                    opportunity_score=opp_score,
                    confidence_level=conf_lvl,
                    confidence_score=conf_score,
                    demand_score=d_score,
                    velocity_score=v_score,
                    outlier_score=outlier_norm,
                    competition_score=comp_score,
                    competition_level=comp_lvl,
                    market_fit_score=mkt_score,
                    freshness_score=fresh_score,
                    freshness_state=fresh_state,
                    video_count=len(k_videos),
                    channel_count=u_chan,
                    median_views=float(median_v),
                    median_views_per_day=round(median_vpd, 1),
                    best_outlier_ratio=best_outlier,
                    is_rising=fresh_state in ("Emerging", "Rising") and v_score >= 60.0,
                    is_low_competition=comp_lvl == "LOW",
                    is_breakout=best_outlier >= 5.0,
                    is_small_channel_win=any(
                        b.is_small_channel_breakout for b in breakout_items
                        if kw.lower() in b.title.lower()
                    ),
                    has_market_signal=mkt_score >= 60.0,
                    breakdown={
                        "demand_details": f"Median Views: {median_v:,}, P75 Views: {sorted(k_views)[int(len(k_views)*0.75)]:,}" if k_views else "N/A",
                        "velocity_details": f"Median Velocity: {round(median_vpd, 1):,} views/day",
                        "outlier_details": f"Peak Channel Outlier: {best_outlier}x",
                        "cross_channel_details": f"{u_chan} unique channels, {high_chan} high performers",
                        "market_fit_details": f"Estimated {market} signal ({mkt_conf} confidence)",
                        "competition_details": f"{comp_lvl} competition ({comp_score}/100)"
                    }
                )
                keyword_records.append(k_rec)

                trend_radar_items.append(
                    TrendRadarSchema(
                        topic=kw.title(),
                        count_24h=c24,
                        count_7d=c7,
                        count_30d=c30,
                        median_velocity=round(median_vpd, 1),
                        breakout_count=sum(1 for o in kw_outliers if o >= 4.0),
                        unique_channels=u_chan,
                        trend_state=fresh_state,
                        confidence_level=conf_lvl
                    )
                )

            keyword_records.sort(key=lambda x: x.opportunity_score, reverse=True)

            # Apply keyword-level filters
            filter_stats.keywords_before_filters = len(keyword_records)
            keyword_records = apply_keyword_filters(keyword_records, filters, filter_stats)
            filter_stats.keywords_after_filters = len(keyword_records)

            # ── Near match suggestions ─────────────────────────────────────────
            near_match_suggestions: List[NearMatchSuggestionSchema] = []
            if len(exact_candidates) == 0 and any([
                filters.min_views, filters.max_subscribers,
                filters.min_views_per_day, filters.min_outlier_ratio
            ]):
                near_match_suggestions = _generate_near_match_suggestions(
                    market_universe_enriched, filters
                )

            # ── Filter Summary ─────────────────────────────────────────────────
            filter_stats.videos_after_all_filters = len(exact_matches_dicts)
            filter_stats.videos_after_metadata_filters = filter_stats.matched_metadata

            funnel_dict = {
                "raw_collected": filter_stats.funnel.raw_collected,
                "unique_after_dedupe": filter_stats.funnel.unique_after_dedupe,
                "above_min_views": filter_stats.funnel.above_min_views,
                "subscriber_known": filter_stats.funnel.subscriber_known,
                "subscriber_unknown": filter_stats.funnel.subscriber_unknown,
                "exact_matches": filter_stats.funnel.exact_matches,
                "unverified_matches": filter_stats.funnel.unverified_matches,
                "near_matches": filter_stats.funnel.near_matches,
            }

            filter_summary = FilterSummarySchema(
                applied_filters=get_active_filters(filters),
                raw_videos_collected=filter_stats.raw_videos,
                videos_after_metadata_filters=filter_stats.videos_after_metadata_filters,
                videos_after_all_filters=filter_stats.videos_after_all_filters,
                keywords_before_filters=filter_stats.keywords_before_filters,
                keywords_after_filters=filter_stats.keywords_after_filters,
                excluded_by_reason={
                    "min_views": filter_stats.excluded_min_views,
                    "min_views_per_day": filter_stats.excluded_min_views_per_day,
                    "max_subscribers": filter_stats.excluded_max_subscribers,
                    "unknown_subscribers": filter_stats.excluded_unknown_subscribers,
                    "min_outlier": filter_stats.excluded_min_outlier,
                    "missing_baseline": filter_stats.excluded_missing_baseline,
                    "min_opportunity": filter_stats.excluded_min_opportunity,
                    "max_competition": filter_stats.excluded_max_competition
                },
                funnel=funnel_dict
            )

            filter_funnel_schema = FilterFunnelSchema(
                raw_collected=filter_stats.funnel.raw_collected,
                unique_after_dedupe=filter_stats.funnel.unique_after_dedupe,
                above_min_views=filter_stats.funnel.above_min_views,
                subscriber_known=filter_stats.funnel.subscriber_known,
                subscriber_unknown=filter_stats.funnel.subscriber_unknown,
                exact_matches=filter_stats.funnel.exact_matches,
                unverified_matches=filter_stats.funnel.unverified_matches,
                near_matches=filter_stats.funnel.near_matches,
                excluded_by_reason={
                    "min_views": filter_stats.excluded_min_views,
                    "min_views_per_day": filter_stats.excluded_min_views_per_day,
                    "max_subscribers": filter_stats.excluded_max_subscribers,
                    "unknown_subscribers": filter_stats.excluded_unknown_subscribers,
                    "min_outlier": filter_stats.excluded_min_outlier,
                }
            )

            # ── Stage 7: CLUSTERING ───────────────────────────────────────────
            await update_progress(
                "CLUSTERING", 88, "Clustering topic themes...",
                videos_collected=len(market_universe_videos),
                channels_analyzed=len(channel_baselines),
                keywords_expanded=keywords_count
            )
            topic_clusters = clustering_service.cluster_videos(market_universe_enriched)

            # ── Stage 8: AI_ANALYSIS ──────────────────────────────────────────
            await update_progress(
                "AI_ANALYSIS", 93, "Generating market summary and content angles...",
                videos_collected=len(market_universe_videos),
                channels_analyzed=len(channel_baselines),
                keywords_expanded=keywords_count
            )
            top_kw_str = keyword_records[0].keyword if keyword_records else topic
            ai_report = await ai_engine.generate_insights(
                topic=topic,
                market=market,
                top_keyword=top_kw_str,
                breakouts=[b.model_dump() for b in breakout_items],
                clusters=[c.model_dump() for c in topic_clusters]
            )

            # ── Stage 9: PERSISTING ───────────────────────────────────────────
            await update_progress(
                "PERSISTING", 97, "Saving research results to database...",
                videos_collected=len(market_universe_videos),
                channels_analyzed=len(channel_baselines),
                keywords_expanded=keywords_count
            )

            # Build Top Opportunity
            top_opp = None
            if keyword_records:
                top_k = keyword_records[0]
                top_opp = TopOpportunitySchema(
                    keyword=top_k.keyword,
                    opportunity_score=top_k.opportunity_score,
                    confidence_level=top_k.confidence_level,
                    market_fit_score=top_k.market_fit_score,
                    competition_score=top_k.competition_score,
                    trend_state=top_k.freshness_state,
                    summary=f"Strong market opportunity with {top_k.opportunity_score}/100 score in {market}."
                )

            # Overview metrics
            unique_total_channels = len(set(v["channel_id"] for v in market_universe_enriched))
            small_channel_wins_count = sum(1 for b in breakout_items if b.is_small_channel_breakout)
            overall_confidence, _ = compute_confidence_level(
                sample_size=len(market_universe_videos),
                unique_channels=unique_total_channels,
                has_snapshots=False,
                provider_source=self.provider_mgr.last_provenance
            )

            overview_metrics = OverviewMetricsSchema(
                videos_analyzed=len(market_universe_videos),
                unique_channels=unique_total_channels,
                keywords_found=len(keyword_records),
                breakouts_found=len(breakout_items),
                small_channel_wins=small_channel_wins_count,
                data_confidence=overall_confidence
            )

            data_sources = [
                DataSourceSchema(
                    metric="Views & Duration",
                    source=f"YouTube {self.provider_mgr.last_provenance}",
                    note="Public metrics normalized via structured parser"
                ),
                DataSourceSchema(
                    metric="Channel Baseline",
                    source="Uploads Playlist (20-30 Recent Videos)",
                    note="Fetched via contentDetails.relatedPlaylists.uploads, filtered by content type"
                ),
                DataSourceSchema(
                    metric="Market Fit Signal",
                    source=f"Estimated {market} Signal",
                    note="Estimated public-data signal, not private audience geography"
                ),
                DataSourceSchema(
                    metric="AI Insights",
                    source=f"{settings.ai_provider.title() if settings.ai_provider != 'disabled' else 'Deterministic Analyzer'}",
                    note="Synthesized angles & gaps; metrics calculated deterministically"
                ),
            ]

            full_result = ResearchRunResultSchema(
                run_id=run_id,
                topic=topic,
                market=market,
                language=language,
                content_type=content_type,
                time_range=time_range,
                created_at=utcnow_str(),
                completed_at=utcnow_str(),
                provider_source=self.provider_mgr.last_provenance,
                provider_notes="Scraper fallback active" if self.provider_mgr.last_provenance == "SCRAPER" else "Official API verified",
                top_opportunity=top_opp,
                overview_metrics=overview_metrics,
                keywords=keyword_records,
                breakout_videos=breakout_items[:25],
                trend_radar=trend_radar_items[:12],
                topic_clusters=topic_clusters,
                ai_insights=ai_report,
                data_sources=data_sources,
                filter_summary=filter_summary,
                # V2 new fields
                exact_matches=exact_candidates[:50],
                unverified_matches=unverified_candidates[:50],
                near_matches=near_candidates[:20],
                near_match_suggestions=near_match_suggestions,
                filter_funnel=filter_funnel_schema,
                search_diagnostics=diag,
            )

            run_rec = repo.get_run(run_id)
            if run_rec:
                run_rec.raw_results_json = json.dumps(full_result.model_dump())
                db.commit()

            total_evidence = len(exact_candidates) + len(unverified_candidates)
            await update_progress(
                "COMPLETED", 100,
                f"Completed analysis for '{topic}'! "
                f"Found {len(keyword_records)} opportunities, "
                f"{len(exact_candidates)} verified + {len(unverified_candidates)} unverified evidence videos.",
                videos_collected=len(market_universe_videos),
                channels_analyzed=len(channel_baselines),
                keywords_expanded=keywords_count
            )
            research_logger.info(
                f"[Discovery] Run {run_id} complete. exact={len(exact_candidates)} "
                f"unverified={len(unverified_candidates)} near={len(near_candidates)}"
            )

        except asyncio.CancelledError:
            research_logger.info(f"[Discovery] Run {run_id} cancelled.")
            await asyncio.shield(update_progress("CANCELLED", None, "Research run was cancelled."))
        except Exception as e:
            research_logger.error(f"[Discovery] Error in run {run_id}: {e}", exc_info=True)
            await asyncio.shield(update_progress("FAILED", None, f"Research error: {str(e)}", error=str(e)))
        finally:
            try:
                db.close()
            except Exception:
                pass
            task_manager.cleanup_run(run_id)
