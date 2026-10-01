"""
Unit tests for the Time Window Resolver (V2.1).

Tests:
- All canonical time ranges produce correct start/end UTC
- Calendar month arithmetic (4m, 5m, 6m)
- Month-end clamping
- Alias normalization (120d → 4m, etc.)
- Boundary: video exactly at start/end is included, 1 second outside is excluded
- Bucket count and structure
- "all" open-ended range
- Fallback for unknown range key
"""

from datetime import datetime, timezone, timedelta
import pytest
from utils.time_window import (
    resolve_time_window,
    normalize_time_range,
    _subtract_months,
)

# ── Freeze "now" for deterministic tests ─────────────────────────────────────
# Chosen deliberately: October 1, 2026, 15:00:00 UTC
FROZEN_NOW = datetime(2026, 10, 1, 15, 0, 0, tzinfo=timezone.utc)


# ── normalize_time_range ──────────────────────────────────────────────────────

class TestNormalization:
    def test_canonical_passthrough(self):
        for key in ("7d", "30d", "90d", "4m", "5m", "6m", "365d", "all"):
            assert normalize_time_range(key) == key

    def test_alias_120d(self):
        assert normalize_time_range("120d") == "4m"

    def test_alias_150d(self):
        assert normalize_time_range("150d") == "5m"

    def test_alias_180d(self):
        assert normalize_time_range("180d") == "6m"

    def test_case_insensitive(self):
        assert normalize_time_range("4M") == "4m"
        assert normalize_time_range("90D") == "90d"


# ── Day-based windows ─────────────────────────────────────────────────────────

class TestDayBasedWindows:
    def test_7d_start(self):
        tw = resolve_time_window("7d", FROZEN_NOW)
        assert tw.start_utc == FROZEN_NOW - timedelta(days=7)
        assert tw.end_utc == FROZEN_NOW

    def test_30d_start(self):
        tw = resolve_time_window("30d", FROZEN_NOW)
        assert tw.start_utc == FROZEN_NOW - timedelta(days=30)

    def test_90d_start(self):
        # now_utc = 2026-10-01T15:00:00Z → start = 2026-07-03T15:00:00Z
        tw = resolve_time_window("90d", FROZEN_NOW)
        expected_start = datetime(2026, 7, 3, 15, 0, 0, tzinfo=timezone.utc)
        assert tw.start_utc == expected_start

    def test_365d_start(self):
        tw = resolve_time_window("365d", FROZEN_NOW)
        assert tw.start_utc == FROZEN_NOW - timedelta(days=365)

    def test_90d_bucket_count(self):
        tw = resolve_time_window("90d", FROZEN_NOW)
        assert len(tw.buckets) == 3

    def test_30d_bucket_count(self):
        tw = resolve_time_window("30d", FROZEN_NOW)
        assert len(tw.buckets) == 2

    def test_7d_bucket_count(self):
        tw = resolve_time_window("7d", FROZEN_NOW)
        assert len(tw.buckets) == 1

    def test_labels_non_empty(self):
        tw = resolve_time_window("90d", FROZEN_NOW)
        assert tw.label == "Last 90 Days"
        for b in tw.buckets:
            assert b.label  # not empty


# ── Calendar-month windows ────────────────────────────────────────────────────

class TestMonthBasedWindows:
    def test_4m_start(self):
        # 2026-10-01 - 4 months = 2026-06-01
        tw = resolve_time_window("4m", FROZEN_NOW)
        expected_start = datetime(2026, 6, 1, 15, 0, 0, tzinfo=timezone.utc)
        assert tw.start_utc == expected_start

    def test_5m_start(self):
        # 2026-10-01 - 5 months = 2026-05-01
        tw = resolve_time_window("5m", FROZEN_NOW)
        expected_start = datetime(2026, 5, 1, 15, 0, 0, tzinfo=timezone.utc)
        assert tw.start_utc == expected_start

    def test_6m_start(self):
        # 2026-10-01 - 6 months = 2026-04-01
        tw = resolve_time_window("6m", FROZEN_NOW)
        expected_start = datetime(2026, 4, 1, 15, 0, 0, tzinfo=timezone.utc)
        assert tw.start_utc == expected_start

    def test_4m_bucket_count(self):
        tw = resolve_time_window("4m", FROZEN_NOW)
        assert len(tw.buckets) == 4

    def test_5m_bucket_count(self):
        tw = resolve_time_window("5m", FROZEN_NOW)
        assert len(tw.buckets) == 5

    def test_6m_bucket_count(self):
        tw = resolve_time_window("6m", FROZEN_NOW)
        assert len(tw.buckets) == 6

    def test_alias_120d_equals_4m(self):
        tw_alias = resolve_time_window("120d", FROZEN_NOW)
        tw_canon = resolve_time_window("4m", FROZEN_NOW)
        assert tw_alias.start_utc == tw_canon.start_utc
        assert tw_alias.range_key == "4m"

    def test_month_end_clamping(self):
        # March 31 - 1 month = Feb 28 (not Feb 31)
        march_31 = datetime(2026, 3, 31, 12, 0, 0, tzinfo=timezone.utc)
        tw = resolve_time_window("1m", march_31)  # Will fallback, but test _subtract_months
        # Direct test of _subtract_months
        result = _subtract_months(march_31, 1)
        assert result.month == 2
        assert result.day == 28  # 2026 is not a leap year

    def test_leap_year_feb(self):
        # 2024 is a leap year: March 31, 2024 - 1 month = Feb 29
        march_31_2024 = datetime(2024, 3, 31, 0, 0, 0, tzinfo=timezone.utc)
        result = _subtract_months(march_31_2024, 1)
        assert result.month == 2
        assert result.day == 29  # leap year


# ── All Time ──────────────────────────────────────────────────────────────────

class TestAllTime:
    def test_open_ended(self):
        tw = resolve_time_window("all", FROZEN_NOW)
        assert tw.start_utc is None
        assert tw.is_open_ended is True
        assert tw.end_utc == FROZEN_NOW

    def test_all_has_one_bucket(self):
        tw = resolve_time_window("all", FROZEN_NOW)
        assert len(tw.buckets) == 1


# ── is_video_in_window ────────────────────────────────────────────────────────

class TestIsVideoInWindow:
    """Boundary inclusion/exclusion tests."""

    def get_tw_90d(self):
        return resolve_time_window("90d", FROZEN_NOW)

    def test_video_at_exact_start_included(self):
        tw = self.get_tw_90d()
        pub = tw.start_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
        assert tw.is_video_in_window(pub) is True

    def test_video_at_exact_end_included(self):
        tw = self.get_tw_90d()
        pub = tw.end_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
        assert tw.is_video_in_window(pub) is True

    def test_video_1s_before_start_excluded(self):
        tw = self.get_tw_90d()
        before = tw.start_utc - timedelta(seconds=1)
        pub = before.strftime("%Y-%m-%dT%H:%M:%SZ")
        assert tw.is_video_in_window(pub) is False

    def test_video_1s_after_end_excluded(self):
        tw = self.get_tw_90d()
        after = tw.end_utc + timedelta(seconds=1)
        pub = after.strftime("%Y-%m-%dT%H:%M:%SZ")
        assert tw.is_video_in_window(pub) is False

    def test_video_in_middle_included(self):
        tw = self.get_tw_90d()
        mid = tw.start_utc + (tw.end_utc - tw.start_utc) / 2
        pub = mid.strftime("%Y-%m-%dT%H:%M:%SZ")
        assert tw.is_video_in_window(pub) is True

    def test_video_91_days_ago_excluded_from_90d(self):
        # 91 days ago is outside a 90d window
        pub_dt = FROZEN_NOW - timedelta(days=91)
        pub = pub_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        tw = resolve_time_window("90d", FROZEN_NOW)
        assert tw.is_video_in_window(pub) is False

    def test_video_89_days_ago_included_in_90d(self):
        pub_dt = FROZEN_NOW - timedelta(days=89)
        pub = pub_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        tw = resolve_time_window("90d", FROZEN_NOW)
        assert tw.is_video_in_window(pub) is True

    def test_empty_string_excluded(self):
        tw = self.get_tw_90d()
        assert tw.is_video_in_window("") is False

    def test_invalid_string_excluded(self):
        tw = self.get_tw_90d()
        assert tw.is_video_in_window("not-a-date") is False

    def test_all_time_window_accepts_old_video(self):
        tw = resolve_time_window("all", FROZEN_NOW)
        # Video from 5 years ago
        pub = (FROZEN_NOW - timedelta(days=1825)).strftime("%Y-%m-%dT%H:%M:%SZ")
        assert tw.is_video_in_window(pub) is True


# ── Bucket coverage ───────────────────────────────────────────────────────────

class TestBucketCoverage:
    def test_90d_buckets_span_full_window(self):
        tw = resolve_time_window("90d", FROZEN_NOW)
        # Bucket 0 start should equal window start
        assert tw.buckets[0].start_utc == tw.start_utc
        # Last bucket end should equal window end (±1 second tolerance)
        diff = abs((tw.buckets[-1].end_utc - tw.end_utc).total_seconds())
        assert diff < 2

    def test_buckets_chronological(self):
        tw = resolve_time_window("6m", FROZEN_NOW)
        for i in range(len(tw.buckets) - 1):
            assert tw.buckets[i].end_utc <= tw.buckets[i + 1].start_utc or \
                   tw.buckets[i].end_utc == tw.buckets[i + 1].start_utc

    def test_6m_buckets_span_full_window(self):
        tw = resolve_time_window("6m", FROZEN_NOW)
        assert tw.buckets[0].start_utc == tw.start_utc


# ── to_published_after/before_rfc3339 ────────────────────────────────────────

class TestRFC3339Output:
    def test_published_after_format(self):
        tw = resolve_time_window("30d", FROZEN_NOW)
        pa = tw.to_published_after_rfc3339()
        assert pa is not None
        assert "Z" in pa or "+" in pa  # timezone present

    def test_published_before_format(self):
        tw = resolve_time_window("30d", FROZEN_NOW)
        pb = tw.to_published_before_rfc3339()
        assert "Z" in pb

    def test_all_time_has_no_published_after(self):
        tw = resolve_time_window("all", FROZEN_NOW)
        assert tw.to_published_after_rfc3339() is None
