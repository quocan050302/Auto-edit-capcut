import pytest
from utils.parsers import (
    parse_view_count,
    parse_duration,
    parse_subscriber_count,
    calculate_age_days,
    approximate_published_date
)

def test_parse_view_count():
    assert parse_view_count("1.2M views") == 1_200_000
    assert parse_view_count("450K views") == 450_000
    assert parse_view_count("1,234,567 views") == 1_234_567
    assert parse_view_count("100 views") == 100
    assert parse_view_count("No views") == 0
    assert parse_view_count(None) == 0
    # Foreign locale signals
    assert parse_view_count("1,2 M de vues") == 1_200_000
    assert parse_view_count("450 Tsd. Aufrufe") == 450_000
    assert parse_view_count("12万 回視聴") == 120_000
    assert parse_view_count("조회수 1.2만회") == 12_000

def test_parse_duration():
    assert parse_duration("14:20") == 860
    assert parse_duration("1:02:30") == 3750
    assert parse_duration("0:45") == 45
    assert parse_duration("PT14M20S") == 860
    assert parse_duration("PT1H2M30S") == 3750
    assert parse_duration("") == 0
    assert parse_duration(None) == 0

def test_parse_subscriber_count():
    assert parse_subscriber_count("1.2M subscribers") == 1_200_000
    assert parse_subscriber_count("45.2K subscribers") == 45_200
    assert parse_subscriber_count("120 subscribers") == 120
    assert parse_subscriber_count(None) is None
    assert parse_subscriber_count("Subscribers hidden") is None

def test_calculate_age_days():
    # ISO string
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    three_days_ago = (now - timedelta(days=3)).isoformat()
    age = calculate_age_days(three_days_ago)
    assert 2.9 <= age <= 3.1

    # Safe minimum
    future_date = (now + timedelta(days=1)).isoformat()
    assert calculate_age_days(future_date) == 0.04
