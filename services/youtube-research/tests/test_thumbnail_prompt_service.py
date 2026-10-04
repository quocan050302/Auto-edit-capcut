"""
Tests v2 cho ThumbnailPromptService Hook Intelligence Pipeline.

Covers:
- TitleHookBrief semantic analysis
- HookCandidate generation
- HookQualityScore per hook family
- Overlay redundancy
- Generic hook rejection
- Unsupported claim rejection
- Candidate diversity / top-5 selection
- Top-3 A/B diversity
- Semantic deterministic fallback (no keyword-suffix)
- Restaurant bill title fixture (spec-required)
- Multiple title types
"""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.thumbnail_prompt_service import (
    ThumbnailPromptService,
    _build_title_brief_deterministic,
    _build_deterministic_candidates,
    _score_and_select,
    _expand_candidate_to_variant,
    _is_generic_only,
    _validate_variants_v2,
    calculate_title_overlay_redundancy,
    score_hook_candidate,
    HOOK_FAMILIES,
    OPTION_LABELS,
    HookCandidate,
    TitleHookBrief,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

TITLES = {
    "restaurant": "The Hidden Fee Making Your Restaurant Bill So Much Higher",
    "communities": "Why These Communities Never Go Bankrupt",
    "walmart": "What Walmart's Price Tags Aren't Telling You",
    "groceries": "The Real Cost of Cheap Groceries",
    "dollars": "Why $100 Doesn't Buy Groceries Anymore",
}


def _make_blueprint(mode="validated_winning", validated=True):
    return {
        "id": "bp_test",
        "name": "Test Blueprint",
        "use_when": "test",
        "target_hook": "curiosity_gap",
        "blueprint_mode": mode,
        "is_statistically_validated": validated,
        "fallback_reason": "",
        "source_group": "outlier",
        "sample_summary": {},
        "limitations": [],
        "based_on_pattern_ids": [],
        "layout_description": "Split layout: subject left, text right",
        "subject_recipe": "One primary subject with visible face",
        "background_recipe": "Simple dark background",
        "text_recipe": "3-5 words max",
        "color_recipe": "High contrast palette",
        "lighting_recipe": "High contrast lighting",
        "hierarchy_recipe": "Subject -> Text -> Background",
        "title_pairing_recipe": "Curiosity gap",
        "overlay_text_formula": ["Short hook"],
        "image_prompt_template": "...",
        "negative_prompt": "watermark, blur, low quality",
        "evidence": [],
        "confidence": "high",
        "originality_rules": [],
    }


def _make_intel(n_outliers=5, n_baseline=3):
    analyses = []
    for i in range(n_outliers):
        analyses.append({
            "video_id": f"out_{i}",
            "video_title": f"Outlier Video {i}",
            "performance_group": "outlier",
            "views": 600000,
            "outlier_ratio": 5.0,
            "ocr": {"text": "WHAT IS THIS", "word_count": 3, "line_count": 1, "has_text": True, "has_uppercase": True},
            "composition": {"layout_type": "right_subject_left_text", "background_complexity": "low"},
            "subjects": {"has_person": True, "has_proof_object": True},
            "colors": {"has_yellow": True, "contrast": 0.8},
            "hooks": [{"hook_type": "proof_object_anomaly", "confidence": 0.9}],
            "mobile_readability": {"score": 85},
            "title_pairing": {},
        })
    for i in range(n_baseline):
        analyses.append({
            "video_id": f"base_{i}",
            "video_title": f"Baseline Video {i}",
            "performance_group": "baseline",
            "views": 50000,
            "outlier_ratio": 1.0,
            "ocr": {"text": "JUST ANOTHER TITLE", "word_count": 3, "line_count": 1, "has_text": True, "has_uppercase": False},
            "composition": {"layout_type": "centered", "background_complexity": "medium"},
            "subjects": {"has_person": True, "has_proof_object": False},
            "colors": {"has_yellow": False, "contrast": 0.5},
            "hooks": [{"hook_type": "curiosity_gap", "confidence": 0.5}],
            "mobile_readability": {"score": 60},
            "title_pairing": {},
        })
    return {
        "analyses": analyses,
        "patterns": [
            {"pattern_id": "has_face", "name": "Face Present", "description": "Outliers show face", "is_winning": True, "is_avoid": False},
            {"pattern_id": "proof_obj", "name": "Proof Object", "description": "Outliers show proof objects", "is_winning": True, "is_avoid": False},
        ],
        "group_stats": {"outlier": {"n": n_outliers, "median_mobile_score": 85}, "baseline": {"n": n_baseline}},
        "blueprints": [_make_blueprint()],
        "limitations": [],
    }


def _make_ai_engine(return_dict=None, provider="gemini"):
    engine = MagicMock()
    engine.provider = provider
    engine._cloud_model = "gemini-2.0-flash"
    engine.ollama_model = "llama3"
    if return_dict is None:
        return_dict = {}
    engine.generate_thumbnail_prompt_variants = AsyncMock(return_value=return_dict)
    return engine


def _run(coro):
    return asyncio.run(coro)


# ── Test 1: TitleHookBrief semantic analysis ──────────────────────────────────

class TestTitleHookBrief:
    def test_restaurant_title_not_just_title(self):
        title = TITLES["restaurant"]
        brief = _build_title_brief_deterministic(title, "")
        # Must not just be the title
        assert brief.literal_subject == title  # literal_subject IS the title
        assert brief.viewer_expectation != ""
        assert "title" not in brief.viewer_expectation.lower()

    def test_restaurant_detects_proof_object(self):
        brief = _build_title_brief_deterministic(TITLES["restaurant"], "")
        assert brief.strongest_proof_object != ""
        assert any(kw in brief.strongest_proof_object.lower() for kw in ["bill", "fee", "charge", "receipt", "invoice"])

    def test_restaurant_detects_contradiction(self):
        brief = _build_title_brief_deterministic(TITLES["restaurant"], "")
        assert brief.visual_contradiction != ""

    def test_communities_title(self):
        brief = _build_title_brief_deterministic(TITLES["communities"], "")
        assert brief.viewer_expectation != ""

    def test_claims_not_allowed_populated(self):
        brief = _build_title_brief_deterministic(TITLES["restaurant"], "")
        assert len(brief.claims_not_allowed) > 0
        assert any("dollar" in c.lower() or "amount" in c.lower() for c in brief.claims_not_allowed)


# ── Test 2: Overlay redundancy ────────────────────────────────────────────────

class TestOverlayRedundancy:
    def test_low_redundancy(self):
        r = calculate_title_overlay_redundancy("The Hidden Fee Making Your Restaurant Bill So Much Higher", "WHAT'S THIS CHARGE?")
        assert r <= 0.3, f"Expected low redundancy, got {r}"

    def test_high_redundancy(self):
        r = calculate_title_overlay_redundancy("The Hidden Fee Making Your Restaurant Bill So Much Higher", "HIDDEN FEE RESTAURANT BILL")
        assert r > 0.6, f"Expected high redundancy, got {r}"

    def test_empty_overlay(self):
        r = calculate_title_overlay_redundancy("any title", "")
        assert r == 1.0

    def test_exact_title_is_max_redundancy(self):
        title = "Why These Communities Never Go Bankrupt"
        r = calculate_title_overlay_redundancy(title, title.upper())
        assert r > 0.6


# ── Test 3: Generic hook rejection ───────────────────────────────────────────

class TestGenericHookRejection:
    def test_the_truth_is_generic(self):
        assert _is_generic_only("THE TRUTH") is True

    def test_exposed_is_generic(self):
        assert _is_generic_only("EXPOSED") is True

    def test_revealed_is_generic(self):
        assert _is_generic_only("REVEALED") is True

    def test_specific_overlay_not_generic(self):
        assert _is_generic_only("WHAT'S THIS CHARGE?") is False
        assert _is_generic_only("MENU PRICE") is False
        assert _is_generic_only("WHY SO HIGH?") is False

    def test_case_insensitive(self):
        assert _is_generic_only("the truth") is True


# ── Test 4: Candidate generation ─────────────────────────────────────────────

class TestCandidateGeneration:
    def _setup(self, title):
        brief = _build_title_brief_deterministic(title, "")
        blueprint = _make_blueprint()
        intel = _make_intel()
        from services.thumbnail_prompt_service import _build_competitor_dna
        dna = _build_competitor_dna(blueprint, intel)
        return brief, blueprint, dna

    def test_generates_at_least_5_candidates(self):
        title = TITLES["restaurant"]
        brief, _, dna = self._setup(title)
        candidates = _build_deterministic_candidates(title, brief, dna)
        assert len(candidates) >= 5

    def test_candidates_have_different_families(self):
        for key, title in TITLES.items():
            brief, _, dna = self._setup(title)
            candidates = _build_deterministic_candidates(title, brief, dna)
            families = [c.hook_family for c in candidates]
            assert len(set(families)) >= 4, f"Title '{title}': only {len(set(families))} families"

    def test_overlay_not_generic(self):
        title = TITLES["restaurant"]
        brief, _, dna = self._setup(title)
        candidates = _build_deterministic_candidates(title, brief, dna)
        for c in candidates:
            combined = f"{c.overlay_line_1} {c.overlay_line_2 or ''}".strip()
            assert not _is_generic_only(combined), f"Generic overlay in candidate: '{combined}'"

    def test_no_fabricated_dollar_amounts(self):
        title = TITLES["restaurant"]
        brief, _, dna = self._setup(title)
        candidates = _build_deterministic_candidates(title, brief, dna)
        for c in candidates:
            combined = f"{c.overlay_line_1} {c.overlay_line_2 or ''}".strip()
            # No $ signs, no hardcoded monetary amounts
            import re
            assert not re.search(r"\$\d+", combined), f"Dollar amount in overlay: '{combined}'"


# ── Test 5: Hook quality scoring ─────────────────────────────────────────────

class TestHookQualityScoring:
    def _dna(self):
        intel = _make_intel()
        from services.thumbnail_prompt_service import _build_competitor_dna
        return _build_competitor_dna(_make_blueprint(), intel)

    def test_proof_object_anomaly_gets_high_curiosity(self):
        dna = self._dna()
        c = HookCandidate(
            id="test",
            hook_family="proof_object_anomaly",
            visual_question="What is this unexplained charge on the receipt?",
            focal_subject="Receipt with highlighted line item",
            proof_object="Restaurant receipt with unexplained fee",
            visual_tension="Expected total vs actual total",
            hidden_information="The unexplained fee category",
            overlay_line_1="WHAT'S THIS CHARGE?",
        )
        score = score_hook_candidate(c, TITLES["restaurant"], dna)
        assert score.curiosity_gap >= 15, f"Expected high curiosity_gap, got {score.curiosity_gap}"

    def test_redundant_overlay_penalized(self):
        dna = self._dna()
        c = HookCandidate(
            id="test",
            hook_family="hidden_mechanism",
            visual_question="What's hiding here?",
            focal_subject="Generic scene",
            proof_object=None,
            visual_tension="Generic tension",
            hidden_information="Something hidden",
            overlay_line_1="HIDDEN FEE RESTAURANT BILL",
        )
        score = score_hook_candidate(c, TITLES["restaurant"], dna)
        # High redundancy → penalty
        assert score.penalties < 0, "Redundant overlay should have penalty"

    def test_generic_overlay_penalized(self):
        dna = self._dna()
        c = HookCandidate(
            id="test",
            hook_family="hidden_mechanism",
            visual_question="What's hiding here?",
            focal_subject="Generic scene",
            proof_object=None,
            visual_tension="Generic tension",
            hidden_information="Something hidden",
            overlay_line_1="EXPOSED",
        )
        score = score_hook_candidate(c, TITLES["restaurant"], dna)
        assert score.total_score < 70, f"Generic overlay should score below 70, got {score.total_score}"

    def test_total_score_clamped_0_100(self):
        dna = self._dna()
        c = HookCandidate(
            id="test",
            hook_family="proof_object_anomaly",
            visual_question="What is wrong with this receipt?",
            focal_subject="Receipt close-up",
            proof_object="Restaurant receipt with unexplained charge",
            visual_tension="Expected total vs actual total on receipt",
            hidden_information="The explanation for the fee",
            overlay_line_1="WHAT'S THIS CHARGE?",
        )
        score = score_hook_candidate(c, TITLES["restaurant"], dna)
        assert 0 <= score.total_score <= 100


# ── Test 6: Top-5 selection diversity ────────────────────────────────────────

class TestTopFiveSelection:
    def test_top5_has_at_least_4_families(self):
        for title in TITLES.values():
            brief = _build_title_brief_deterministic(title, "")
            intel = _make_intel()
            from services.thumbnail_prompt_service import _build_competitor_dna
            dna = _build_competitor_dna(_make_blueprint(), intel)
            candidates = _build_deterministic_candidates(title, brief, dna)
            selected = _score_and_select(candidates, title, dna)
            assert len(selected) == 5
            families = [c.hook_family for c in selected]
            assert len(set(families)) >= 4, f"Title: {title} — families: {families}"

    def test_selected_overlays_unique(self):
        title = TITLES["restaurant"]
        brief = _build_title_brief_deterministic(title, "")
        from services.thumbnail_prompt_service import _build_competitor_dna
        dna = _build_competitor_dna(_make_blueprint(), _make_intel())
        candidates = _build_deterministic_candidates(title, brief, dna)
        selected = _score_and_select(candidates, title, dna)
        overlays = [f"{c.overlay_line_1}|{c.overlay_line_2}" for c in selected]
        assert len(set(overlays)) == 5, f"Duplicate overlays: {overlays}"


# ── Test 7: Restaurant fixture (spec-required) ────────────────────────────────

class TestRestaurantFixture:
    def _run_fallback(self):
        svc = ThumbnailPromptService()
        engine = _make_ai_engine(return_dict={}, provider="disabled")
        engine._cloud_model = ""
        result = _run(svc.generate_five_variants(
            title=TITLES["restaurant"],
            video_context="This video explains a common practice in restaurants of adding fees not shown on the menu.",
            channel_title="Finance Channel",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        return result

    def test_recommended_hook_not_unknown(self):
        result = self._run_fallback()
        assert result.analysis_summary.recommended_hook != ""
        assert result.analysis_summary.recommended_hook != "unknown"

    def test_title_subject_not_just_title(self):
        result = self._run_fallback()
        # title_subject should be the literal subject, but NOT just repeat title as title_promise
        assert result.analysis_summary.title_promise != f"Viewer will learn about: {TITLES['restaurant']}"

    def test_exactly_5_variants(self):
        result = self._run_fallback()
        assert len(result.variants) == 5

    def test_has_proof_object_variant(self):
        result = self._run_fallback()
        families = [v.hook_family for v in result.variants]
        assert "proof_object_anomaly" in families, f"No proof_object_anomaly: {families}"

    def test_has_expectation_vs_reality(self):
        result = self._run_fallback()
        families = [v.hook_family for v in result.variants]
        assert "expectation_vs_reality" in families or "visual_contradiction" in families, f"Missing: {families}"

    def test_no_dollar_amounts_in_overlay(self):
        import re
        result = self._run_fallback()
        for v in result.variants:
            text = v.overlay_text.combined_text
            assert not re.search(r"\$\d+", text), f"Dollar amount in overlay: '{text}'"

    def test_no_deadline_in_overlay(self):
        result = self._run_fallback()
        deadline_words = {"deadline", "expires", "limited time", "hours left", "days left", "tonight"}
        for v in result.variants:
            text = v.overlay_text.combined_text.lower()
            for dw in deadline_words:
                assert dw not in text, f"Deadline word '{dw}' found in overlay: '{text}'"

    def test_no_scam_claim(self):
        result = self._run_fallback()
        for v in result.variants:
            text = (v.overlay_text.combined_text + " " + v.visual_question + " " + v.why_it_works).lower()
            assert "scam" not in text, f"'scam' claim found when title does not say scam"

    def test_no_generic_only_overlay(self):
        result = self._run_fallback()
        for v in result.variants:
            assert not _is_generic_only(v.overlay_text.combined_text), \
                f"Generic-only overlay for {v.option_label}: '{v.overlay_text.combined_text}'"

    def test_at_least_3_ab_test_variants(self):
        result = self._run_fallback()
        ab = [v for v in result.variants if v.recommended_for_ab_test]
        assert len(ab) == 3, f"Expected 3 A/B variants, got {len(ab)}"

    def test_labels_a_through_e(self):
        result = self._run_fallback()
        labels = sorted([v.option_label for v in result.variants])
        assert labels == ["A", "B", "C", "D", "E"]

    def test_all_hook_quality_above_minimum(self):
        result = self._run_fallback()
        for v in result.variants:
            # Fallback variants should have scores — allow lower threshold for fallback
            assert v.hook_quality.total_score >= 50, \
                f"Hook quality too low for {v.option_label}: {v.hook_quality.total_score}"

    def test_top3_ab_have_different_families(self):
        result = self._run_fallback()
        ab = [v for v in result.variants if v.recommended_for_ab_test]
        ab_families = [v.hook_family for v in ab]
        assert len(set(ab_families)) >= 2, f"Top A/B has duplicate families: {ab_families}"

    def test_overlay_line1_yellow_line2_white(self):
        result = self._run_fallback()
        for v in result.variants:
            assert v.overlay_text.line_1_color == "#FFE600", \
                f"Line 1 not yellow in {v.option_label}: {v.overlay_text.line_1_color}"
            assert v.overlay_text.line_2_color == "#FFFFFF", \
                f"Line 2 not white in {v.option_label}: {v.overlay_text.line_2_color}"

    def test_no_overlap_with_title_in_overlay(self):
        result = self._run_fallback()
        title = TITLES["restaurant"]
        for v in result.variants:
            redundancy = calculate_title_overlay_redundancy(title, v.overlay_text.combined_text)
            assert redundancy <= 0.65, \
                f"Overlay too redundant with title for {v.option_label}: {redundancy:.0%} — '{v.overlay_text.combined_text}'"


# ── Test 8: Multiple title types ──────────────────────────────────────────────

class TestMultipleTitles:
    def _run_for(self, title):
        svc = ThumbnailPromptService()
        engine = _make_ai_engine(return_dict={}, provider="disabled")
        engine._cloud_model = ""
        return _run(svc.generate_five_variants(
            title=title,
            video_context="",
            channel_title="Test Channel",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))

    def test_all_titles_produce_5_variants(self):
        for key, title in TITLES.items():
            result = self._run_for(title)
            assert len(result.variants) == 5, f"Title '{key}': got {len(result.variants)} variants"

    def test_all_titles_have_valid_recommended_hook(self):
        for key, title in TITLES.items():
            result = self._run_for(title)
            hook = result.analysis_summary.recommended_hook
            assert hook and hook != "unknown", f"Title '{key}': recommended_hook='{hook}'"

    def test_all_titles_unique_hook_families_per_run(self):
        for key, title in TITLES.items():
            result = self._run_for(title)
            families = [v.hook_family for v in result.variants]
            unique = len(set(families))
            assert unique >= 4, f"Title '{key}': only {unique} unique families — {families}"


# ── Test 9: Validator V2 ──────────────────────────────────────────────────────

class TestValidatorV2:
    def _make_valid_variants(self):
        from schemas.research_schemas import ThumbnailPromptVariantSchema, ThumbnailOverlayTextSchema, HookQualityScoreSchema
        families = ["proof_object_anomaly", "visual_contradiction", "hidden_mechanism", "expectation_vs_reality", "personal_consequence"]
        return [
            ThumbnailPromptVariantSchema(
                id=str(i),
                option_label=OPTION_LABELS[i],
                concept_name=f"Option {OPTION_LABELS[i]}",
                hook_family=families[i],
                visual_question=f"What is happening in this scene {i}?",
                hidden_information=f"The answer is withheld {i}",
                test_hypothesis=f"Hypothesis {i} — testing different visual approach",
                strategic_angle=families[i],
                title_interpretation=f"Title interpretation {i}",
                overlay_text=ThumbnailOverlayTextSchema(
                    line_1=["WHAT'S THIS CHARGE?", "MENU PRICE", "WHY SO HIGH?", "YOU PAID EXTRA", "HOLD ON"][i],
                    line_1_color="#FFE600",
                    combined_text=["WHAT'S THIS CHARGE?", "MENU PRICE", "WHY SO HIGH?", "YOU PAID EXTRA", "HOLD ON"][i],
                    total_words=3,
                    outline_color="#050505",
                    placement="upper_left",
                    typography="bold_condensed_sans",
                ),
                visual_concept=f"Visual concept {i} — unique",
                subject_direction=f"Subject direction {i}",
                composition_direction=f"Composition direction {i}",
                background_direction="Dark background",
                color_direction="High contrast",
                lighting_direction="High contrast lighting",
                mobile_readability_direction="Readable at mobile",
                title_thumbnail_relationship=f"Thumbnail question {i}, title answers",
                full_image_prompt=(
                    f"YouTube thumbnail 16:9. CORE VISUAL QUESTION: What is this? "
                    f"VIEWER EXPECTATION: Standard outcome. "
                    f"VISUAL CONTRADICTION: Expected vs actual. "
                    f"WHAT MUST REMAIN UNANSWERED: The explanation. "
                    f"Photorealistic. One primary subject with proof object. "
                    f"Split layout. Subject on right, text on left. Simple dark background. "
                    f"High contrast lighting. No watermarks, no competitor logos. "
                    f"Overlay Line 1 yellow: 'OVERLAY TEXT'. Font: bold condensed sans. "
                    f"Readable at 120x67px. Bottom-right 30% clear. Variant {i}."
                ),
                negative_prompt="watermark, blur",
                why_it_works=f"Why it works {i}",
                hook_quality=HookQualityScoreSchema(
                    curiosity_gap=16, one_second_clarity=12, title_complementarity=12,
                    visual_tension=11, specificity_and_proof=8, mobile_readability=8,
                    promise_integrity=9, competitor_fit=3, penalties=0, total_score=79,
                ),
                recommended_test_rank=i + 1,
                recommended_for_ab_test=i < 3,
            )
            for i in range(5)
        ]

    def test_valid_variants_pass(self):
        variants = self._make_valid_variants()
        errors = _validate_variants_v2(variants)
        assert errors == [], f"Valid variants should have no errors: {errors}"

    def test_detects_wrong_count(self):
        variants = self._make_valid_variants()[:3]
        errors = _validate_variants_v2(variants)
        assert any("5 variants" in e or "3" in e for e in errors)

    def test_detects_generic_overlay(self):
        from schemas.research_schemas import ThumbnailPromptVariantSchema, ThumbnailOverlayTextSchema, HookQualityScoreSchema
        variants = self._make_valid_variants()
        # Make variant A have generic overlay
        ot = variants[0].overlay_text.model_copy(update={"combined_text": "THE TRUTH", "line_1": "THE TRUTH"})
        variants[0] = variants[0].model_copy(update={"overlay_text": ot})
        errors = _validate_variants_v2(variants)
        assert any("generic" in e.lower() or "TRUTH" in e for e in errors)


# ── Test 10: AI provider error → fallback ─────────────────────────────────────

class TestAIFallback:
    def test_ai_error_returns_fallback(self):
        svc = ThumbnailPromptService()
        engine = _make_ai_engine(provider="gemini")

        async def raise_runtime(*a, **kw):
            raise RuntimeError("AI_TIMEOUT")

        engine.generate_thumbnail_prompt_variants = raise_runtime
        result = _run(svc.generate_five_variants(
            title=TITLES["restaurant"],
            video_context="",
            channel_title="Test",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        assert result.fallback_used is True
        assert len(result.variants) == 5
        assert result.fallback_reason is not None

    def test_disabled_provider_returns_fallback_with_hook(self):
        svc = ThumbnailPromptService()
        engine = MagicMock()
        engine.provider = "disabled"
        engine._cloud_model = ""
        result = _run(svc.generate_five_variants(
            title=TITLES["restaurant"],
            video_context="",
            channel_title="Test",
            market="US",
            blueprint=_make_blueprint(),
            thumbnail_intelligence=_make_intel(),
            ai_engine=engine,
        ))
        assert result.fallback_used is True
        hook = result.analysis_summary.recommended_hook
        assert hook and hook != "unknown", f"recommended_hook should not be unknown, got '{hook}'"
        # hook_source must indicate deterministic
        assert "deterministic" in result.analysis_summary.hook_source.lower(), \
            f"hook_source should indicate deterministic: {result.analysis_summary.hook_source}"
