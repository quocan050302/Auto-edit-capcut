import json
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

# Persisted settings file — stored alongside the DB
SETTINGS_FILE = DATA_DIR / "youtube-research-settings.json"

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
    provider_priority: str = "scraper_first"  # or official_first
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
    ai_provider: str = "disabled"  # ollama, gemini, openai, anthropic, disabled
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

    def save(self) -> None:
        """Persist mutable settings (excluding runtime-only fields) to disk."""
        try:
            persisted = {
                "use_official_api": self.use_official_api,
                "official_api_key": self.official_api_key,
                "scraper_fallback": self.scraper_fallback,
                "provider_priority": self.provider_priority,
                "default_market": self.default_market,
                "default_language": self.default_language,
                "default_time_range": self.default_time_range,
                "default_content_type": self.default_content_type,
                "default_result_size": self.default_result_size,
                "ai_provider": self.ai_provider,
                "ollama_base_url": self.ollama_base_url,
                "ollama_model": self.ollama_model,
                "cloud_ai_key": self.cloud_ai_key,
                "max_expanded_keywords": self.max_expanded_keywords,
                "raw_video_limit": self.raw_video_limit,
                "max_enrichment_videos": self.max_enrichment_videos,
                "channel_baseline_size": self.channel_baseline_size,
                "debug": self.debug,
                "scoring_weights": self.scoring_weights.model_dump(),
            }
            SETTINGS_FILE.write_text(json.dumps(persisted, indent=2), encoding="utf-8")
        except Exception as e:
            # Non-fatal — settings will just not persist across restarts
            import logging
            logging.getLogger("youtube_research").warning(f"[Config] Failed to save settings: {e}")

    def load(self) -> None:
        """Load persisted settings from disk if the file exists."""
        if not SETTINGS_FILE.exists():
            return
        try:
            data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            for key, value in data.items():
                if key == "scoring_weights" and isinstance(value, dict):
                    self.scoring_weights = ScoringWeights(**value)
                elif hasattr(self, key):
                    setattr(self, key, value)
        except Exception as e:
            import logging
            logging.getLogger("youtube_research").warning(f"[Config] Failed to load settings: {e}")


def _build_settings() -> AppSettings:
    s = AppSettings()
    s.load()
    return s

settings = _build_settings()
