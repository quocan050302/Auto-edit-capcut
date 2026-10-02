import asyncio
import io
import json
import time
import uuid
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from core.config import settings
from core.logger import research_logger
from db.engine import engine, Base, get_db
from models.entities import ResearchRun, ResearchProject, utcnow_str
from repositories.research_repo import ResearchRepository
from providers.fallback import ProviderFallbackManager
from providers.autocomplete import keyword_expander
from services.discovery_service import DiscoveryService
from workers.task_manager import task_manager
from schemas.research_schemas import (
    DiscoverRequest,
    DiscoverResponse,
    ProgressStateSchema,
    KeywordExpandRequest,
    KeywordExpandResponse,
    CompetitorRequest,
    CompetitorResponse,
    ThumbnailIntelligenceRequest,
    SavedProjectCreate,
    SavedProjectUpdate,
    SavedProjectSchema,
    SettingsUpdateSchema,
    SettingsResponseSchema,
    ResearchRunResultSchema,
    ThumbnailGenerationRequest,
    ThumbnailGenerationResponse,
    ThumbnailPromptGenerationRequest,
    ThumbnailPromptGenerationResponse,
)
import httpx

# Initialize fallback provider manager
provider_manager = ProviderFallbackManager(
    official_api_key=settings.official_api_key,
    use_official=settings.use_official_api,
    priority=settings.provider_priority
)
discovery_service = DiscoveryService(provider_manager)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: ensure tables created & mark stale interrupted runs
    research_logger.info("[App] Initializing YouTube Foreign Market Researcher database...")
    Base.metadata.create_all(bind=engine)
    db = next(get_db())
    try:
        repo = ResearchRepository(db)
        interrupted = repo.mark_interrupted_runs()
        if interrupted > 0:
            research_logger.info(f"[App] Recovered startup: marked {interrupted} stale runs as INTERRUPTED")
    finally:
        db.close()

    yield

    # Shutdown
    research_logger.info("[App] Shutting down YouTube Foreign Market Researcher...")

app = FastAPI(
    title="YouTube Foreign Market Researcher",
    version="1.0.0",
    lifespan=lifespan
)

# Local Electron CORS: allow local loopback origins and packaged null origin
LOCAL_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "null",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=LOCAL_ALLOWED_ORIGINS,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    expose_headers=["Content-Type"],
)

@app.get("/health")
async def health_check():
    # Instantaneous liveness check: does not touch external network or YouTube APIs
    prov_health = provider_manager.get_cached_health()
    return {
        "status": "online",
        "service": "YouTube Foreign Market Researcher",
        "version": "1.0.0",
        "providers": prov_health,
        "database": "sqlite_connected",
        "build_id": os.environ.get("RESEARCH_SIDECAR_BUILD_ID", "unknown"),
        "parent_pid": os.environ.get("RESEARCH_SIDECAR_PARENT_PID", "unknown")
    }

@app.get("/api/research/providers/health")
async def provider_diagnostic_health():
    try:
        prov_health = await asyncio.wait_for(provider_manager.get_health_status(), timeout=5.0)
        return {
            "status": "online",
            "providers": prov_health
        }
    except Exception as e:
        research_logger.warning(f"[Health] Provider diagnostic health check error: {e}")
        return {
            "status": "degraded",
            "error": str(e),
            "providers": provider_manager.get_cached_health()
        }

@app.post("/api/research/discover", response_model=DiscoverResponse)
async def start_discovery(req: DiscoverRequest, db: Session = Depends(get_db)):
    start_time = time.perf_counter()
    topic = req.topic.strip()
    research_logger.info(f"[ResearchAPI] discover.received topic={topic} market={req.market}")
    if not topic:
        raise HTTPException(status_code=422, detail="Topic keyword cannot be empty")

    run_id = task_manager.create_run_id()
    repo = ResearchRepository(db)

    # Create run record
    run = ResearchRun(
        id=run_id,
        topic=topic,
        market=req.market,
        content_type=req.content_type,
        time_range=req.time_range,
        status="QUEUED",
        stage="QUEUED",
        progress_percent=0,
        message="Queued for analysis"
    )
    repo.create_run(run)
    research_logger.info(f"[ResearchAPI] run.created run_id={run_id}")

    # Spawn background async task
    task = asyncio.create_task(
        discovery_service.execute_discovery_run(
            run_id=run_id,
            topic=topic,
            market=req.market,
            content_type=req.content_type,
            time_range=req.time_range,
            limit=req.limit,
            filters=req.filters
        )
    )
    task_manager.register_run(run_id, task)
    research_logger.info(f"[ResearchAPI] task.scheduled run_id={run_id}")

    duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
    research_logger.info(f"[ResearchAPI] discover.response run_id={run_id} duration_ms={duration_ms}")

    return DiscoverResponse(
        run_id=run_id,
        status="QUEUED",
        message="Research started successfully"
    )

@app.post("/api/research/expand-keywords", response_model=KeywordExpandResponse)
async def expand_keywords_endpoint(req: KeywordExpandRequest):
    keywords, sources = await keyword_expander.expand_keywords(
        seed=req.topic,
        market=req.market,
        max_keywords=settings.max_expanded_keywords
    )
    return KeywordExpandResponse(keywords=keywords, sources=sources)

@app.get("/api/research/stream/{run_id}")
async def stream_progress(run_id: str, db: Session = Depends(get_db)):
    research_logger.info(f"[ResearchAPI] stream.requested run_id={run_id}")
    repo = ResearchRepository(db)
    run = repo.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    q = task_manager.subscribe(run_id)

    # If run already finished in DB and not in task manager memory, emit state immediately
    if run.stage in ("COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"):
        if run_id not in task_manager.latest_progress:
            initial_state = ProgressStateSchema(
                run_id=run.id,
                stage=run.stage,
                progress_percent=run.progress_percent,
                message=run.message or "",
                videos_collected=run.videos_collected or 0,
                channels_analyzed=run.channels_analyzed or 0,
                keywords_expanded=run.keywords_expanded or 0,
                elapsed_seconds=0,
                can_cancel=False
            )
            q.put_nowait(initial_state)

    async def event_generator():
        try:
            while True:
                try:
                    # Wait for state update with heartbeat timeout (10s)
                    state = await asyncio.wait_for(q.get(), timeout=10.0)
                    payload = json.dumps(state.model_dump())
                    yield f"data: {payload}\n\n"

                    if state.stage in ("COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"):
                        break
                except asyncio.TimeoutError:
                    # Send standard SSE keep-alive heartbeat comment
                    yield ": keep-alive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            task_manager.unsubscribe(run_id, q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.get("/api/research/runs/{run_id}/status", response_model=ProgressStateSchema)
async def get_run_status(run_id: str, db: Session = Depends(get_db)):
    if run_id in task_manager.latest_progress:
        return task_manager.latest_progress[run_id]

    repo = ResearchRepository(db)
    run = repo.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    return ProgressStateSchema(
        run_id=run.id,
        stage=run.stage,
        progress_percent=run.progress_percent,
        message=run.message or "",
        videos_collected=run.videos_collected or 0,
        channels_analyzed=run.channels_analyzed or 0,
        keywords_expanded=run.keywords_expanded or 0,
        elapsed_seconds=0,
        can_cancel=run.stage not in ("COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED")
    )

@app.post("/api/research/cancel/{run_id}")
async def cancel_run(run_id: str, db: Session = Depends(get_db)):
    repo = ResearchRepository(db)
    run = repo.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    cancelled = task_manager.cancel_run(run_id)
    repo.update_run_stage(run_id, "CANCELLED", 100, "Research cancelled by user")
    return {"success": True, "message": "Research task cancelled"}

@app.get("/api/research/runs/{run_id}", response_model=ResearchRunResultSchema)
async def get_run_result(run_id: str, db: Session = Depends(get_db)):
    repo = ResearchRepository(db)
    run = repo.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    if not run.raw_results_json:
        raise HTTPException(status_code=400, detail=f"Run is currently in status {run.status}")

    try:
        data = json.loads(run.raw_results_json)
        return ResearchRunResultSchema(**data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed parsing saved result: {e}")

@app.get("/api/research/runs/latest", response_model=ResearchRunResultSchema)
async def get_latest_run(
    topic: Optional[str] = Query(None),
    market: Optional[str] = Query(None),
    db: Session = Depends(get_db)
):
    repo = ResearchRepository(db)
    run = repo.get_latest_run(topic=topic, market=market)
    if not run or not run.raw_results_json:
        raise HTTPException(status_code=404, detail="No completed research runs found")
    data = json.loads(run.raw_results_json)
    return ResearchRunResultSchema(**data)

@app.post("/api/research/competitor", response_model=CompetitorResponse)
async def analyze_competitor_endpoint(req: CompetitorRequest):
    try:
        return await discovery_service.competitor_svc.analyze_channel(
            channel_input=req.channel_url,
            market=req.market
        )
    except Exception as e:
        research_logger.error(f"[Competitor] Error analyzing {req.channel_url}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to analyze competitor: {str(e)}")


@app.post("/api/research/competitor/thumbnail-intelligence")
async def analyze_thumbnail_intelligence_endpoint(req: ThumbnailIntelligenceRequest):
    """
    Analyze thumbnails of recently collected competitor videos.
    Runs classification, download, analysis, pattern detection, blueprint generation.
    Does NOT affect existing channel baseline data.
    Returns: ThumbnailIntelligenceResult as dict
    """
    try:
        from services.thumbnail_intelligence_service import ThumbnailIntelligenceService
        from ai.engine import ai_engine
        svc = ThumbnailIntelligenceService(ai_engine=ai_engine)
        result = await svc.run(
            channel_id=req.channel_id,
            channel_title=req.channel_title,
            videos=req.videos,
            channel_median_views=req.channel_median_views,
            p75_views=req.p75_views,
            max_videos=req.max_videos,
        )
        return result.to_dict()
    except Exception as e:
        research_logger.error(f"[ThumbnailIntel] Error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Thumbnail intelligence failed: {str(e)}")

@app.post("/api/research/competitor/thumbnail-generate", response_model=ThumbnailGenerationResponse)
async def generate_thumbnail_endpoint(req: ThumbnailGenerationRequest):
    """V2: Generate a thumbnail from title and blueprint."""
    from providers.image_generator import ThumbnailGeneratorProvider
    from services.thumbnail_compositor import ThumbnailCompositor
    import base64

    # Build prompt from blueprint
    prompt = f"YouTube thumbnail. {req.blueprint.background_recipe}. {req.blueprint.subject_recipe}. {req.blueprint.lighting_recipe}."
    if req.title:
        prompt += f" Concept relates to: {req.title}."
    if req.script_summary:
        prompt += f" Context: {req.script_summary}."

    # Use a real provider if configured. For local demo without key, we use dummy/disabled.
    generator = ThumbnailGeneratorProvider(provider="disabled")
    
    try:
        base_img_bytes = await generator.generate(prompt)
        
        # Composite text
        compositor = ThumbnailCompositor()
        text_overlay = req.blueprint.overlay_text_formula or []
        if not text_overlay and req.title:
            # simple fallback
            words = req.title.split()
            text_overlay = [" ".join(words[:3])]
            
        final_img_bytes = compositor.compose(base_img_bytes, text_overlay)
        
        b64 = base64.b64encode(final_img_bytes).decode('utf-8')
        return ThumbnailGenerationResponse(image_base64=b64, prompt_used=prompt)
    except Exception as e:
        research_logger.error(f"Thumbnail generation error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/research/competitor/thumbnail-prompts", response_model=ThumbnailPromptGenerationResponse)
async def generate_thumbnail_prompts_endpoint(req: ThumbnailPromptGenerationRequest):
    """
    V2 Prompt Studio: Generate 5 competitor-informed thumbnail prompt concepts.
    Does NOT create images. Returns structured prompts ready for external image tools.
    """
    from ai.engine import ai_engine
    from services.thumbnail_prompt_service import ThumbnailPromptService

    try:
        svc = ThumbnailPromptService()
        result = await svc.generate_five_variants(
            title=req.title,
            video_context=req.video_context or "",
            channel_title=req.channel_title,
            market=req.market,
            blueprint=req.blueprint.model_dump(),
            thumbnail_intelligence=req.thumbnail_intelligence,
            ai_engine=ai_engine,
        )
        return result
    except Exception as e:
        research_logger.error(f"[PromptStudio] Endpoint error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Thumbnail prompt generation failed: {str(e)}")


# ─── Saved Projects ───────────────────────────────────────────────────────────


@app.get("/api/research/saved", response_model=List[SavedProjectSchema])
async def list_saved_projects(db: Session = Depends(get_db)):
    repo = ResearchRepository(db)
    projects = repo.list_saved_projects()
    results = []
    for p in projects:
        results.append(
            SavedProjectSchema(
                id=p.id,
                name=p.name,
                seed_topic=p.seed_topic,
                market=p.market,
                language=p.language,
                content_type=p.content_type,
                time_range=p.time_range,
                created_at=p.created_at,
                updated_at=p.updated_at,
                last_run_id=p.last_run_id,
                scoring_version=p.scoring_version,
                provider_source=p.provider_source,
                summary_snippet=p.summary_snippet,
                top_opportunity_keyword=p.top_opportunity_keyword,
                top_opportunity_score=p.top_opportunity_score,
                video_count=p.video_count
            )
        )
    return results

@app.post("/api/research/saved", response_model=SavedProjectSchema)
async def create_saved_project(req: SavedProjectCreate, db: Session = Depends(get_db)):
    repo = ResearchRepository(db)
    run = repo.get_run(req.run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Referenced run not found")

    top_kw = ""
    top_score = 0.0
    summary_snip = f"Market research for '{req.seed_topic}' in {req.market}."
    video_c = run.videos_collected

    if run.raw_results_json:
        try:
            r_data = json.loads(run.raw_results_json)
            if r_data.get("top_opportunity"):
                top_kw = r_data["top_opportunity"].get("keyword", "")
                top_score = r_data["top_opportunity"].get("opportunity_score", 0.0)
            if r_data.get("ai_insights"):
                summary_snip = r_data["ai_insights"].get("summary", summary_snip)
        except Exception:
            pass

    proj_id = f"proj_{uuid.uuid4().hex[:10]}"
    project = ResearchProject(
        id=proj_id,
        name=req.name,
        seed_topic=req.seed_topic,
        market=req.market,
        content_type=req.content_type,
        time_range=req.time_range,
        last_run_id=req.run_id,
        provider_source=run.provider_source,
        summary_snippet=summary_snip[:300],
        top_opportunity_keyword=top_kw,
        top_opportunity_score=top_score,
        video_count=video_c
    )
    repo.create_saved_project(project)

    return SavedProjectSchema(
        id=project.id,
        name=project.name,
        seed_topic=project.seed_topic,
        market=project.market,
        language=project.language,
        content_type=project.content_type,
        time_range=project.time_range,
        created_at=project.created_at,
        updated_at=project.updated_at,
        last_run_id=project.last_run_id,
        scoring_version=project.scoring_version,
        provider_source=project.provider_source,
        summary_snippet=project.summary_snippet,
        top_opportunity_keyword=project.top_opportunity_keyword,
        top_opportunity_score=project.top_opportunity_score,
        video_count=project.video_count
    )

@app.patch("/api/research/saved/{id}", response_model=SavedProjectSchema)
async def update_saved_project(id: str, req: SavedProjectUpdate, db: Session = Depends(get_db)):
    repo = ResearchRepository(db)
    proj = repo.get_saved_project(id)
    if not proj:
        raise HTTPException(status_code=404, detail="Saved project not found")
    proj.name = req.name
    proj.updated_at = utcnow_str()
    db.commit()
    db.refresh(proj)
    return SavedProjectSchema(
        id=proj.id,
        name=proj.name,
        seed_topic=proj.seed_topic,
        market=proj.market,
        language=proj.language,
        content_type=proj.content_type,
        time_range=proj.time_range,
        created_at=proj.created_at,
        updated_at=proj.updated_at,
        last_run_id=proj.last_run_id,
        scoring_version=proj.scoring_version,
        provider_source=proj.provider_source,
        summary_snippet=proj.summary_snippet,
        top_opportunity_keyword=proj.top_opportunity_keyword,
        top_opportunity_score=proj.top_opportunity_score,
        video_count=proj.video_count
    )

@app.delete("/api/research/saved/{id}")
async def delete_saved_project(id: str, db: Session = Depends(get_db)):
    repo = ResearchRepository(db)
    ok = repo.delete_saved_project(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Saved project not found")
    return {"success": True}

# ─── Settings ─────────────────────────────────────────────────────────────────

@app.get("/api/research/settings", response_model=SettingsResponseSchema)
async def get_settings_endpoint():
    return SettingsResponseSchema(
        use_official_api=settings.use_official_api,
        has_official_api_key=bool(settings.official_api_key),
        scraper_fallback=settings.scraper_fallback,
        provider_priority=settings.provider_priority,
        default_market=settings.default_market,
        default_language=settings.default_language,
        default_date_range=settings.default_time_range,
        default_content_type=settings.default_content_type,
        default_result_size=settings.default_result_size,
        ai_provider=settings.ai_provider,
        ollama_base_url=settings.ollama_base_url,
        ollama_model=settings.ollama_model,
        has_cloud_ai_key=bool(settings.cloud_ai_key),
        max_expanded_keywords=settings.max_expanded_keywords,
        raw_video_limit=settings.raw_video_limit,
        max_enrichment_videos=settings.max_enrichment_videos,
        channel_baseline_size=settings.channel_baseline_size,
        debug_mode=settings.debug,
        scoring_weights=settings.scoring_weights.model_dump()
    )

@app.post("/api/research/settings", response_model=SettingsResponseSchema)
async def update_settings_endpoint(req: SettingsUpdateSchema):
    if req.use_official_api is not None:
        settings.use_official_api = req.use_official_api
    if req.official_api_key is not None:
        settings.official_api_key = req.official_api_key.strip()
    if req.scraper_fallback is not None:
        settings.scraper_fallback = req.scraper_fallback
    if req.provider_priority is not None:
        settings.provider_priority = req.provider_priority
    if req.default_market is not None:
        settings.default_market = req.default_market
    if req.default_language is not None:
        settings.default_language = req.default_language
    if req.default_date_range is not None:
        settings.default_time_range = req.default_date_range
    if req.default_content_type is not None:
        settings.default_content_type = req.default_content_type
    if req.default_result_size is not None:
        settings.default_result_size = req.default_result_size
    if req.ai_provider is not None:
        settings.ai_provider = req.ai_provider
    if req.ollama_base_url is not None:
        settings.ollama_base_url = req.ollama_base_url
    if req.ollama_model is not None:
        settings.ollama_model = req.ollama_model
    if req.cloud_ai_key is not None:
        settings.cloud_ai_key = req.cloud_ai_key.strip()
    if req.max_expanded_keywords is not None:
        settings.max_expanded_keywords = req.max_expanded_keywords
    if req.raw_video_limit is not None:
        settings.raw_video_limit = req.raw_video_limit
    if req.max_enrichment_videos is not None:
        settings.max_enrichment_videos = req.max_enrichment_videos
    if req.channel_baseline_size is not None:
        settings.channel_baseline_size = req.channel_baseline_size
    if req.debug_mode is not None:
        settings.debug = req.debug_mode

    # Update providers
    provider_manager.update_configuration(
        api_key=settings.official_api_key,
        use_official=settings.use_official_api,
        priority=settings.provider_priority
    )

    # Update AI engine singleton immediately so new settings take effect without restart
    from ai.engine import ai_engine
    ai_engine.update_config(
        provider=settings.ai_provider,
        ollama_url=settings.ollama_base_url,
        ollama_model=settings.ollama_model,
        cloud_api_key=settings.cloud_ai_key,
        cloud_model="gemini-2.0-flash",
    )

    # Persist settings to disk so they survive sidecar restarts
    settings.save()

    return await get_settings_endpoint()

@app.post("/api/research/test-api-key")
async def test_api_key_endpoint(payload: Dict[str, str]):
    key = payload.get("api_key", "").strip()
    if not key:
        return {"valid": False, "status": "not_configured", "error": "API key cannot be empty"}
    try:
        # Use videos.list (1 unit cost) instead of search (100 units)
        url = "https://www.googleapis.com/youtube/v3/videos"
        params = {"key": key, "part": "snippet", "chart": "mostPopular", "maxResults": 1}
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(url, params=params)
            if resp.status_code == 200:
                return {"valid": True, "status": "connected"}
            elif resp.status_code == 400:
                return {"valid": False, "status": "invalid_request", "error": "Invalid API request format"}
            elif resp.status_code == 403:
                try:
                    data = resp.json()
                    err_code = data.get("error", {}).get("errors", [{}])[0].get("reason", "")
                    err_msg = data.get("error", {}).get("message", "")
                    err_lower = (err_code + " " + err_msg).lower()
                    if "accessnotconfigured" in err_lower or "api not enabled" in err_lower:
                        return {"valid": False, "status": "api_not_enabled",
                                "error": "YouTube Data API v3 is not enabled. Enable it at console.cloud.google.com → APIs & Services."}
                    elif "quotaexceeded" in err_lower or "dailylimitexceeded" in err_lower or "usagelimitexceeded" in err_lower:
                        return {"valid": False, "status": "quota_exhausted",
                                "error": "YouTube API quota exhausted for today. Resets at midnight Pacific Time."}
                    elif "keyinvalid" in err_lower or "key not valid" in err_lower:
                        return {"valid": False, "status": "invalid_key",
                                "error": "YouTube API key is invalid. Check the key value and try again."}
                    else:
                        return {"valid": False, "status": "forbidden",
                                "error": f"Access denied: {err_msg or err_code}"}
                except Exception:
                    return {"valid": False, "status": "invalid_key", "error": "Access forbidden (403)"}
            elif resp.status_code == 429:
                return {"valid": False, "status": "rate_limited",
                        "error": "Too many requests. Wait a moment and try again."}
            elif resp.status_code >= 500:
                return {"valid": False, "status": "server_error",
                        "error": f"YouTube API server error ({resp.status_code}). Google may have a temporary outage."}
            else:
                return {"valid": False, "status": "unknown_error", "error": f"HTTP {resp.status_code}"}
    except httpx.TimeoutException:
        return {"valid": False, "status": "network_error",
                "error": "Connection timed out. Check your network or DNS settings."}
    except Exception as e:
        return {"valid": False, "status": "network_error", "error": str(e)}

@app.post("/api/research/test-ollama")
async def test_ollama_endpoint(payload: Dict[str, str]):
    url = payload.get("url", "http://localhost:11434").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(f"{url}/api/tags")
            if resp.status_code == 200:
                return {"available": True}
    except Exception as e:
        return {"available": False, "error": str(e)}
    return {"available": False, "error": "Ollama service unreachable"}


# ─── Similar Channel Discovery ────────────────────────────────────────────────

from services.similar_channel_discovery_service import SimilarChannelDiscoveryService

_similar_discovery_svc = SimilarChannelDiscoveryService(provider_manager)


@app.post("/api/research/competitor/similar-channels/discover")
async def discover_similar_channels(req: dict):
    """
    Start a background similar-channel discovery run.
    Returns {run_id} immediately.
    req body: {
      source_channel_id, source_channel_title, source_videos,
      market?, language?, window_days?, min_views?,
      max_subscribers?, min_evaluable_videos?,
      candidate_channel_limit?, search_query_budget?
    }
    """
    try:
        run_id = await _similar_discovery_svc.start(
            source_channel_id=req.get("source_channel_id", ""),
            source_channel_title=req.get("source_channel_title", ""),
            source_videos=req.get("source_videos", []),
            market=req.get("market", "US"),
            language=req.get("language", "en"),
            content_type=req.get("content_type", "LONG"),
            window_days=int(req.get("window_days", 90)),
            min_views=int(req.get("min_views", 10_000)),
            max_subscribers=int(req.get("max_subscribers", 50_000)),
            min_evaluable_videos=int(req.get("min_evaluable_videos", 3)),
            candidate_channel_limit=int(req.get("candidate_channel_limit", 40)),
            search_query_budget=int(req.get("search_query_budget", 10)),
        )
        return {"run_id": run_id, "status": "QUEUED"}
    except Exception as e:
        research_logger.error(f"[SimilarDisc] Start error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/research/competitor/similar-channels/{run_id}/progress")
async def similar_channels_progress(run_id: str):
    """Poll for progress of a similar-channel discovery run."""
    from models.entities import SimilarChannelRun
    db = next(get_db())
    try:
        obj = db.get(SimilarChannelRun, run_id)
        if not obj:
            raise HTTPException(status_code=404, detail="Run not found")
        # Also include latest in-memory progress
        latest = task_manager.latest_progress.get(run_id)
        return {
            "run_id": run_id,
            "stage": obj.stage,
            "status": obj.status,
            "progress_percent": obj.progress_percent,
            "message": obj.message or "",
            "candidate_videos_found": obj.candidate_videos_found,
            "candidate_channels_found": obj.candidate_channels_found,
            "channels_enriched": obj.channels_enriched,
            "channels_qualified": obj.qualified_count,
            "can_cancel": obj.status == "RUNNING",
            "elapsed_seconds": latest.elapsed_seconds if latest else 0,
            "error": obj.error,
        }
    finally:
        db.close()


@app.get("/api/research/competitor/similar-channels/{run_id}/result")
async def similar_channels_result(run_id: str):
    """Return full result of a completed run from DB."""
    from models.entities import SimilarChannelRun, SimilarChannelCandidate, SimilarChannelVideo
    db = next(get_db())
    try:
        obj = db.get(SimilarChannelRun, run_id)
        if not obj:
            raise HTTPException(status_code=404, detail="Run not found")
        if obj.status not in ("COMPLETED",):
            return {"run_id": run_id, "status": obj.status, "stage": obj.stage,
                    "progress_percent": obj.progress_percent, "candidates": []}

        cands = (db.query(SimilarChannelCandidate)
                 .filter(SimilarChannelCandidate.run_id == run_id)
                 .order_by(SimilarChannelCandidate.rank)
                 .all())

        videos_q = (db.query(SimilarChannelVideo)
                    .filter(SimilarChannelVideo.run_id == run_id)
                    .all())
        vids_by_ch: Dict[str, List] = {}
        for v in videos_q:
            vids_by_ch.setdefault(v.channel_id, []).append(v)

        def _cand_dict(c):
            vids = vids_by_ch.get(c.channel_id, [])
            return {
                "rank": c.rank,
                "channel_id": c.channel_id,
                "channel_title": c.channel_title,
                "channel_url": c.channel_url,
                "country": c.country,
                "subscriber_count": c.subscriber_count,
                "subscriber_status": c.subscriber_status,
                "public_video_count": c.public_video_count,
                "status": c.status,
                "is_most_promising": c.is_most_promising,
                "most_promising_label": c.most_promising_label,
                "window_start": c.window_start,
                "window_end": c.window_end,
                "recent_video_count": c.recent_video_count,
                "evaluable_video_count": c.evaluable_video_count,
                "pending_video_count": c.pending_video_count,
                "passed_views_count": c.passed_views_count,
                "passed_growth_confirmed_count": c.passed_growth_confirmed_count,
                "passed_growth_provisional_count": c.passed_growth_provisional_count,
                "failed_video_count": c.failed_video_count,
                "strict_success_ratio": c.strict_success_ratio,
                "provisional_success_ratio": c.provisional_success_ratio,
                "minimum_recent_views": c.minimum_recent_views,
                "median_recent_views": c.median_recent_views,
                "mean_recent_views": c.mean_recent_views,
                "p25_recent_views": c.p25_recent_views,
                "p75_recent_views": c.p75_recent_views,
                "maximum_recent_views": c.maximum_recent_views,
                "total_recent_views": c.total_recent_views,
                "single_hit_dependency": c.single_hit_dependency,
                "niche_match_reason": c.niche_match_reason,
                "matched_topics": json.loads(c.matched_topics_json or "[]"),
                "matched_video_ids": json.loads(c.matched_video_ids_json or "[]"),
                "active_months_last_12": c.active_months_last_12,
                "median_upload_cadence_days": c.median_upload_cadence_days,
                "maximum_upload_gap_days": c.maximum_upload_gap_days,
                "evergreen_ratio": c.evergreen_ratio,
                "topic_cluster_count": c.topic_cluster_count,
                "future_title_angle_count": c.future_title_angle_count,
                "monetization_viability": c.monetization_viability,
                "monetization_evidence": json.loads(c.monetization_evidence_json or "[]"),
                "policy_risk_flags": json.loads(c.policy_risk_flags_json or "[]"),
                "data_confidence": c.data_confidence,
                "confidence_limitations": json.loads(c.confidence_limitations_json or "[]"),
                "qualification_reasons": json.loads(c.qualification_reasons_json or "[]"),
                "rejection_reasons": json.loads(c.rejection_reasons_json or "[]"),
                "scores": {
                    "niche_match_score": c.niche_match_score,
                    "recent_consistency_score": c.recent_consistency_score,
                    "growth_quality_score": c.growth_quality_score,
                    "durability_score": c.durability_score,
                    "monetization_viability_score": c.monetization_viability_score,
                    "data_confidence_score": c.data_confidence_score,
                    "final_score": c.final_score,
                },
                "recent_videos": [
                    {
                        "video_id": v.video_id,
                        "video_url": v.video_url,
                        "title": v.title,
                        "published_at": v.published_at,
                        "age_days": v.age_days,
                        "duration_seconds": v.duration_seconds,
                        "views": v.views,
                        "likes": v.likes,
                        "comments": v.comments,
                        "lifetime_views_per_day": v.lifetime_views_per_day,
                        "observed_views_per_day": v.observed_views_per_day,
                        "projected_day_90_views": v.projected_day_90_views,
                        "growth_status": v.growth_status,
                        "evaluation_status": v.evaluation_status,
                        "evaluation_reason": v.evaluation_reason,
                        "niche_similarity": v.niche_similarity,
                        "snapshot_count": v.snapshot_count,
                    }
                    for v in sorted(vids, key=lambda x: x.views, reverse=True)
                ],
            }

        return {
            "run_id": run_id,
            "status": obj.status,
            "stage": obj.stage,
            "source_channel_id": obj.source_channel_id,
            "source_channel_title": obj.source_channel_title,
            "market": obj.market,
            "language": obj.language,
            "window_days": obj.window_days,
            "min_views": obj.min_views,
            "max_subscribers": obj.max_subscribers,
            "candidate_videos_found": obj.candidate_videos_found,
            "candidate_channels_found": obj.candidate_channels_found,
            "channels_enriched": obj.channels_enriched,
            "qualified_count": obj.qualified_count,
            "growing_count": obj.growing_count,
            "watchlist_count": obj.watchlist_count,
            "rejected_count": obj.rejected_count,
            "most_promising_channel_id": obj.most_promising_channel_id,
            "most_promising_status": obj.most_promising_status,
            "most_promising_reason": json.loads(obj.most_promising_reason_json or "[]"),
            "niche_fingerprint": json.loads(obj.niche_fingerprint_json or "{}"),
            "limitations": json.loads(obj.limitations_json or "[]"),
            "created_at": obj.created_at,
            "completed_at": obj.completed_at,
            "candidates": [_cand_dict(c) for c in cands],
        }
    finally:
        db.close()


@app.post("/api/research/competitor/similar-channels/{run_id}/cancel")
async def cancel_similar_channels(run_id: str):
    """Cancel a running similar-channel discovery."""
    from models.entities import SimilarChannelRun
    cancelled = task_manager.cancel_run(run_id)
    db = next(get_db())
    try:
        obj = db.get(SimilarChannelRun, run_id)
        if obj and obj.status == "RUNNING":
            obj.status = "CANCELLED"
            obj.stage = "CANCELLED"
            obj.updated_at = utcnow_str()
            db.commit()
    finally:
        db.close()
    return {"cancelled": True, "run_id": run_id}


@app.post("/api/research/competitor/similar-channels/{run_id}/retry")
async def retry_similar_channels(run_id: str, req: dict = {}):
    """Retry an interrupted/failed/cancelled run with same parameters."""
    from models.entities import SimilarChannelRun
    db = next(get_db())
    try:
        obj = db.get(SimilarChannelRun, run_id)
        if not obj:
            raise HTTPException(status_code=404, detail="Run not found")
        if obj.status == "RUNNING":
            raise HTTPException(status_code=409, detail="Run is already running")
    finally:
        db.close()

    new_run_id = await _similar_discovery_svc.start(
        source_channel_id=obj.source_channel_id,
        source_channel_title=obj.source_channel_title,
        source_videos=req.get("source_videos", []),
        market=obj.market,
        language=obj.language,
        content_type=obj.content_type,
        window_days=obj.window_days,
        min_views=obj.min_views,
        max_subscribers=obj.max_subscribers,
        min_evaluable_videos=obj.min_evaluable_videos,
    )
    return {"run_id": new_run_id, "previous_run_id": run_id, "status": "QUEUED"}


@app.get("/api/research/competitor/similar-channels/{run_id}/export.xlsx")
async def export_similar_channels_excel(run_id: str):
    """Export completed run as Excel workbook."""
    from models.entities import SimilarChannelRun, SimilarChannelCandidate, SimilarChannelVideo
    from services.similar_channel_excel_service import build_excel_bytes
    import re as _re

    db = next(get_db())
    try:
        obj = db.get(SimilarChannelRun, run_id)
        if not obj:
            raise HTTPException(status_code=404, detail="Run not found")
        if obj.status != "COMPLETED":
            raise HTTPException(status_code=409, detail=f"Run status is {obj.status}; only COMPLETED runs can be exported")

        cands = (db.query(SimilarChannelCandidate)
                 .filter(SimilarChannelCandidate.run_id == run_id)
                 .order_by(SimilarChannelCandidate.rank)
                 .all())
        videos = (db.query(SimilarChannelVideo)
                  .filter(SimilarChannelVideo.run_id == run_id)
                  .all())

        videos_by_ch: Dict[str, List] = {}
        for v in videos:
            videos_by_ch.setdefault(v.channel_id, []).append(v)

        xlsx_bytes = build_excel_bytes(obj, cands, videos_by_ch)

        safe_name = _re.sub(r"[^\w\-]", "_", obj.source_channel_title or "channel")[:30]
        date_str  = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        filename  = f"similar-channel-analysis-{safe_name}-{date_str}.xlsx"

        return StreamingResponse(
            io.BytesIO(xlsx_bytes),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except HTTPException:
        raise
    except Exception as e:
        research_logger.error(f"[SimilarDisc] Excel export error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")
    finally:
        db.close()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=False)

