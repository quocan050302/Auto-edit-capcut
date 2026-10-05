import uuid
import pytest
from fastapi.testclient import TestClient
from main import app
from db.engine import SessionLocal, init_db
from repositories.research_repo import ResearchRepository
from models.entities import ResearchRun

init_db()
client = TestClient(app)

def test_health_endpoint():
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "online"
    assert data["service"] == "YouTube Foreign Market Researcher"
    assert "providers" in data

def test_settings_security():
    res = client.get("/api/research/settings")
    assert res.status_code == 200
    data = res.json()
    # Must NOT expose raw API key
    assert "official_api_key" not in data
    assert "has_official_api_key" in data
    assert "has_cloud_ai_key" in data

def test_repository_and_snapshot_policy():
    db = SessionLocal()
    try:
        repo = ResearchRepository(db)
        vid_id = f"vid_test_{uuid.uuid4().hex[:8]}"
        
        # Snapshot 1
        s1 = repo.add_snapshot_if_eligible(vid_id, 10_000, 500, 50, min_interval_hours=6)
        assert s1 is not None
        assert s1.view_count == 10_000

        # Snapshot 2 immediate (should be rejected by policy)
        s2 = repo.add_snapshot_if_eligible(vid_id, 10_500, 520, 52, min_interval_hours=6)
        assert s2 is None

        # Verify retrieval
        snaps = repo.get_video_snapshots(vid_id)
        assert len(snaps) == 1
    finally:
        db.close()

def test_saved_projects_flow():
    db = SessionLocal()
    try:
        repo = ResearchRepository(db)
        run_id = f"run_test_{uuid.uuid4().hex[:8]}"
        run = ResearchRun(
            id=run_id,
            topic="grocery prices",
            market="US",
            status="COMPLETED",
            stage="COMPLETED",
            videos_collected=45,
            raw_results_json='{"top_opportunity": {"keyword": "grocery inflation", "opportunity_score": 88.5}}'
        )
        repo.create_run(run)

        # Create saved project via API
        create_res = client.post(
            "/api/research/saved",
            json={
                "name": "US Grocery Inflation Project",
                "run_id": run_id,
                "seed_topic": "grocery prices",
                "market": "US",
                "content_type": "LONG",
                "time_range": "30d"
            }
        )
        assert create_res.status_code == 200
        proj = create_res.json()
        assert proj["name"] == "US Grocery Inflation Project"
        proj_id = proj["id"]

        # Rename project
        patch_res = client.patch(f"/api/research/saved/{proj_id}", json={"name": "Renamed Grocery Project"})
        assert patch_res.status_code == 200
        assert patch_res.json()["name"] == "Renamed Grocery Project"

        # Delete project
        del_res = client.delete(f"/api/research/saved/{proj_id}")
        assert del_res.status_code == 200
        assert del_res.json()["success"] is True
    finally:
        db.close()
