import json
import re
from typing import Dict, Any, Optional, List
import httpx
from schemas.research_schemas import AiReportSchema, VideoIdeaSchema
from core.logger import research_logger

class AiInsightsEngine:
    def __init__(
        self,
        provider: str = "disabled",
        ollama_url: str = "http://localhost:11434",
        ollama_model: str = "llama3",
        cloud_api_key: str = ""
    ):
        self.provider = provider.lower()
        self.ollama_url = ollama_url
        self.ollama_model = ollama_model
        self.cloud_api_key = cloud_api_key

    def update_config(self, provider: str, ollama_url: str, ollama_model: str, cloud_api_key: str):
        self.provider = provider.lower()
        self.ollama_url = ollama_url
        self.ollama_model = ollama_model
        self.cloud_api_key = cloud_api_key

    def generate_deterministic_fallback(
        self,
        topic: str,
        market: str,
        top_keyword: str,
        breakouts: List[Dict[str, Any]],
        clusters: List[Dict[str, Any]]
    ) -> AiReportSchema:
        top_titles = [b.get("title", "") for b in breakouts[:3] if b.get("title")]
        cluster_labels = [c.get("label", "") for c in clusters[:3] if c.get("label")]

        summary = (
            f"Public YouTube data in the {market} market reveals strong viewer interest in '{topic}'. "
            f"Key breakout topics center around {', '.join(cluster_labels) if cluster_labels else top_keyword} "
            f"with independent channels successfully gaining traction."
        )

        why_rising = [
            f"Increased search demand for '{top_keyword}' across foreign market signals",
            "Multiple independent channels achieving >3x their usual baseline views",
            "Strong viewer engagement with explanatory and investigative long-form titles"
        ]

        winning_angles = [
            f"Why {top_keyword} is happening now: Breaking down the root causes",
            f"The real cost: Personal story and case study angle",
            "Comparative breakdown: What the mainstream headlines missed"
        ]

        title_patterns = [
            "Why [Subject] Is Breaking In [Current Year]",
            "The Real Reason [Subject] Won't Get Better",
            "I Investigated [Subject] (Here's What Happened)",
            "[Number] Things You Weren't Told About [Subject]"
        ]

        content_gaps = [
            "Lack of high-production, data-driven documentary style breakdowns",
            "Few creators connecting macro trends to everyday personal impact",
            "Over-saturation of superficial reaction clips with limited deep research"
        ]

        risks = [
            "Rapid news cycle shifts requiring timely publishing",
            "Viewer fatigue if title promises reveal without substantive evidence"
        ]

        video_ideas = [
            VideoIdeaSchema(
                title=f"The Hidden Reality of {top_keyword.title()}",
                angle="In-depth documentary focusing on economic and systemic factors",
                target_format="Long-form",
                why_it_works="Capitalizes on high search volume and addresses content gap for thorough investigative storytelling."
            ),
            VideoIdeaSchema(
                title=f"Why Everyone is Talking About {top_keyword.title()}",
                angle="Fast-paced trend overview with breakdown of key figures",
                target_format="Long-form",
                why_it_works="Broad appeal hook designed for high initial CTR."
            )
        ]

        return AiReportSchema(
            summary=summary,
            why_it_is_rising=why_rising,
            winning_angles=winning_angles,
            title_patterns=title_patterns,
            content_gaps=content_gaps,
            risks=risks,
            video_ideas=video_ideas
        )

    async def generate_insights(
        self,
        topic: str,
        market: str,
        top_keyword: str,
        breakouts: List[Dict[str, Any]],
        clusters: List[Dict[str, Any]]
    ) -> AiReportSchema:
        if self.provider == "disabled" or not self.provider:
            return self.generate_deterministic_fallback(topic, market, top_keyword, breakouts, clusters)

        prompt = f"""You are a senior YouTube market strategist. Analyze the following verified public YouTube data:
Topic: {topic}
Target Market: {market}
Top Rising Keyword: {top_keyword}
Top Breakout Titles: {[b.get('title') for b in breakouts[:5]]}
Discovered Topic Clusters: {[c.get('label') for c in clusters[:4]]}

Respond ONLY with valid JSON matching this exact schema:
{{
  "summary": "1-2 sentence executive overview",
  "why_it_is_rising": ["point 1", "point 2", "point 3"],
  "winning_angles": ["angle 1", "angle 2", "angle 3"],
  "title_patterns": ["pattern 1", "pattern 2", "pattern 3"],
  "content_gaps": ["gap 1", "gap 2"],
  "risks": ["risk 1", "risk 2"],
  "video_ideas": [
    {{
      "title": "Proposed video title",
      "angle": "Specific perspective",
      "target_format": "Long-form",
      "why_it_works": "Strategic reason"
    }}
  ]
}}"""

        try:
            if self.provider == "ollama":
                async with httpx.AsyncClient(timeout=25.0) as client:
                    resp = await client.post(
                        f"{self.ollama_url}/api/generate",
                        json={"model": self.ollama_model, "prompt": prompt, "stream": False, "format": "json"}
                    )
                    if resp.status_code == 200:
                        raw_text = resp.json().get("response", "")
                        parsed = json.loads(raw_text)
                        return AiReportSchema(**parsed)

        except Exception as e:
            research_logger.warning(f"[AI] Provider {self.provider} error ({e}). Using deterministic fallback.")

        return self.generate_deterministic_fallback(topic, market, top_keyword, breakouts, clusters)

    async def analyze_thumbnail_vision(self, image_data: bytes, context: dict) -> dict:
        if self.provider == "disabled" or not self.provider:
            return {"confidence": 0.0}

        import base64
        b64_img = base64.b64encode(image_data).decode('utf-8')
        
        prompt = f"""You are analyzing a YouTube thumbnail image for intelligence research.
Context:
- Video title: "{context.get('video_title', '')}"
- Performance group: {context.get('performance_group', 'unknown')}
- Views: {context.get('views', 0):,}
- Views/day: {context.get('views_per_day', 0):.1f}
- Outlier ratio: {context.get('outlier_ratio', 0):.2f}x

Analyze the thumbnail and return ONLY valid JSON with this exact schema. Do not use markdown blocks, just raw JSON:
{{
  "confidence": 0.8,
  "ocr": {{
    "text": "exact text on thumbnail",
    "line_count": 1,
    "text_coverage_pct": 0.1,
    "text_alignment": "center",
    "confidence": 0.9,
    "font_category": "bold_condensed_sans"
  }},
  "composition": {{
    "layout_type": "centered",
    "main_focal_point": "face",
    "has_negative_space": true,
    "background_complexity": "low",
    "subject_size_pct": 0.4,
    "face_size_pct": 0.2,
    "main_subject_box": {{"x": 0.3, "y": 0.2, "width": 0.4, "height": 0.6}},
    "text_region_box": {{"x": 0.1, "y": 0.8, "width": 0.8, "height": 0.15}},
    "duration_badge_risk": true
  }},
  "subjects": {{
    "has_person": true,
    "person_count": 1,
    "face_count": 1,
    "shot_type": "close_up",
    "facial_expression": "surprised",
    "gaze_direction": "camera",
    "has_proof_object": false,
    "has_arrow_circle": false,
    "has_comparison": false,
    "has_contradiction": false
  }},
  "hooks": [
    {{
      "hook_type": "curiosity_gap",
      "confidence": 0.9,
      "visual_evidence": "surprised face looking at camera",
      "text_evidence": "text says 'why'",
      "title_evidence": "title asks question"
    }}
  ],
  "mobile_readability": {{
    "score": 85,
    "text_readable": true,
    "face_recognizable": true,
    "main_object_clear": true,
    "duration_badge_overlap_risk": false,
    "breakdown": {{}}
  }}
}}
"""
        try:
            if self.provider == "ollama":
                # Some Ollama models support vision (e.g. llava). 
                # We assume self.ollama_model supports vision if this is called.
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post(
                        f"{self.ollama_url}/api/generate",
                        json={
                            "model": self.ollama_model,
                            "prompt": prompt,
                            "images": [b64_img],
                            "stream": False,
                            "format": "json"
                        }
                    )
                    if resp.status_code == 200:
                        raw_text = resp.json().get("response", "")
                        return json.loads(raw_text)
            
            elif self.provider == "gemini":
                if not self.cloud_api_key:
                    return {"confidence": 0.0}
                # Use Gemini Pro Vision / Flash via REST API
                url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={self.cloud_api_key}"
                payload = {
                    "contents": [{
                        "parts": [
                            {"text": prompt},
                            {"inline_data": {"mime_type": "image/jpeg", "data": b64_img}}
                        ]
                    }],
                    "generationConfig": {
                        "response_mime_type": "application/json"
                    }
                }
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post(url, json=payload)
                    if resp.status_code == 200:
                        data = resp.json()
                        text_content = data["candidates"][0]["content"]["parts"][0]["text"]
                        return json.loads(text_content)
        except Exception as e:
            research_logger.warning(f"[AI] analyze_thumbnail_vision error: {e}")
        
        return {"confidence": 0.0}

    async def generate_thumbnail_prompt_variants(
        self,
        system_prompt: str,
        payload: dict
    ) -> dict:
        """
        Generate exactly 5 thumbnail prompt variants using competitor intelligence.
        Returns raw parsed dict from AI. Caller must validate.
        """
        import json as _json

        if self.provider == "disabled" or not self.provider:
            return {}

        user_message = _json.dumps(payload, ensure_ascii=False)

        try:
            if self.provider == "gemini":
                if not self.cloud_api_key:
                    research_logger.warning("[AI] Gemini key not configured for thumbnail prompts")
                    return {}

                # Use configurable model, fallback to gemini-2.0-flash
                model = getattr(self, "_cloud_model", "gemini-2.0-flash")
                url = (
                    f"https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{model}:generateContent?key={self.cloud_api_key}"
                )
                gemini_payload = {
                    "system_instruction": {"parts": [{"text": system_prompt}]},
                    "contents": [{"parts": [{"text": user_message}]}],
                    "generationConfig": {
                        "response_mime_type": "application/json",
                        "temperature": 0.7,
                        "maxOutputTokens": 8192,
                    }
                }

                last_err = None
                for attempt in range(3):
                    try:
                        async with httpx.AsyncClient(timeout=110.0) as client:
                            resp = await client.post(url, json=gemini_payload)
                            if resp.status_code == 429:
                                research_logger.warning(f"[AI] Gemini rate limited (attempt {attempt+1})")
                                if attempt < 2:
                                    import asyncio
                                    await asyncio.sleep(2 ** attempt)
                                    continue
                                raise RuntimeError("AI_RATE_LIMITED")
                            if resp.status_code == 400:
                                raise RuntimeError("AI_INVALID_RESPONSE")
                            if resp.status_code != 200:
                                raise RuntimeError(f"AI_HTTP_{resp.status_code}")

                            data = resp.json()
                            text = data["candidates"][0]["content"]["parts"][0]["text"]
                            # Strip markdown fences if present
                            text = text.strip()
                            if text.startswith("```"):
                                text = text.split("```")[1]
                                if text.startswith("json"):
                                    text = text[4:]
                            return _json.loads(text)
                    except (_json.JSONDecodeError, KeyError) as e:
                        last_err = e
                        research_logger.warning(f"[AI] Gemini parse error (attempt {attempt+1}): {e}")
                        break
                    except RuntimeError:
                        raise
                    except Exception as e:
                        last_err = e
                        research_logger.warning(f"[AI] Gemini error (attempt {attempt+1}): {e}")
                        if attempt < 2:
                            import asyncio
                            await asyncio.sleep(2 ** attempt)

                if last_err:
                    research_logger.warning(f"[AI] Gemini exhausted retries: {last_err}")
                return {}

            elif self.provider == "ollama":
                combined = f"{system_prompt}\n\nUser data:\n{user_message}"
                async with httpx.AsyncClient(timeout=110.0) as client:
                    resp = await client.post(
                        f"{self.ollama_url}/api/generate",
                        json={"model": self.ollama_model, "prompt": combined, "stream": False, "format": "json"}
                    )
                    if resp.status_code == 200:
                        raw = resp.json().get("response", "")
                        return _json.loads(raw)

        except Exception as e:
            research_logger.warning(f"[AI] generate_thumbnail_prompt_variants error: {e}")

        return {}

    def update_config(
        self,
        provider: str,
        ollama_url: str,
        ollama_model: str,
        cloud_api_key: str,
        cloud_model: str = "gemini-2.0-flash"
    ):
        self.provider = provider.lower()
        self.ollama_url = ollama_url
        self.ollama_model = ollama_model
        self.cloud_api_key = cloud_api_key
        self._cloud_model = cloud_model


ai_engine = AiInsightsEngine()
