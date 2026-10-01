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

ai_engine = AiInsightsEngine()
