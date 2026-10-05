import re
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any

def parse_view_count(raw: Optional[str]) -> int:
    if not raw:
        return 0
    clean = str(raw).strip().replace("\xa0", " ").lower()
    # Normalize European decimal comma (e.g. 1,2 M -> 1.2 M)
    clean = re.sub(r"(\d+),(\d{1,2})\s*([a-zA-Z万만])", r"\1.\2 \3", clean)
    # Remove thousands commas
    clean = re.sub(r",(?=\d{3})", "", clean)
    clean = clean.replace(",", "")
    
    # Try finding digits followed by suffix
    m_bill = re.search(r"([\d\.]+)\s*(?:b|mrd|ty|b views)", clean)
    if m_bill:
        try:
            return int(float(m_bill.group(1)) * 1_000_000_000)
        except ValueError:
            pass

    m_mill = re.search(r"([\d\.]+)\s*(?:m|mio|tr|triệu|m de vues|m views)", clean)
    if m_mill:
        try:
            return int(float(m_mill.group(1)) * 1_000_000)
        except ValueError:
            pass

    m_k = re.search(r"([\d\.]+)\s*(?:k|tsd|nghìn|k de vues|k views)", clean)
    if m_k:
        try:
            return int(float(m_k.group(1)) * 1_000)
        except ValueError:
            pass

    # Asian unit 万 (10,000)
    m_wan = re.search(r"([\d\.]+)\s*(?:万|만)", clean)
    if m_wan:
        try:
            return int(float(m_wan.group(1)) * 10_000)
        except ValueError:
            pass

    # Asian unit 亿 / 억 (100,000,000)
    m_yi = re.search(r"([\d\.]+)\s*(?:亿|억)", clean)
    if m_yi:
        try:
            return int(float(m_yi.group(1)) * 100_000_000)
        except ValueError:
            pass

    # Digits only
    digits = re.findall(r"\d+", clean)
    if digits:
        try:
            return int("".join(digits))
        except ValueError:
            return 0
            
    return 0

def parse_duration(raw: Optional[str]) -> int:
    if not raw:
        return 0
    clean = str(raw).strip().upper()
    
    # ISO 8601 e.g. PT1H2M30S or PT14M20S
    if clean.startswith("PT"):
        hours = re.search(r"(\d+)H", clean)
        mins = re.search(r"(\d+)M", clean)
        secs = re.search(r"(\d+)S", clean)
        h = int(hours.group(1)) if hours else 0
        m = int(mins.group(1)) if mins else 0
        s = int(secs.group(1)) if secs else 0
        return h * 3600 + m * 60 + s
        
    # Colon format: "1:23:45" or "14:20" or "0:45"
    parts = clean.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        elif len(parts) == 1:
            return int(parts[0])
    except ValueError:
        return 0
        
    return 0

def parse_subscriber_count(raw: Optional[str]) -> Optional[int]:
    if not raw:
        return None
    clean = str(raw).strip().replace("\xa0", " ").lower()
    clean = re.sub(r"(\d+),(\d{1,2})\s*([a-zA-Z万만])", r"\1.\2 \3", clean)
    clean = re.sub(r",(?=\d{3})", "", clean)
    clean = clean.replace(",", "")
    
    if any(k in clean for k in ["hidden", "no subscribers", "không có", "subscribers"]):
        pass

    m_mill = re.search(r"([\d\.]+)\s*(?:m|mio|tr|triệu)", clean)
    if m_mill:
        try:
            return int(float(m_mill.group(1)) * 1_000_000)
        except ValueError:
            pass

    m_k = re.search(r"([\d\.]+)\s*(?:k|tsd|nghìn)", clean)
    if m_k:
        try:
            return int(float(m_k.group(1)) * 1_000)
        except ValueError:
            pass

    m_wan = re.search(r"([\d\.]+)\s*(?:万|만)", clean)
    if m_wan:
        try:
            return int(float(m_wan.group(1)) * 10_000)
        except ValueError:
            pass

    digits = re.findall(r"\d+", clean)
    if digits:
        try:
            val = int("".join(digits))
            return val
        except ValueError:
            return None
            
    return None

def approximate_published_date(relative_str: Optional[str]) -> str:
    now = datetime.now(timezone.utc)
    if not relative_str:
        return now.isoformat()
        
    clean = relative_str.strip().lower()
    
    num_match = re.search(r"(\d+)", clean)
    num = int(num_match.group(1)) if num_match else 1
    
    if "second" in clean or "giây" in clean:
        delta = timedelta(seconds=num)
    elif "minute" in clean or "phút" in clean:
        delta = timedelta(minutes=num)
    elif "hour" in clean or "giờ" in clean:
        delta = timedelta(hours=num)
    elif "day" in clean or "ngày" in clean:
        delta = timedelta(days=num)
    elif "week" in clean or "tuần" in clean:
        delta = timedelta(weeks=num)
    elif "month" in clean or "tháng" in clean:
        delta = timedelta(days=num * 30.5)
    elif "year" in clean or "năm" in clean:
        delta = timedelta(days=num * 365)
    else:
        delta = timedelta(days=7)
        
    pub = now - delta
    return pub.isoformat()

def calculate_age_days(published_at_str: str) -> float:
    now = datetime.now(timezone.utc)
    try:
        # replace Z with +00:00 for python fromisoformat
        clean_str = published_at_str.replace("Z", "+00:00")
        pub = datetime.fromisoformat(clean_str)
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        diff = (now - pub).total_seconds() / 86400.0
        # Safe minimum age is ~1 hour (0.04 days) to prevent division by zero
        return max(diff, 0.04)
    except Exception:
        return 1.0


def parse_published_date_with_quality(raw_value: Optional[str]) -> Dict[str, Any]:
    """
    Parse published date and classify date quality.
    Does NOT default empty values to current time.
    Returns:
        {
            "published_at": datetime | None (in UTC),
            "date_quality": "VERIFIED" | "APPROXIMATED" | "UNKNOWN"
        }
    """
    if not raw_value or not str(raw_value).strip():
        return {"published_at": None, "date_quality": "UNKNOWN"}

    clean = str(raw_value).strip()

    # 1. Try ISO format (Official YouTube API returns RFC3339 / ISO format like 2024-05-12T10:30:00Z)
    if "T" in clean:
        try:
            iso_clean = clean.replace("Z", "+00:00")
            dt = datetime.fromisoformat(iso_clean)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            else:
                dt = dt.astimezone(timezone.utc)
            return {"published_at": dt, "date_quality": "VERIFIED"}
        except Exception:
            pass

    # 2. Try Relative Date approximation (e.g. "2 weeks ago", "3 days ago", "1 month ago")
    relative_keywords = [
        "ago", "second", "minute", "hour", "day", "week", "month", "year",
        "giây", "phút", "giờ", "ngày", "tuần", "tháng", "năm", "trước",
    ]
    low = clean.lower()
    if any(k in low for k in relative_keywords):
        try:
            approx_iso = approximate_published_date(clean)
            dt = datetime.fromisoformat(approx_iso.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            else:
                dt = dt.astimezone(timezone.utc)
            return {"published_at": dt, "date_quality": "APPROXIMATED"}
        except Exception:
            pass

    # 3. Try standard date patterns like YYYY-MM-DD
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d"):
        try:
            dt = datetime.strptime(clean, fmt).replace(tzinfo=timezone.utc)
            return {"published_at": dt, "date_quality": "VERIFIED"}
        except Exception:
            pass

    return {"published_at": None, "date_quality": "UNKNOWN"}

