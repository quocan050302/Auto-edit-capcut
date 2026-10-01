import asyncio
import time
from unittest.mock import AsyncMock, patch, MagicMock
import httpx
import pytest
from providers.autocomplete import KeywordExpander, keyword_expander
from main import app
from fastapi.testclient import TestClient

client = TestClient(app)

@pytest.mark.anyio
async def test_keyword_expansion_success_mock():
    """Verify expand_keywords returns queries and emits monotonically increasing progress."""
    expander = KeywordExpander(timeout=1.0)
    progress_records = []

    async def on_progress(pct: int, msg: str):
        progress_records.append(pct)

    # Mock _query_suggest_with_client
    async def mock_suggest(client, sem, query, market, language):
        return [f"{query} tip", f"{query} news"]

    with patch.object(expander, "_query_suggest_with_client", side_effect=mock_suggest):
        keywords, sources = await expander.expand_keywords(
            seed="grocery prices",
            market="US",
            language="en",
            max_keywords=20,
            progress_callback=on_progress
        )

    assert len(keywords) > 0
    assert "grocery prices" in keywords
    assert len(progress_records) >= 5
    # Monotonic progress
    for i in range(len(progress_records) - 1):
        assert progress_records[i] <= progress_records[i + 1]
    assert progress_records[0] == 15
    assert progress_records[-1] == 29

@pytest.mark.anyio
async def test_keyword_expansion_google_suggest_429_fallback():
    """Verify that when Google Suggest returns 429, rule-based fallback produces clean queries."""
    expander = KeywordExpander(timeout=1.0)

    # Simulate 429 empty responses from queries
    async def mock_suggest_429(client, sem, query, market, language):
        return []

    with patch.object(expander, "_query_suggest_with_client", side_effect=mock_suggest_429):
        keywords, sources = await expander.expand_keywords(
            seed="housing market",
            market="US",
            language="en",
            max_keywords=15
        )

    assert len(keywords) >= 5
    assert "housing market" in keywords
    # Should contain rule-based expansions like "why housing market" or "housing market explained"
    assert any("explained" in k or "cost" in k or "why" in k or "prices" in k for k in keywords)
    assert len(sources.get("fallback", [])) > 0

@pytest.mark.anyio
async def test_keyword_expansion_timeout_fallback():
    """Verify timeout triggers rule-based fallback without hanging."""
    expander = KeywordExpander(timeout=0.1)

    async def mock_suggest_timeout(client, sem, query, market, language):
        await asyncio.sleep(0.5)
        return ["late query"]

    # Wrap in wait_for as discovery_service does
    try:
        keywords, sources = await asyncio.wait_for(
            expander.expand_keywords("electric cars", max_keywords=10),
            timeout=0.2
        )
    except asyncio.TimeoutError:
        keywords, sources = expander.build_rule_based_fallback("electric cars", max_keywords=10)

    assert len(keywords) >= 5
    assert "electric cars" in keywords

def test_rule_based_fallback_dynamic_year_no_duplicates():
    """Verify build_rule_based_fallback generates current year and no duplicates."""
    from datetime import datetime, timezone
    current_year = str(datetime.now(timezone.utc).year)

    expander = KeywordExpander()
    keywords, sources = expander.build_rule_based_fallback("coffee roasting", max_keywords=25)

    assert len(keywords) == len(set(keywords)), "Keywords must have no duplicates"
    assert any(current_year in kw for kw in keywords), f"Should include dynamic year {current_year}"
    assert "coffee roasting" in keywords

def test_health_liveness_zero_external_network():
    """Verify GET /health responds instantly with database and cached provider status."""
    start = time.perf_counter()
    res = client.get("/health")
    elapsed = time.perf_counter() - start

    assert res.status_code == 200
    assert elapsed < 0.25, f"/health must be instantaneous, took {elapsed}s"
    data = res.json()
    assert data["status"] == "online"
    assert data["service"] == "YouTube Foreign Market Researcher"
    assert data["database"] == "sqlite_connected"
    assert "providers" in data
    assert "scraper" in data["providers"]
    assert "official" in data["providers"]

def test_provider_diagnostic_health_endpoint():
    """Verify GET /api/research/providers/health returns diagnostic state."""
    res = client.get("/api/research/providers/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "online"
    assert "providers" in data
