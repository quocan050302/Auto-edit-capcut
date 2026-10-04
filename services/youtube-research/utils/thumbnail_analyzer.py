"""
Thumbnail Analyzer — Competitor Thumbnail Intelligence V1

Two-layer analysis:
1. Deterministic layer: dimensions, colors, brightness, contrast, edge density
2. AI/vision layer: composition, subjects, hooks, text (optional, uses existing AI engine)

Analysis is returned as structured JSON.
OCR: basic pixel-based text detection (deterministic fallback if no AI).
Vision: uses existing AI engine (Gemini / Ollama) in multimodal mode if available.

Design contract:
- analyze_thumbnail() never raises; returns partial results with warnings
- AI failure → falls back to deterministic-only result
- Invalid image → returns error dict with is_error=True
- No fabricated CTR
- No causation claims
"""

from __future__ import annotations

import colorsys
import hashlib
import io
import json
import re
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple

from core.logger import research_logger

ANALYSIS_VERSION = "1.0.0"
MIN_FACE_AREA = 0.01   # 1% of frame is a detectable face
HOOK_TYPES = [
    "curiosity_gap", "shock_surprise", "fear_danger", "money_value",
    "transformation", "before_after", "hidden_truth", "proof_evidence",
    "authority_expert", "mistake_warning", "scarcity_urgency",
    "contradiction", "scale_comparison", "identity_community",
    "outcome_result", "mystery", "unknown"
]


# ── Data structures ──────────────────────────────────────────────────────────

@dataclass
class NormalizedBox:
    x: float = 0.0
    y: float = 0.0
    width: float = 1.0
    height: float = 1.0


@dataclass
class DominantColor:
    hex: str = "#000000"
    rgb: Tuple[int, int, int] = (0, 0, 0)
    fraction: float = 0.0
    label: str = ""


@dataclass
class ThumbnailOcrAnalysis:
    text: str = ""
    word_count: int = 0
    line_count: int = 0
    char_count: int = 0
    has_uppercase: bool = False
    uppercase_ratio: float = 0.0
    has_numbers: bool = False
    has_currency: bool = False
    has_question: bool = False
    has_exclamation: bool = False
    repeats_title: bool = False
    text_coverage_pct: float = 0.0
    text_alignment: str = "unknown"
    confidence: float = 0.0
    is_uncertain: bool = True
    font_category: str = "unknown"


@dataclass
class ThumbnailCompositionAnalysis:
    layout_type: str = "unknown"
    main_focal_point: str = "unknown"
    has_negative_space: bool = False
    background_complexity: str = "unknown"
    subject_size_pct: float = 0.0
    face_size_pct: float = 0.0
    main_subject_box: Optional[NormalizedBox] = None
    text_region_box: Optional[NormalizedBox] = None
    duration_badge_risk: bool = False


@dataclass
class ThumbnailSubjectAnalysis:
    has_person: bool = False
    person_count: int = 0
    face_count: int = 0
    shot_type: str = "unknown"
    facial_expression: str = "unknown"
    gaze_direction: str = "unknown"
    has_proof_object: bool = False
    has_arrow_circle: bool = False
    has_comparison: bool = False
    has_contradiction: bool = False


@dataclass
class ThumbnailColorAnalysis:
    dominant_colors: List[DominantColor] = field(default_factory=list)
    background_color: str = "#000000"
    accent_color: str = "#ffffff"
    warm_cool_balance: str = "neutral"
    saturation: float = 0.0
    brightness: float = 0.0
    contrast: float = 0.0
    has_yellow: bool = False
    has_red: bool = False


@dataclass
class ThumbnailHook:
    hook_type: str = "unknown"
    confidence: float = 0.0
    visual_evidence: str = ""
    text_evidence: str = ""
    title_evidence: str = ""


@dataclass
class ThumbnailTitlePairing:
    relationship: str = "unknown"
    redundancy_pct: float = 0.0
    has_curiosity_gap: bool = False
    has_promise_mismatch: bool = False
    thumbnail_adds: str = ""


@dataclass
class MobileReadability:
    score: int = 0
    text_readable: bool = False
    face_recognizable: bool = False
    main_object_clear: bool = False
    duration_badge_overlap_risk: bool = True
    breakdown: Dict[str, int] = field(default_factory=dict)


@dataclass
class ThumbnailAnalysis:
    video_id: str = ""
    video_title: str = ""
    thumbnail_url: str = ""
    thumbnail_hash: str = ""
    thumbnail_quality: str = "unknown"
    width: int = 0
    height: int = 0
    performance_group: str = "baseline"  # outlier | baseline | low
    views: int = 0
    views_per_day: float = 0.0
    outlier_ratio: float = 0.0
    video_age_days: float = 0.0
    ocr: ThumbnailOcrAnalysis = field(default_factory=ThumbnailOcrAnalysis)
    composition: ThumbnailCompositionAnalysis = field(default_factory=ThumbnailCompositionAnalysis)
    subjects: ThumbnailSubjectAnalysis = field(default_factory=ThumbnailSubjectAnalysis)
    colors: ThumbnailColorAnalysis = field(default_factory=ThumbnailColorAnalysis)
    hooks: List[ThumbnailHook] = field(default_factory=list)
    title_pairing: ThumbnailTitlePairing = field(default_factory=ThumbnailTitlePairing)
    mobile_readability: MobileReadability = field(default_factory=MobileReadability)
    provider: str = "deterministic"
    model: Optional[str] = None
    analysis_version: str = ANALYSIS_VERSION
    confidence: float = 0.0
    warnings: List[str] = field(default_factory=list)
    is_error: bool = False
    error_reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        return d


# ── Deterministic Color Extraction ──────────────────────────────────────────

def _extract_dominant_colors(image_data: bytes, n: int = 6) -> List[DominantColor]:
    """
    Extract dominant colors using PIL quantize.
    Returns up to n dominant colors sorted by frequency.
    """
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(image_data)).convert("RGB")
        img_small = img.resize((80, 45), Image.LANCZOS)
        quantized = img_small.quantize(colors=n, method=Image.Quantize.MEDIANCUT).convert("RGB")

        # Count pixels per color
        pixels = list(quantized.get_flattened_data())
        color_counts: Dict[Tuple[int, int, int], int] = {}
        for px in pixels:
            color_counts[px] = color_counts.get(px, 0) + 1

        total = len(pixels)
        colors = []
        for (r, g, b), count in sorted(color_counts.items(), key=lambda x: -x[1])[:n]:
            hex_color = f"#{r:02x}{g:02x}{b:02x}"
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            label = _label_color(h, s, v)
            colors.append(DominantColor(
                hex=hex_color,
                rgb=(r, g, b),
                fraction=round(count / total, 3),
                label=label
            ))
        return colors
    except Exception as e:
        research_logger.debug(f"[ThumbnailAnalyzer] Color extraction failed: {e}")
        return []


def _label_color(h: float, s: float, v: float) -> str:
    """Label a color given HSV values (0–1 range)."""
    if v < 0.15:
        return "black"
    if v > 0.9 and s < 0.1:
        return "white"
    if s < 0.15:
        return "gray"
    h_deg = h * 360
    if h_deg < 20 or h_deg >= 345:
        return "red"
    if h_deg < 45:
        return "orange"
    if h_deg < 70:
        return "yellow"
    if h_deg < 150:
        return "green"
    if h_deg < 195:
        return "cyan"
    if h_deg < 265:
        return "blue"
    if h_deg < 300:
        return "purple"
    return "pink"


def _compute_brightness_contrast(image_data: bytes) -> Tuple[float, float, float]:
    """
    Returns (brightness, contrast, saturation) as 0–1 floats.
    """
    try:
        from PIL import Image, ImageStat
        img = Image.open(io.BytesIO(image_data)).convert("RGB")
        img_small = img.resize((160, 90), Image.LANCZOS)
        stat = ImageStat.Stat(img_small)
        r_mean, g_mean, b_mean = stat.mean[0], stat.mean[1], stat.mean[2]
        r_std, g_std, b_std = stat.stddev[0], stat.stddev[1], stat.stddev[2]
        brightness = round((0.299 * r_mean + 0.587 * g_mean + 0.114 * b_mean) / 255, 3)
        # Contrast = avg stddev normalized
        contrast = round((r_std + g_std + b_std) / (3 * 128), 3)
        # Saturation: average saturation via HSV
        pixels = list(img_small.get_flattened_data())
        sat_sum = sum(
            colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[1]
            for r, g, b in pixels
        )
        saturation = round(sat_sum / max(len(pixels), 1), 3)
        return brightness, contrast, saturation
    except Exception:
        return 0.5, 0.5, 0.5


def _get_image_dimensions(image_data: bytes) -> Tuple[int, int]:
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(image_data))
        return img.width, img.height
    except Exception:
        return 0, 0


# ── OCR: Deterministic text detection (PLACEHOLDER, real OCR via AI) ─────────

def _basic_text_analysis(title: str, thumbnail_url: str) -> ThumbnailOcrAnalysis:
    """
    Deterministic text analysis without actual OCR.
    In the absence of a real OCR engine, returns uncertain result.
    Real OCR comes from AI vision layer.
    """
    return ThumbnailOcrAnalysis(
        text="",
        word_count=0,
        line_count=0,
        char_count=0,
        confidence=0.0,
        is_uncertain=True,
    )


# ── Mobile Readability Score ─────────────────────────────────────────────────

def _compute_mobile_readability(
    brightness: float,
    contrast: float,
    subject_size_pct: float,
    has_text: bool,
    word_count: int,
) -> MobileReadability:
    """
    Heuristic mobile readability score (0–100).
    Breakdown:
    - Contrast: 0–30
    - Subject size: 0–25
    - Text clarity: 0–25
    - Brightness: 0–20
    """
    breakdown: Dict[str, int] = {}

    # Contrast score (higher contrast = better mobile visibility)
    c_score = min(30, int(contrast * 50))
    breakdown["contrast"] = c_score

    # Subject size score (larger subject = easier to see on small screen)
    s_score = min(25, int(subject_size_pct * 50))
    breakdown["subject_size"] = s_score

    # Text clarity (fewer words = more readable on mobile)
    if not has_text:
        t_score = 20  # No text overlay = neutral
    elif word_count <= 4:
        t_score = 25
    elif word_count <= 7:
        t_score = 18
    elif word_count <= 12:
        t_score = 10
    else:
        t_score = 3
    breakdown["text_clarity"] = t_score

    # Brightness (0.2–0.8 is optimal, extremes penalized)
    if 0.2 <= brightness <= 0.8:
        b_score = 20
    elif brightness < 0.1 or brightness > 0.95:
        b_score = 5
    else:
        b_score = 12
    breakdown["brightness"] = b_score

    total = c_score + s_score + t_score + b_score
    return MobileReadability(
        score=min(100, total),
        text_readable=t_score >= 18,
        face_recognizable=subject_size_pct > 0.1,
        main_object_clear=subject_size_pct > 0.05 and contrast > 0.3,
        duration_badge_overlap_risk=True,  # conservative default
        breakdown=breakdown
    )


# ── Hook detection (deterministic from title + AI) ──────────────────────────

def _detect_hooks_from_title(title: str) -> List[ThumbnailHook]:
    """Deterministic hook detection from video title text."""
    hooks = []
    lower = title.lower()

    patterns = [
        ("why", "curiosity_gap"),
        ("how", "curiosity_gap"),
        ("secret", "hidden_truth"),
        ("truth", "hidden_truth"),
        ("never knew", "hidden_truth"),
        ("shocking", "shock_surprise"),
        ("unbelievable", "shock_surprise"),
        ("warning", "mistake_warning"),
        ("mistake", "mistake_warning"),
        ("before", "before_after"),
        ("after", "before_after"),
        ("vs", "scale_comparison"),
        ("versus", "scale_comparison"),
        ("$", "money_value"),
        ("million", "money_value"),
        ("billion", "money_value"),
        ("income", "money_value"),
        ("danger", "fear_danger"),
        ("fear", "fear_danger"),
        ("proof", "proof_evidence"),
        ("evidence", "proof_evidence"),
        ("expert", "authority_expert"),
        ("study", "authority_expert"),
    ]

    seen_types: set = set()
    for keyword, hook_type in patterns:
        if keyword in lower and hook_type not in seen_types:
            seen_types.add(hook_type)
            hooks.append(ThumbnailHook(
                hook_type=hook_type,
                confidence=0.5,
                title_evidence=f"Title contains '{keyword}'",
            ))
        if len(hooks) >= 3:
            break

    if not hooks:
        hooks.append(ThumbnailHook(
            hook_type="unknown",
            confidence=0.2,
            title_evidence="No strong hook detected in title",
        ))

    return hooks


# ── Title–Thumbnail Pairing ──────────────────────────────────────────────────

def _analyze_title_pairing(title: str, ocr_text: str) -> ThumbnailTitlePairing:
    """Compare OCR text with title to detect redundancy vs complementarity."""
    if not ocr_text:
        return ThumbnailTitlePairing(
            relationship="unknown",
            redundancy_pct=0.0,
            has_curiosity_gap=False,
            thumbnail_adds="No text overlay detected",
        )

    title_words = set(re.sub(r"[^\w\s]", "", title.lower()).split())
    ocr_words = set(re.sub(r"[^\w\s]", "", ocr_text.lower()).split())
    common = title_words & ocr_words

    redundancy = len(common) / max(len(title_words), 1)

    if redundancy > 0.7:
        relationship = "redundant"
    elif redundancy > 0.3:
        relationship = "partially_complementary"
    elif ocr_words:
        relationship = "complementary"
    else:
        relationship = "unknown"

    return ThumbnailTitlePairing(
        relationship=relationship,
        redundancy_pct=round(redundancy, 2),
        has_curiosity_gap=redundancy < 0.4 and bool(ocr_words),
        thumbnail_adds="Thumbnail text adds context not in title" if redundancy < 0.4 else "",
    )


# ── Main Analyzer ─────────────────────────────────────────────────────────────

async def analyze_thumbnail(
    image_data: bytes,
    video_id: str,
    video_title: str,
    thumbnail_url: str,
    thumbnail_quality: str,
    performance_group: str,
    views: int,
    views_per_day: float,
    outlier_ratio: float,
    video_age_days: float,
    ai_engine=None,  # Optional: AiInsightsEngine instance
    ocr_result: Optional[ThumbnailOcrAnalysis] = None,
) -> ThumbnailAnalysis:
    """
    Analyze a thumbnail image. Returns ThumbnailAnalysis.
    Never raises — returns partial result with warnings on any error.
    """
    result = ThumbnailAnalysis(
        video_id=video_id,
        video_title=video_title,
        thumbnail_url=thumbnail_url,
        thumbnail_quality=thumbnail_quality,
        performance_group=performance_group,
        views=views,
        views_per_day=views_per_day,
        outlier_ratio=outlier_ratio,
        video_age_days=video_age_days,
        thumbnail_hash=hashlib.sha256(image_data).hexdigest()[:16],
    )

    try:
        # ── Layer 1: Deterministic ────────────────────────────────────────────
        width, height = _get_image_dimensions(image_data)
        result.width = width
        result.height = height

        colors = _extract_dominant_colors(image_data, n=6)
        brightness, contrast, saturation = _compute_brightness_contrast(image_data)

        # Color analysis
        has_yellow = any(c.label == "yellow" for c in colors)
        has_red = any(c.label == "red" for c in colors)
        bg_color = colors[0].hex if colors else "#000000"
        accent_color = colors[1].hex if len(colors) > 1 else "#ffffff"

        # Warm/cool balance
        warm_labels = {"red", "orange", "yellow"}
        cool_labels = {"blue", "cyan", "purple"}
        warm_count = sum(1 for c in colors if c.label in warm_labels)
        cool_count = sum(1 for c in colors if c.label in cool_labels)
        warm_cool = "warm" if warm_count > cool_count else ("cool" if cool_count > warm_count else "neutral")

        result.colors = ThumbnailColorAnalysis(
            dominant_colors=colors,
            background_color=bg_color,
            accent_color=accent_color,
            warm_cool_balance=warm_cool,
            saturation=saturation,
            brightness=brightness,
            contrast=contrast,
            has_yellow=has_yellow,
            has_red=has_red,
        )

        # Real OCR
        if ocr_result:
            result.ocr = ocr_result
        else:
            result.ocr = _basic_text_analysis(video_title, thumbnail_url)

        # Title hooks from title text
        result.hooks = _detect_hooks_from_title(video_title)

        # Basic composition from image
        result.composition = ThumbnailCompositionAnalysis(
            layout_type="unknown",
            main_focal_point="unknown",
            has_negative_space=False,
            background_complexity="medium" if contrast > 0.4 else "low",
            subject_size_pct=0.0,
            face_size_pct=0.0,
            duration_badge_risk=True,
        )

        result.subjects = ThumbnailSubjectAnalysis()
        result.mobile_readability = _compute_mobile_readability(
            brightness=brightness,
            contrast=contrast,
            subject_size_pct=0.0,
            has_text=False,
            word_count=0,
        )
        result.title_pairing = _analyze_title_pairing(video_title, "")
        result.confidence = 0.3  # deterministic only
        result.provider = "deterministic"
        result.warnings.append("Vision AI unavailable — deterministic analysis only")

        # ── Layer 2: AI/Vision (if engine available) ──────────────────────────
        if ai_engine is not None:
            try:
                ai_result = await _run_ai_thumbnail_analysis(
                    ai_engine=ai_engine,
                    image_data=image_data,
                    video_title=video_title,
                    performance_group=performance_group,
                    views=views,
                    views_per_day=views_per_day,
                    outlier_ratio=outlier_ratio,
                    channel_median_views=0.0,
                )
                if ai_result:
                    _merge_ai_result(result, ai_result)
                    # Clear the deterministic-only warning
                    result.warnings = [
                        w for w in result.warnings
                        if "deterministic" not in w
                    ]
            except Exception as ai_err:
                result.warnings.append(f"AI vision failed: {type(ai_err).__name__} — using deterministic result")
                research_logger.warning(f"[ThumbnailAnalyzer] AI failed for {video_id}: {ai_err}")

    except Exception as e:
        result.is_error = True
        result.error_reason = f"{type(e).__name__}: {e}"
        result.confidence = 0.0
        result.warnings.append(f"Analysis error: {result.error_reason}")
        research_logger.warning(f"[ThumbnailAnalyzer] Error analyzing {video_id}: {e}")

    return result


async def _run_ai_thumbnail_analysis(
    ai_engine,
    image_data: bytes,
    video_title: str,
    performance_group: str,
    views: int,
    views_per_day: float,
    outlier_ratio: float,
    channel_median_views: float,
) -> Optional[Dict[str, Any]]:
    """
    Call the AI engine's vision capability (if supported) to analyze the thumbnail.
    Returns parsed dict or None.
    """
    # Check if ai_engine supports vision
    if not hasattr(ai_engine, 'analyze_thumbnail_vision'):
        return None
    try:
        result = await ai_engine.analyze_thumbnail_vision(
            image_data=image_data,
            context={
                "video_title": video_title,
                "performance_group": performance_group,
                "views": views,
                "views_per_day": views_per_day,
                "outlier_ratio": outlier_ratio,
                "channel_median_views": channel_median_views,
            }
        )
        return result
    except Exception:
        return None


def _merge_ai_result(result: ThumbnailAnalysis, ai_data: Dict[str, Any]) -> None:
    """Merge AI vision output into existing deterministic result."""
    if not isinstance(ai_data, dict):
        return

    result.provider = "ai_vision"
    result.confidence = float(ai_data.get("confidence", 0.6))

    # OCR
    ocr = ai_data.get("ocr", {})
    if ocr and isinstance(ocr, dict):
        text = ocr.get("text", "")
        words = text.split() if text else []
        result.ocr = ThumbnailOcrAnalysis(
            text=text,
            word_count=len(words),
            line_count=ocr.get("line_count", len(text.split("\n")) if text else 0),
            char_count=len(text),
            has_uppercase=bool(re.search(r"[A-Z]", text)),
            uppercase_ratio=round(sum(1 for c in text if c.isupper()) / max(len(text), 1), 2),
            has_numbers=bool(re.search(r"\d", text)),
            has_currency=bool(re.search(r"[$€£¥]", text)),
            has_question="?" in text,
            has_exclamation="!" in text,
            text_coverage_pct=float(ocr.get("text_coverage_pct", 0.0)),
            text_alignment=ocr.get("text_alignment", "unknown"),
            confidence=float(ocr.get("confidence", 0.5)),
            is_uncertain=float(ocr.get("confidence", 0.5)) < 0.6,
            font_category=ocr.get("font_category", "unknown"),
        )
        # Preserve regions if they were previously computed
        if hasattr(result.ocr, "regions"):
            result.ocr.regions = result.ocr.regions
        result.title_pairing = _analyze_title_pairing(result.video_title, text)

    # Composition
    comp = ai_data.get("composition", {})
    if comp and isinstance(comp, dict):
        msb = comp.get("main_subject_box")
        trb = comp.get("text_region_box")
        result.composition = ThumbnailCompositionAnalysis(
            layout_type=comp.get("layout_type", "unknown"),
            main_focal_point=comp.get("main_focal_point", "unknown"),
            has_negative_space=bool(comp.get("has_negative_space", False)),
            background_complexity=comp.get("background_complexity", "medium"),
            subject_size_pct=float(comp.get("subject_size_pct", 0.0)),
            face_size_pct=float(comp.get("face_size_pct", 0.0)),
            main_subject_box=NormalizedBox(**msb) if msb else None,
            text_region_box=NormalizedBox(**trb) if trb else None,
            duration_badge_risk=bool(comp.get("duration_badge_risk", True)),
        )

    # Subjects
    subj = ai_data.get("subjects", {})
    if subj and isinstance(subj, dict):
        result.subjects = ThumbnailSubjectAnalysis(
            has_person=bool(subj.get("has_person", False)),
            person_count=int(subj.get("person_count", 0)),
            face_count=int(subj.get("face_count", 0)),
            shot_type=subj.get("shot_type", "unknown"),
            facial_expression=subj.get("facial_expression", "unknown"),
            gaze_direction=subj.get("gaze_direction", "unknown"),
            has_proof_object=bool(subj.get("has_proof_object", False)),
            has_arrow_circle=bool(subj.get("has_arrow_circle", False)),
            has_comparison=bool(subj.get("has_comparison", False)),
            has_contradiction=bool(subj.get("has_contradiction", False)),
        )

    # Hooks
    hooks_raw = ai_data.get("hooks", [])
    if hooks_raw and isinstance(hooks_raw, list):
        result.hooks = [
            ThumbnailHook(
                hook_type=h.get("hook_type", "unknown"),
                confidence=float(h.get("confidence", 0.5)),
                visual_evidence=h.get("visual_evidence", ""),
                text_evidence=h.get("text_evidence", ""),
                title_evidence=h.get("title_evidence", ""),
            )
            for h in hooks_raw
            if isinstance(h, dict)
        ]

    # Mobile readability
    mob = ai_data.get("mobile_readability", {})
    if mob and isinstance(mob, dict):
        result.mobile_readability = MobileReadability(
            score=int(mob.get("score", result.mobile_readability.score)),
            text_readable=bool(mob.get("text_readable", False)),
            face_recognizable=bool(mob.get("face_recognizable", False)),
            main_object_clear=bool(mob.get("main_object_clear", False)),
            duration_badge_overlap_risk=bool(mob.get("duration_badge_overlap_risk", True)),
            breakdown=mob.get("breakdown", {}),
        )


# ── AI Vision Prompt Builder ─────────────────────────────────────────────────

def build_thumbnail_vision_prompt(
    video_title: str,
    performance_group: str,
    views: int,
    views_per_day: float,
    outlier_ratio: float,
) -> str:
    """Build the prompt sent to the vision model."""
    return f"""You are analyzing a YouTube thumbnail image for intelligence research.

Context:
- Video title: {video_title!r}
- Performance group: {performance_group} (outlier | baseline | low)
- Views: {views:,}
- Views/day: {views_per_day:.1f}
- Outlier ratio vs channel baseline: {outlier_ratio:.2f}x

Analyze the thumbnail and return ONLY valid JSON with this exact schema:
{{
  "confidence": 0.0-1.0,
  "ocr": {{
    "text": "exact text visible on thumbnail",
    "line_count": 0,
    "text_coverage_pct": 0.0,
    "text_alignment": "left|center|right|unknown",
    "confidence": 0.0-1.0,
    "font_category": "bold_condensed_sans|heavy_geometric_sans|serif_editorial|handwritten|unknown"
  }},
  "composition": {{
    "layout_type": "left_subject_right_text|right_subject_left_text|centered|split_screen|before_after|diagonal|wide_shot|unknown",
    "main_focal_point": "face|product|text|scene|person|unknown",
    "has_negative_space": false,
    "background_complexity": "low|medium|high",
    "subject_size_pct": 0.0,
    "face_size_pct": 0.0,
    "main_subject_box": {{"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}},
    "text_region_box": {{"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}},
    "duration_badge_risk": true
  }},
  "subjects": {{
    "has_person": false,
    "person_count": 0,
    "face_count": 0,
    "shot_type": "close_up|medium|wide|unknown",
    "facial_expression": "surprised|excited|serious|neutral|concerned|happy|unknown",
    "gaze_direction": "camera|off_camera|object|unknown",
    "has_proof_object": false,
    "has_arrow_circle": false,
    "has_comparison": false,
    "has_contradiction": false
  }},
  "hooks": [
    {{
      "hook_type": "curiosity_gap|shock_surprise|fear_danger|money_value|transformation|before_after|hidden_truth|proof_evidence|authority_expert|mistake_warning|scarcity_urgency|contradiction|scale_comparison|identity_community|outcome_result|mystery|unknown",
      "confidence": 0.0-1.0,
      "visual_evidence": "describe what in image suggests this hook",
      "text_evidence": "any overlay text suggesting this hook",
      "title_evidence": "title element suggesting this hook"
    }}
  ],
  "mobile_readability": {{
    "score": 0-100,
    "text_readable": false,
    "face_recognizable": false,
    "main_object_clear": false,
    "duration_badge_overlap_risk": true,
    "breakdown": {{}}
  }}
}}

IMPORTANT rules:
- Do NOT fabricate CTR data
- Do NOT claim causation; use "associated with" or "appears to"
- Do NOT identify specific persons by name
- Only report what is visually observable
- If uncertain about OCR text, set ocr.confidence < 0.5
- Return ONLY the JSON object, no extra text"""
