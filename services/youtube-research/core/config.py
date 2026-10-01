import os
from pathlib import Path
from pydantic import BaseModel, Field

ROOT_DIR = Path(__file__).resolve().parent.parent.parent.parent
DATA_DIR = ROOT_DIR / "data"
LOGS_DIR = ROOT_DIR / "logs"

DATA_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "youtube-research.db"
SQLITE_URL = f"sqlite:///{DB_PATH}"

class ScoringWeights(BaseModel):
    demand: float = 0.20
    velocity: float = 0.20
    outlier: float = 0.20
    cross_channel: float = 0.10
    market_fit: float = 0.10
    freshness: float = 0.10
    competition: float = 0.10

class AppSettings(BaseModel):
    db_url: str = SQLITE_URL
    host: str = "127.0.0.1"
    port: int = 8765
    debug: bool = False
    
    # Provider Settings
    use_official_api: bool = False
    official_api_key: str = ""
    scraper_fallback: bool = True
    provider_priority: str = "scraper_first" # or official_first
    scraper_concurrency: int = 4
    request_timeout_seconds: float = 12.0
    max_retries: int = 3
    
    # Defaults
    default_market: str = "US"
    default_language: str = "en"
    default_time_range: str = "30d"
    default_content_type: str = "LONG"
    default_result_size: int = 50
    
    # AI Settings
    ai_provider: str = "disabled" # ollama, gemini, openai, anthropic, disabled
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3"
    cloud_ai_key: str = ""
    
    # Research Thresholds
    max_expanded_keywords: int = 25
    raw_video_limit: int = 150
    max_enrichment_videos: int = 50
    channel_baseline_size: int = 25
    snapshot_policy_hours: int = 6
    
    # Scoring
    scoring_weights: ScoringWeights = Field(default_factory=ScoringWeights)

settings = AppSettings()
