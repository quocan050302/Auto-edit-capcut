import asyncio
import json
import time
import uuid
import os
from contextlib import asynccontextmanager
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=False)
