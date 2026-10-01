import asyncio
import json
import uuid
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
    KeywordExpandRequest,
    KeywordExpandResponse,
    CompetitorRequest,
    CompetitorResponse,
    SavedProjectCreate,
    SavedProjectUpdate,
    SavedProjectSchema,
    SettingsUpdateSchema,
    SettingsResponseSchema,
    ResearchRunResultSchema
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

# Local Electron CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health_check():
    prov_health = await provider_manager.get_health_status()
    return {
        "status": "online",
        "service": "YouTube Foreign Market Researcher",
        "version": "1.0.0",
        "providers": prov_health,
        "database": "sqlite_connected"
    }

@app.post("/api/research/discover", response_model=DiscoverResponse)
async def start_discovery(req: DiscoverRequest, db: Session = Depends(get_db)):
    run_id = task_manager.create_run_id()
    repo = ResearchRepository(db)

    # Create run record
    run = ResearchRun(
        id=run_id,
        topic=req.topic,
        market=req.market,
        content_type=req.content_type,
        time_range=req.time_range,
        status="QUEUED",
        stage="QUEUED",
        progress_percent=0,
        message="Queued for analysis"
    )
    repo.create_run(run)

    # Spawn background async task
    task = asyncio.create_task(
        discovery_service.execute_discovery_run(
            run_id=run_id,
            topic=req.topic,
            market=req.market,
            content_type=req.content_type,
            time_range=req.time_range,
            limit=req.limit,
            filters=req.filters
        )
    )
    task_manager.register_run(run_id, task)

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
    repo = ResearchRepository(db)
    run = repo.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    q = task_manager.subscribe(run_id)

    async def event_generator():
        try:
            while True:
                # Wait for state update
                state = await q.get()
                payload = json.dumps(state.model_dump())
                yield f"data: {payload}\n\n"

                if state.stage in ("COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"):
                    break
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

    # Update providers & AI instances
    provider_manager.update_configuration(
        api_key=settings.official_api_key,
        use_official=settings.use_official_api,
        priority=settings.provider_priority
    )
    ai_engine.update_config(
        provider=settings.ai_provider,
        ollama_url=settings.ollama_base_url,
        ollama_model=settings.ollama_model,
        cloud_api_key=settings.cloud_ai_key
    )

    return await get_settings_endpoint()

@app.post("/api/research/test-api-key")
async def test_api_key_endpoint(payload: Dict[str, str]):
    key = payload.get("api_key", "").strip()
    if not key:
        return {"valid": False, "error": "API key cannot be empty"}
    try:
        url = f"https://www.googleapis.com/youtube/v3/search?key={key}&part=snippet&maxResults=1&q=test"
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                return {"valid": True}
            elif resp.status_code == 403:
                data = resp.json()
                msg = data.get("error", {}).get("message", "Quota exceeded or invalid key")
                return {"valid": False, "error": msg}
            else:
                return {"valid": False, "error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"valid": False, "error": str(e)}

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
