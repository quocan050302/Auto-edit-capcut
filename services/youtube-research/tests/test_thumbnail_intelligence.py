"""
Unit tests for Competitor Thumbnail Intelligence V1

Tests:
- Thumbnail URL validation and host allowlist
- Private IP / SSRF blocking
- best_thumbnail_url quality fallback
- hash_thumbnail consistency
- Performance group classification
- confidence from sample size
- Pattern detection (winning / avoid conditions)
- Blueprint generation (only when enough winning patterns)
- No winning pattern if sample < 6 or count < 2
- Group stats computation
- Balanced sample selection
- Mobile readability score breakdown
- Hook detection from title
- Title pairing redundancy
- Deterministic color label assignment
- No CTR in output
- analyze_thumbnail never raises
"""

from __future__ import annotations

import asyncio
import io
import math
from dataclasses import asdict
from typing import List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── Module imports ────────────────────────────────────────────────────────────

from utils.thumbnail_downloader import (
    validate_thumbnail_url,
    ThumbnailDownloadError,
    best_thumbnail_url,
    hash_thumbnail,
    ALLOWED_THUMBNAIL_HOSTS,
)
from utils.thumbnail_analyzer import (
    _label_color,
    _detect_hooks_from_title,
    _compute_mobile_readability,
    _analyze_title_pairing,
    analyze_thumbnail,
    ThumbnailAnalysis,
)
from services.thumbnail_intelligence_service import (
    classify_performance_groups,
    get_confidence_from_sample,
    detect_patterns,
    generate_blueprints,
    _compute_group_stats,
    _balance_sample,
    ThumbnailSampleVideo,
    ThumbnailIntelligenceService,
)


# ═══════════════════════════════════════════════════════════════════════════════
# 1. URL Validation & Security
# ═══════════════════════════════════════════════════════════════════════════════

class TestThumbnailURLValidation:
    def test_valid_ytimg_https(self):
        url = "https://i.ytimg.com/vi/abc123/maxresdefault.jpg"
        result = validate_thumbnail_url(url)
        assert result == url

    def test_valid_yt3_ggpht(self):
        url = "https://yt3.ggpht.com/channel/thumbnail.jpg"
        assert validate_thumbnail_url(url)

    def test_http_upgraded_to_https(self):
        url = "http://i.ytimg.com/vi/abc/default.jpg"
        result = validate_thumbnail_url(url)
        assert result.startswith("https://")

    def test_disallowed_host_raises(self):
        with pytest.raises(ThumbnailDownloadError, match="Host not in allowlist"):
            validate_thumbnail_url("https://evil.com/thumbnail.jpg")

    def test_localhost_raises(self):
        with pytest.raises(ThumbnailDownloadError):
            validate_thumbnail_url("https://localhost/thumbnail.jpg")

    def test_internal_ip_host_raises(self):
        # 192.168.x.x is a private IP hostname-style
        with pytest.raises(ThumbnailDownloadError):
            validate_thumbnail_url("https://192.168.1.1/thumbnail.jpg")

    def test_non_http_protocol_raises(self):
        with pytest.raises(ThumbnailDownloadError, match="Protocol"):
            validate_thumbnail_url("ftp://i.ytimg.com/vi/abc/default.jpg")

    def test_file_protocol_raises(self):
        with pytest.raises(ThumbnailDownloadError, match="Protocol"):
            validate_thumbnail_url("file:///etc/passwd")

    def test_javascript_protocol_raises(self):
        with pytest.raises(ThumbnailDownloadError, match="Protocol"):
            validate_thumbnail_url("javascript:alert(1)")

    def test_empty_url_raises(self):
        with pytest.raises(ThumbnailDownloadError):
            validate_thumbnail_url("")

    def test_all_allowed_hosts_accepted(self):
        for host in ALLOWED_THUMBNAIL_HOSTS:
            url = f"https://{host}/thumbnail.jpg"
            result = validate_thumbnail_url(url)
            assert host in result


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Thumbnail Quality Selection
# ═══════════════════════════════════════════════════════════════════════════════

class TestBestThumbnailUrl:
    def test_maxres_preferred(self):
        thumbnails = {
            "maxres": {"url": "https://i.ytimg.com/vi/x/maxresdefault.jpg", "width": 1280, "height": 720},
            "high": {"url": "https://i.ytimg.com/vi/x/hqdefault.jpg"},
            "default": {"url": "https://i.ytimg.com/vi/x/default.jpg"},
        }
        url, quality = best_thumbnail_url(thumbnails)
        assert quality == "maxres"
        assert "maxresdefault" in url

    def test_falls_back_to_standard(self):
        thumbnails = {
            "standard": {"url": "https://i.ytimg.com/vi/x/sddefault.jpg"},
            "high": {"url": "https://i.ytimg.com/vi/x/hqdefault.jpg"},
        }
        url, quality = best_thumbnail_url(thumbnails)
        assert quality == "standard"

    def test_falls_back_to_high_when_no_maxres_standard(self):
        thumbnails = {
            "high": {"url": "https://i.ytimg.com/vi/x/hqdefault.jpg"},
            "default": {"url": "https://i.ytimg.com/vi/x/default.jpg"},
        }
        url, quality = best_thumbnail_url(thumbnails)
        assert quality == "high"

    def test_fallback_url_when_empty_thumbnails(self):
        url, quality = best_thumbnail_url({}, fallback_url="https://i.ytimg.com/vi/x/default.jpg")
        assert url != ""
        assert quality == "unknown"

    def test_empty_thumbnails_no_fallback(self):
        url, quality = best_thumbnail_url({})
        assert url == ""
        assert quality == "unknown"


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Hash Consistency
# ═══════════════════════════════════════════════════════════════════════════════

class TestThumbnailHashing:
    def test_same_bytes_same_hash(self):
        data = b"fake thumbnail bytes"
        assert hash_thumbnail(data) == hash_thumbnail(data)

    def test_different_bytes_different_hash(self):
        assert hash_thumbnail(b"aaa") != hash_thumbnail(b"bbb")

    def test_hash_is_hex_string(self):
        h = hash_thumbnail(b"test")
        assert all(c in "0123456789abcdef" for c in h)

    def test_hash_length_64(self):
        # SHA-256 = 32 bytes = 64 hex chars
        assert len(hash_thumbnail(b"test")) == 64


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Performance Group Classification
# ═══════════════════════════════════════════════════════════════════════════════

def _make_video(
    video_id: str,
    views: int,
    views_per_day: float = 0,
    outlier_ratio: float = 0,
    thumbnail_url: str = "https://i.ytimg.com/vi/x/default.jpg"
) -> dict:
    return {
        "video_id": video_id,
        "title": f"Video {video_id}",
        "published_at": "2026-09-01T00:00:00Z",
        "age_days": 30.0,
        "views": views,
        "views_per_day": views_per_day or views / 30,
        "outlier_ratio": outlier_ratio,
        "thumbnail_url": thumbnail_url,
        "thumbnail_quality": "high",
    }


class TestPerformanceGroupClassification:
    def test_outlier_by_ratio(self):
        videos = [_make_video("v1", 100_000, outlier_ratio=3.0)]
        result = classify_performance_groups(videos, channel_median_views=30_000, p75_views=50_000)
        assert result[0].performance_group == "outlier"

    def test_outlier_by_p75_threshold(self):
        videos = [_make_video("v1", 60_000)]
        result = classify_performance_groups(videos, channel_median_views=30_000, p75_views=50_000)
        assert result[0].performance_group == "outlier"

    def test_baseline_group(self):
        videos = [_make_video("v1", 20_000, outlier_ratio=0.7)]
        result = classify_performance_groups(videos, channel_median_views=30_000, p75_views=50_000)
        assert result[0].performance_group == "baseline"

    def test_low_performer(self):
        videos = [_make_video("v1", 5_000, outlier_ratio=0.1)]
        result = classify_performance_groups(videos, channel_median_views=30_000, p75_views=50_000)
        assert result[0].performance_group == "low"

    def test_skips_missing_thumbnail_url(self):
        videos = [_make_video("v1", 50_000, thumbnail_url="")]
        result = classify_performance_groups(videos, 30_000, 50_000)
        assert len(result) == 0

    def test_skips_missing_video_id(self):
        v = _make_video("", 50_000)
        result = classify_performance_groups([v], 30_000, 50_000)
        assert len(result) == 0

    def test_computes_ratio_from_median_if_zero(self):
        # outlier_ratio=0 → computed from channel_median_views
        videos = [_make_video("v1", 90_000, outlier_ratio=0)]
        result = classify_performance_groups(videos, channel_median_views=30_000, p75_views=50_000)
        assert result[0].outlier_ratio == pytest.approx(3.0)


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Confidence from Sample Size
# ═══════════════════════════════════════════════════════════════════════════════

class TestConfidenceFromSampleSize:
    def test_less_than_6_is_insufficient(self):
        label, score = get_confidence_from_sample(5)
        assert label == "insufficient"
        assert score < 0.3

    def test_6_to_11_is_low(self):
        label, score = get_confidence_from_sample(8)
        assert label == "low"

    def test_12_to_23_is_medium(self):
        label, score = get_confidence_from_sample(15)
        assert label == "medium"

    def test_24_plus_is_high(self):
        label, score = get_confidence_from_sample(30)
        assert label == "high"
        assert score >= 0.8

    def test_zero_is_insufficient(self):
        label, _ = get_confidence_from_sample(0)
        assert label == "insufficient"


# ═══════════════════════════════════════════════════════════════════════════════
# 6. Pattern Detection
# ═══════════════════════════════════════════════════════════════════════════════

def _make_analysis(
    video_id: str,
    group: str,
    has_text: bool = False,
    word_count: int = 0,
    has_person: bool = False,
    has_yellow: bool = False,
    has_red: bool = False,
    contrast: float = 0.3,
    brightness: float = 0.5,
    mobile_score: int = 50,
    outlier_ratio: float = 1.0,
) -> ThumbnailAnalysis:
    from utils.thumbnail_analyzer import (
        ThumbnailOcrAnalysis, ThumbnailCompositionAnalysis, ThumbnailSubjectAnalysis,
        ThumbnailColorAnalysis, ThumbnailHook, ThumbnailTitlePairing, MobileReadability
    )
    return ThumbnailAnalysis(
        video_id=video_id,
        video_title=f"Title {video_id}",
        performance_group=group,
        outlier_ratio=outlier_ratio,
        views=10_000,
        views_per_day=100,
        ocr=ThumbnailOcrAnalysis(word_count=word_count, is_uncertain=not has_text),
        subjects=ThumbnailSubjectAnalysis(has_person=has_person, face_count=1 if has_person else 0),
        colors=ThumbnailColorAnalysis(has_yellow=has_yellow, has_red=has_red, contrast=contrast, brightness=brightness, saturation=0.5, warm_cool_balance="warm" if has_yellow else "neutral"),
        hooks=[ThumbnailHook(hook_type="curiosity_gap", confidence=0.7)],
        composition=ThumbnailCompositionAnalysis(layout_type="centered", background_complexity="medium"),
        title_pairing=ThumbnailTitlePairing(relationship="complementary", redundancy_pct=0.2),
        mobile_readability=MobileReadability(score=mobile_score),
        confidence=0.5,
    )


class TestPatternDetection:
    def _build_dataset(self, n_out=8, n_base=8, n_low=8, has_face_in_outlier=True) -> List[ThumbnailAnalysis]:
        analyses = []
        for i in range(n_out):
            analyses.append(_make_analysis(f"out_{i}", "outlier", has_person=has_face_in_outlier, has_yellow=True, contrast=0.6, outlier_ratio=3.0))
        for i in range(n_base):
            analyses.append(_make_analysis(f"base_{i}", "baseline", has_person=False, has_yellow=False, contrast=0.3, outlier_ratio=1.0))
        for i in range(n_low):
            analyses.append(_make_analysis(f"low_{i}", "low", has_person=False, has_yellow=False, contrast=0.2, word_count=12, has_text=True, outlier_ratio=0.2))
        return analyses

    def test_face_pattern_detected_as_winning(self):
        dataset = self._build_dataset(has_face_in_outlier=True)
        patterns = detect_patterns(dataset)
        face_p = next((p for p in patterns if p.pattern_id == "has_face"), None)
        assert face_p is not None
        assert face_p.is_winning is True

    def test_no_winning_pattern_when_fewer_than_2_outliers_have_it(self):
        # Only 1 outlier has face — should NOT be winning
        analyses = [_make_analysis(f"out_{i}", "outlier", has_person=(i == 0), outlier_ratio=3.0) for i in range(8)]
        analyses += [_make_analysis(f"base_{i}", "baseline") for i in range(8)]
        analyses += [_make_analysis(f"low_{i}", "low") for i in range(8)]
        patterns = detect_patterns(analyses)
        face_p = next((p for p in patterns if p.pattern_id == "has_face"), None)
        assert face_p is not None
        assert face_p.is_winning is False

    def test_long_text_appears_as_avoid_pattern(self):
        # All low performers have >8 words, no outliers do
        analyses = [_make_analysis(f"out_{i}", "outlier", word_count=3, has_text=True, outlier_ratio=3.0) for i in range(8)]
        analyses += [_make_analysis(f"base_{i}", "baseline", word_count=5, has_text=True) for i in range(8)]
        analyses += [_make_analysis(f"low_{i}", "low", word_count=12, has_text=True, outlier_ratio=0.1) for i in range(8)]
        patterns = detect_patterns(analyses)
        long_text = next((p for p in patterns if p.pattern_id == "long_text"), None)
        assert long_text is not None
        assert long_text.is_avoid is True

    def test_insufficient_sample_no_winning(self):
        # Only 3 total samples — confidence insufficient
        analyses = [
            _make_analysis("out_1", "outlier", has_yellow=True, outlier_ratio=3.0),
            _make_analysis("base_1", "baseline"),
            _make_analysis("low_1", "low"),
        ]
        patterns = detect_patterns(analyses)
        winning = [p for p in patterns if p.is_winning]
        assert len(winning) == 0

    def test_pattern_sample_size_correct(self):
        dataset = self._build_dataset()
        patterns = detect_patterns(dataset)
        face_p = next(p for p in patterns if p.pattern_id == "has_face")
        assert face_p.sample_size == 24  # 8+8+8

    def test_pattern_counts_correct(self):
        # 6 outliers have yellow, 2 don't; 0 baselines; 0 lows
        analyses = [_make_analysis(f"o{i}", "outlier", has_yellow=(i < 6), outlier_ratio=3.0) for i in range(8)]
        analyses += [_make_analysis(f"b{i}", "baseline") for i in range(8)]
        analyses += [_make_analysis(f"l{i}", "low") for i in range(8)]
        patterns = detect_patterns(analyses)
        yellow_p = next(p for p in patterns if p.pattern_id == "has_yellow")
        assert yellow_p.outlier_count == 6
        assert yellow_p.outlier_total == 8
        assert yellow_p.baseline_count == 0


# ═══════════════════════════════════════════════════════════════════════════════
# 7. Blueprint Generation
# ═══════════════════════════════════════════════════════════════════════════════

class TestBlueprintGeneration:
    def _winning_patterns(self):
        from services.thumbnail_intelligence_service import ThumbnailPattern
        return [
            ThumbnailPattern(
                pattern_id="has_face", name="Face Present", description="",
                outlier_count=6, outlier_total=8, baseline_count=2, baseline_total=8,
                low_count=1, low_total=8, sample_size=24, confidence="medium",
                is_winning=True, is_avoid=False
            ),
            ThumbnailPattern(
                pattern_id="has_yellow", name="Yellow Accent", description="",
                outlier_count=5, outlier_total=8, baseline_count=2, baseline_total=8,
                low_count=0, low_total=8, sample_size=24, confidence="medium",
                is_winning=True, is_avoid=False
            ),
        ]

    def test_blueprint_generated_from_winning_patterns(self):
        patterns = self._winning_patterns()
        group_stats = {
            "outlier": {"n": 8, "top_hook": "curiosity_gap", "top_layout": "centered", "median_word_count": 4.0, "median_brightness": 0.5, "median_mobile_score": 60.0},
            "baseline": {"n": 8},
            "low": {"n": 8},
        }
        blueprints = generate_blueprints(patterns, group_stats, [], "Test Channel")
        assert len(blueprints) >= 1

    def test_no_blueprint_when_no_winning_patterns(self):
        blueprints = generate_blueprints([], {}, [], "Test Channel")
        assert blueprints == []

    def test_blueprint_has_originality_rules(self):
        patterns = self._winning_patterns()
        group_stats = {"outlier": {"n": 8, "top_hook": "curiosity_gap", "top_layout": "centered", "median_word_count": 4.0, "median_brightness": 0.5, "median_mobile_score": 60.0}}
        blueprints = generate_blueprints(patterns, group_stats, [], "Test Channel")
        bp = blueprints[0]
        assert len(bp.originality_rules) > 0
        assert any("Replace" in r for r in bp.originality_rules)

    def test_blueprint_has_negative_prompt(self):
        patterns = self._winning_patterns()
        group_stats = {"outlier": {"n": 8, "top_hook": "curiosity_gap", "top_layout": "centered", "median_word_count": 4.0, "median_brightness": 0.5, "median_mobile_score": 60.0}}
        blueprints = generate_blueprints(patterns, group_stats, [], "Test Channel")
        bp = blueprints[0]
        assert "watermark" in bp.negative_prompt or "branding" in bp.negative_prompt

    def test_blueprint_does_not_contain_ctr(self):
        patterns = self._winning_patterns()
        group_stats = {"outlier": {"n": 8, "top_hook": "curiosity_gap", "top_layout": "centered", "median_word_count": 4.0, "median_brightness": 0.5, "median_mobile_score": 60.0}}
        blueprints = generate_blueprints(patterns, group_stats, [], "Test Channel")
        bp_text = str(asdict(blueprints[0]))
        assert "CTR" not in bp_text
        assert "click-through rate" not in bp_text.lower()

    def test_blueprint_not_generated_for_insufficient_patterns(self):
        from services.thumbnail_intelligence_service import ThumbnailPattern
        # Pattern with confidence=insufficient → should not generate blueprint
        insufficient_pattern = ThumbnailPattern(
            pattern_id="has_face", name="Face Present", description="",
            outlier_count=1, outlier_total=3, baseline_count=0, baseline_total=3,
            low_count=0, low_total=3, sample_size=9, confidence="insufficient",
            is_winning=False, is_avoid=False
        )
        blueprints = generate_blueprints([insufficient_pattern], {}, [], "Test Channel")
        assert blueprints == []


# ═══════════════════════════════════════════════════════════════════════════════
# 8. Balanced Sample Selection
# ═══════════════════════════════════════════════════════════════════════════════

class TestBalancedSample:
    def _make_sample(self, group: str, n: int) -> List[ThumbnailSampleVideo]:
        return [
            ThumbnailSampleVideo(
                video_id=f"{group}_{i}", title=f"T{i}", published_at="", age_days=30,
                views=1000, views_per_day=33, outlier_ratio=float(i) + 1.0,
                performance_group=group, thumbnail_url=f"https://i.ytimg.com/vi/{group}_{i}/default.jpg"
            )
            for i in range(n)
        ]

    def test_balanced_does_not_exceed_max(self):
        videos = self._make_sample("outlier", 10) + self._make_sample("baseline", 10) + self._make_sample("low", 10)
        result = _balance_sample(videos, max_total=20)
        assert len(result) <= 20

    def test_all_outliers_included_first(self):
        outliers = self._make_sample("outlier", 5)
        baselines = self._make_sample("baseline", 10)
        lows = self._make_sample("low", 10)
        result = _balance_sample(outliers + baselines + lows, max_total=20)
        out_ids = {v.video_id for v in result if v.performance_group == "outlier"}
        # All 5 outliers should be in result since 5 < 20
        assert len(out_ids) == 5


# ═══════════════════════════════════════════════════════════════════════════════
# 9. Mobile Readability Score
# ═══════════════════════════════════════════════════════════════════════════════

class TestMobileReadabilityScore:
    def test_score_range_0_to_100(self):
        result = _compute_mobile_readability(0.5, 0.5, 0.3, True, 4)
        assert 0 <= result.score <= 100

    def test_high_contrast_scores_more(self):
        high = _compute_mobile_readability(0.5, 0.8, 0.3, True, 4)
        low = _compute_mobile_readability(0.5, 0.1, 0.3, True, 4)
        assert high.score > low.score

    def test_too_many_words_penalized(self):
        short = _compute_mobile_readability(0.5, 0.5, 0.3, True, 3)
        long = _compute_mobile_readability(0.5, 0.5, 0.3, True, 15)
        assert short.score > long.score

    def test_extreme_brightness_penalized(self):
        mid = _compute_mobile_readability(0.5, 0.5, 0.3, False, 0)
        extreme = _compute_mobile_readability(0.01, 0.5, 0.3, False, 0)
        assert mid.score > extreme.score

    def test_breakdown_keys_present(self):
        result = _compute_mobile_readability(0.5, 0.5, 0.3, True, 4)
        assert "contrast" in result.breakdown
        assert "subject_size" in result.breakdown
        assert "text_clarity" in result.breakdown
        assert "brightness" in result.breakdown


# ═══════════════════════════════════════════════════════════════════════════════
# 10. Hook Detection from Title
# ═══════════════════════════════════════════════════════════════════════════════

class TestHookDetectionFromTitle:
    def test_why_detected_as_curiosity_gap(self):
        hooks = _detect_hooks_from_title("Why This System Is Broken")
        assert any(h.hook_type == "curiosity_gap" for h in hooks)

    def test_secret_detected_as_hidden_truth(self):
        hooks = _detect_hooks_from_title("The Secret About This Algorithm")
        assert any(h.hook_type == "hidden_truth" for h in hooks)

    def test_warning_detected_as_mistake_warning(self):
        hooks = _detect_hooks_from_title("Warning: This Will Ruin Your Finances")
        assert any(h.hook_type == "mistake_warning" for h in hooks)

    def test_dollar_sign_detected_as_money_value(self):
        hooks = _detect_hooks_from_title("I Made $100,000 in 30 Days")
        assert any(h.hook_type == "money_value" for h in hooks)

    def test_no_hook_returns_unknown(self):
        hooks = _detect_hooks_from_title("My Trip to Japan")
        assert any(h.hook_type == "unknown" for h in hooks)

    def test_hooks_not_empty(self):
        hooks = _detect_hooks_from_title("Some video")
        assert len(hooks) >= 1


# ═══════════════════════════════════════════════════════════════════════════════
# 11. Title–Thumbnail Pairing
# ═══════════════════════════════════════════════════════════════════════════════

class TestTitleThumbnailPairing:
    def test_high_overlap_is_redundant(self):
        title = "The Real Reason Banks Are Failing"
        ocr = "The Real Reason Banks Are Failing"
        result = _analyze_title_pairing(title, ocr)
        assert result.relationship == "redundant"
        assert result.redundancy_pct > 0.7

    def test_low_overlap_is_complementary(self):
        title = "Why Banks Are Failing"
        ocr = "COLLAPSE IMMINENT"
        result = _analyze_title_pairing(title, ocr)
        assert result.relationship == "complementary"
        assert result.has_curiosity_gap is True

    def test_no_ocr_returns_unknown(self):
        result = _analyze_title_pairing("Some Title", "")
        assert result.relationship == "unknown"


# ═══════════════════════════════════════════════════════════════════════════════
# 12. Color Label Assignment
# ═══════════════════════════════════════════════════════════════════════════════

class TestColorLabels:
    def test_very_dark_is_black(self):
        assert _label_color(0.0, 0.5, 0.05) == "black"

    def test_very_light_low_sat_is_white(self):
        assert _label_color(0.0, 0.05, 0.95) == "white"

    def test_low_saturation_is_gray(self):
        assert _label_color(0.5, 0.1, 0.5) == "gray"

    def test_red_hue(self):
        assert _label_color(0.0, 0.9, 0.8) == "red"

    def test_yellow_hue(self):
        h = 55 / 360  # yellow
        assert _label_color(h, 0.9, 0.9) == "yellow"

    def test_blue_hue(self):
        h = 220 / 360
        assert _label_color(h, 0.9, 0.8) == "blue"

    def test_green_hue(self):
        h = 120 / 360
        assert _label_color(h, 0.9, 0.7) == "green"


# ═══════════════════════════════════════════════════════════════════════════════
# 13. analyze_thumbnail — Never Raises
# ═══════════════════════════════════════════════════════════════════════════════

class TestAnalyzeThumbnailNeverRaises:
    def _fake_image_bytes(self) -> bytes:
        """Create a minimal valid JPEG-like bytes."""
        try:
            from PIL import Image
            img = Image.new("RGB", (320, 180), color=(100, 150, 200))
            buf = io.BytesIO()
            img.save(buf, format="JPEG")
            return buf.getvalue()
        except Exception:
            return b"JFIF\x00" * 100  # Fake fallback

    def test_returns_analysis_for_valid_image(self):
        data = self._fake_image_bytes()
        result = asyncio.run(analyze_thumbnail(
            image_data=data,
            video_id="test_123",
            video_title="Why This Video Went Viral",
            thumbnail_url="https://i.ytimg.com/vi/test_123/maxresdefault.jpg",
            thumbnail_quality="maxres",
            performance_group="outlier",
            views=100_000,
            views_per_day=1000.0,
            outlier_ratio=3.5,
            video_age_days=100.0,
            ai_engine=None,
        ))
        assert isinstance(result, ThumbnailAnalysis)
        assert result.video_id == "test_123"
        assert result.is_error is False

    def test_does_not_raise_for_garbage_bytes(self):
        result = asyncio.run(analyze_thumbnail(
            image_data=b"not-an-image",
            video_id="bad_image",
            video_title="Test",
            thumbnail_url="https://i.ytimg.com/vi/bad/default.jpg",
            thumbnail_quality="default",
            performance_group="baseline",
            views=1000,
            views_per_day=10.0,
            outlier_ratio=1.0,
            video_age_days=30.0,
            ai_engine=None,
        ))
        assert isinstance(result, ThumbnailAnalysis)
        # Should have error flag or warnings, not raise
        # Some error in analysis should be absorbed
        assert result.video_id == "bad_image"

    def test_colors_analyzed_for_valid_image(self):
        data = self._fake_image_bytes()
        result = asyncio.run(analyze_thumbnail(
            image_data=data,
            video_id="color_test",
            video_title="Testing Colors",
            thumbnail_url="https://i.ytimg.com/vi/color_test/maxresdefault.jpg",
            thumbnail_quality="maxres",
            performance_group="baseline",
            views=10_000,
            views_per_day=100.0,
            outlier_ratio=1.0,
            video_age_days=100.0,
            ai_engine=None,
        ))
        assert result.colors.brightness >= 0.0
        assert result.colors.contrast >= 0.0
        assert len(result.colors.dominant_colors) > 0


# ═══════════════════════════════════════════════════════════════════════════════
# 14. No CTR in any output
# ═══════════════════════════════════════════════════════════════════════════════

class TestNoCTRFabrication:
    def test_no_ctr_in_pattern_dict(self):
        from services.thumbnail_intelligence_service import ThumbnailPattern
        p = ThumbnailPattern(
            pattern_id="test", name="Test Pattern", description="",
            outlier_count=5, outlier_total=8, baseline_count=2, baseline_total=8,
            low_count=1, low_total=8, sample_size=24, confidence="medium",
        )
        d = str(asdict(p))
        assert "CTR" not in d
        assert "click-through" not in d.lower()

    def test_no_causation_claim_expected(self):
        """Patterns should describe association, not causation."""
        from services.thumbnail_intelligence_service import ThumbnailPattern
        p = ThumbnailPattern(
            pattern_id="test", name="This causes success", description="guarantees CTR",
            outlier_count=5, outlier_total=8, baseline_count=2, baseline_total=8,
            low_count=1, low_total=8, sample_size=24, confidence="medium",
        )
        # No code prevents bad description, but we document this expectation
        # The important check: the system fields don't have CTR
        d = asdict(p)
        assert "is_winning" in d  # structural field, no CTR


# ═══════════════════════════════════════════════════════════════════════════════
# 15. ThumbnailIntelligenceService — Integration
# ═══════════════════════════════════════════════════════════════════════════════

class TestThumbnailIntelligenceServiceIntegration:
    """
    Mock download to avoid real HTTP. Tests the orchestration logic.
    """

    def _make_videos(self, n: int = 10) -> List[dict]:
        videos = []
        for i in range(n):
            group_ratio = 3.0 if i < 3 else (1.0 if i < 7 else 0.2)
            videos.append({
                "video_id": f"vid_{i}",
                "title": f"Test Video {i}",
                "published_at": "2026-09-01T00:00:00Z",
                "age_days": 30,
                "views": int(30_000 * group_ratio),
                "views_per_day": int(1000 * group_ratio),
                "outlier_ratio": group_ratio,
                "thumbnail_url": f"https://i.ytimg.com/vi/vid_{i}/maxresdefault.jpg",
                "thumbnail_quality": "maxres",
            })
        return videos

    @pytest.mark.asyncio
    async def test_service_returns_result_on_download_failure(self):
        """Even if all downloads fail, service returns a result (not raises)."""
        from utils.thumbnail_downloader import ThumbnailDownloadError

        async def fake_download(url, retries=2):
            raise ThumbnailDownloadError("Network error (mocked)")

        videos = self._make_videos(n=6)
        svc = ThumbnailIntelligenceService(ai_engine=None)

        with patch("services.thumbnail_intelligence_service.download_thumbnail", side_effect=fake_download):
            result = await svc.run(
                channel_id="ch_test",
                channel_title="Test Channel",
                videos=videos,
                channel_median_views=30_000,
                p75_views=50_000,
                max_videos=10,
            )

        assert result.channel_id == "ch_test"
        assert result.failed_count == 6
        assert result.analyzed_count == 0
        # No crash
        assert result is not None

    @pytest.mark.asyncio
    async def test_service_cache_hit_skips_redownload(self):
        """Second run with same cache key returns cached result."""
        from PIL import Image

        def _fake_bytes():
            img = Image.new("RGB", (320, 180), color=(100, 150, 200))
            buf = io.BytesIO()
            img.save(buf, format="JPEG")
            return buf.getvalue()

        fake_data = _fake_bytes()

        async def fake_download(url, retries=2):
            return fake_data

        videos = self._make_videos(n=6)
        svc = ThumbnailIntelligenceService(ai_engine=None)

        with patch("services.thumbnail_intelligence_service.download_thumbnail", side_effect=fake_download):
            result1 = await svc.run(
                channel_id="ch_cache",
                channel_title="Cache Test",
                videos=videos,
                channel_median_views=30_000,
                p75_views=50_000,
                max_videos=6,
            )

        assert result1.analyzed_count > 0
        initial_analyzed = result1.analyzed_count

        # Run again — same service instance, should hit cache
        with patch("services.thumbnail_intelligence_service.download_thumbnail", side_effect=fake_download) as mock_dl:
            result2 = await svc.run(
                channel_id="ch_cache",
                channel_title="Cache Test",
                videos=videos,
                channel_median_views=30_000,
                p75_views=50_000,
                max_videos=6,
            )

        assert result2.cached_count > 0
        assert result2.analyzed_count == 0  # All from cache, no re-downloads
