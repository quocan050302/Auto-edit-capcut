import logging
import re
import sys
from pathlib import Path
from core.config import LOGS_DIR

LOG_FILE = LOGS_DIR / "youtube-research.log"

SENSITIVE_PATTERNS = [
    re.compile(r"(key=)[^&\s]+", re.IGNORECASE),
    re.compile(r"(Bearer\s+)[^\s]+", re.IGNORECASE),
    re.compile(r"(api[_-]?key[\"']?\s*[:=]\s*[\"'])[^\"']+", re.IGNORECASE),
]

def sanitize_message(msg: str) -> str:
    for pattern in SENSITIVE_PATTERNS:
        msg = pattern.sub(r"\1[REDACTED]", msg)
    return msg

class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        original = super().format(record)
        return sanitize_message(original)

def setup_logger(name: str = "youtube_research") -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    
    if not logger.handlers:
        c_handler = logging.StreamHandler(sys.stdout)
        f_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
        
        formatter = RedactingFormatter(
            "%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"
        )
        
        c_handler.setFormatter(formatter)
        f_handler.setFormatter(formatter)
        
        logger.addHandler(c_handler)
        logger.addHandler(f_handler)
        
    return logger

research_logger = setup_logger()
