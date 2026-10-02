"""
Tests cho ThumbnailPromptService — kiểm tra tất cả acceptance criteria từ spec.
"""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _make_blueprint(mode="validated_winning", validated=True):
    return {
        "id": "bp_test",
        "name": "Test Blueprint",
        "use_when": "test",
        "target_hook": "curiosity_gap",
        "blueprint_mode": mode,
        "is_statistically_validated": validated,
        "fallback_reason": "" if validated else "observed only",
        "source_group": "outlier",
        "sample_summary": {},
        "limitations": [] if validated else ["Not statistically validated"],
        "based_on_pattern_ids": ["has_face"],
        "layout_description": "Split layout: subject left, text right",
        "subject_recipe": "One primary subject with visible face",
        "background_recipe": "Simple dark background",
        "text_recipe": "3-5 words max",
        "color_recipe": "High contrast palette",
        "lighting_recipe": "High contrast lighting",
        "hierarchy_recipe": "Subject -> Text -> Background",
        "title_pairing_recipe": "Curiosity gap",
        "overlay_text_formula": ["Short hook"],
        "image_prompt_template": "YouTube thumbnail. {background_recipe}. {subject_recipe}.",
        "negative_prompt": "watermark, blur, low quality",
        "evidence": ["10 outlier thumbnails show face+text pattern"],
        "confidence": "high",
        "originality_rules": ["Replace competitor's specific person", "Keep layout structure"],
    }


def _make_intel(analyses=None, patterns=None):
    if analyses is None:
        analyses = [
            {
                "video_id": f"vid_{i}",
                "video_title": f"Test Video {i}",
                "performance_group": "outlier" if i < 3 else "baseline",
                "views": 500000 if i < 3 else 50000,
                "outlier_ratio": 5.0 if i < 3 else 1.0,
                "ocr": {"text": "WHY COMMUNITIES", "word_count": 3, "line_count": 1, "has_text": True, "has_uppercase": True},
                "composition": {"layout_type": "right_subject_left_text", "background_complexity": "low"},
                "subjects": {"has_person": True, "has_proof_object": False},
                "colors": {"has_yellow": False, "contrast": 0.75},
                "hooks": [{"hook_type": "curiosity_gap", "confidence": 0.9}],
                "mobile_readability": {"score": 82},
            }
            for i in range(6)
        ]
    if patterns is None:
        patterns = [
            {
                "pattern_id": "has_face",
                "name": "Face Present",
                "description": "Outlier thumbnails predominantly show human face",
                "is_winning": True,
                "is_avoid": False,
                "confidence": "high",
            }
        ]
    return {
        "analyses": analyses,
        "patterns": patterns,
        "group_stats": {
            "outlier": {"n": 3, "top_hook": "curiosity_gap", "median_mobile_score": 82},
            "baseline": {"n": 3},
        },
        "blueprints": [_make_blueprint()],
        "limitations": [],
    }


def _make_ai_engine(return_dict=None):
    engine = MagicMock()
    engine.provider = "gemini"
    engine._cloud_model = "gemini-2.0-flash"
    if return_dict is None:
        # Build valid 5-variant response
        return_dict = {
            "analysis_summary": {
                "title_subject": "Community financial stability",
                "title_promise": "Viewer will learn why communities never go bankrupt",
                "viewer_tension": "Fear of financial instability",
                "recommended_hook": "curiosity_gap",
                "competitor_style_summary": "Right-subject-left-text, high contrast, face+text",
                "overlay_style_summary": "3-5 words, ALL CAPS, single or double line",
            },
            "variants": [
                _make_variant(label, title)
                for label, title in zip(
                    ["A", "B", "C", "D", "E"],
                    [
                        "NEVER BROKE / WHY?",
                        "THE PROOF",
                        "RICH VS POOR",
                        "THE RESULT",
                        "THEIR SECRET",
                    ],
                )
            ]
        }
    engine.generate_thumbnail_prompt_variants = AsyncMock(return_value=return_dict)
    return engine


def _make_variant(label, overlay):
    words = overlay.replace("/", "").split()
    parts = overlay.split(" / ")
    prompt = (
        f"YouTube thumbnail 16:9. Target resolution 3840x2160. Photorealistic photography style. "
        f"Option {label} visual concept for: Why These Communities Never Go Bankrupt. "
        f"Main subject occupies 45-60% of frame. Split layout with subject on right and text on left. "
        f"Simple dark background with high contrast. One primary human subject with visible face. "
        f"High contrast lighting separating foreground from background. "
        f'Render exactly this overlay text: Line 1: "{parts[0]}". '
        + (f'Line 2: "{parts[1]}".' if len(parts) > 1 else "") +
        f" Font: bold condensed sans. Color: #FFFFFF. Outline: #000000. Placement: upper_left. "
        f"Text must be readable at 120x67px thumbnail size. "
        f"Keep bottom-right 30% clear of critical content (YouTube duration badge). "
        f"All elements recognizable at mobile thumbnail size. "
        f"Do NOT copy competitor thumbnails. Replace subjects with topic-relevant alternatives. "
        f"No watermarks, no competitor logos, no extra text beyond specified overlay."
    )
    return {
        "id": f"variant_{label}",
        "option_label": label,
        "concept_name": f"Option {label} — Concept",
        "strategic_angle": f"Strategic angle for {label}",
        "title_interpretation": f"Title suggests: {label} concept",
        "overlay_text": {
            "line_1": parts[0],
            "line_2": parts[1] if len(parts) > 1 else None,
            "combined_text": overlay,
            "total_words": len(words),
            "capitalization": "ALL_CAPS",
            "text_color": "#FFFFFF",
            "outline_color": "#000000",
            "placement": "upper_left",
            "typography": "bold_condensed_sans",
        },
        "visual_concept": f"Visual concept for option {label}",
        "subject_direction": "One primary human subject. Do NOT copy specific individuals.",
        "composition_direction": "Split layout: subject right, text left",
        "background_direction": "Simple dark background with depth",
        "color_direction": "High contrast palette",
        "lighting_direction": "High contrast lighting",
        "mobile_readability_direction": "All elements readable at 120x67px",
        "title_thumbnail_relationship": "Thumbnail complements title without repeating it",
        "full_image_prompt": prompt,
        "negative_prompt": "watermark, blur, distorted faces, competitor logo, extra text",
        "competitor_traits_used": ["Face Present pattern", "Curiosity gap hook"],
        "evidence": ["3 outlier thumbnails analyzed"],
        "originality_changes": ["Replaced competitor face with topic-relevant person"],
        "why_it_works": f"Option {label} leverages curiosity_gap hook seen in competitor outliers",
        "warnings": [],
    }


# ── Test Class ─────────────────────────────────────────────────────────────────

class TestThumbnailPromptService:

    def _svc(self):
        from services.thumbnail_prompt_service import ThumbnailPromptService
        return ThumbnailPromptService()

    def _run(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    # Test 1 — Valid AI response
    def test_valid_ai_response(self):
        engine = _make_ai_engine()
        result = self._run(self._svc().generate_five_variants(
            title="Why These Communities Never Go Bankrupt",
            video_context="",
            channel_title="Test Channel",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        assert len(result.variants) == 5
        labels = [v.option_label for v in result.variants]
        assert sorted(labels) == ["A", "B", "C", "D", "E"]
        assert result.used_ai is True
        assert result.fallback_used is False

    # Test 2 — Duplicate concept handled
    def test_duplicate_concept_triggers_fallback(self):
        dup_response = {
            "analysis_summary": {
                "title_subject": "x", "title_promise": "x", "viewer_tension": "x",
                "recommended_hook": "curiosity_gap", "competitor_style_summary": "x", "overlay_style_summary": "x",
            },
            "variants": [_make_variant(l, "SAME PROMPT / TEXT") for l in ["A", "B", "C", "D", "E"]]
        }
        engine = _make_ai_engine(dup_response)
        result = self._run(self._svc().generate_five_variants(
            title="Why These Communities Never Go Bankrupt",
            video_context="",
            channel_title="Test Channel",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        # Duplicate overlay or prompt causes validation failure → fallback
        assert len(result.variants) == 5
        # Fallback variants should have different overlays
        overlays = [v.overlay_text.combined_text for v in result.variants]
        assert len(set(overlays)) > 1

    # Test 3 — Invalid JSON triggers fallback
    def test_invalid_json_triggers_fallback(self):
        engine = MagicMock()
        engine.provider = "gemini"
        engine._cloud_model = "gemini-2.0-flash"
        engine.generate_thumbnail_prompt_variants = AsyncMock(return_value={})  # empty = parse fail
        result = self._run(self._svc().generate_five_variants(
            title="Test Title",
            video_context="",
            channel_title="Test Channel",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        assert result.fallback_used is True
        assert len(result.variants) == 5

    # Test 4 — AI unavailable → fallback
    def test_ai_unavailable_returns_fallback(self):
        engine = MagicMock()
        engine.provider = "disabled"
        engine._cloud_model = ""
        engine.generate_thumbnail_prompt_variants = AsyncMock(return_value={})
        result = self._run(self._svc().generate_five_variants(
            title="Test Title",
            video_context="",
            channel_title="Test Channel",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        assert result.fallback_used is True
        assert len(result.variants) == 5
        for v in result.variants:
            assert len(v.warnings) > 0  # must warn about fallback

    # Test 5 — Observed Outlier Style not described as proven
    def test_observed_blueprint_has_limitations(self):
        engine = MagicMock()
        engine.provider = "disabled"
        engine._cloud_model = ""  # must be a real string, not MagicMock attr
        result = self._run(self._svc().generate_five_variants(
            title="Test Title",
            video_context="",
            channel_title="Test Channel",
            market="US",
            blueprint=_make_blueprint(mode="observed_outlier_style", validated=False),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        # All fallback variants must warn about non-validated
        for v in result.variants:
            combined_text = " ".join(v.warnings)
            assert "observed" in combined_text.lower() or "fallback" in combined_text.lower() or "not" in combined_text.lower()

    # Test 6 — Validated winning uses winning patterns
    def test_validated_blueprint_uses_winning_patterns(self):
        engine = _make_ai_engine()
        result = self._run(self._svc().generate_five_variants(
            title="Why These Communities Never Go Bankrupt",
            video_context="",
            channel_title="Test Channel",
            market="US",
            blueprint=_make_blueprint(mode="validated_winning", validated=True),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        # AI was used, variants should reference competitor traits
        assert result.used_ai is True
        for v in result.variants:
            assert len(v.competitor_traits_used) > 0

    # Test 7 — Overlay text uniqueness
    def test_overlay_text_unique(self):
        engine = _make_ai_engine()
        result = self._run(self._svc().generate_five_variants(
            title="Why These Communities Never Go Bankrupt",
            video_context="",
            channel_title="Test Channel",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        overlays = [v.overlay_text.combined_text for v in result.variants]
        assert len(set(overlays)) == 5, f"Duplicate overlay texts: {overlays}"
        for v in result.variants:
            assert v.overlay_text.combined_text.strip() != ""
            assert "[" not in v.overlay_text.combined_text, "Placeholder detected"

    # Test 8 — Prompt completeness
    def test_prompt_completeness(self):
        engine = _make_ai_engine()
        result = self._run(self._svc().generate_five_variants(
            title="Why These Communities Never Go Bankrupt",
            video_context="",
            channel_title="Test Channel",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        for v in result.variants:
            words = len(v.full_image_prompt.split())
            assert words >= 50, f"Option {v.option_label} prompt too short: {words} words"
            assert "3840" in v.full_image_prompt or "16:9" in v.full_image_prompt
            assert "same as" not in v.full_image_prompt.lower()
            assert v.negative_prompt.strip() != ""

    # Test 9 — Input validation via schema
    def test_input_validation(self):
        from schemas.research_schemas import ThumbnailPromptGenerationRequest
        from pydantic import ValidationError

        # Empty title
        with pytest.raises(ValidationError):
            ThumbnailPromptGenerationRequest(
                title="ab",  # too short
                channel_title="Test",
                blueprint=_make_blueprint(),
                thumbnail_intelligence=_make_intel(),
            )

        # Title too long
        with pytest.raises(ValidationError):
            ThumbnailPromptGenerationRequest(
                title="x" * 201,
                channel_title="Test",
                blueprint=_make_blueprint(),
                thumbnail_intelligence=_make_intel(),
            )

        # Context too long
        with pytest.raises(ValidationError):
            ThumbnailPromptGenerationRequest(
                title="Valid Title Here",
                video_context="x" * 2001,
                channel_title="Test",
                blueprint=_make_blueprint(),
                thumbnail_intelligence=_make_intel(),
            )

    # Test 10 — Provider error → fallback not hang
    def test_provider_error_returns_fallback(self):
        engine = MagicMock()
        engine.provider = "gemini"
        engine._cloud_model = "gemini-2.0-flash"

        async def raise_err(*a, **kw):
            raise RuntimeError("AI_TIMEOUT")

        engine.generate_thumbnail_prompt_variants = raise_err
        result = self._run(self._svc().generate_five_variants(
            title="Why These Communities Never Go Bankrupt",
            video_context="",
            channel_title="Test Channel",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        assert result.fallback_used is True
        assert len(result.variants) == 5
        assert result.fallback_reason is not None
