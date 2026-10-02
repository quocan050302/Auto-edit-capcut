from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from core.config import settings

engine = create_engine(
    settings.db_url,
    connect_args={"check_same_thread": False},
    echo=False
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def _migrate_sqlite_columns():
    """Idempotently add new columns to SQLite tables if they do not exist."""
    from sqlalchemy import text
    columns_to_add = [
        ("similar_channel_runs", "best_available_channel_id", "VARCHAR(128)"),
        ("similar_channel_runs", "best_available_status", "VARCHAR(30)"),
        ("similar_channel_runs", "best_available_reason_json", "TEXT"),
        ("similar_channel_runs", "best_available_candidates_json", "TEXT"),
        ("similar_channel_runs", "recommendation_tier", "VARCHAR(30)"),
        ("similar_channel_runs", "discovery_diagnostics_json", "TEXT"),
        ("similar_channel_candidates", "recommendation_tier", "VARCHAR(30) DEFAULT 'MONITOR'"),
        ("similar_channel_candidates", "best_available_rank", "INTEGER"),
        ("similar_channel_candidates", "is_best_available", "BOOLEAN DEFAULT 0"),
        ("similar_channel_candidates", "qualification_gap_score", "FLOAT DEFAULT 0.0"),
        ("similar_channel_candidates", "unmet_criteria_json", "TEXT"),
        ("similar_channel_candidates", "window_coverage", "VARCHAR(30) DEFAULT 'UNKNOWN'"),
        ("similar_channel_candidates", "history_coverage", "VARCHAR(30) DEFAULT 'UNKNOWN'"),
        ("similar_channel_candidates", "date_quality", "VARCHAR(30) DEFAULT 'APPROXIMATED'"),
        ("similar_channel_candidates", "source_coverage", "FLOAT DEFAULT 0.0"),
        ("similar_channel_candidates", "candidate_precision", "FLOAT DEFAULT 0.0"),
        ("similar_channel_candidates", "median_title_similarity", "FLOAT DEFAULT 0.0"),
        ("similar_channel_candidates", "matched_terms_json", "TEXT"),
        ("similar_channel_candidates", "matched_entities_json", "TEXT"),
        ("similar_channel_candidates", "matched_clusters_json", "TEXT"),
        ("similar_channel_videos", "date_quality", "VARCHAR(30) DEFAULT 'APPROXIMATED'"),
    ]
    with engine.connect() as conn:
        for table, col, col_type in columns_to_add:
            try:
                res = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
                existing_cols = {row[1] for row in res}
                if existing_cols and col not in existing_cols:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}"))
                    conn.commit()
            except Exception:
                pass

def init_db():
    import models.entities
    Base.metadata.create_all(bind=engine)
    _migrate_sqlite_columns()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
