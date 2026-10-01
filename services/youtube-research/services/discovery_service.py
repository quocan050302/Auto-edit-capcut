import asyncio
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
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
    FilterSummarySchema
)
from utils.parsers import calculate_age_days
from services.filter_service import (
    FilterStats,
    get_active_filters,
    apply_metadata_filters,
    apply_enriched_video_filters,
    apply_keyword_filters
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
                research_logger.warning(f"[Discovery] Failed to update stage in primary DB session ({db_err}), retrying with fresh session...")
                try:
                    db.rollback()
                except Exception:
                    pass
                try:
                    fresh_db = SessionLocal()
                    try:
                        fresh_repo = ResearchRepository(fresh_db)
                        fresh_repo.update_run_stage(
                            run_id=run_id,
                            stage=stage,
                            progress_percent=progress_percent,
                            message=message,
                            videos_collected=videos_collected,
                            channels_analyzed=channels_analyzed,
                            keywords_expanded=keywords_expanded,
                            error=error
                        )
                    finally:
                        fresh_db.close()
                except Exception as final_db_err:
                    research_logger.error(f"[Discovery] Failed to persist stage in fallback session: {final_db_err}")

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
                research_logger.warning(f"[Discovery] Failed to emit progress event: {emit_err}")

        try:
            research_logger.info(f"[Discovery] Starting run {run_id} for topic: {topic} (market={market})")
            await update_progress("QUEUED", 5, "Initializing research run...")

            if task_manager.is_cancelled(run_id):
                await update_progress("CANCELLED", None, "Research cancelled by user")
                return

            # Stage 1: EXPANDING_KEYWORDS
            research_logger.info(f"[Discovery] stage.start run_id={run_id} stage=EXPANDING_KEYWORDS")
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
                research_logger.warning(f"[Discovery] [KeywordExpand] timeout fallback=true run_id={run_id}")
                expanded_keywords, sources = keyword_expander.build_rule_based_fallback(
                    seed=topic,
                    max_keywords=settings.max_expanded_keywords
                )
            except Exception as expand_err:
                research_logger.warning(f"[Discovery] Keyword expander exception ({expand_err}), using rule fallback: run_id={run_id}")
                expanded_keywords, sources = keyword_expander.build_rule_based_fallback(
                    seed=topic,
                    max_keywords=settings.max_expanded_keywords
                )

            keywords_count = len(expanded_keywords)
            research_logger.info(f"[Discovery] stage.complete run_id={run_id} stage=EXPANDING_KEYWORDS count={keywords_count}")

            if task_manager.is_cancelled(run_id):
                await update_progress("CANCELLED", None, "Research cancelled by user")
                return

            # Stage 2: SEARCHING & FETCHING_METADATA (Pass 1 - Broad Collection)
            await update_progress("SEARCHING", 30, f"Searching YouTube across {keywords_count} queries...", keywords_expanded=keywords_count)
            all_raw_videos = []
            seen_video_ids = set()
            keyword_to_videos: Dict[str, List[Any]] = {}

            # Search top queries
            search_batch = expanded_keywords[:8]
            for idx, kw in enumerate(search_batch):
                if task_manager.is_cancelled(run_id):
                    await update_progress("CANCELLED", None, "Research cancelled by user")
                    return

                res_videos = await self.provider_mgr.search_videos(
                    query=kw,
                    market=market,
                    language=language,
                    content_type=content_type,
                    time_range=time_range,
                    limit=20
                )
                
                filter_stats.raw_videos += len(res_videos)
                filtered_res = apply_metadata_filters(res_videos, filters, filter_stats)
                filter_stats.matched_metadata += len(filtered_res)
                
                keyword_to_videos[kw] = filtered_res
                for v in filtered_res:
                    if v.video_id not in seen_video_ids:
                        seen_video_ids.add(v.video_id)
                        all_raw_videos.append(v)

                pct = 30 + int((idx + 1) / len(search_batch) * 20)
                await update_progress("FETCHING_METADATA", pct, f"Collected {len(all_raw_videos)} videos...", videos_collected=len(all_raw_videos), keywords_expanded=keywords_count)

            # Stage 3: BASIC_SCORING
            await update_progress("BASIC_SCORING", 55, "Computing preliminary velocity & age metrics...", videos_collected=len(all_raw_videos), keywords_expanded=keywords_count)
            
            # Stage 4: ENRICHING_CANDIDATES & LOADING_CHANNEL_BASELINES (Pass 2)
            await update_progress("ENRICHING_CANDIDATES", 65, "Selecting top candidates for channel enrichment...", videos_collected=len(all_raw_videos), keywords_expanded=keywords_count)
            
            # Deduplicate channels to avoid redundant network hits!
            unique_channel_ids = list(dict.fromkeys([v.channel_id for v in all_raw_videos if v.channel_id]))
            channel_baselines: Dict[str, Dict[str, Any]] = {}
            
            # Enrich top 15 unique channels
            channels_to_enrich = unique_channel_ids[:15]
            for c_idx, cid in enumerate(channels_to_enrich):
                if task_manager.is_cancelled(run_id):
                    await update_progress("CANCELLED", None, "Research cancelled by user")
                    return

                # Check if channel already in repo with fresh baseline
                cached_ch = repo.get_channel(cid)
                if cached_ch and cached_ch.median_recent_views > 0:
                    channel_baselines[cid] = {
                        "median": cached_ch.median_recent_views,
                        "mean": cached_ch.mean_recent_views,
                        "p75": cached_ch.p75_views,
                        "p90": cached_ch.p90_views,
                        "subs": cached_ch.subscriber_count,
                        "title": cached_ch.title,
                        "country": cached_ch.country
                    }
                else:
                    c_data = await self.provider_mgr.get_channel_baseline(cid, content_type=content_type, max_videos=20)
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
                    channel_baselines[cid] = {
                        "median": median_v,
                        "mean": mean_v,
                        "p75": p75_v,
                        "p90": p90_v,
                        "subs": c_data.subscriber_count,
                        "title": c_data.title,
                        "country": c_data.country
                    }

                pct = 65 + int((c_idx + 1) / max(len(channels_to_enrich), 1) * 12)
                await update_progress("LOADING_CHANNEL_BASELINES", pct, f"Analyzed baseline for {c_idx + 1} channels...", videos_collected=len(all_raw_videos), channels_analyzed=c_idx + 1, keywords_expanded=keywords_count)

            # Stage 5: CALCULATING_ADVANCED_METRICS
            await update_progress("CALCULATING_ADVANCED_METRICS", 80, "Calculating opportunity scores, breakouts, and market signals...", videos_collected=len(all_raw_videos), channels_analyzed=len(channel_baselines), keywords_expanded=keywords_count)

            breakout_items: List[BreakoutVideoSchema] = []
            enriched_video_dicts = []

            for v in all_raw_videos:
                c_info = channel_baselines.get(v.channel_id, {"median": 15000.0, "subs": None, "country": None})
                median_v = c_info.get("median", 15000.0)
                sub_count = c_info.get("subs")

                ratio = compute_outlier_ratio(v.views, median_v)
                age_days = calculate_age_days(v.published_at)
                vpd = calculate_lifetime_velocity(v.views, v.published_at)

                # Snapshot logic
                snap = repo.add_snapshot_if_eligible(
                    video_id=v.video_id,
                    views=v.views,
                    likes=v.likes,
                    comments=v.comments,
                    min_interval_hours=settings.snapshot_policy_hours
                )
                
                # Check for observed velocity if multiple snapshots exist
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
                    outlier_ratio=ratio,
                    channel_subscribers=sub_count,
                    published_at=v.published_at,
                    channel_median_views=median_v
                )

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
                    channel_median_views=round(median_v, 1),
                    outlier_ratio=ratio,
                    market_signal=f"{market} Relevance Signal",
                    source_provider=v.provider,
                    thumbnail_url=v.thumbnail_url,
                    is_small_channel_breakout=is_breakout
                )

                if ratio >= 2.5 or is_breakout or v.views >= 50_000:
                    breakout_items.append(b_schema)

                enriched_video_dicts.append({
                    **v.model_dump(),
                    "outlier_ratio": ratio,
                    "views_per_day": vpd,
                    "is_breakout": is_breakout,
                    "channel_median": median_v,
                    "channel_subscribers": sub_count
                })

            # Apply Enriched Filters
            enriched_video_dicts = apply_enriched_video_filters(enriched_video_dicts, filters, filter_stats)
            valid_video_ids = {v['video_id'] for v in enriched_video_dicts}
            
            breakout_items = [b for b in breakout_items if b.video_id in valid_video_ids]
            
            # Clean up keyword_to_videos based on enriched filters
            for kw in list(keyword_to_videos.keys()):
                keyword_to_videos[kw] = [v for v in keyword_to_videos[kw] if v.video_id in valid_video_ids]

            # Sort breakouts by outlier ratio descending
            breakout_items.sort(key=lambda x: (x.is_small_channel_breakout, x.outlier_ratio), reverse=True)

            # Calculate Keyword Scores
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
                
                # Outlier for keyword
                kw_outliers = [compute_outlier_ratio(kv.views, channel_baselines.get(kv.channel_id, {}).get("median", 15000.0)) for kv in k_videos]
                median_outlier = sorted(kw_outliers)[len(kw_outliers)//2] if kw_outliers else 1.0
                best_outlier = max(kw_outliers) if kw_outliers else 1.0
                outlier_norm = normalize_outlier_score(best_outlier)

                cc_score, u_chan, high_chan = compute_cross_channel_validation(k_channels, k_views)
                comp_score, comp_lvl = compute_competition_score(len(k_videos), k_subs, k_titles, sum(1 for o in kw_outliers if o >= 4.0))
                fresh_score, fresh_state, c24, c7, c30 = compute_freshness(k_pubs)
                mkt_score, mkt_conf = compute_market_fit(market, language, [language]*len(k_videos), k_countries)

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

                median_v = sorted(k_views)[len(k_views)//2] if k_views else 0
                median_vpd = sorted(k_vpds)[len(k_vpds)//2] if k_vpds else 0

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
                    is_small_channel_win=any(b.is_small_channel_breakout for b in breakout_items if kw.lower() in b.title.lower()),
                    has_market_signal=mkt_score >= 60.0,
                    breakdown={
                        "demand_details": f"Median Views: {median_v:,}, P75 Views: {sorted(k_views)[int(len(k_views)*0.75)]:,}",
                        "velocity_details": f"Median Velocity: {round(median_vpd, 1):,} views/day",
                        "outlier_details": f"Peak Channel Outlier: {best_outlier}x",
                        "cross_channel_details": f"{u_chan} unique channels, {high_chan} high performers",
                        "market_fit_details": f"Estimated {market} signal ({mkt_conf} confidence)",
                        "competition_details": f"{comp_lvl} competition ({comp_score}/100)"
                    }
                )
                keyword_records.append(k_rec)

                # Trend radar item
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

            # Sort keywords by opportunity score descending
            keyword_records.sort(key=lambda x: x.opportunity_score, reverse=True)
            
            # Apply Keyword Filters
            filter_stats.keywords_before_filters = len(keyword_records)
            keyword_records = apply_keyword_filters(keyword_records, filters, filter_stats)
            filter_stats.keywords_after_filters = len(keyword_records)
            
            # Filter Summary Construction
            filter_stats.videos_after_all_filters = len(enriched_video_dicts)
            filter_stats.videos_after_metadata_filters = filter_stats.matched_metadata
            
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
                }
            )

            # Stage 6: CLUSTERING
            await update_progress("CLUSTERING", 88, "Clustering topic themes...", videos_collected=len(all_raw_videos), channels_analyzed=len(channel_baselines), keywords_expanded=keywords_count)
            topic_clusters = clustering_service.cluster_videos(enriched_video_dicts)

            # Stage 7: AI_ANALYSIS
            await update_progress("AI_ANALYSIS", 93, "Generating market summary and content angles...", videos_collected=len(all_raw_videos), channels_analyzed=len(channel_baselines), keywords_expanded=keywords_count)
            top_kw_str = keyword_records[0].keyword if keyword_records else topic
            ai_report = await ai_engine.generate_insights(
                topic=topic,
                market=market,
                top_keyword=top_kw_str,
                breakouts=[b.model_dump() for b in breakout_items],
                clusters=[c.model_dump() for c in topic_clusters]
            )

            # Stage 8: PERSISTING
            await update_progress("PERSISTING", 97, "Saving research results to database...", videos_collected=len(all_raw_videos), channels_analyzed=len(channel_baselines), keywords_expanded=keywords_count)

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

            # Overall metrics
            unique_total_channels = len(set(v['channel_id'] for v in enriched_video_dicts))
            small_channel_wins_count = sum(1 for b in breakout_items if b.is_small_channel_breakout)
            overall_confidence, _ = compute_confidence_level(
                sample_size=len(all_raw_videos),
                unique_channels=unique_total_channels,
                has_snapshots=False,
                provider_source=self.provider_mgr.last_provenance
            )

            overview_metrics = OverviewMetricsSchema(
                videos_analyzed=len(all_raw_videos),
                unique_channels=unique_total_channels,
                keywords_found=len(keyword_records),
                breakouts_found=len(breakout_items),
                small_channel_wins=small_channel_wins_count,
                data_confidence=overall_confidence
            )

            data_sources = [
                DataSourceSchema(metric="Views & Duration", source=f"YouTube {self.provider_mgr.last_provenance}", note="Public metrics normalized via structured parser"),
                DataSourceSchema(metric="Channel Baseline", source="20-30 Recent Uploads", note="Calculated strictly against identical content type"),
                DataSourceSchema(metric="Market Fit Signal", source=f"Estimated {market} Signal", note="Estimated public-data signal, not private audience geography"),
                DataSourceSchema(metric="AI Insights", source=f"{settings.ai_provider.title() if settings.ai_provider != 'disabled' else 'Deterministic Analyzer'}", note="Synthesized angles & gaps; metrics calculated deterministically")
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
                filter_summary=filter_summary
            )

            # Save full JSON to run record
            run_rec = repo.get_run(run_id)
            if run_rec:
                run_rec.raw_results_json = json.dumps(full_result.model_dump())
                db.commit()

            await update_progress("COMPLETED", 100, f"Completed analysis for '{topic}'! Found {len(keyword_records)} rising opportunities.", videos_collected=len(all_raw_videos), channels_analyzed=len(channel_baselines), keywords_expanded=keywords_count)
            research_logger.info(f"[Discovery] Successfully completed run {run_id}")

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
