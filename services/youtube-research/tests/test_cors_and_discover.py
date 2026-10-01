import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, AsyncMock
from main import app
from db.engine import SessionLocal, init_db
from repositories.research_repo import ResearchRepository
from workers.task_manager import task_manager

init_db()
client = TestClient(app)

def test_cors_options_preflight():
    """16.2: Test CORS preflight with local dev origin."""
    headers = {
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"
    }
    res = client.options("/api/research/discover", headers=headers)
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert "POST" in res.headers.get("access-control-allow-methods", "")

def test_cors_production_null_origin():
    """16.2: Test CORS with production file:// origin (Origin: null)."""
    headers = {
        "Origin": "null",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"
    }
    res = client.options("/api/research/discover", headers=headers)
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == "null"

def test_cors_rejects_external_origin():
    """16.2: Test that external/malicious origins do NOT get CORS permission."""
    headers = {
        "Origin": "https://malicious.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"
    }
    res = client.options("/api/research/discover", headers=headers)
    allow_origin = res.headers.get("access-control-allow-origin")
    assert allow_origin != "https://malicious.example"

def test_health_endpoint_contract():
    """16.3: Health endpoint returns status, service, and version."""
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "online"
    assert data["service"] == "YouTube Foreign Market Researcher"
    assert data["version"] == "1.0.0"
    assert "providers" in data

@patch("services.discovery_service.DiscoveryService.execute_discovery_run", new_callable=AsyncMock)
def test_discover_api_success(mock_execute):
    """16.4: Test discover API generates run_id, queues run, and creates DB record."""
    payload = {
        "topic": "test grocery inflation",
        "market": "US",
        "content_type": "LONG",
        "time_range": "30d",
        "limit": 50,
        "filters": {}
    }
    res = client.post("/api/research/discover", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert "run_id" in data
    assert data["status"] == "QUEUED"
    run_id = data["run_id"]

    # Verify DB record exists
    db = SessionLocal()
    try:
        repo = ResearchRepository(db)
        run = repo.get_run(run_id)
        assert run is not None
        assert run.topic == "test grocery inflation"
        assert run.status == "QUEUED"
    finally:
        db.close()

def test_discover_api_rejects_empty_topic():
    """16.4: Discover API rejects empty topic with HTTP 422."""
    payload = {
        "topic": "   ",
        "market": "US",
        "content_type": "LONG",
        "time_range": "30d"
    }
    res = client.post("/api/research/discover", json=payload)
    assert res.status_code == 422

@patch("services.discovery_service.DiscoveryService.execute_discovery_run", new_callable=AsyncMock)
def test_run_status_endpoint(mock_execute):
    """16.6: Status endpoint returns progress state for polling fallback."""
    payload = {
        "topic": "status test topic",
        "market": "US",
        "content_type": "LONG",
        "time_range": "30d"
    }
    res = client.post("/api/research/discover", json=payload)
    assert res.status_code == 200
    run_id = res.json()["run_id"]

    status_res = client.get(f"/api/research/runs/{run_id}/status")
    assert status_res.status_code == 200
    data = status_res.json()
    assert data["run_id"] == run_id
    assert data["stage"] in ("QUEUED", "EXPANDING_KEYWORDS", "SEARCHING", "COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED")

def test_unknown_run_status_returns_404():
    """Test that requesting status of a non-existent run returns 404."""
    res = client.get("/api/research/runs/nonexistent_run_9999/status")
    assert res.status_code == 404

def test_unknown_stream_returns_404():
    """Test that streaming progress of a non-existent run returns 404."""
    res = client.get("/api/research/stream/nonexistent_run_9999")
    assert res.status_code == 404

@patch("services.discovery_service.DiscoveryService.execute_discovery_run", new_callable=AsyncMock)
def test_discover_returns_rapidly_without_awaiting_job(mock_execute):
    """Test that discover endpoint returns immediately with run_id without blocking on execution."""
    import time
    start = time.perf_counter()
    res = client.post("/api/research/discover", json={
        "topic": "rapid response test",
        "market": "US",
        "content_type": "LONG",
        "time_range": "30d"
    })
    duration = time.perf_counter() - start
    assert res.status_code == 200
    assert duration < 0.5  # Under 500ms
    assert "run_id" in res.json()

