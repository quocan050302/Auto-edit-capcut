"""
Thumbnail Intelligence Service — Competitor Thumbnail Intelligence V1

Orchestrates:
1. Video performance classification (outlier / baseline / low)
2. Thumbnail collection (best quality, multiple videos)
3. Individual thumbnail analysis (deterministic + AI)
4. Group comparison (outlier vs baseline vs low)
5. Pattern detection (winning / avoid)
6. Blueprint generation (reusable structure, no pixel-for-pixel copy)

Design:
- Non-blocking: each thumbnail failure is isolated
- Cache-aware: skip already-analyzed thumbnails
- Progress callbacks for real-time UI updates
- Confidence gates: no "winning" claim if N < 6
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Dict, List, Optional, Tuple

from core.logger import research_logger
from utils.thumbnail_downloader import download_thumbnail, validate_thumbnail_url, ThumbnailDownloadError
from utils.thumbnail_analyzer import (
    analyze_thumbnail,
    ThumbnailAnalysis,
    ANALYSIS_VERSION,
)

# ── Confidence thresholds ─────────────────────────────────────────────────────
MIN_SAMPLE_FOR_PATTERN = 6        # Below this: insufficient sample
MIN_COUNT_FOR_WINNING = 2         # At least 2 occurrences to call it a pattern
WINNING_PATTERN_OUTLIER_RATIO = 0.5  # Pattern must appear in ≥50% of outliers
AVOID_PATTERN_LOW_RATIO = 0.5     # Pattern appears in ≥50% of low performers
CONCURRENCY_LIMIT = 3             # Max concurrent thumbnail downloads/analyses

ProgressCallback = Callable[[str, int, int], Coroutine[Any, Any, None]]  # (stage, current, total)


# ── Sample video classification ───────────────────────────────────────────────

@dataclass
class ThumbnailSampleVideo:
    video_id: str
    title: str
    published_at: str
    age_days: float
    views: int
    views_per_day: float
    outlier_ratio: float
    performance_group: str  # outlier | baseline | low
    thumbnail_url: str
    thumbnail_quality: str = "unknown"


def classify_performance_groups(
    videos: List[Dict[str, Any]],
    channel_median_views: float,
    p75_views: float,
) -> List[ThumbnailSampleVideo]:
    """
    Classify videos into outlier / baseline / low groups using age-adjusted metrics.
    Priority: outlier_ratio > views_per_day > total_views
    """
    classified = []
    for v in videos:
        video_id = v.get("video_id", "") or v.get("id", "")
        title = v.get("title", "")
        published_at = v.get("published_at", "")
        views = int(v.get("views", 0) or 0)
        vpd = float(v.get("views_per_day", 0) or 0)
        outlier_ratio = float(v.get("outlier_ratio", 0) or 0)
        age_days = float(v.get("age_days", 1) or 1)
        thumbnail_url = v.get("thumbnail_url", "")
        thumbnail_quality = v.get("thumbnail_quality", "unknown")

        # Age-adjusted: if vpd not provided, compute it
        if vpd == 0 and views > 0 and age_days > 0:
            vpd = views / max(age_days, 1)

        # Outlier ratio: if not provided, compute vs channel median
        if outlier_ratio == 0 and channel_median_views > 0:
            outlier_ratio = views / max(channel_median_views, 1)

        # Performance group
        if outlier_ratio >= 2.0 or views >= p75_views:
            group = "outlier"
        elif outlier_ratio >= 0.5:
            group = "baseline"
        else:
            group = "low"

        if not video_id or not thumbnail_url:
            continue

        classified.append(ThumbnailSampleVideo(
            video_id=video_id,
            title=title,
            published_at=published_at,
            age_days=age_days,
            views=views,
            views_per_day=vpd,
            outlier_ratio=outlier_ratio,
            performance_group=group,
            thumbnail_url=thumbnail_url,
            thumbnail_quality=thumbnail_quality,
        ))

    return classified


def get_confidence_from_sample(n: int) -> Tuple[str, float]:
    """Map sample size to confidence label and numeric score."""
    if n < 6:
        return "insufficient", 0.1
    elif n < 12:
        return "low", 0.35
    elif n < 24:
        return "medium", 0.65
    else:
        return "high", 0.85


# ── Pattern detection ─────────────────────────────────────────────────────────

@dataclass
class ThumbnailPattern:
    pattern_id: str
    name: str
    description: str
    outlier_count: int = 0
    outlier_total: int = 0
    baseline_count: int = 0
    baseline_total: int = 0
    low_count: int = 0
    low_total: int = 0
    sample_size: int = 0
    confidence: str = "low"
    evidence_video_ids: List[str] = field(default_factory=list)
    is_winning: bool = False
    is_avoid: bool = False
    outlier_rate: float = 0.0
    control_rate: Optional[float] = None
    uplift: Optional[float] = None
    relative_lift: Optional[float] = None
    category: str = "neutral"
    reason: str = ""


def _compute_group_stats(
    analyses: List[ThumbnailAnalysis],
    group: str
) -> Dict[str, Any]:
    """Compute aggregate statistics for a performance group."""
    group_items = [a for a in analyses if a.performance_group == group]
    n = len(group_items)
    if n == 0:
        return {"n": 0}

    has_text = sum(1 for a in group_items if a.ocr.word_count > 0)
    has_face = sum(1 for a in group_items if a.subjects.has_person)
    has_proof = sum(1 for a in group_items if a.subjects.has_proof_object)
    has_arrow = sum(1 for a in group_items if a.subjects.has_arrow_circle)
    has_comparison = sum(1 for a in group_items if a.subjects.has_comparison)
    has_yellow = sum(1 for a in group_items if a.colors.has_yellow)
    has_red = sum(1 for a in group_items if a.colors.has_red)
    close_up = sum(1 for a in group_items if a.composition.shot_type == "close_up"
                   if hasattr(a.composition, "shot_type")) if False else 0

    word_counts = [a.ocr.word_count for a in group_items]
    brightness_vals = [a.colors.brightness for a in group_items]
    contrast_vals = [a.colors.contrast for a in group_items]
    sat_vals = [a.colors.saturation for a in group_items]
    mobile_scores = [a.mobile_readability.score for a in group_items]
    subject_sizes = [a.composition.subject_size_pct for a in group_items]
    outlier_ratios = [a.outlier_ratio for a in group_items]

    def _median(lst: List[float]) -> float:
        if not lst:
            return 0.0
        s = sorted(lst)
        mid = len(s) // 2
        return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2

    # Most common hook
    hook_counts: Dict[str, int] = {}
    for a in group_items:
        for h in a.hooks[:1]:
            hook_counts[h.hook_type] = hook_counts.get(h.hook_type, 0) + 1
    top_hook = max(hook_counts, key=hook_counts.get) if hook_counts else "unknown"

    # Most common layout
    layout_counts: Dict[str, int] = {}
    for a in group_items:
        lt = a.composition.layout_type
        layout_counts[lt] = layout_counts.get(lt, 0) + 1
    top_layout = max(layout_counts, key=layout_counts.get) if layout_counts else "unknown"

    return {
        "n": n,
        "has_text_pct": round(has_text / n, 2),
        "has_face_pct": round(has_face / n, 2),
        "has_proof_pct": round(has_proof / n, 2),
        "has_arrow_pct": round(has_arrow / n, 2),
        "has_comparison_pct": round(has_comparison / n, 2),
        "has_yellow_pct": round(has_yellow / n, 2),
        "has_red_pct": round(has_red / n, 2),
        "median_word_count": _median(word_counts),
        "median_brightness": _median(brightness_vals),
        "median_contrast": _median(contrast_vals),
        "median_saturation": _median(sat_vals),
        "median_mobile_score": _median(mobile_scores),
        "median_subject_size": _median(subject_sizes),
        "median_outlier_ratio": _median(outlier_ratios),
        "top_hook": top_hook,
        "top_layout": top_layout,
    }


def detect_patterns(analyses: List[ThumbnailAnalysis]) -> List[ThumbnailPattern]:
    """
    Compare outlier vs baseline vs low groups to find patterns.
    Only marks pattern as winning if N >= MIN_COUNT_FOR_WINNING.
    """
    patterns: List[ThumbnailPattern] = []

    outliers = [a for a in analyses if a.performance_group == "outlier"]
    baselines = [a for a in analyses if a.performance_group == "baseline"]
    lows = [a for a in analyses if a.performance_group == "low"]

    n_out = len(outliers)
    n_base = len(baselines)
    n_low = len(lows)

    def _pct(items: List[ThumbnailAnalysis], condition: Callable) -> Tuple[int, int]:
        count = sum(1 for a in items if condition(a))
        return count, len(items)

    def _add_pattern(
        pid: str, name: str, desc: str,
        out: Tuple[int, int], base: Tuple[int, int], low: Tuple[int, int],
        evidence_ids: List[str]
    ):
        o_cnt, o_tot = out
        b_cnt, b_tot = base
        l_cnt, l_tot = low
        total = o_tot + b_tot + l_tot

        _, conf_score = get_confidence_from_sample(total)
        if total < 6:
            conf_label = "insufficient"
        elif total < 12:
            conf_label = "low"
        elif total < 24:
            conf_label = "medium"
        else:
            conf_label = "high"

        o_ratio = o_cnt / max(o_tot, 1)
        b_ratio = b_cnt / max(b_tot, 1)
        l_ratio = l_cnt / max(l_tot, 1)

        # Weighted control rate (baseline + low)
        control_cnt = b_cnt + l_cnt
        control_tot = b_tot + l_tot
        
        has_valid_outlier_group = o_tot >= 2
        has_valid_control_group = control_tot >= 2
        
        if control_tot > 0:
            control_ratio = control_cnt / control_tot
            uplift = o_ratio - control_ratio
            relative_lift = o_ratio / max(control_ratio, 0.01)
        else:
            control_ratio = None
            uplift = None
            relative_lift = None

        is_winning = (
            has_valid_outlier_group
            and has_valid_control_group
            and o_cnt >= 2
            and o_ratio >= 0.50
            and uplift is not None and uplift >= 0.20
            and relative_lift is not None and relative_lift >= 1.25
            and conf_label != "insufficient"
        )
        
        # Avoid pattern when control rate is high, outlier rate is low
        is_avoid = (
            has_valid_control_group
            and l_cnt >= 2
            and l_ratio >= 0.50
            and o_ratio < 0.3
            and control_ratio is not None and (control_ratio - o_ratio) >= 0.20
            and conf_label != "insufficient"
        )

        # Category and reason logic
        category = "neutral"
        reason = ""
        
        if conf_label == "insufficient":
            category = "insufficient"
            reason = "Sample size is too small to draw reliable conclusions."
        elif not has_valid_control_group:
            category = "insufficient_comparison"
            reason = "No baseline or low-performing control thumbnails were available."
            is_winning = False
        elif is_winning:
            category = "winning"
            reason = f"Appears significantly more in outliers ({o_ratio:.0%}) than in control group ({control_ratio:.0%})."
        elif is_avoid:
            category = "avoid"
            reason = f"Appears mostly in low performers ({l_ratio:.0%}) compared to outliers ({o_ratio:.0%})."
        elif o_ratio >= 0.6 and b_ratio >= 0.6 and l_ratio >= 0.6 and uplift is not None and uplift < 0.2:
            category = "channel_wide"
            reason = f"Appears consistently across all groups ({o_ratio:.0%} outliers, {(control_ratio or 0):.0%} control). It's a channel style, not a differentiator."
        else:
            reason = f"Found in {o_ratio:.0%} of outliers and {(control_ratio or 0):.0%} of control. Not a strong differentiator."

        patterns.append(ThumbnailPattern(
            pattern_id=pid,
            name=name,
            description=desc,
            outlier_count=o_cnt,
            outlier_total=o_tot,
            baseline_count=b_cnt,
            baseline_total=b_tot,
            low_count=l_cnt,
            low_total=l_tot,
            sample_size=total,
            confidence=conf_label,
            evidence_video_ids=evidence_ids[:6],
            is_winning=is_winning,
            is_avoid=is_avoid,
            outlier_rate=round(o_ratio, 3),
            control_rate=round(control_ratio, 3) if control_ratio is not None else None,
            uplift=round(uplift, 3) if uplift is not None else None,
            relative_lift=round(relative_lift, 3) if relative_lift is not None else None,
            category=category,
            reason=reason,
        ))

    # Pattern: Has text overlay
    _add_pattern(
        "has_text", "Text Overlay",
        "Thumbnail includes overlaid text",
        _pct(outliers, lambda a: a.ocr.word_count > 0),
        _pct(baselines, lambda a: a.ocr.word_count > 0),
        _pct(lows, lambda a: a.ocr.word_count > 0),
        [a.video_id for a in outliers if a.ocr.word_count > 0][:6],
    )

    # Pattern: Short text (≤5 words)
    _add_pattern(
        "short_text", "Short Text (≤5 words)",
        "Overlay text is concise, 5 words or fewer",
        _pct(outliers, lambda a: 0 < a.ocr.word_count <= 5),
        _pct(baselines, lambda a: 0 < a.ocr.word_count <= 5),
        _pct(lows, lambda a: 0 < a.ocr.word_count <= 5),
        [a.video_id for a in outliers if 0 < a.ocr.word_count <= 5][:6],
    )

    # Pattern: Long text (>8 words)
    _add_pattern(
        "long_text", "Long Text (>8 words)",
        "Overlay text is verbose, more than 8 words",
        _pct(outliers, lambda a: a.ocr.word_count > 8),
        _pct(baselines, lambda a: a.ocr.word_count > 8),
        _pct(lows, lambda a: a.ocr.word_count > 8),
        [a.video_id for a in lows if a.ocr.word_count > 8][:6],
    )

    # Pattern: Has face / person
    _add_pattern(
        "has_face", "Person / Face Present",
        "Thumbnail features a visible person or face",
        _pct(outliers, lambda a: a.subjects.has_person),
        _pct(baselines, lambda a: a.subjects.has_person),
        _pct(lows, lambda a: a.subjects.has_person),
        [a.video_id for a in outliers if a.subjects.has_person][:6],
    )

    # Pattern: High contrast
    _add_pattern(
        "high_contrast", "High Visual Contrast",
        "Brightness contrast is above 0.4 (visually punchy)",
        _pct(outliers, lambda a: a.colors.contrast > 0.4),
        _pct(baselines, lambda a: a.colors.contrast > 0.4),
        _pct(lows, lambda a: a.colors.contrast > 0.4),
        [a.video_id for a in outliers if a.colors.contrast > 0.4][:6],
    )

    # Pattern: Has yellow accent
    _add_pattern(
        "has_yellow", "Yellow Accent Color",
        "Yellow is among dominant colors (high visibility)",
        _pct(outliers, lambda a: a.colors.has_yellow),
        _pct(baselines, lambda a: a.colors.has_yellow),
        _pct(lows, lambda a: a.colors.has_yellow),
        [a.video_id for a in outliers if a.colors.has_yellow][:6],
    )

    # Pattern: Has red accent
    _add_pattern(
        "has_red", "Red Accent Color",
        "Red is among dominant colors (urgency/attention)",
        _pct(outliers, lambda a: a.colors.has_red),
        _pct(baselines, lambda a: a.colors.has_red),
        _pct(lows, lambda a: a.colors.has_red),
        [a.video_id for a in outliers if a.colors.has_red][:6],
    )

    # Pattern: Has proof object
    _add_pattern(
        "has_proof", "Proof Object Present",
        "Thumbnail contains a physical proof element (document, chart, product)",
        _pct(outliers, lambda a: a.subjects.has_proof_object),
        _pct(baselines, lambda a: a.subjects.has_proof_object),
        _pct(lows, lambda a: a.subjects.has_proof_object),
        [a.video_id for a in outliers if a.subjects.has_proof_object][:6],
    )

    # Pattern: High mobile readability
    _add_pattern(
        "mobile_readable", "Mobile Readable (≥60 score)",
        "Thumbnail is highly readable on small/mobile screens",
        _pct(outliers, lambda a: a.mobile_readability.score >= 60),
        _pct(baselines, lambda a: a.mobile_readability.score >= 60),
        _pct(lows, lambda a: a.mobile_readability.score >= 60),
        [a.video_id for a in outliers if a.mobile_readability.score >= 60][:6],
    )

    # Pattern: Warm color dominant
    _add_pattern(
        "warm_color", "Warm Color Palette",
        "Thumbnail uses warm tones (red/orange/yellow dominant)",
        _pct(outliers, lambda a: a.colors.warm_cool_balance == "warm"),
        _pct(baselines, lambda a: a.colors.warm_cool_balance == "warm"),
        _pct(lows, lambda a: a.colors.warm_cool_balance == "warm"),
        [a.video_id for a in outliers if a.colors.warm_cool_balance == "warm"][:6],
    )

    # ── Combination Patterns ─────────────────────────────────────────────────
    
    # Face + Short Text
    _add_pattern(
        "face_and_short_text", "Face + Short Text",
        "Thumbnail combines a visible face with concise text (≤5 words)",
        _pct(outliers, lambda a: a.subjects.has_person and 0 < a.ocr.word_count <= 5),
        _pct(baselines, lambda a: a.subjects.has_person and 0 < a.ocr.word_count <= 5),
        _pct(lows, lambda a: a.subjects.has_person and 0 < a.ocr.word_count <= 5),
        [a.video_id for a in outliers if a.subjects.has_person and 0 < a.ocr.word_count <= 5][:6],
    )

    # Face + Yellow Accent
    _add_pattern(
        "face_and_yellow", "Face + Yellow Accent",
        "Combines human subject with highly visible yellow accent elements",
        _pct(outliers, lambda a: a.subjects.has_person and a.colors.has_yellow),
        _pct(baselines, lambda a: a.subjects.has_person and a.colors.has_yellow),
        _pct(lows, lambda a: a.subjects.has_person and a.colors.has_yellow),
        [a.video_id for a in outliers if a.subjects.has_person and a.colors.has_yellow][:6],
    )

    # Proof Object + No Face
    _add_pattern(
        "proof_no_face", "Proof Object (No Face)",
        "Features a physical proof element without competing human faces",
        _pct(outliers, lambda a: a.subjects.has_proof_object and not a.subjects.has_person),
        _pct(baselines, lambda a: a.subjects.has_proof_object and not a.subjects.has_person),
        _pct(lows, lambda a: a.subjects.has_proof_object and not a.subjects.has_person),
        [a.video_id for a in outliers if a.subjects.has_proof_object and not a.subjects.has_person][:6],
    )

    # High Contrast + Short Text
    _add_pattern(
        "contrast_and_short_text", "High Contrast + Short Text",
        "Punchy visual contrast paired with very concise text",
        _pct(outliers, lambda a: a.colors.contrast > 0.4 and 0 < a.ocr.word_count <= 5),
        _pct(baselines, lambda a: a.colors.contrast > 0.4 and 0 < a.ocr.word_count <= 5),
        _pct(lows, lambda a: a.colors.contrast > 0.4 and 0 < a.ocr.word_count <= 5),
        [a.video_id for a in outliers if a.colors.contrast > 0.4 and 0 < a.ocr.word_count <= 5][:6],
    )

    return patterns


# ── Reusable Blueprint Generator ──────────────────────────────────────────────

@dataclass
class ThumbnailBlueprint:
    id: str
    name: str
    use_when: str
    target_hook: str
    blueprint_mode: str = "validated_winning"
    is_statistically_validated: bool = False
    fallback_reason: str = ""
    source_group: str = "all"
    sample_summary: Dict[str, Any] = field(default_factory=dict)
    limitations: List[str] = field(default_factory=list)
    based_on_pattern_ids: List[str] = field(default_factory=list)
    layout_description: str = ""
    subject_recipe: str = ""
    background_recipe: str = ""
    text_recipe: str = ""
    color_recipe: str = ""
    lighting_recipe: str = ""
    hierarchy_recipe: str = ""
    title_pairing_recipe: str = ""
    overlay_text_formula: List[str] = field(default_factory=list)
    image_prompt_template: str = ""
    negative_prompt: str = ""
    evidence: List[str] = field(default_factory=list)
    confidence: str = "low"
    originality_rules: List[str] = field(default_factory=list)


STANDARD_NEGATIVE_PROMPT = (
    "unreadable text, distorted face, malformed hands, excessive objects, "
    "cluttered background, duplicated people, warped products, low contrast, "
    "tiny subject, important content in bottom-right duration zone, "
    "competitor logo, watermark, copied branding, nsfw, blurry"
)

ORIGINALITY_RULES = [
    "Keep: abstract composition, visual hierarchy, text length pattern, contrast strategy, hook category",
    "Replace: people, location, products, props, wording, color combination if too distinctive",
    "Replace: logos, brand identity, specific background details",
    "Do NOT copy faces, names, channel branding, or distinctive visual signatures",
]


def _build_observed_stats(analyses: List[ThumbnailAnalysis]) -> Dict[str, Any]:
    if not analyses:
        return {}
        
    def _mode(lst: List[Any], fallback: Any) -> Any:
        lst = [x for x in lst if x is not None and x not in ("unknown", "", 0, False)]
        if not lst:
            return fallback
        return max(set(lst), key=lst.count)

    def _median(lst: List[float], fallback: float) -> float:
        lst = [x for x in lst if x is not None]
        if not lst:
            return fallback
        s = sorted(lst)
        n = len(s)
        return s[n//2] if n % 2 else (s[n//2 - 1] + s[n//2]) / 2.0
        
    def _top_hook(a: ThumbnailAnalysis) -> str:
        if a.hooks:
            return a.hooks[0].hook_type
        return "unknown"

    stats = {
        "hook": _mode([_top_hook(a) for a in analyses], "curiosity_gap"),
        "layout": _mode([a.composition.layout_type for a in analyses], "right_subject_left_text"),
        "has_face": sum(1 for a in analyses if a.subjects.has_person) > len(analyses) / 2,
        "has_proof": sum(1 for a in analyses if a.subjects.has_proof_object) > len(analyses) / 2,
        "has_text": sum(1 for a in analyses if a.ocr.word_count > 0) > len(analyses) / 2,
        "median_words": int(_median([a.ocr.word_count for a in analyses if a.ocr.word_count > 0], 4)),
        "uses_yellow": sum(1 for a in analyses if a.colors.has_yellow) > len(analyses) / 2,
        "high_contrast": _median([a.colors.contrast for a in analyses], 0.5) > 0.6,
        "mobile_score": _median([a.mobile_readability.score for a in analyses], 50),
    }
    return stats

def _build_blueprint_from_stats(
    stats: Dict[str, Any],
    mode: str,
    channel_title: str,
    evidence_text: str,
    limitations: List[str],
    fallback_reason: str,
    source_group: str,
    validated: bool = False,
    confidence: str = "low",
    based_on_pattern_ids: List[str] = None
) -> ThumbnailBlueprint:
    # Basic logic
    layout = stats.get("layout", "right_subject_left_text")
    has_face = stats.get("has_face", True)
    has_proof = stats.get("has_proof", False)
    has_text = stats.get("has_text", True)
    median_words = stats.get("median_words", 4)
    uses_yellow = stats.get("uses_yellow", False)
    high_contrast = stats.get("high_contrast", True)
    hook = stats.get("hook", "curiosity_gap")
    if hook == "unknown":
        hook = "curiosity_gap"
        
    # Build layout
    if layout in ("left_subject_right_text", "right_subject_left_text"):
        layout_desc = "Split layout: Subject on one side, text block on opposite side. Leave margin on edges."
    elif layout == "centered":
        layout_desc = "Centered composition: Subject fills center 60% of frame, text above or below subject."
    else:
        layout_desc = "Mobile-first composition: Dominant subject filling 50–65% of frame."

    # Subject recipe
    if has_face:
        subject_recipe = "One primary subject with visible face. Expression should match the hook type. Do NOT copy specific individuals."
    elif has_proof:
        subject_recipe = "Primary visual should be a proof element (document, data, product close-up). Replace with your own content."
    else:
        subject_recipe = "One clear primary visual subject relevant to the topic. Do NOT copy competitor's specific subject."

    background_recipe = "Simple, uncluttered background with high contrast to subject."
    if high_contrast:
        background_recipe += " Use very dark or very bright background to make subject pop."

    text_recipe = f"{median_words} words max. Short, punchy text." if has_text else "No text, or absolute minimum (1-2 words). Rely completely on visual storytelling."
    color_recipe = "Warm dominant palette (yellow/orange/red)." if uses_yellow else "Balanced palette with strong contrast."
    lighting_recipe = "High contrast lighting with clear separation between foreground and background."

    overlay_formula = []
    if has_text:
        overlay_formula.append("Short phrase reflecting topic")
        if median_words > 4:
            overlay_formula.append("Optional secondary context word")

    prompt = (
        f"YouTube thumbnail. {background_recipe} {subject_recipe} "
        f"{color_recipe} {lighting_recipe} Concept relates to: {{title}}."
    )

    return ThumbnailBlueprint(
        id=f"blueprint_{mode}_{hash(channel_title) % 10000}",
        name=f"Recommended Style ({mode.replace('_', ' ').title()})",
        use_when="Default style for this channel/niche.",
        target_hook=hook,
        blueprint_mode=mode,
        is_statistically_validated=validated,
        fallback_reason=fallback_reason,
        source_group=source_group,
        sample_summary={},
        limitations=limitations,
        based_on_pattern_ids=based_on_pattern_ids or [],
        layout_description=layout_desc,
        subject_recipe=subject_recipe,
        background_recipe=background_recipe,
        text_recipe=text_recipe,
        color_recipe=color_recipe,
        lighting_recipe=lighting_recipe,
        hierarchy_recipe="Subject first, then text, then background.",
        title_pairing_recipe=f"Pair with {hook} titles.",
        overlay_text_formula=overlay_formula,
        image_prompt_template=prompt,
        negative_prompt=STANDARD_NEGATIVE_PROMPT,
        evidence=[evidence_text] if evidence_text else [],
        confidence=confidence,
        originality_rules=ORIGINALITY_RULES
    )

def generate_validated_blueprint(
    winning_patterns: List[ThumbnailPattern], 
    outlier_analyses: List[ThumbnailAnalysis], 
    channel_title: str
) -> ThumbnailBlueprint:
    stats = _build_observed_stats(outlier_analyses)
    
    uses_yellow = any(p.pattern_id == "has_yellow" for p in winning_patterns)
    has_text = any(p.pattern_id == "has_text" for p in winning_patterns)
    has_face = any(p.pattern_id == "has_face" for p in winning_patterns)
    high_contrast = any(p.pattern_id == "high_contrast" for p in winning_patterns)
    
    stats["uses_yellow"] = uses_yellow or stats.get("uses_yellow")
    stats["has_text"] = has_text or stats.get("has_text")
    stats["has_face"] = has_face or stats.get("has_face")
    stats["high_contrast"] = high_contrast or stats.get("high_contrast")
    
    return _build_blueprint_from_stats(
        stats, mode="validated_winning", channel_title=channel_title,
        evidence_text="Based on patterns that perform significantly better than baseline.",
        limitations=[], fallback_reason="", source_group="outlier",
        validated=True, confidence="high",
        based_on_pattern_ids=[p.pattern_id for p in winning_patterns[:5]]
    )

def generate_observed_outlier_blueprint(
    outlier_analyses: List[ThumbnailAnalysis], channel_title: str
) -> ThumbnailBlueprint:
    stats = _build_observed_stats(outlier_analyses)
    cnt = len(outlier_analyses)
    return _build_blueprint_from_stats(
        stats, mode="observed_outlier_style", channel_title=channel_title,
        evidence_text=f"Observed in {cnt} analyzed outlier thumbnails. Median mobile readability score: {stats.get('mobile_score', 50)}.",
        limitations=["No control group was available to validate if this style causes higher performance."],
        fallback_reason="No valid baseline/low control group was available.",
        source_group="outlier", validated=False, confidence="low"
    )

def generate_channel_style_blueprint(
    analyses: List[ThumbnailAnalysis], channel_title: str
) -> ThumbnailBlueprint:
    stats = _build_observed_stats(analyses)
    return _build_blueprint_from_stats(
        stats, mode="observed_channel_style", channel_title=channel_title,
        evidence_text=f"Observed across {len(analyses)} channel thumbnails.",
        limitations=["Pattern does not statistically distinguish high vs low performance."],
        fallback_reason="No statistically distinguishing pattern was found. Blueprint is based on recurring channel-wide traits.",
        source_group="all", validated=False, confidence="low"
    )

def generate_title_derived_blueprint(channel_title: str) -> ThumbnailBlueprint:
    return _build_blueprint_from_stats(
        {"hook": "curiosity_gap", "has_text": True, "has_face": True}, 
        mode="title_derived_fallback", channel_title=channel_title,
        evidence_text="Synthesized from mobile-first principles.",
        limitations=["Derived without visual competitor data."],
        fallback_reason="No valid thumbnail data available.",
        source_group="title", validated=False, confidence="insufficient"
    )

def generate_safe_default_blueprint(channel_title: str) -> ThumbnailBlueprint:
    prompt = "YouTube thumbnail 16:9. Simple background with depth. Single dominant subject (45-60% of frame). High contrast. Concept relates to: {title}."
    
    return ThumbnailBlueprint(
        id=f"blueprint_default_{hash(channel_title) % 10000}",
        name="Mobile-First Safe Blueprint",
        use_when="Fallback when no competitor data is available.",
        target_hook="curiosity_gap",
        blueprint_mode="safe_default",
        is_statistically_validated=False,
        fallback_reason="No competitor thumbnail could be analyzed. A safe mobile-first default blueprint is provided.",
        source_group="default",
        sample_summary={},
        limitations=["Not based on specific competitor data."],
        based_on_pattern_ids=[],
        layout_description="Single dominant subject filling 45–60% of frame. Leave clear space for text.",
        subject_recipe="One primary subject.",
        background_recipe="Simple, uncluttered background with depth.",
        text_recipe="Maximum 2 lines, 3-6 words. High contrast.",
        color_recipe="High contrast palette.",
        lighting_recipe="Bright and clear.",
        hierarchy_recipe="Subject -> Text -> Background",
        title_pairing_recipe="Curiosity gap",
        overlay_text_formula=["Short hook"],
        image_prompt_template=prompt,
        negative_prompt=STANDARD_NEGATIVE_PROMPT,
        evidence=[],
        confidence="insufficient",
        originality_rules=ORIGINALITY_RULES + ["Do NOT use competitor logos or branding."]
    )

def generate_blueprints(
    patterns: List[ThumbnailPattern],
    group_stats: Dict[str, Dict],
    analyses: List[ThumbnailAnalysis],
    channel_title: str = "",
) -> List[ThumbnailBlueprint]:
    
    winning = [p for p in patterns if p.is_winning and p.confidence != "insufficient"]
    outliers = [a for a in analyses if a.performance_group == "outlier"]
    
    if winning:
        blueprints = [generate_validated_blueprint(winning, outliers or analyses, channel_title)]
    elif outliers:
        blueprints = [generate_observed_outlier_blueprint(outliers, channel_title)]
    elif analyses:
        blueprints = [generate_channel_style_blueprint(analyses, channel_title)]
    elif channel_title:
        blueprints = [generate_safe_default_blueprint(channel_title)]
    else:
        blueprints = [generate_safe_default_blueprint("Competitor")]
        
    assert len(blueprints) >= 1
    if not blueprints:
        blueprints = [generate_safe_default_blueprint(channel_title)]
        
    outlier_count = sum(1 for a in analyses if a.performance_group == "outlier")
    baseline_count = sum(1 for a in analyses if a.performance_group == "baseline")
    low_count = sum(1 for a in analyses if a.performance_group == "low")
    has_valid_control_group = (baseline_count + low_count) >= 2
    
    for b in blueprints:
        b.sample_summary = {
            "total_analyzed": len(analyses),
            "outlier_count": outlier_count,
            "baseline_count": baseline_count,
            "low_count": low_count,
            "has_valid_control_group": has_valid_control_group,
            "blueprint_mode": b.blueprint_mode,
        }
        
    return blueprints



@dataclass
class ThumbnailIntelligenceResult:
    channel_id: str
    analyzed_count: int = 0
    cached_count: int = 0
    failed_count: int = 0
    skipped_count: int = 0
    outlier_count: int = 0
    baseline_count: int = 0
    low_count: int = 0
    overall_confidence: str = "insufficient"
    confidence_score: float = 0.0
    analyses: List[ThumbnailAnalysis] = field(default_factory=list)
    patterns: List[ThumbnailPattern] = field(default_factory=list)
    winning_patterns: List[ThumbnailPattern] = field(default_factory=list)
    avoid_patterns: List[ThumbnailPattern] = field(default_factory=list)
    blueprints: List[ThumbnailBlueprint] = field(default_factory=list)
    group_stats: Dict[str, Dict] = field(default_factory=dict)
    analysis_version: str = ANALYSIS_VERSION
    provider: str = "deterministic"
    limitations: List[str] = field(default_factory=list)
    failure_details: List[Dict] = field(default_factory=list)
    created_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        return d


class ThumbnailIntelligenceService:
    """
    Orchestrates the full thumbnail intelligence pipeline.
    Safe to call after competitor_service.analyze_channel().
    Does NOT affect channel baseline analysis on failure.
    """

    def __init__(self, ai_engine=None):
        self.ai_engine = ai_engine  # Optional AiInsightsEngine
        
        from providers.ocr_provider import ThumbnailOcrProvider
        self.ocr_provider = ThumbnailOcrProvider()
        
        # Simple in-memory cache: thumbnail_hash → ThumbnailAnalysis dict
        self._cache: Dict[str, ThumbnailAnalysis] = {}

    def _cache_key(self, video_id: str, thumbnail_url: str) -> str:
        return hashlib.sha256(f"{video_id}::{thumbnail_url}::{ANALYSIS_VERSION}".encode()).hexdigest()[:16]

    async def run(
        self,
        channel_id: str,
        channel_title: str,
        videos: List[Dict[str, Any]],
        channel_median_views: float,
        p75_views: float,
        on_progress: Optional[ProgressCallback] = None,
        max_videos: int = 30,
    ) -> ThumbnailIntelligenceResult:
        """
        Run the full thumbnail intelligence pipeline.
        Returns ThumbnailIntelligenceResult — never raises.
        """
        result = ThumbnailIntelligenceResult(
            channel_id=channel_id,
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        async def _progress(stage: str, current: int, total: int):
            if on_progress:
                try:
                    await on_progress(stage, current, total)
                except Exception:
                    pass

        try:
            # ── Step 1: Classify ───────────────────────────────────────────────
            await _progress("Classifying performance groups", 0, 1)
            sample_videos = classify_performance_groups(
                videos, channel_median_views, p75_views
            )
            # Trim to max_videos, balanced across groups
            sample_videos = _balance_sample(sample_videos, max_videos)

            n_total = len(sample_videos)
            conf_label, conf_score = get_confidence_from_sample(n_total)
            result.overall_confidence = conf_label
            result.confidence_score = conf_score

            if n_total == 0:
                result.limitations.append("No videos with thumbnail URLs found")
                return result

            # ── Step 2: Download + Analyze (concurrency limited) ───────────────
            semaphore = asyncio.Semaphore(CONCURRENCY_LIMIT)
            analyses: List[ThumbnailAnalysis] = []
            fail_details: List[Dict] = []

            async def _process_one(sv: ThumbnailSampleVideo, idx: int):
                async with semaphore:
                    await _progress("Collecting thumbnails", idx + 1, n_total)
                    cache_key = self._cache_key(sv.video_id, sv.thumbnail_url)

                    # Cache hit
                    if cache_key in self._cache:
                        result.cached_count += 1
                        analyses.append(self._cache[cache_key])
                        return

                    # Download
                    try:
                        url_safe = validate_thumbnail_url(sv.thumbnail_url)
                        await _progress("Downloading thumbnail", idx + 1, n_total)
                        image_data = await download_thumbnail(url_safe)
                    except ThumbnailDownloadError as e:
                        result.failed_count += 1
                        fail_details.append({
                            "video_id": sv.video_id,
                            "title": sv.title,
                            "reason": str(e),
                            "stage": "download",
                        })
                        research_logger.warning(f"[ThumbnailIntel] Download failed {sv.video_id}: {e}")
                        return
                    except Exception as e:
                        result.failed_count += 1
                        fail_details.append({
                            "video_id": sv.video_id,
                            "title": sv.title,
                            "reason": f"Unexpected: {e}",
                            "stage": "download",
                        })
                        return

                    # Run OCR
                    ocr_result = None
                    if self.ocr_provider:
                        try:
                            ocr_result = await self.ocr_provider.analyze(image_data)
                        except Exception as e:
                            research_logger.warning(f"[ThumbnailIntel] OCR failed for {sv.video_id}: {e}")

                    # Analyze
                    await _progress("Analyzing thumbnail", idx + 1, n_total)
                    analysis = await analyze_thumbnail(
                        image_data=image_data,
                        video_id=sv.video_id,
                        video_title=sv.title,
                        thumbnail_url=sv.thumbnail_url,
                        thumbnail_quality=sv.thumbnail_quality,
                        performance_group=sv.performance_group,
                        views=sv.views,
                        views_per_day=sv.views_per_day,
                        outlier_ratio=sv.outlier_ratio,
                        video_age_days=sv.age_days,
                        ai_engine=self.ai_engine,
                        ocr_result=ocr_result,
                    )

                    self._cache[cache_key] = analysis
                    result.analyzed_count += 1
                    analyses.append(analysis)

            tasks = [_process_one(sv, i) for i, sv in enumerate(sample_videos)]
            await asyncio.gather(*tasks)

            result.failure_details = fail_details
            result.analyses = analyses

            # Count groups
            result.outlier_count = sum(1 for a in analyses if a.performance_group == "outlier")
            result.baseline_count = sum(1 for a in analyses if a.performance_group == "baseline")
            result.low_count = sum(1 for a in analyses if a.performance_group == "low")

            if not analyses:
                result.limitations.append("All thumbnail downloads or analyses failed")
                return result

            # ── Step 3: Compare groups ─────────────────────────────────────────
            await _progress("Comparing outliers with baseline", n_total, n_total)
            group_stats = {
                "outlier": _compute_group_stats(analyses, "outlier"),
                "baseline": _compute_group_stats(analyses, "baseline"),
                "low": _compute_group_stats(analyses, "low"),
            }
            result.group_stats = group_stats

            # ── Step 4: Pattern detection ──────────────────────────────────────
            await _progress("Building reusable thumbnail patterns", n_total, n_total)
            patterns = detect_patterns(analyses)
            result.patterns = patterns
            result.winning_patterns = [p for p in patterns if p.is_winning]
            result.avoid_patterns = [p for p in patterns if p.is_avoid]

            # Limitations
            if conf_label == "insufficient":
                result.limitations.append(
                    f"Only {n_total} thumbnails analyzed — below minimum 6. "
                    "Confidence is insufficient for reliable patterns."
                )
            elif conf_label == "low":
                result.limitations.append(
                    f"Only {n_total} thumbnails analyzed — low confidence. "
                    "Patterns may not generalize."
                )

            if result.failed_count > 0:
                result.limitations.append(
                    f"{result.failed_count} thumbnail(s) could not be downloaded or analyzed."
                )

            if result.outlier_count < 2:
                result.limitations.append(
                    "Fewer than 2 outlier videos available. "
                    "Winning pattern comparison requires at least 2 outlier thumbnails."
                )

            # ── Step 5: Blueprint generation ──────────────────────────────────
            await _progress("Generating thumbnail blueprints", n_total, n_total)
            blueprints = generate_blueprints(
                patterns, group_stats, analyses, channel_title
            )
            result.blueprints = blueprints

            result.provider = "deterministic" if (
                not analyses or analyses[0].provider == "deterministic"
            ) else "ai_vision"

        except Exception as e:
            result.limitations.append(f"Thumbnail intelligence pipeline error: {type(e).__name__}: {e}")
            research_logger.error(f"[ThumbnailIntel] Pipeline error for {channel_id}: {e}", exc_info=True)

        return result


def _balance_sample(
    videos: List[ThumbnailSampleVideo],
    max_total: int
) -> List[ThumbnailSampleVideo]:
    """
    Return balanced sample of max_total videos across groups.
    Quota: 40% Outlier, 35% Baseline, 25% Low.
    """
    # Remove duplicates and empty thumbnails
    seen = set()
    unique_videos = []
    for v in videos:
        if v.video_id not in seen and v.thumbnail_url:
            seen.add(v.video_id)
            unique_videos.append(v)
            
    outliers = [v for v in unique_videos if v.performance_group == "outlier"]
    baselines = [v for v in unique_videos if v.performance_group == "baseline"]
    lows = [v for v in unique_videos if v.performance_group == "low"]

    # Sort each group
    outliers.sort(key=lambda v: -v.outlier_ratio)
    baselines.sort(key=lambda v: abs(1.0 - v.outlier_ratio))  # closest to median first
    lows.sort(key=lambda v: v.outlier_ratio)  # worst performers first for low

    # Target quotas
    o_target = int(max_total * 0.40)
    b_target = int(max_total * 0.35)
    l_target = max_total - o_target - b_target

    # Actual lengths
    o_len = len(outliers)
    b_len = len(baselines)
    l_len = len(lows)

    # First pass: take what we can up to target
    o_take = min(o_target, o_len)
    b_take = min(b_target, b_len)
    l_take = min(l_target, l_len)

    # Redistribute shortfall
    shortfall = max_total - (o_take + b_take + l_take)
    
    # Give remaining slots to groups that have extra capacity
    while shortfall > 0:
        allocated = False
        if o_take < o_len and shortfall > 0:
            o_take += 1
            shortfall -= 1
            allocated = True
        if b_take < b_len and shortfall > 0:
            b_take += 1
            shortfall -= 1
            allocated = True
        if l_take < l_len and shortfall > 0:
            l_take += 1
            shortfall -= 1
            allocated = True
        if not allocated:
            break # No group has extra capacity

    result = outliers[:o_take] + baselines[:b_take] + lows[:l_take]
    return result
