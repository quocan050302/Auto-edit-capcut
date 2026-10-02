"""
ThumbnailPromptService — Tạo 5 thumbnail prompt concept từ title + competitor intelligence.
Feature này KHÔNG tạo ảnh. Chỉ tạo prompt để user copy sang công cụ tạo ảnh bên ngoài.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from core.logger import research_logger
from schemas.research_schemas import (
    ThumbnailPromptGenerationResponse,
    ThumbnailPromptVariantSchema,
    ThumbnailOverlayTextSchema,
    ThumbnailPromptAnalysisSummarySchema,
)

# ── System Prompt ──────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a senior YouTube thumbnail strategist for the US market.
Your task is to transform one video title into exactly five original thumbnail concepts using structured competitor-thumbnail intelligence.

Rules:
1. Use competitor data as visual EVIDENCE, not as permission to copy a specific thumbnail.
2. Separate: (1) statistically validated patterns, (2) observed channel style, (3) fallback recommendations.
3. Never describe an observed pattern as "proven" when blueprint_mode is not "validated_winning".
4. Return ONLY valid JSON. Do NOT use Markdown code fences. Do NOT include explanations outside JSON.
5. Create exactly five variants labeled A, B, C, D and E.
6. Every full_image_prompt must be complete, standalone, 250–450 words.
7. Every variant must contain exact overlay_text (no placeholders like [HOOK TEXT]).
8. Do NOT say "same as above" or "same as Option A".
9. Do NOT copy faces, names, channel branding, or distinctive visual signatures of competitors.
10. Do NOT fabricate numbers, dates, prices, names, statistics, disasters, or absolute claims unless they appear in the input title or video_context.
11. Overlay text must be in the market language (default: US English). Must create an open loop. Must NOT repeat the full title.
12. Each of the 5 variants must have a genuinely different visual idea, not just word changes.

Return this exact JSON schema (no extra keys, no markdown):
{
  "analysis_summary": {
    "title_subject": "...",
    "title_promise": "...",
    "viewer_tension": "...",
    "recommended_hook": "...",
    "competitor_style_summary": "...",
    "overlay_style_summary": "..."
  },
  "variants": [
    {
      "id": "uuid-string",
      "option_label": "A",
      "concept_name": "...",
      "strategic_angle": "...",
      "title_interpretation": "...",
      "overlay_text": {
        "line_1": "THE REAL COST",
        "line_2": "WHO PAYS?",
        "combined_text": "THE REAL COST / WHO PAYS?",
        "total_words": 4,
        "capitalization": "ALL_CAPS",
        "text_color": "#FFFFFF",
        "outline_color": "#000000",
        "placement": "upper_left",
        "typography": "bold_condensed_sans"
      },
      "visual_concept": "...",
      "subject_direction": "...",
      "composition_direction": "...",
      "background_direction": "...",
      "color_direction": "...",
      "lighting_direction": "...",
      "mobile_readability_direction": "...",
      "title_thumbnail_relationship": "...",
      "full_image_prompt": "YouTube thumbnail 16:9. Target resolution 3840x2160. [250-450 word complete standalone prompt]",
      "negative_prompt": "...",
      "competitor_traits_used": ["..."],
      "evidence": ["..."],
      "originality_changes": ["..."],
      "why_it_works": "...",
      "warnings": []
    }
  ]
}"""

OPTION_ANGLES = [
    ("A", "Human Situation",
     "Focus on a person or group in a clearly recognizable situation. Show emotion and action relevant to the title."),
    ("B", "Object or Proof",
     "A concrete proof object: document, product, data chart, invoice, food, device, or physical evidence."),
    ("C", "Comparison or Contrast",
     "Before/after, rich vs poor, full vs empty, old vs new. Only use if the title supports comparison."),
    ("D", "Consequence",
     "Visual result or consequence implied by the title. Do not exaggerate into crisis if title does not say so."),
    ("E", "Curiosity Gap",
     "A hidden detail, a visual question, an anomaly, or a moment that makes viewer want to know what is happening."),
]

NEGATIVE_PROMPT_BASE = (
    "unreadable text, distorted faces, malformed hands, excessive objects, cluttered background, "
    "duplicate people, warped products, low contrast, tiny subject, content in bottom-right duration zone, "
    "competitor logo, watermark, copied branding, nsfw, blurry, extra text not specified, store signs, "
    "product labels, random captions, random headlines"
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _extract_overlay_words(title: str, max_words: int = 5) -> Tuple[str, Optional[str]]:
    """Extract keyword words from title to form overlay text without repeating full title."""
    stop = {
        "the","a","an","and","or","but","in","on","at","to","of","for","with","by",
        "is","are","was","were","be","been","being","do","does","did","have","has","had",
        "this","that","these","those","it","its","we","our","they","their","you","your",
        "my","me","him","her","his","she","he","i","why","how","what","when","where","who",
    }
    words = re.sub(r"[^a-zA-Z0-9\s']", "", title).split()
    keywords = [w for w in words if w.lower() not in stop and len(w) > 2]
    if not keywords:
        keywords = words
    main_words = keywords[:max_words]
    # Split into two lines if 3+ words
    if len(main_words) >= 4:
        mid = len(main_words) // 2
        line1 = " ".join(main_words[:mid]).upper()
        line2 = " ".join(main_words[mid:]).upper()
        return line1, line2
    return " ".join(main_words).upper(), None


def _build_competitor_dna(blueprint: dict, intel: dict) -> dict:
    """Build compact Competitor DNA object for AI context."""
    analyses = intel.get("analyses", [])
    patterns = intel.get("patterns", [])
    group_stats = intel.get("group_stats", {})
    outlier_stats = group_stats.get("outlier", {})
    baseline_stats = group_stats.get("baseline", {})

    winning = [p for p in patterns if p.get("is_winning")]
    avoid = [p for p in patterns if p.get("is_avoid")]

    # Compute modal overlay style from analyses
    text_words = [a.get("ocr", {}).get("word_count", 0) for a in analyses if a.get("ocr", {}).get("word_count", 0) > 0]
    text_lines = [a.get("ocr", {}).get("line_count", 0) for a in analyses if a.get("ocr", {}).get("line_count", 0) > 0]
    has_uppercase = sum(1 for a in analyses if a.get("ocr", {}).get("has_uppercase")) > len(analyses) / 2 if analyses else False
    layouts = [a.get("composition", {}).get("layout_type", "") for a in analyses if a.get("composition", {})]
    layout_mode = max(set(layouts), key=layouts.count) if layouts else "unknown"
    hooks = []
    for a in analyses:
        hooks_list = a.get("hooks", [])
        if hooks_list:
            hooks.append(hooks_list[0].get("hook_type", "unknown"))
    top_hook = max(set(hooks), key=hooks.count) if hooks else blueprint.get("target_hook", "curiosity_gap")

    return {
        "blueprint_mode": blueprint.get("blueprint_mode", "safe_default"),
        "validated": blueprint.get("is_statistically_validated", False),
        "dominant_hook": top_hook,
        "dominant_layout": layout_mode,
        "subject_has_person": sum(1 for a in analyses if a.get("subjects", {}).get("has_person")) > len(analyses) / 2 if analyses else True,
        "text_word_range": f"{min(text_words, default=2)}–{max(text_words, default=5)}",
        "text_line_range": f"{min(text_lines, default=1)}–{max(text_lines, default=2)}",
        "text_uppercase": has_uppercase,
        "layout_description": blueprint.get("layout_description", ""),
        "background_complexity": blueprint.get("background_recipe", ""),
        "contrast_strategy": blueprint.get("color_recipe", ""),
        "mobile_readability": outlier_stats.get("median_mobile_score", 50),
        "winning_patterns": [
            {"id": p.get("pattern_id"), "name": p.get("name"), "description": p.get("description")}
            for p in winning[:10]
        ],
        "channel_wide_patterns": [
            {"id": p.get("pattern_id"), "name": p.get("name")}
            for p in patterns if not p.get("is_winning") and not p.get("is_avoid")
        ][:5],
        "avoid_patterns": [
            {"id": p.get("pattern_id"), "name": p.get("name"), "description": p.get("description")}
            for p in avoid[:5]
        ],
        "limitations": intel.get("limitations", []),
    }


def _sample_analyses(analyses: list) -> Tuple[list, list, list]:
    """Return sliced outlier/baseline/low with summary fields only (no base64)."""
    def _slim(a: dict) -> dict:
        return {
            "video_id": a.get("video_id", ""),
            "video_title": a.get("video_title", ""),
            "performance_group": a.get("performance_group", ""),
            "views": a.get("views", 0),
            "outlier_ratio": a.get("outlier_ratio", 0),
            "ocr": a.get("ocr", {}),
            "composition": a.get("composition", {}),
            "subjects": a.get("subjects", {}),
            "colors": {k: v for k, v in a.get("colors", {}).items() if k != "dominant_colors"},
            "hooks": a.get("hooks", [])[:2],
            "mobile_readability": a.get("mobile_readability", {}),
            "title_pairing": a.get("title_pairing", {}),
        }

    outliers = [_slim(a) for a in analyses if a.get("performance_group") == "outlier"][:12]
    baseline = [_slim(a) for a in analyses if a.get("performance_group") == "baseline"][:6]
    low = [_slim(a) for a in analyses if a.get("performance_group") == "low"][:6]
    return outliers, baseline, low


def _build_fallback_overlay(title: str, idx: int) -> ThumbnailOverlayTextSchema:
    """Create fallback overlay text for a variant."""
    line1, line2 = _extract_overlay_words(title, max_words=5)
    # Vary slightly per option
    suffixes = ["REVEALED", "EXPLAINED", "THE TRUTH", "EXPOSED", "UNCOVERED"]
    if line2 is None and idx > 0:
        line2 = suffixes[idx % len(suffixes)]
    combined = f"{line1} / {line2}" if line2 else line1
    total_words = len(combined.replace("/", "").split())
    return ThumbnailOverlayTextSchema(
        line_1=line1,
        line_2=line2,
        combined_text=combined,
        total_words=total_words,
        capitalization="ALL_CAPS",
        text_color="#FFFFFF",
        outline_color="#000000",
        placement="upper_left" if idx % 2 == 0 else "lower_center",
        typography="bold_condensed_sans",
    )


def _build_fallback_variant(
    idx: int,
    title: str,
    blueprint: dict,
    competitor_dna: dict,
    outliers: list,
) -> ThumbnailPromptVariantSchema:
    """Build one deterministic fallback variant."""
    label, angle_name, angle_desc = OPTION_ANGLES[idx]
    overlay = _build_fallback_overlay(title, idx)

    layout = competitor_dna.get("dominant_layout", "right_subject_left_text")
    hook = competitor_dna.get("dominant_hook", "curiosity_gap")
    validated = competitor_dna.get("validated", False)
    blueprint_mode = competitor_dna.get("blueprint_mode", "safe_default")
    has_person = competitor_dna.get("subject_has_person", True)
    bg_recipe = competitor_dna.get("background_complexity", "Simple, uncluttered background with depth")
    color_recipe = competitor_dna.get("contrast_strategy", "High contrast palette")
    mobile_score = competitor_dna.get("mobile_readability", 50)
    negative = blueprint.get("negative_prompt", NEGATIVE_PROMPT_BASE)

    validation_note = (
        "Based on statistically validated competitor patterns." if validated
        else f"Note: blueprint_mode={blueprint_mode} — patterns are observed, not statistically proven."
    )

    winning_traits = [p["name"] for p in competitor_dna.get("winning_patterns", [])[:3]]
    avoid_traits = [p["name"] for p in competitor_dna.get("avoid_patterns", [])[:2]]

    full_prompt = (
        f"YouTube thumbnail 16:9. Target resolution 3840x2160. Photorealistic photography style.\n\n"
        f"VISUAL CONCEPT — OPTION {label} ({angle_name}):\n"
        f"{angle_desc}\n\n"
        f"SUBJECT:\n"
        f"{'One primary human subject with clear facial expression related to the topic.' if has_person and idx in (0, 3) else 'A clear, concrete primary object or environment relevant to the topic.'} "
        f"Subject occupies 45-60% of frame. Do NOT copy any specific person from competitor thumbnails.\n\n"
        f"COMPOSITION ({layout.replace('_', ' ')}):\n"
        f"{blueprint.get('layout_description', 'Mobile-first single dominant subject')} "
        f"Clear visual hierarchy: subject first, then text, then background.\n\n"
        f"BACKGROUND:\n"
        f"{bg_recipe} High contrast between subject and background.\n\n"
        f"COLOR & LIGHTING:\n"
        f"{color_recipe}. {blueprint.get('lighting_recipe', 'High contrast lighting')}.\n\n"
        f"OVERLAY TEXT — render exactly this text and no other words:\n"
        f'Line 1: "{overlay.line_1}"'
        + (f'\nLine 2: "{overlay.line_2}"' if overlay.line_2 else "")
        + f"\n"
        f"Font: {overlay.typography}. Color: {overlay.text_color}. Outline: {overlay.outline_color} thick stroke. "
        f"Placement: {overlay.placement}. Text must be readable at 120x67px (mobile thumbnail size).\n\n"
        f"SAFE ZONES:\n"
        f"Keep bottom-right 30% clear of critical content (YouTube duration badge zone). "
        f"Keep 5% margin on all edges.\n\n"
        f"MOBILE READABILITY:\n"
        f"All key elements must be recognizable at thumbnail size. Target mobile readability score: {mobile_score}+.\n\n"
        f"ORIGINALITY:\n"
        f"Do NOT copy competitor thumbnails. Replace people, locations, props, color combos if too distinctive. "
        f"Keep layout structure, text length, and contrast strategy only.\n\n"
        f"NEGATIVE INSTRUCTIONS:\n"
        f"No watermarks, no competitor logos, no extra text, no store signs, no product labels, "
        f"no random captions, {negative}"
    )

    warnings = [
        f"Deterministic fallback — AI not available. {validation_note}",
    ]
    if avoid_traits:
        warnings.append(f"Avoid patterns detected: {', '.join(avoid_traits)}")

    return ThumbnailPromptVariantSchema(
        id=str(uuid.uuid4()),
        option_label=label,
        concept_name=f"Option {label} — {angle_name}",
        strategic_angle=angle_desc,
        title_interpretation=f"Title '{title}' suggests: {angle_desc}",
        overlay_text=overlay,
        visual_concept=f"{angle_name} approach for: {title}",
        subject_direction=(
            "One primary human subject relevant to topic. Do NOT copy specific individuals."
            if has_person and idx in (0, 3) else
            "One clear primary object or environment. Do NOT copy competitor's specific objects."
        ),
        composition_direction=blueprint.get("layout_description", "Mobile-first single dominant subject"),
        background_direction=bg_recipe,
        color_direction=color_recipe,
        lighting_direction=blueprint.get("lighting_recipe", "High contrast lighting"),
        mobile_readability_direction=f"All elements readable at mobile thumbnail size. Target score {mobile_score}+.",
        title_thumbnail_relationship=(
            f"Thumbnail shows visual evidence of '{title}' without repeating it as text."
        ),
        full_image_prompt=full_prompt,
        negative_prompt=negative or NEGATIVE_PROMPT_BASE,
        competitor_traits_used=winning_traits,
        evidence=[f"Observed in {len(outliers)} outlier thumbnail analyses." if outliers else "No outlier data."],
        originality_changes=[
            "Replaced competitor's specific subject with topic-relevant alternative.",
            "Preserved layout structure and contrast strategy only.",
            f"Used overlay text derived from input title instead of copying competitor wording.",
        ],
        why_it_works=(
            f"Option {label} ({angle_name}) uses the {hook} hook strategy "
            f"observed in competitor outlier thumbnails. {validation_note}"
        ),
        warnings=warnings,
    )


def _parse_ai_variant(raw: dict, idx: int, title: str, negative_base: str) -> Optional[ThumbnailPromptVariantSchema]:
    """Safely parse one AI-returned variant dict into schema."""
    try:
        ot_raw = raw.get("overlay_text", {})
        line_1 = ot_raw.get("line_1", "")
        line_2 = ot_raw.get("line_2") or None
        combined = ot_raw.get("combined_text", "") or (f"{line_1} / {line_2}" if line_2 else line_1)

        if not combined.strip():
            l1, l2 = _extract_overlay_words(title, 4)
            combined = f"{l1} / {l2}" if l2 else l1
            line_1 = l1
            line_2 = l2

        # Reject placeholders
        placeholder_re = re.compile(r'\[.+?\]')
        if placeholder_re.search(combined) or "same as" in raw.get("full_image_prompt", "").lower():
            return None

        overlay = ThumbnailOverlayTextSchema(
            line_1=line_1 or combined,
            line_2=line_2,
            combined_text=combined,
            total_words=ot_raw.get("total_words", len(combined.split())),
            capitalization=ot_raw.get("capitalization", "ALL_CAPS"),
            text_color=ot_raw.get("text_color", "#FFFFFF"),
            outline_color=ot_raw.get("outline_color", "#000000"),
            placement=ot_raw.get("placement", "upper_left"),
            typography=ot_raw.get("typography", "bold_condensed_sans"),
        )

        fip = raw.get("full_image_prompt", "")
        if len(fip.split()) < 50:
            return None  # Too short — reject

        negative = raw.get("negative_prompt") or negative_base
        expected_labels = ["A", "B", "C", "D", "E"]

        return ThumbnailPromptVariantSchema(
            id=raw.get("id") or str(uuid.uuid4()),
            option_label=raw.get("option_label", expected_labels[idx]),
            concept_name=raw.get("concept_name", f"Option {expected_labels[idx]}"),
            strategic_angle=raw.get("strategic_angle", ""),
            title_interpretation=raw.get("title_interpretation", ""),
            overlay_text=overlay,
            visual_concept=raw.get("visual_concept", ""),
            subject_direction=raw.get("subject_direction", ""),
            composition_direction=raw.get("composition_direction", ""),
            background_direction=raw.get("background_direction", ""),
            color_direction=raw.get("color_direction", ""),
            lighting_direction=raw.get("lighting_direction", ""),
            mobile_readability_direction=raw.get("mobile_readability_direction", ""),
            title_thumbnail_relationship=raw.get("title_thumbnail_relationship", ""),
            full_image_prompt=fip,
            negative_prompt=negative,
            competitor_traits_used=raw.get("competitor_traits_used", []),
            evidence=raw.get("evidence", []),
            originality_changes=raw.get("originality_changes", []),
            why_it_works=raw.get("why_it_works", ""),
            warnings=raw.get("warnings", []),
        )
    except Exception as e:
        research_logger.warning(f"[PromptStudio] Failed to parse AI variant {idx}: {e}")
        return None


def _validate_variants(variants: List[ThumbnailPromptVariantSchema]) -> List[str]:
    """Return list of validation errors."""
    errors = []
    labels = [v.option_label for v in variants]
    if sorted(labels) != ["A", "B", "C", "D", "E"]:
        errors.append(f"Expected labels A-E, got {labels}")
    overlays = [v.overlay_text.combined_text for v in variants]
    if len(set(overlays)) < len(overlays):
        errors.append("Duplicate overlay_text detected")
    prompts = [v.full_image_prompt for v in variants]
    if len(set(prompts)) < len(prompts):
        errors.append("Duplicate full_image_prompt detected")
    for v in variants:
        if not v.overlay_text.combined_text.strip():
            errors.append(f"Empty overlay_text in variant {v.option_label}")
        if len(v.full_image_prompt.split()) < 50:
            errors.append(f"full_image_prompt too short in variant {v.option_label}")
    return errors


# ── Main Service ───────────────────────────────────────────────────────────────

class ThumbnailPromptService:

    async def generate_five_variants(
        self,
        title: str,
        video_context: str,
        channel_title: str,
        market: str,
        blueprint: dict,
        thumbnail_intelligence: dict,
        ai_engine,
    ) -> ThumbnailPromptGenerationResponse:
        """
        Main entry point. Returns ThumbnailPromptGenerationResponse with exactly 5 variants.
        Never raises — falls back to deterministic if AI fails.
        """
        now = datetime.now(timezone.utc).isoformat()

        # Sanitize inputs
        title = title.strip()[:200]
        video_context = (video_context or "").strip()[:2000]
        channel_title = channel_title.strip()

        analyses = thumbnail_intelligence.get("analyses", [])
        patterns = thumbnail_intelligence.get("patterns", [])
        limitations = thumbnail_intelligence.get("limitations", [])

        competitor_dna = _build_competitor_dna(blueprint, thumbnail_intelligence)
        outliers, baseline_samp, low_samp = _sample_analyses(analyses)

        provider = getattr(ai_engine, "provider", "disabled")
        model = getattr(ai_engine, "_cloud_model", ai_engine.ollama_model if provider == "ollama" else "gemini-2.0-flash")

        # Try AI first
        variants: List[ThumbnailPromptVariantSchema] = []
        used_ai = False
        fallback_used = False
        fallback_reason: Optional[str] = None
        analysis_summary: Optional[ThumbnailPromptAnalysisSummarySchema] = None
        ai_error: Optional[str] = None

        if provider not in ("disabled", ""):
            payload = {
                "input_title": title,
                "video_context": video_context or None,
                "market": market,
                "channel_title": channel_title,
                "competitor_dna": competitor_dna,
                "blueprint": blueprint,
                "outlier_examples": outliers,
                "baseline_examples": baseline_samp,
                "low_performer_examples": low_samp,
                "winning_patterns": [
                    {"id": p.get("pattern_id"), "name": p.get("name"), "description": p.get("description")}
                    for p in patterns if p.get("is_winning")
                ][:10],
                "avoid_patterns": [
                    {"id": p.get("pattern_id"), "name": p.get("name"), "description": p.get("description")}
                    for p in patterns if p.get("is_avoid")
                ][:5],
                "limitations": limitations,
                "option_angles": [
                    {"label": l, "name": n, "description": d} for l, n, d in OPTION_ANGLES
                ],
            }

            try:
                raw = await ai_engine.generate_thumbnail_prompt_variants(SYSTEM_PROMPT, payload)
                if raw and isinstance(raw, dict):
                    # Parse analysis summary
                    summ_raw = raw.get("analysis_summary", {})
                    analysis_summary = ThumbnailPromptAnalysisSummarySchema(
                        title_subject=summ_raw.get("title_subject", title),
                        title_promise=summ_raw.get("title_promise", ""),
                        viewer_tension=summ_raw.get("viewer_tension", ""),
                        recommended_hook=summ_raw.get("recommended_hook", competitor_dna.get("dominant_hook", "curiosity_gap")),
                        competitor_style_summary=summ_raw.get("competitor_style_summary", ""),
                        overlay_style_summary=summ_raw.get("overlay_style_summary", ""),
                    )

                    # Parse variants
                    raw_variants = raw.get("variants", [])
                    if isinstance(raw_variants, list):
                        for i, rv in enumerate(raw_variants[:5]):
                            parsed = _parse_ai_variant(rv, i, title, blueprint.get("negative_prompt", NEGATIVE_PROMPT_BASE))
                            if parsed is not None:
                                variants.append(parsed)

                    # Validate
                    if len(variants) == 5:
                        errs = _validate_variants(variants)
                        if not errs:
                            used_ai = True
                        else:
                            research_logger.warning(f"[PromptStudio] AI variant validation errors: {errs}")
                            variants = []
                            ai_error = f"PROMPT_VALIDATION_FAILED: {'; '.join(errs)}"

            except RuntimeError as e:
                ai_error = str(e)
                research_logger.warning(f"[PromptStudio] AI RuntimeError: {e}")
            except Exception as e:
                ai_error = str(e)
                research_logger.warning(f"[PromptStudio] AI unexpected error: {e}")

        # Deterministic fallback
        if not used_ai:
            fallback_used = True
            fallback_reason = ai_error or (
                "AI provider not configured" if provider in ("disabled", "")
                else "AI returned invalid or incomplete response"
            )
            variants = [
                _build_fallback_variant(i, title, blueprint, competitor_dna, outliers)
                for i in range(5)
            ]

        # Always ensure analysis_summary exists
        if analysis_summary is None:
            hook = competitor_dna.get("dominant_hook", "curiosity_gap")
            style = competitor_dna.get("dominant_layout", "right_subject_left_text").replace("_", " ")
            bp_mode = competitor_dna.get("blueprint_mode", "safe_default")
            analysis_summary = ThumbnailPromptAnalysisSummarySchema(
                title_subject=title,
                title_promise=f"Viewer will learn about: {title}",
                viewer_tension="Audience curiosity and desire for actionable insight",
                recommended_hook=hook,
                competitor_style_summary=f"Competitor style: {style} layout. Blueprint mode: {bp_mode}.",
                overlay_style_summary=(
                    f"Typical overlay: {competitor_dna.get('text_word_range', '3-5')} words, "
                    f"{competitor_dna.get('text_line_range', '1-2')} lines, "
                    f"{'ALL CAPS' if competitor_dna.get('text_uppercase') else 'mixed case'}."
                ),
            )

        return ThumbnailPromptGenerationResponse(
            title=title,
            channel_title=channel_title,
            provider=provider,
            model=model,
            used_ai=used_ai,
            fallback_used=fallback_used,
            fallback_reason=fallback_reason,
            analysis_summary=analysis_summary,
            variants=variants,
            generated_at=now,
        )
