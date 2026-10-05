"""
ThumbnailPromptService v2 — Hook Intelligence Pipeline.

Không tạo ảnh. Chỉ tạo prompt để user copy sang công cụ tạo ảnh bên ngoài.

Architecture:
  1. Title Deconstruction  → TitleHookBrief
  2. Hook Candidate Gen    → 12 HookCandidate  (short)
  3. Hook Quality Scoring  → HookQualityScore  per candidate
  4. Top-5 Selection       → diverse hook families
  5. Pass 2 Expansion      → full_image_prompt 250-450w
  6. Final Validation V2
  7. Deterministic fallback at any stage (semantic, not keyword-suffix)
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from core.logger import research_logger
from schemas.research_schemas import (
    HookQualityScoreSchema,
    ThumbnailOverlayTextSchema,
    ThumbnailPromptAnalysisSummarySchema,
    ThumbnailPromptGenerationResponse,
    ThumbnailPromptVariantSchema,
)

# ── Constants ─────────────────────────────────────────────────────────────────

HOOK_FAMILIES = {
    "visual_contradiction",
    "hidden_mechanism",
    "proof_object_anomaly",
    "expectation_vs_reality",
    "moment_before_discovery",
    "personal_consequence",
    "scale_difference",
    "missing_information",
    "social_reaction",
    "forbidden_or_overlooked_detail",
}

# Forbidden generic-only overlays (context-free usage rejected)
FORBIDDEN_GENERIC_OVERLAYS = {
    "THE TRUTH", "EXPOSED", "REVEALED", "UNCOVERED",
    "SHOCKING", "YOU WON'T BELIEVE",
}

# Signals → hook family for deterministic fallback
SEMANTIC_SIGNALS: List[Tuple[List[str], str]] = [
    (["hidden", "secret", "unknown", "missing", "nobody", "untold"], "hidden_mechanism"),
    (["fee", "price", "cost", "bill", "charge", "receipt", "invoice", "pay"], "proof_object_anomaly"),
    (["why", "how come", "reason", "cause", "behind"], "hidden_mechanism"),
    (["before", "after", "change", "transform", "was", "used to"], "visual_contradiction"),
    (["never", "always", "every time", "guaranteed", "myth"], "expectation_vs_reality"),
    (["warning", "risk", "danger", "threat", "consequence", "result"], "personal_consequence"),
    (["versus", " vs ", "compared", "difference", "better", "worse"], "visual_contradiction"),
    (["moment", "second", "realized", "found out", "discovered"], "moment_before_discovery"),
    (["reaction", "respond", "feel", "think", "know"], "social_reaction"),
    (["banned", "forbidden", "not allowed", "won't tell", "they hide"], "forbidden_or_overlooked_detail"),
    (["million", "billion", "huge", "massive", "tiny", "massive gap"], "scale_difference"),
]

# Deterministic hook templates per family
FALLBACK_TEMPLATES: Dict[str, Dict] = {
    "proof_object_anomaly": {
        "concept": "Proof Object Anomaly",
        "visual_question": "What is this unexpected detail in the document/receipt/label?",
        "hidden_information": "The anomalous line item or figure is partially visible but not explained.",
        "test_hypothesis": "A specific proof object (bill, receipt, label) will generate more curiosity than a generic reaction face.",
        "subject": "A close-up of the proof object (receipt, bill, label, contract) with one specific line item highlighted or circled.",
        "overlay_templates": [("WHAT'S THIS CHARGE?", None), ("CHECK THE BOTTOM", None)],
        "composition": "Macro close-up of proof object. Text overlay points to anomalous detail.",
        "hook_quality_base": {"curiosity_gap": 17, "one_second_clarity": 13, "title_complementarity": 13,
                              "visual_tension": 12, "specificity_and_proof": 9, "mobile_readability": 8,
                              "promise_integrity": 9, "competitor_fit": 3},
    },
    "visual_contradiction": {
        "concept": "Visual Contradiction",
        "visual_question": "Why do these two things not match?",
        "hidden_information": "One element in the frame contradicts the other — viewer sees the mismatch before knowing the reason.",
        "test_hypothesis": "Showing two contradictory elements will produce stronger tension than showing one element alone.",
        "subject": "Split or juxtaposition: expected item on one side, actual outcome on the other. No collage — one clean composition.",
        "overlay_templates": [("MENU PRICE / ISN'T THE BILL", "ISN'T THE BILL"), ("EXPECTED / ACTUAL", None)],
        "composition": "Clean split-frame or side-by-side. High contrast between the two elements.",
        "hook_quality_base": {"curiosity_gap": 16, "one_second_clarity": 12, "title_complementarity": 13,
                              "visual_tension": 14, "specificity_and_proof": 7, "mobile_readability": 8,
                              "promise_integrity": 9, "competitor_fit": 3},
    },
    "hidden_mechanism": {
        "concept": "Hidden Mechanism",
        "visual_question": "What is causing this outcome that isn't visible?",
        "hidden_information": "The mechanism or root cause is implied but not shown fully.",
        "test_hypothesis": "Revealing the consequence without the cause creates stronger watch motivation than explaining the mechanism upfront.",
        "subject": "Result or outcome visible. Cause is implied by context but not stated.",
        "overlay_templates": [("WHY SO HIGH?", None), ("THE HIDDEN CAUSE", None)],
        "composition": "Subject center. Proof of result visible. Cause deliberately absent from frame.",
        "hook_quality_base": {"curiosity_gap": 18, "one_second_clarity": 11, "title_complementarity": 12,
                              "visual_tension": 12, "specificity_and_proof": 7, "mobile_readability": 8,
                              "promise_integrity": 9, "competitor_fit": 3},
    },
    "expectation_vs_reality": {
        "concept": "Expectation vs Reality",
        "visual_question": "Why is the reality so different from what viewers expected?",
        "hidden_information": "The gap between what was promised or expected and what actually happened.",
        "test_hypothesis": "Highlighting the expectation gap will attract viewers who have felt misled or surprised.",
        "subject": "A person or object representing the expectation, contrasted with a visible element representing reality.",
        "overlay_templates": [("YOU PAID EXTRA", None), ("NOT WHAT YOU THINK", None)],
        "composition": "Side-by-side or before/after. Keep it to two main elements max.",
        "hook_quality_base": {"curiosity_gap": 16, "one_second_clarity": 12, "title_complementarity": 14,
                              "visual_tension": 13, "specificity_and_proof": 7, "mobile_readability": 8,
                              "promise_integrity": 9, "competitor_fit": 3},
    },
    "moment_before_discovery": {
        "concept": "Moment Before Discovery",
        "visual_question": "What is the person about to realize?",
        "hidden_information": "The discovery hasn't happened yet. The viewer knows something the subject doesn't.",
        "test_hypothesis": "Capturing the moment before realization creates more tension than showing the aftermath.",
        "subject": "Person closely examining proof object with expression of concern or confusion.",
        "overlay_templates": [("WAIT — WHAT?", None), ("HOLD ON", None)],
        "composition": "Medium close-up. Person and proof object both visible. Expression: concern or disbelief.",
        "hook_quality_base": {"curiosity_gap": 17, "one_second_clarity": 12, "title_complementarity": 12,
                              "visual_tension": 13, "specificity_and_proof": 6, "mobile_readability": 9,
                              "promise_integrity": 9, "competitor_fit": 3},
    },
    "personal_consequence": {
        "concept": "Personal Consequence",
        "visual_question": "What is happening to this specific person because of this?",
        "hidden_information": "Why this person is affected and how much.",
        "test_hypothesis": "Personalizing the consequence to one specific person creates more empathy than showing systemic impact.",
        "subject": "One person reacting to proof object. Expression: concern, frustration, or realization.",
        "overlay_templates": [("YOU PAY MORE", None), ("IT COSTS YOU MORE", None)],
        "composition": "Person prominent. Proof object visible in context. No generic reaction.",
        "hook_quality_base": {"curiosity_gap": 15, "one_second_clarity": 13, "title_complementarity": 12,
                              "visual_tension": 11, "specificity_and_proof": 7, "mobile_readability": 8,
                              "promise_integrity": 9, "competitor_fit": 3},
    },
    "scale_difference": {
        "concept": "Scale Difference",
        "visual_question": "How large is this gap compared to what we expected?",
        "hidden_information": "The actual scale of the difference is not yet revealed.",
        "test_hypothesis": "Visualizing unexpected scale creates stronger emotional response than stating the number.",
        "subject": "One small element versus one large element in the same frame.",
        "overlay_templates": [("HOW MUCH MORE?", None), ("THE REAL GAP", None)],
        "composition": "Visual scale comparison. Clean background. Two elements in clear size contrast.",
        "hook_quality_base": {"curiosity_gap": 15, "one_second_clarity": 12, "title_complementarity": 11,
                              "visual_tension": 12, "specificity_and_proof": 7, "mobile_readability": 8,
                              "promise_integrity": 9, "competitor_fit": 3},
    },
    "missing_information": {
        "concept": "Missing Information",
        "visual_question": "What is being hidden from you in this image?",
        "hidden_information": "A crucial detail is partially obscured, cropped, or omitted intentionally.",
        "test_hypothesis": "Partial information creates more desire to watch than full disclosure.",
        "subject": "Proof object with key detail cropped, blurred, or covered. Viewer sees the object but not the full answer.",
        "overlay_templates": [("WHAT'S MISSING?", None), ("THEY DIDN'T SHOW YOU", None)],
        "composition": "Proof object centered. Key detail partially out of frame or obscured.",
        "hook_quality_base": {"curiosity_gap": 18, "one_second_clarity": 11, "title_complementarity": 12,
                              "visual_tension": 12, "specificity_and_proof": 7, "mobile_readability": 8,
                              "promise_integrity": 9, "competitor_fit": 3},
    },
    "social_reaction": {
        "concept": "Social Reaction",
        "visual_question": "What did this person just discover that caused this reaction?",
        "hidden_information": "The viewer sees the reaction but not yet the proof object that caused it.",
        "test_hypothesis": "Showing reaction without full context creates more curiosity than explaining what happened.",
        "subject": "Person reacting to (or looking at) proof object. Expression: disbelief, concern, or realization.",
        "overlay_templates": [("LOOK WHAT I FOUND", None), ("THEY SAW IT", None)],
        "composition": "Person and proof object in same frame. Expression drives tension. No direct camera stare.",
        "hook_quality_base": {"curiosity_gap": 15, "one_second_clarity": 13, "title_complementarity": 11,
                              "visual_tension": 11, "specificity_and_proof": 6, "mobile_readability": 9,
                              "promise_integrity": 9, "competitor_fit": 3},
    },
    "forbidden_or_overlooked_detail": {
        "concept": "Forbidden or Overlooked Detail",
        "visual_question": "What is this detail that everyone missed or was not supposed to see?",
        "hidden_information": "The detail exists and is visible but was not communicated before.",
        "test_hypothesis": "Highlighting an overlooked detail creates more qualified curiosity than a generic reaction.",
        "subject": "Proof object with specific overlooked detail highlighted or circled.",
        "overlay_templates": [("NOBODY CHECKS THIS", None), ("THEY ALL MISSED IT", None)],
        "composition": "Proof object dominant. Overlooked detail circled or highlighted. Minimal other elements.",
        "hook_quality_base": {"curiosity_gap": 17, "one_second_clarity": 12, "title_complementarity": 12,
                              "visual_tension": 12, "specificity_and_proof": 8, "mobile_readability": 8,
                              "promise_integrity": 9, "competitor_fit": 3},
    },
}

OPTION_LABELS = ["A", "B", "C", "D", "E"]

STOP_WORDS = frozenset({
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "of", "for",
    "with", "by", "is", "are", "was", "were", "be", "been", "being", "do",
    "does", "did", "have", "has", "had", "this", "that", "these", "those",
    "it", "its", "we", "our", "they", "their", "you", "your", "my", "me",
    "him", "her", "his", "she", "he", "i", "why", "how", "what", "when",
    "where", "who", "make", "making", "your", "so", "much", "more",
})

NEGATIVE_PROMPT_BASE = (
    "unreadable text, distorted faces, malformed hands, extra fingers, excessive objects, "
    "cluttered background, duplicate people, warped products, low contrast, tiny subject, "
    "content in bottom-right duration zone, competitor logo, watermark, copied branding, "
    "nsfw, blurry, extra text beyond overlay, store signs, product labels, random captions, "
    "random headlines, collage multiple scenes"
)

SYSTEM_PROMPT_V2 = """You are a senior YouTube thumbnail strategist and visual hook editor.
Your goal is NOT to make the image merely attractive.
Your goal is to create ONE immediate visual question that the title promises to answer.
Optimize for qualified curiosity and watch-time potential — not deceptive clicks.

A strong thumbnail:
1. Is understandable in one second.
2. Contains one dominant visual story.
3. Shows a contradiction, proof object, consequence, or moment of realization.
4. Withholds the explanation.
5. Complements instead of repeats the title.
6. Accurately represents the video.
7. Remains readable at phone size.

Before expanding any image prompt:
- Deconstruct the title.
- Identify the viewer expectation.
- Identify the hidden variable.
- Identify the strongest visible proof.
- Identify what must remain unanswered.
- Generate multiple hook candidates.
- Reject generic or redundant candidates.
- Select five candidates from DIFFERENT hook families.

Do NOT use generic phrases (THE TRUTH, EXPOSED, REVEALED, UNCOVERED) unless they refer to a specific visible anomaly in context.
Do NOT create five cosmetic variations of one idea.
Each final variant must test a DIFFERENT viewer hypothesis.
NEVER fabricate facts, people, money amounts, numbers, dates, emergencies, deadlines, or predictions.

Use competitor thumbnail intelligence as evidence for structure, text length, layout, contrast and visual hierarchy.
Do NOT copy competitor wording, people, logos, branding, props or pixel layout.

Overlay text rules:
- Line 1: yellow (#FFE600), outline black (#050505)
- Line 2 (optional): white (#FFFFFF), outline black (#050505)
- ALL CAPS
- 4-7 words (max 9 when competitor data supports)
- Do NOT repeat the title
- Do NOT explain the answer

Every variant MUST have:
- one visual question
- one dominant subject
- at most one main proof object
- exact overlay text (no placeholders)
- title complementarity
- hook_quality scores
- a distinct test_hypothesis
- hook_family from: visual_contradiction, hidden_mechanism, proof_object_anomaly, expectation_vs_reality, moment_before_discovery, personal_consequence, scale_difference, missing_information, social_reaction, forbidden_or_overlooked_detail
- a complete standalone full_image_prompt (250-450 words)

full_image_prompt MUST open with:
CORE VISUAL QUESTION: ...
VIEWER EXPECTATION: ...
VISUAL CONTRADICTION OR PROOF: ...
WHAT MUST REMAIN UNANSWERED: ...
Then describe: Scene, Subject, Proof object, Composition, Emotion, Background, Camera, Light, Color, Exact overlay text, Typography, Mobile readability, Safe zone, Originality, Negative.

Return ONLY valid JSON. No markdown fences. No explanations outside JSON.

Schema:
{
  "title_brief": {
    "literal_subject": "...",
    "viewer_expectation": "...",
    "hidden_variable": "...",
    "visible_consequence": "...",
    "emotional_stake": "...",
    "knowledge_gap": "...",
    "strongest_proof_object": "...",
    "visual_contradiction": "...",
    "facts_explicitly_supported": [],
    "claims_not_allowed": []
  },
  "analysis_summary": {
    "title_subject": "...",
    "title_promise": "...",
    "viewer_tension": "...",
    "viewer_expectation": "...",
    "hidden_variable": "...",
    "strongest_proof_object": "...",
    "visual_contradiction": "...",
    "recommended_hook": "...",
    "hook_source": "ai_analysis",
    "competitor_style_summary": "...",
    "overlay_style_summary": "..."
  },
  "variants": [
    {
      "id": "...",
      "option_label": "A",
      "concept_name": "...",
      "hook_family": "proof_object_anomaly",
      "visual_question": "...",
      "hidden_information": "...",
      "test_hypothesis": "...",
      "strategic_angle": "...",
      "title_interpretation": "...",
      "overlay_text": {
        "line_1": "WHAT'S THIS CHARGE?",
        "line_1_color": "#FFE600",
        "line_2": null,
        "line_2_color": "#FFFFFF",
        "combined_text": "WHAT'S THIS CHARGE?",
        "total_words": 3,
        "capitalization": "ALL_CAPS",
        "outline_color": "#050505",
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
      "full_image_prompt": "YouTube thumbnail 16:9 ...",
      "negative_prompt": "...",
      "competitor_traits_used": [],
      "evidence": [],
      "originality_changes": [],
      "why_it_works": "...",
      "hook_quality": {
        "curiosity_gap": 17,
        "one_second_clarity": 13,
        "title_complementarity": 13,
        "visual_tension": 12,
        "specificity_and_proof": 9,
        "mobile_readability": 8,
        "promise_integrity": 9,
        "competitor_fit": 3,
        "penalties": 0,
        "total_score": 84,
        "rejection_reasons": []
      },
      "recommended_test_rank": 1,
      "recommended_for_ab_test": true,
      "warnings": []
    }
  ]
}"""

# ── Internal dataclasses ──────────────────────────────────────────────────────

@dataclass
class TitleHookBrief:
    literal_subject: str = ""
    viewer_expectation: str = ""
    hidden_variable: str = ""
    visible_consequence: str = ""
    emotional_stake: str = ""
    knowledge_gap: str = ""
    strongest_proof_object: str = ""
    visual_contradiction: str = ""
    facts_explicitly_supported: List[str] = field(default_factory=list)
    claims_not_allowed: List[str] = field(default_factory=list)


@dataclass
class HookCandidate:
    id: str
    hook_family: str
    visual_question: str
    focal_subject: str
    proof_object: Optional[str]
    visual_tension: str
    hidden_information: str
    overlay_line_1: str
    overlay_line_1_color: str = "#FFE600"
    overlay_line_2: Optional[str] = None
    overlay_line_2_color: str = "#FFFFFF"
    title_complement: str = ""
    supported_by_title: bool = True
    competitor_traits_used: List[str] = field(default_factory=list)
    score: Optional["HookScoreResult"] = None


@dataclass
class HookScoreResult:
    curiosity_gap: int = 0
    one_second_clarity: int = 0
    title_complementarity: int = 0
    visual_tension: int = 0
    specificity_and_proof: int = 0
    mobile_readability: int = 0
    promise_integrity: int = 0
    competitor_fit: int = 0
    penalties: int = 0
    total_score: int = 0
    rejection_reasons: List[str] = field(default_factory=list)


# ── Utility functions ─────────────────────────────────────────────────────────

def _tokenize(text: str) -> List[str]:
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", "", text)
    return [t for t in text.split() if t and t not in STOP_WORDS and len(t) > 2]


def calculate_title_overlay_redundancy(title: str, overlay_text: str) -> float:
    """Return overlap ratio 0.0–1.0. Reject if > 0.65."""
    t_tokens = set(_tokenize(title))
    o_tokens = set(_tokenize(overlay_text))
    if not o_tokens:
        return 1.0
    overlap = t_tokens & o_tokens
    return len(overlap) / len(o_tokens)


def _detect_semantic_signals(title: str) -> List[str]:
    """Return list of hook families suggested by title keywords."""
    title_lower = title.lower()
    families: List[str] = []
    for keywords, family in SEMANTIC_SIGNALS:
        if any(kw in title_lower for kw in keywords):
            families.append(family)
    return list(dict.fromkeys(families))  # dedup, preserve order


def _build_title_brief_deterministic(title: str, context: str) -> TitleHookBrief:
    """Build TitleHookBrief without AI using semantic signals."""
    title_lower = title.lower()

    # Detect proof object
    proof_object = ""
    proof_keywords = {
        "bill": "restaurant bill or invoice",
        "receipt": "receipt",
        "fee": "service fee line item",
        "charge": "unexplained charge on statement",
        "price": "price label or tag",
        "cost": "cost breakdown document",
        "invoice": "invoice",
        "contract": "contract document",
        "statement": "account statement",
        "label": "product label",
        "tax": "tax line item",
    }
    for kw, desc in proof_keywords.items():
        if kw in title_lower:
            proof_object = desc
            break

    # Detect contradiction
    contradiction = ""
    if any(w in title_lower for w in ["hidden", "secret", "actually", "real"]):
        contradiction = "Advertised or expected value vs actual value discovered"
    elif any(w in title_lower for w in ["fee", "charge", "extra", "more"]):
        contradiction = "Menu/listed price vs actual total"
    elif any(w in title_lower for w in ["before", "after", "change"]):
        contradiction = "Before state vs after state"

    # viewer expectation
    if proof_object:
        expectation = "The final amount matches the sum of chosen items"
    else:
        expectation = f"Standard outcome from the title topic"

    # hidden variable
    if "hidden" in title_lower or "secret" in title_lower:
        hidden_var = "An undisclosed factor is changing the expected outcome"
    elif "fee" in title_lower or "charge" in title_lower:
        hidden_var = "A fee that is not prominently disclosed upfront"
    else:
        hidden_var = "The mechanism causing the unexpected result"

    return TitleHookBrief(
        literal_subject=title,
        viewer_expectation=expectation,
        hidden_variable=hidden_var,
        visible_consequence="Outcome is higher/different than expected",
        emotional_stake="Frustration, confusion, or concern about being misled",
        knowledge_gap="Why this is happening and whether it is avoidable",
        strongest_proof_object=proof_object,
        visual_contradiction=contradiction,
        facts_explicitly_supported=[w for w in title.split() if len(w) > 4],
        claims_not_allowed=["specific dollar amounts", "named entities not in title", "dates", "deadlines"],
    )


def _build_competitor_dna(blueprint: dict, intel: dict) -> dict:
    """Build Competitor DNA prioritising outlier thumbnails over all."""
    analyses = intel.get("analyses", [])
    patterns = intel.get("patterns", [])
    group_stats = intel.get("group_stats", {})

    outliers = [a for a in analyses if a.get("performance_group") == "outlier"]
    baseline = [a for a in analyses if a.get("performance_group") == "baseline"]

    def _modal(lst, key_path):
        vals = []
        for a in lst:
            v = a
            for k in key_path:
                v = v.get(k, {}) if isinstance(v, dict) else None
                if v is None:
                    break
            if isinstance(v, str) and v:
                vals.append(v)
        return max(set(vals), key=vals.count) if vals else None

    def _hook_dist(lst):
        hooks = []
        for a in lst:
            hl = a.get("hooks", [])
            if hl:
                hooks.append(hl[0].get("hook_type", ""))
        if not hooks:
            return {}
        from collections import Counter
        return dict(Counter(hooks).most_common(5))

    def _proof_rate(lst):
        if not lst:
            return 0.0
        return sum(1 for a in lst if a.get("subjects", {}).get("has_proof_object")) / len(lst)

    # Outlier-first hook
    out_hook_dist = _hook_dist(outliers)
    base_hook_dist = _hook_dist(baseline)

    # Choose dominant hook from outliers first
    dominant_hook = "curiosity_gap"
    hook_source = "safe_fallback"
    if out_hook_dist:
        dominant_hook = max(out_hook_dist, key=out_hook_dist.get)
        hook_source = "outlier_analysis"
    elif base_hook_dist:
        dominant_hook = max(base_hook_dist, key=base_hook_dist.get)
        hook_source = "baseline_analysis"
    # If still empty, try to infer from blueprint
    if not out_hook_dist and not base_hook_dist:
        bp_hook = blueprint.get("target_hook", "")
        if bp_hook:
            dominant_hook = bp_hook
            hook_source = "blueprint_inference"

    out_layout = _modal(outliers, ["composition", "layout_type"]) or _modal(analyses, ["composition", "layout_type"])
    out_text_words = [a.get("ocr", {}).get("word_count", 0) for a in outliers if a.get("ocr", {}).get("word_count", 0) > 0]
    out_text_lines = [a.get("ocr", {}).get("line_count", 0) for a in outliers if a.get("ocr", {}).get("line_count", 0) > 0]
    out_has_uppercase = sum(1 for a in outliers if a.get("ocr", {}).get("has_uppercase")) > max(len(outliers) // 2, 1)
    out_mobile = [a.get("mobile_readability", {}).get("score", 0) for a in outliers if a.get("mobile_readability", {}).get("score", 0) > 0]
    out_proof_rate = _proof_rate(outliers)

    winning = [p for p in patterns if p.get("is_winning")]
    avoid = [p for p in patterns if p.get("is_avoid")]

    return {
        "blueprint_mode": blueprint.get("blueprint_mode", "safe_default"),
        "validated": blueprint.get("is_statistically_validated", False),
        "dominant_hook": dominant_hook,
        "hook_source": hook_source,
        "outlier_hook_distribution": out_hook_dist,
        "baseline_hook_distribution": base_hook_dist,
        "dominant_layout": out_layout or blueprint.get("layout_description", "single_subject_center"),
        "outlier_overlay_word_median": (sorted(out_text_words)[len(out_text_words) // 2] if out_text_words else 4),
        "outlier_overlay_line_median": (sorted(out_text_lines)[len(out_text_lines) // 2] if out_text_lines else 1),
        "text_uppercase": out_has_uppercase,
        "outlier_proof_object_rate": out_proof_rate,
        "outlier_mobile_score": (sorted(out_mobile)[len(out_mobile) // 2] if out_mobile else 50),
        "layout_description": blueprint.get("layout_description", ""),
        "background_recipe": blueprint.get("background_recipe", "Simple, uncluttered background"),
        "color_recipe": blueprint.get("color_recipe", "High contrast palette"),
        "lighting_recipe": blueprint.get("lighting_recipe", "High contrast lighting"),
        "winning_patterns": [
            {"id": p.get("pattern_id"), "name": p.get("name"), "description": p.get("description")}
            for p in winning[:8]
        ],
        "avoid_patterns": [
            {"id": p.get("pattern_id"), "name": p.get("name")}
            for p in avoid[:5]
        ],
        "limitations": intel.get("limitations", []),
        "n_outliers": len(outliers),
        "n_baseline": len(baseline),
    }


def _sample_analyses(analyses: list) -> Tuple[list, list, list]:
    """Slim analyses — remove base64 image data."""
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

    out = [_slim(a) for a in analyses if a.get("performance_group") == "outlier"][:10]
    base = [_slim(a) for a in analyses if a.get("performance_group") == "baseline"][:5]
    low = [_slim(a) for a in analyses if a.get("performance_group") == "low"][:5]
    return out, base, low


# ── Hook Quality Scorer ───────────────────────────────────────────────────────

_GENERIC_ONLY_WORDS = {
    "the truth", "exposed", "revealed", "uncovered", "shocking", "you won't believe"
}


def _is_generic_only(overlay: str) -> bool:
    norm = overlay.strip().lower()
    return norm in _GENERIC_ONLY_WORDS


def _count_focal_elements(visual_concept: str) -> int:
    """Approximate focal element count from visual_concept text."""
    markers = ["plus", "and a", "with a", "alongside", "next to", "chart", "arrow", "circle"]
    count = 1
    for m in markers:
        if m in visual_concept.lower():
            count += 1
    return count


def score_hook_candidate(
    candidate: HookCandidate,
    title: str,
    competitor_dna: dict,
    used_families: Optional[List[str]] = None,
) -> HookScoreResult:
    """Score a HookCandidate deterministically."""
    r = HookScoreResult()

    combined = f"{candidate.overlay_line_1} {candidate.overlay_line_2 or ''}".strip()
    redundancy = calculate_title_overlay_redundancy(title, combined)

    # ── Curiosity gap /20 ──
    if "?" in candidate.visual_question:
        r.curiosity_gap += 8
    if candidate.proof_object:
        r.curiosity_gap += 5
    if candidate.hook_family in ("proof_object_anomaly", "missing_information", "hidden_mechanism"):
        r.curiosity_gap += 5
    elif candidate.hook_family in ("visual_contradiction", "expectation_vs_reality"):
        r.curiosity_gap += 4
    else:
        r.curiosity_gap += 2
    r.curiosity_gap = min(r.curiosity_gap, 20)

    # ── One-second clarity /15 ──
    word_count = len(combined.split())
    if word_count <= 5:
        r.one_second_clarity += 8
    elif word_count <= 7:
        r.one_second_clarity += 5
    if candidate.focal_subject and len(candidate.focal_subject) > 5:
        r.one_second_clarity += 4
    if candidate.proof_object:
        r.one_second_clarity += 3
    r.one_second_clarity = min(r.one_second_clarity, 15)

    # ── Title complementarity /15 ──
    if redundancy <= 0.3:
        r.title_complementarity += 13
    elif redundancy <= 0.5:
        r.title_complementarity += 9
    elif redundancy <= 0.65:
        r.title_complementarity += 5
    else:
        r.title_complementarity += 0
        r.rejection_reasons.append(f"Overlay too redundant with title ({redundancy:.0%})")
    r.title_complementarity = min(r.title_complementarity, 15)

    # ── Visual tension /15 ──
    if candidate.visual_tension:
        r.visual_tension += 8
    if candidate.hook_family in ("visual_contradiction", "proof_object_anomaly"):
        r.visual_tension += 5
    elif candidate.hook_family in ("moment_before_discovery", "expectation_vs_reality"):
        r.visual_tension += 4
    else:
        r.visual_tension += 2
    r.visual_tension = min(r.visual_tension, 15)

    # ── Specificity & proof /10 ──
    if candidate.proof_object:
        r.specificity_and_proof += 7
    if len(candidate.visual_question) > 20:
        r.specificity_and_proof += 3
    r.specificity_and_proof = min(r.specificity_and_proof, 10)

    # ── Mobile readability /10 ──
    if word_count <= 5:
        r.mobile_readability += 8
    elif word_count <= 7:
        r.mobile_readability += 6
    out_score = competitor_dna.get("outlier_mobile_score", 50)
    r.mobile_readability += min(int(out_score / 25), 2)
    r.mobile_readability = min(r.mobile_readability, 10)

    # ── Promise integrity /10 ──
    r.promise_integrity = 9  # base — deducted by penalties below
    if not candidate.supported_by_title:
        r.promise_integrity -= 5

    # ── Competitor fit /5 ──
    out_hook = competitor_dna.get("dominant_hook", "")
    if candidate.hook_family.replace("_", " ") in out_hook or out_hook in candidate.hook_family:
        r.competitor_fit += 3
    if competitor_dna.get("outlier_proof_object_rate", 0) > 0.4 and candidate.proof_object:
        r.competitor_fit += 2
    r.competitor_fit = min(r.competitor_fit, 5)

    # ── Penalties ──
    if redundancy > 0.65:
        r.penalties -= 15

    if _is_generic_only(combined):
        r.penalties -= 30
        r.rejection_reasons.append(f"Generic-only overlay: '{combined}'")

    if word_count > 9:
        r.penalties -= 10
        r.rejection_reasons.append(f"Overlay too long: {word_count} words")

    if used_families and candidate.hook_family in used_families:
        r.penalties -= 10
        r.rejection_reasons.append(f"Duplicate hook family: {candidate.hook_family}")

    if _count_focal_elements(candidate.visual_tension) > 3:
        r.penalties -= 10
        r.rejection_reasons.append("More than 3 focal elements")

    raw = (
        r.curiosity_gap + r.one_second_clarity + r.title_complementarity +
        r.visual_tension + r.specificity_and_proof + r.mobile_readability +
        r.promise_integrity + r.competitor_fit + r.penalties
    )
    r.total_score = max(0, min(100, raw))
    return r


def _passes_threshold(score: HookScoreResult) -> bool:
    return (
        score.total_score >= 70 and
        score.promise_integrity >= 8 and
        score.one_second_clarity >= 10 and
        score.curiosity_gap >= 13
    )


# ── Deterministic Hook Candidates ────────────────────────────────────────────

def _select_families_for_title(title: str, n: int = 10) -> List[str]:
    """Choose hook families ordered by semantic relevance to title."""
    signals = _detect_semantic_signals(title)
    all_families = list(HOOK_FAMILIES)
    # Put signaled families first
    ordered = list(dict.fromkeys(signals + all_families))
    return ordered[:n]


def _make_semantic_overlay(
    title: str,
    family: str,
    brief: TitleHookBrief,
    competitor_dna: dict,
    variant_idx: int,
) -> Tuple[str, Optional[str]]:
    """Generate overlay text from title semantics — not keyword-suffix extraction."""
    proof = brief.strongest_proof_object
    title_lower = title.lower()

    # Per-family overlay logic based on semantics
    if family == "proof_object_anomaly":
        if "fee" in title_lower or "charge" in title_lower:
            return ("WHAT'S THIS CHARGE?", None) if variant_idx == 0 else ("CHECK THE BOTTOM", None)
        elif "price" in title_lower or "bill" in title_lower:
            return ("WHY SO HIGH?", None) if variant_idx == 0 else ("THE EXTRA LINE", None)
        return ("LOOK AT THIS", None)

    elif family == "visual_contradiction":
        if "bill" in title_lower or "price" in title_lower:
            return ("MENU PRICE", "ISN'T THE BILL") if variant_idx == 0 else ("EXPECTED", "VS REALITY")
        return ("NOT WHAT IT SHOWS", None)

    elif family == "hidden_mechanism":
        if "hidden" in title_lower:
            return ("WHY DOES THIS HAPPEN?", None)
        return ("HOW IS THIS POSSIBLE?", None)

    elif family == "expectation_vs_reality":
        if "pay" in title_lower or "bill" in title_lower:
            return ("YOU PAID EXTRA", None)
        return ("NOT WHAT THEY TOLD YOU", None)

    elif family == "moment_before_discovery":
        return ("WAIT — WHAT?", None) if variant_idx < 2 else ("HOLD ON", None)

    elif family == "personal_consequence":
        if "pay" in title_lower or "cost" in title_lower or "bill" in title_lower:
            return ("IT COSTS YOU MORE", None)
        return ("THIS AFFECTS YOU", None)

    elif family == "scale_difference":
        return ("HOW MUCH MORE?", None)

    elif family == "missing_information":
        return ("WHAT'S MISSING?", None) if variant_idx < 2 else ("THEY DIDN'T SHOW YOU", None)

    elif family == "social_reaction":
        return ("THEY SAW IT", None)

    elif family == "forbidden_or_overlooked_detail":
        return ("NOBODY CHECKS THIS", None) if variant_idx < 2 else ("THEY ALL MISSED IT", None)

    # Safe generic fallback — still specific
    return ("WHY DOES THIS HAPPEN?", None)


def _build_deterministic_candidates(
    title: str,
    brief: TitleHookBrief,
    competitor_dna: dict,
) -> List[HookCandidate]:
    """Generate 10 semantic hook candidates deterministically."""
    families = _select_families_for_title(title, n=10)
    candidates: List[HookCandidate] = []

    proof = brief.strongest_proof_object
    layout = competitor_dna.get("dominant_layout", "single subject center")

    for idx, family in enumerate(families):
        tpl = FALLBACK_TEMPLATES.get(family, FALLBACK_TEMPLATES["hidden_mechanism"])
        l1, l2 = _make_semantic_overlay(title, family, brief, competitor_dna, idx)
        combined = f"{l1} / {l2}" if l2 else l1

        redundancy = calculate_title_overlay_redundancy(title, combined)
        # Skip if overlay is too redundant
        if redundancy > 0.65:
            # Try to rescue
            l1 = "LOOK AT THIS"
            l2 = None
            combined = l1

        candidate = HookCandidate(
            id=str(uuid.uuid4()),
            hook_family=family,
            visual_question=tpl["visual_question"],
            focal_subject=tpl["subject"].split(".")[0],
            proof_object=proof or None,
            visual_tension=tpl.get("composition", ""),
            hidden_information=tpl["hidden_information"],
            overlay_line_1=l1,
            overlay_line_1_color="#FFE600",
            overlay_line_2=l2,
            overlay_line_2_color="#FFFFFF",
            title_complement=f"Thumbnail shows {tpl['visual_question']} — title answers why",
            supported_by_title=True,
            competitor_traits_used=[p["name"] for p in competitor_dna.get("winning_patterns", [])[:2]],
        )
        candidates.append(candidate)

    return candidates


def _score_and_select(
    candidates: List[HookCandidate],
    title: str,
    competitor_dna: dict,
) -> List[HookCandidate]:
    """Score all candidates, then select top-5 with maximum family diversity."""
    for c in candidates:
        c.score = score_hook_candidate(c, title, competitor_dna)

    # Sort by score desc
    candidates.sort(key=lambda c: c.score.total_score if c.score else 0, reverse=True)

    # Greedy selection: pick top candidate then diversify families
    selected: List[HookCandidate] = []
    used_families: List[str] = []

    # First pass: prefer passing threshold
    for c in candidates:
        if len(selected) >= 5:
            break
        if c.hook_family not in used_families and _passes_threshold(c.score):
            selected.append(c)
            used_families.append(c.hook_family)

    # Second pass: fill with best remaining (may be below threshold if < 5)
    for c in candidates:
        if len(selected) >= 5:
            break
        if c.hook_family not in used_families:
            selected.append(c)
            used_families.append(c.hook_family)

    # Third pass: allow same-family if still < 5
    for c in candidates:
        if len(selected) >= 5:
            break
        if c not in selected:
            selected.append(c)

    # Re-score with family-duplicate penalty applied
    final: List[HookCandidate] = []
    used_in_final: List[str] = []
    for c in selected[:5]:
        c.score = score_hook_candidate(c, title, competitor_dna, used_families=used_in_final)
        used_in_final.append(c.hook_family)
        final.append(c)

    # Sort final selection by score desc to assign rank
    final.sort(key=lambda c: c.score.total_score if c.score else 0, reverse=True)
    return final[:5]


def _expand_candidate_to_variant(
    candidate: HookCandidate,
    option_label: str,
    rank: int,
    title: str,
    blueprint: dict,
    competitor_dna: dict,
    brief: TitleHookBrief,
) -> ThumbnailPromptVariantSchema:
    """Expand a HookCandidate into a full ThumbnailPromptVariantSchema deterministically."""
    tpl = FALLBACK_TEMPLATES.get(candidate.hook_family, FALLBACK_TEMPLATES["hidden_mechanism"])
    score = candidate.score

    overlay_text = ThumbnailOverlayTextSchema(
        line_1=candidate.overlay_line_1,
        line_1_color=candidate.overlay_line_1_color,
        line_2=candidate.overlay_line_2,
        line_2_color=candidate.overlay_line_2_color,
        combined_text=(
            f"{candidate.overlay_line_1} / {candidate.overlay_line_2}"
            if candidate.overlay_line_2
            else candidate.overlay_line_1
        ),
        total_words=len(f"{candidate.overlay_line_1} {candidate.overlay_line_2 or ''}".split()),
        capitalization="ALL_CAPS",
        outline_color="#050505",
        placement="upper_left" if rank % 2 == 0 else "upper_center",
        typography="bold_condensed_sans",
    )

    proof = candidate.proof_object or ""
    layout = blueprint.get("layout_description") or competitor_dna.get("dominant_layout", "single subject center")
    bg = blueprint.get("background_recipe", "Simple, uncluttered background")
    color = blueprint.get("color_recipe", "High contrast palette")
    lighting = blueprint.get("lighting_recipe", "High contrast lighting")
    negative = blueprint.get("negative_prompt", NEGATIVE_PROMPT_BASE)
    mobile_score = competitor_dna.get("outlier_mobile_score", 50)
    validated = competitor_dna.get("validated", False)
    bp_mode = competitor_dna.get("blueprint_mode", "safe_default")
    hook_src = competitor_dna.get("hook_source", "safe_fallback")

    validation_note = (
        "Based on statistically validated competitor patterns."
        if validated
        else f"Note: blueprint_mode={bp_mode} — patterns observed, not statistically proven."
    )

    full_prompt = (
        f"YouTube thumbnail 16:9. Target resolution 3840x2160. Photorealistic photography style.\n\n"
        f"CORE VISUAL QUESTION: {candidate.visual_question}\n"
        f"VIEWER EXPECTATION: {brief.viewer_expectation or 'Standard outcome expected'}\n"
        f"VISUAL CONTRADICTION OR PROOF: {brief.visual_contradiction or candidate.visual_tension}\n"
        f"WHAT MUST REMAIN UNANSWERED: {candidate.hidden_information}\n\n"
        f"OPTION {option_label} — {tpl['concept']} ({candidate.hook_family.replace('_',' ')}):\n"
        f"{tpl['subject']}\n\n"
        f"COMPOSITION ({layout.replace('_', ' ') if isinstance(layout, str) else layout}):\n"
        f"{tpl['composition']} "
        f"Clear visual hierarchy: subject first, then text, then background. "
        f"Single dominant visual story. Maximum 2–4 major visual elements.\n\n"
        f"SUBJECT:\n"
        f"{tpl['subject']} Do NOT copy any specific person, logo or prop from competitor thumbnails.\n\n"
        f"PROOF OBJECT:\n"
        f"{proof or 'Relevant to topic'}. Prominently visible. One proof object maximum.\n\n"
        f"BACKGROUND:\n"
        f"{bg}. High contrast between subject and background.\n\n"
        f"COLOR & LIGHTING:\n"
        f"{color}. {lighting}. High contrast. Primary colors: yellow and white for overlay text.\n\n"
        f"EMOTION (if person present):\n"
        f"Specific expression relevant to proof object: concern, disbelief, confusion, or realization. "
        f"Person should be looking AT proof object or reacting to situation, NOT staring at camera.\n\n"
        f"OVERLAY TEXT — render EXACTLY these words and no others:\n"
        f'Line 1 (YELLOW #FFE600, thick black outline): "{candidate.overlay_line_1}"\n'
        + (f'Line 2 (WHITE #FFFFFF, thick black outline): "{candidate.overlay_line_2}"\n' if candidate.overlay_line_2 else "")
        + f"Font: {overlay_text.typography}. Outline: {overlay_text.outline_color} thick stroke. "
        f"Placement: {overlay_text.placement}. "
        f"Text must be readable at 120x67px (mobile thumbnail size).\n\n"
        f"SAFE ZONES:\n"
        f"Keep bottom-right 30% clear of critical content (YouTube duration badge). "
        f"Keep 5% margin on all edges.\n\n"
        f"MOBILE READABILITY:\n"
        f"All key elements must be recognizable at thumbnail size. "
        f"Target mobile readability score: {mobile_score}+.\n\n"
        f"ORIGINALITY:\n"
        f"Do NOT copy competitor thumbnails. Replace people, locations, props, color combinations if too distinctive. "
        f"Keep layout structure and contrast strategy only.\n\n"
        f"NEGATIVE INSTRUCTIONS:\n"
        f"No watermarks, no competitor logos, no extra text beyond specified overlay, "
        f"no store signs, no product labels, no random captions, "
        f"no collage of multiple scenes, no more than 4 focal elements, "
        f"{negative}"
    )

    warnings = [
        f"Deterministic semantic fallback — {hook_src}. {validation_note}",
    ]
    avoid_traits = [p["name"] for p in competitor_dna.get("avoid_patterns", [])[:2]]
    if avoid_traits:
        warnings.append(f"Avoid patterns detected: {', '.join(avoid_traits)}")

    hq = HookQualityScoreSchema(
        curiosity_gap=score.curiosity_gap,
        one_second_clarity=score.one_second_clarity,
        title_complementarity=score.title_complementarity,
        visual_tension=score.visual_tension,
        specificity_and_proof=score.specificity_and_proof,
        mobile_readability=score.mobile_readability,
        promise_integrity=score.promise_integrity,
        competitor_fit=score.competitor_fit,
        penalties=score.penalties,
        total_score=score.total_score,
        rejection_reasons=score.rejection_reasons,
    )

    return ThumbnailPromptVariantSchema(
        id=candidate.id,
        option_label=option_label,
        concept_name=f"Option {option_label} — {tpl['concept']}",
        hook_family=candidate.hook_family,
        visual_question=candidate.visual_question,
        hidden_information=candidate.hidden_information,
        test_hypothesis=tpl["test_hypothesis"],
        strategic_angle=candidate.hook_family.replace("_", " ").title(),
        title_interpretation=f"Title '{title}' supports visual approach: {candidate.visual_question}",
        overlay_text=overlay_text,
        visual_concept=tpl["concept"],
        subject_direction=tpl["subject"],
        composition_direction=tpl["composition"],
        background_direction=bg,
        color_direction=color,
        lighting_direction=lighting,
        mobile_readability_direction=f"All elements readable at mobile size. Target score {mobile_score}+.",
        title_thumbnail_relationship=candidate.title_complement,
        full_image_prompt=full_prompt,
        negative_prompt=negative or NEGATIVE_PROMPT_BASE,
        competitor_traits_used=candidate.competitor_traits_used,
        evidence=[f"Observed in {competitor_dna.get('n_outliers', 0)} outlier thumbnail analyses."],
        originality_changes=[
            "Replaced competitor-specific subject with topic-relevant alternative.",
            "Preserved layout structure and contrast strategy only.",
            "Overlay derived from title semantics, not copied from competitor.",
        ],
        why_it_works=(
            f"Option {option_label} ({tpl['concept']}) uses {candidate.hook_family.replace('_',' ')} strategy "
            f"to create visual question: '{candidate.visual_question}'. {validation_note}"
        ),
        hook_quality=hq,
        recommended_test_rank=rank,
        recommended_for_ab_test=(rank <= 3),
        warnings=warnings,
    )


# ── AI Response Parser ─────────────────────────────────────────────────────────

def _parse_overlay(ot_raw: dict, title: str) -> Optional[ThumbnailOverlayTextSchema]:
    """Parse and validate overlay from AI response."""
    line_1 = ot_raw.get("line_1", "").strip()
    line_2 = ot_raw.get("line_2") or None
    if line_2:
        line_2 = line_2.strip() or None
    combined = ot_raw.get("combined_text", "") or (f"{line_1} / {line_2}" if line_2 else line_1)
    combined = combined.strip()

    # Reject empty or placeholder
    if not combined or re.search(r"\[.+?\]", combined):
        return None

    # Reject generic-only
    if _is_generic_only(combined):
        return None

    # Reject if too redundant with title
    redundancy = calculate_title_overlay_redundancy(title, combined)
    if redundancy > 0.65:
        return None

    # Reject if overlay word count > 9
    if len(combined.split()) > 9:
        return None

    return ThumbnailOverlayTextSchema(
        line_1=line_1 or combined,
        line_1_color=ot_raw.get("line_1_color", "#FFE600"),
        line_2=line_2,
        line_2_color=ot_raw.get("line_2_color", "#FFFFFF"),
        combined_text=combined,
        total_words=len(combined.split()),
        capitalization="ALL_CAPS",
        outline_color=ot_raw.get("outline_color", "#050505"),
        placement=ot_raw.get("placement", "upper_left"),
        typography=ot_raw.get("typography", "bold_condensed_sans"),
    )


def _parse_ai_variant(
    raw: dict,
    idx: int,
    title: str,
    negative_base: str,
    competitor_dna: dict,
) -> Optional[ThumbnailPromptVariantSchema]:
    """Safely parse one AI-returned variant dict into schema."""
    try:
        label = raw.get("option_label", OPTION_LABELS[idx])
        hook_family = raw.get("hook_family", "hidden_mechanism")
        if hook_family not in HOOK_FAMILIES:
            hook_family = "hidden_mechanism"

        ot = _parse_overlay(raw.get("overlay_text", {}), title)
        if ot is None:
            research_logger.warning(f"[PromptStudio] Overlay parse failed for variant {idx}")
            return None

        fip = raw.get("full_image_prompt", "")
        if len(fip.split()) < 50 or "same as" in fip.lower():
            research_logger.warning(f"[PromptStudio] full_image_prompt too short or invalid for variant {idx}")
            return None

        # Parse hook_quality
        hq_raw = raw.get("hook_quality", {})
        hq = HookQualityScoreSchema(
            curiosity_gap=int(hq_raw.get("curiosity_gap", 14)),
            one_second_clarity=int(hq_raw.get("one_second_clarity", 11)),
            title_complementarity=int(hq_raw.get("title_complementarity", 11)),
            visual_tension=int(hq_raw.get("visual_tension", 11)),
            specificity_and_proof=int(hq_raw.get("specificity_and_proof", 7)),
            mobile_readability=int(hq_raw.get("mobile_readability", 7)),
            promise_integrity=int(hq_raw.get("promise_integrity", 8)),
            competitor_fit=int(hq_raw.get("competitor_fit", 3)),
            penalties=int(hq_raw.get("penalties", 0)),
            total_score=int(hq_raw.get("total_score", 72)),
            rejection_reasons=hq_raw.get("rejection_reasons", []),
        )
        # Clamp
        hq.total_score = max(0, min(100, hq.total_score))
        # Enforce promise_integrity minimum for parsing (production safety)
        if hq.promise_integrity < 8:
            hq.rejection_reasons.append(f"promise_integrity below threshold: {hq.promise_integrity}")

        negative = raw.get("negative_prompt") or negative_base

        return ThumbnailPromptVariantSchema(
            id=raw.get("id") or str(uuid.uuid4()),
            option_label=label,
            concept_name=raw.get("concept_name", f"Option {label}"),
            hook_family=hook_family,
            visual_question=raw.get("visual_question", ""),
            hidden_information=raw.get("hidden_information", ""),
            test_hypothesis=raw.get("test_hypothesis", ""),
            strategic_angle=raw.get("strategic_angle", ""),
            title_interpretation=raw.get("title_interpretation", ""),
            overlay_text=ot,
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
            hook_quality=hq,
            recommended_test_rank=raw.get("recommended_test_rank", idx + 1),
            recommended_for_ab_test=raw.get("recommended_for_ab_test", idx < 3),
            warnings=raw.get("warnings", []),
        )
    except Exception as e:
        research_logger.warning(f"[PromptStudio] Failed to parse AI variant {idx}: {e}")
        return None


# ── Validator V2 ─────────────────────────────────────────────────────────────

def _validate_variants_v2(variants: List[ThumbnailPromptVariantSchema]) -> List[str]:
    """Comprehensive variant validation per spec."""
    errors: List[str] = []

    if len(variants) != 5:
        errors.append(f"Expected 5 variants, got {len(variants)}")
        return errors

    labels = [v.option_label for v in variants]
    if sorted(labels) != ["A", "B", "C", "D", "E"]:
        errors.append(f"Labels must be A-E, got {labels}")

    # Unique hook families — at least 4 different
    families = [v.hook_family for v in variants]
    if len(set(families)) < 4:
        errors.append(f"Need >= 4 unique hook families, got {len(set(families))}: {families}")

    # Unique overlays
    overlays = [v.overlay_text.combined_text for v in variants]
    if len(set(overlays)) < len(overlays):
        errors.append("Duplicate overlay text detected")

    # Unique visual concepts
    concepts = [v.visual_concept for v in variants]
    if len(set(concepts)) < len(concepts):
        errors.append("Duplicate visual_concept detected")

    for v in variants:
        # Overlay not empty, no placeholder
        if not v.overlay_text.combined_text.strip():
            errors.append(f"Empty overlay in variant {v.option_label}")
        if re.search(r"\[.+?\]", v.overlay_text.combined_text):
            errors.append(f"Placeholder in overlay for variant {v.option_label}")

        # Full prompt word count
        word_count = len(v.full_image_prompt.split())
        if word_count < 50:
            errors.append(f"full_image_prompt too short in variant {v.option_label}: {word_count} words")

        # Overlay word count <= 9
        ov_words = len(v.overlay_text.combined_text.split())
        if ov_words > 9:
            errors.append(f"Overlay too long in variant {v.option_label}: {ov_words} words")

        # Redundancy
        redundancy = calculate_title_overlay_redundancy(
            "placeholder_title", v.overlay_text.combined_text
        )  # will be called with actual title in context

        # Generic-only overlay
        if _is_generic_only(v.overlay_text.combined_text):
            errors.append(f"Generic-only overlay in variant {v.option_label}: '{v.overlay_text.combined_text}'")

        # Hook quality threshold
        if v.hook_quality.total_score < 70:
            errors.append(f"Hook quality below 70 in variant {v.option_label}: {v.hook_quality.total_score}")
        if v.hook_quality.promise_integrity < 8:
            errors.append(f"promise_integrity below 8 in variant {v.option_label}")
        if v.hook_quality.one_second_clarity < 10:
            errors.append(f"one_second_clarity below 10 in variant {v.option_label}")

        # same as above / placeholder
        if "same as above" in v.full_image_prompt.lower() or "same as option" in v.full_image_prompt.lower():
            errors.append(f"Forbidden text 'same as' in variant {v.option_label}")

    # Top 3 A/B must have different test hypotheses
    ab_variants = [v for v in variants if v.recommended_for_ab_test]
    ab_hypotheses = [v.test_hypothesis[:40] for v in ab_variants]
    if len(set(ab_hypotheses)) < min(len(ab_variants), 2):
        errors.append("Top A/B variants have identical test hypotheses")

    return errors


# ── Main Service ──────────────────────────────────────────────────────────────

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
        Never raises — falls back to deterministic semantic fallback if AI fails.
        """
        now = datetime.now(timezone.utc).isoformat()

        # Sanitize
        title = title.strip()[:200]
        video_context = (video_context or "").strip()[:2000]
        channel_title = channel_title.strip()

        analyses = thumbnail_intelligence.get("analyses", [])
        patterns = thumbnail_intelligence.get("patterns", [])
        limitations = thumbnail_intelligence.get("limitations", [])

        competitor_dna = _build_competitor_dna(blueprint, thumbnail_intelligence)
        outliers, baseline_samp, low_samp = _sample_analyses(analyses)

        # Deterministic title brief (always built; used as fallback)
        brief = _build_title_brief_deterministic(title, video_context)

        provider = getattr(ai_engine, "provider", "disabled")
        model_name = getattr(ai_engine, "_cloud_model", None)
        if model_name is None or not isinstance(model_name, str) or not model_name:
            model_name = ai_engine.ollama_model if provider == "ollama" else "gemini-2.0-flash"

        variants: List[ThumbnailPromptVariantSchema] = []
        used_ai = False
        fallback_used = False
        fallback_reason: Optional[str] = None
        analysis_summary: Optional[ThumbnailPromptAnalysisSummarySchema] = None
        ai_error: Optional[str] = None

        # ── AI pass ──────────────────────────────────────────────────────────
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
                "hook_families": list(HOOK_FAMILIES),
            }

            try:
                raw = await ai_engine.generate_thumbnail_prompt_variants(SYSTEM_PROMPT_V2, payload)
                if raw and isinstance(raw, dict):
                    # Build analysis_summary from AI response
                    summ_raw = raw.get("analysis_summary", {})
                    brief_raw = raw.get("title_brief", {})

                    rec_hook = summ_raw.get("recommended_hook") or competitor_dna.get("dominant_hook", "curiosity_gap")
                    if not rec_hook or rec_hook == "unknown":
                        rec_hook = competitor_dna.get("dominant_hook", "curiosity_gap")

                    analysis_summary = ThumbnailPromptAnalysisSummarySchema(
                        title_subject=summ_raw.get("title_subject") or title,
                        title_promise=summ_raw.get("title_promise") or f"Explores: {title}",
                        viewer_tension=summ_raw.get("viewer_tension") or brief.emotional_stake,
                        viewer_expectation=summ_raw.get("viewer_expectation") or brief.viewer_expectation,
                        hidden_variable=summ_raw.get("hidden_variable") or brief.hidden_variable,
                        strongest_proof_object=summ_raw.get("strongest_proof_object") or brief.strongest_proof_object,
                        visual_contradiction=summ_raw.get("visual_contradiction") or brief.visual_contradiction,
                        recommended_hook=rec_hook,
                        hook_source="ai_analysis",
                        competitor_style_summary=summ_raw.get("competitor_style_summary", ""),
                        overlay_style_summary=summ_raw.get("overlay_style_summary", ""),
                    )

                    # Parse variants
                    raw_variants = raw.get("variants", [])
                    if isinstance(raw_variants, list):
                        for i, rv in enumerate(raw_variants[:5]):
                            parsed = _parse_ai_variant(
                                rv, i, title, blueprint.get("negative_prompt", NEGATIVE_PROMPT_BASE), competitor_dna
                            )
                            if parsed is not None:
                                variants.append(parsed)

                    # Validate
                    if len(variants) == 5:
                        errs = _validate_variants_v2(variants)
                        if not errs:
                            used_ai = True
                        else:
                            research_logger.warning(f"[PromptStudio] AI validation errors: {errs}")
                            variants = []
                            ai_error = f"VALIDATION_FAILED: {'; '.join(errs)}"
                    else:
                        ai_error = f"AI returned {len(variants)} valid variants, expected 5"

            except RuntimeError as e:
                ai_error = str(e)
                research_logger.warning(f"[PromptStudio] AI RuntimeError: {e}")
            except Exception as e:
                ai_error = str(e)
                research_logger.warning(f"[PromptStudio] AI unexpected error: {e}")

        # ── Deterministic semantic fallback ────────────────────────────────────
        if not used_ai:
            fallback_used = True
            fallback_reason = ai_error or (
                "AI provider not configured. Using deterministic semantic fallback."
                if provider in ("disabled", "")
                else "AI returned invalid or incomplete response. Using deterministic semantic fallback."
            )

            candidates = _build_deterministic_candidates(title, brief, competitor_dna)
            selected = _score_and_select(candidates, title, competitor_dna)

            # Ensure exactly 5
            while len(selected) < 5:
                family = list(HOOK_FAMILIES)[len(selected) % len(HOOK_FAMILIES)]
                l1, l2 = _make_semantic_overlay(title, family, brief, competitor_dna, len(selected))
                extra = HookCandidate(
                    id=str(uuid.uuid4()),
                    hook_family=family,
                    visual_question="What is the viewer missing in this scene?",
                    focal_subject="Primary subject relevant to topic",
                    proof_object=brief.strongest_proof_object or None,
                    visual_tension="Clear visual contradiction or anomaly",
                    hidden_information="The explanation is withheld",
                    overlay_line_1=l1,
                    overlay_line_2=l2,
                    title_complement="Thumbnail creates question; title answers it",
                )
                extra.score = score_hook_candidate(extra, title, competitor_dna)
                selected.append(extra)

            variants = [
                _expand_candidate_to_variant(
                    selected[i], OPTION_LABELS[i], i + 1, title, blueprint, competitor_dna, brief
                )
                for i in range(5)
            ]

        # Simple rank assignment by hook_quality.total_score
        sorted_indices = sorted(
            range(len(variants)),
            key=lambda i: variants[i].hook_quality.total_score,
            reverse=True
        )
        rank_map: Dict[int, int] = {orig: rank + 1 for rank, orig in enumerate(sorted_indices)}

        # Ensure top-3 A/B have unique test hypotheses (best-effort swap)
        ab_indices = sorted_indices[:3]
        used_hyps: List[str] = []
        final_ab = []
        alt_pool = sorted_indices[3:]

        for ab_idx in ab_indices:
            hyp = variants[ab_idx].test_hypothesis[:40].lower()
            if hyp not in used_hyps:
                used_hyps.append(hyp)
                final_ab.append(ab_idx)
            else:
                # Try to find a replacement in alt_pool with different hypothesis
                swapped = False
                for alt_idx in alt_pool:
                    alt_hyp = variants[alt_idx].test_hypothesis[:40].lower()
                    if alt_hyp not in used_hyps:
                        # Swap ranks
                        rank_map[ab_idx], rank_map[alt_idx] = rank_map[alt_idx], rank_map[ab_idx]
                        used_hyps.append(alt_hyp)
                        final_ab.append(alt_idx)
                        swapped = True
                        break
                if not swapped:
                    used_hyps.append(hyp)
                    final_ab.append(ab_idx)

        for orig_idx, variant in enumerate(variants):
            variants[orig_idx] = ThumbnailPromptVariantSchema(
                **{
                    **variant.model_dump(),
                    "recommended_test_rank": rank_map[orig_idx],
                    "recommended_for_ab_test": rank_map[orig_idx] <= 3,
                }
            )

        # ── Analysis summary ───────────────────────────────────────────────────
        if analysis_summary is None:
            rec_hook = competitor_dna.get("dominant_hook", "curiosity_gap")
            hook_src = competitor_dna.get("hook_source", "safe_fallback")
            layout = competitor_dna.get("dominant_layout", "single subject center")
            bp_mode = competitor_dna.get("blueprint_mode", "safe_default")
            ov_words = competitor_dna.get("outlier_overlay_word_median", 4)
            ov_lines = competitor_dna.get("outlier_overlay_line_median", 1)
            caps = "ALL CAPS" if competitor_dna.get("text_uppercase", True) else "mixed case"

            analysis_summary = ThumbnailPromptAnalysisSummarySchema(
                title_subject=brief.literal_subject,
                title_promise=f"Explores: {brief.knowledge_gap or title}",
                viewer_tension=brief.emotional_stake or "Confusion or concern about unexpected outcome",
                viewer_expectation=brief.viewer_expectation,
                hidden_variable=brief.hidden_variable,
                strongest_proof_object=brief.strongest_proof_object,
                visual_contradiction=brief.visual_contradiction,
                recommended_hook=rec_hook,
                hook_source=f"deterministic_semantic ({hook_src})",
                competitor_style_summary=(
                    f"Competitor style: {str(layout).replace('_', ' ')} layout. "
                    f"Blueprint mode: {bp_mode}. "
                    f"Outlier hook: {rec_hook}."
                ),
                overlay_style_summary=(
                    f"Outlier overlay: ~{ov_words} words, ~{ov_lines} line(s), {caps}. "
                    f"Line 1 yellow (#FFE600), Line 2 white (#FFFFFF)."
                ),
            )

        return ThumbnailPromptGenerationResponse(
            title=title,
            channel_title=channel_title,
            provider=provider,
            model=model_name,
            used_ai=used_ai,
            fallback_used=fallback_used,
            fallback_reason=fallback_reason,
            analysis_summary=analysis_summary,
            variants=variants,
            generated_at=now,
        )
