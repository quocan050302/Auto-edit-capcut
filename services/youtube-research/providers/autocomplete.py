import asyncio
import re
import urllib.parse
from datetime import datetime, timezone
from typing import List, Dict, Set, Tuple
import httpx
from core.logger import research_logger

DEFAULT_INTENT_MODIFIERS = [
    "why",
    "how",
    "what",
    "best",
    "worst",
    "hidden",
    "truth",
    "explained",
    "cost",
    "price",
    "problem",
    "guide",
    "secret",
    "vs",
]

class KeywordExpander:
    def __init__(self, timeout: float = 4.0):
        self.timeout = timeout

    async def _query_suggest(self, query: str, market: str = "US", language: str = "en") -> List[str]:
        q_enc = urllib.parse.quote(query)
        url = f"https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q={q_enc}&gl={market}&hl={language}"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                if res.status_code == 200:
                    data = res.json()
                    if isinstance(data, list) and len(data) > 1 and isinstance(data[1], list):
                        return [str(s).strip() for s in data[1] if str(s).strip()]
        except Exception as e:
            research_logger.debug(f"[Suggest] Failed {query}: {e}")
        return []

    def _normalize_phrase(self, phrase: str) -> str:
        p = phrase.lower().strip()
        p = re.sub(r"[^\w\s\$\%]", "", p)
        p = re.sub(r"\s+", " ", p)
        return p

    def _is_too_similar(self, new_phrase: str, existing_set: Set[str]) -> bool:
        new_words = set(new_phrase.split())
        for existing in existing_set:
            existing_words = set(existing.split())
            if new_words == existing_words:
                return True
            # High Jaccard similarity
            intersect = len(new_words.intersection(existing_words))
            union = len(new_words.union(existing_words))
            if union > 0 and (intersect / union) > 0.85:
                return True
        return False

    async def expand_keywords(
        self,
        seed: str,
        market: str = "US",
        language: str = "en",
        max_keywords: int = 25
    ) -> Tuple[List[str], Dict[str, List[str]]]:
        current_year = str(datetime.now(timezone.utc).year)
        seed_norm = self._normalize_phrase(seed)
        
        results: List[str] = [seed_norm]
        seen_phrases: Set[str] = {seed_norm}
        sources: Dict[str, List[str]] = {
            "seed": [seed_norm],
            "autocomplete": [],
            "intent": [],
            "alphabet": [],
            "year": []
        }

        # 1. Base autocomplete
        base_suggestions = await self._query_suggest(seed_norm, market, language)
        for s in base_suggestions:
            norm = self._normalize_phrase(s)
            if norm and norm not in seen_phrases and not self._is_too_similar(norm, seen_phrases):
                seen_phrases.add(norm)
                results.append(norm)
                sources["autocomplete"].append(norm)

        # 2. Dynamic Year Modifier
        year_query = f"{seed_norm} {current_year}"
        year_suggestions = await self._query_suggest(year_query, market, language)
        for s in [year_query] + year_suggestions:
            norm = self._normalize_phrase(s)
            if norm and norm not in seen_phrases and not self._is_too_similar(norm, seen_phrases):
                seen_phrases.add(norm)
                results.append(norm)
                sources["year"].append(norm)

        # 3. Intent modifiers (parallel batch)
        intent_queries = [
            f"{modifier} {seed_norm}" for modifier in DEFAULT_INTENT_MODIFIERS[:8]
        ] + [
            f"{seed_norm} {modifier}" for modifier in ["explained", "cost", "problem", "secrets"]
        ]

        async def fetch_intent(q: str):
            suggs = await self._query_suggest(q, market, language)
            return q, suggs

        tasks = [fetch_intent(q) for q in intent_queries]
        intent_results = await asyncio.gather(*tasks, return_exceptions=True)

        for item in intent_results:
            if isinstance(item, tuple):
                query_used, suggs = item
                all_candidates = [query_used] + suggs
                for c in all_candidates:
                    norm = self._normalize_phrase(c)
                    if norm and norm not in seen_phrases and not self._is_too_similar(norm, seen_phrases):
                        seen_phrases.add(norm)
                        results.append(norm)
                        sources["intent"].append(norm)
                        if len(results) >= max_keywords:
                            break
            if len(results) >= max_keywords:
                break

        # 4. Alphabet expansion if still under limit
        if len(results) < max_keywords:
            alpha_letters = ["a", "b", "c", "h", "w"]
            alpha_tasks = [self._query_suggest(f"{seed_norm} {letter}", market, language) for letter in alpha_letters]
            alpha_results = await asyncio.gather(*alpha_tasks, return_exceptions=True)
            for res_list in alpha_results:
                if isinstance(res_list, list):
                    for s in res_list:
                        norm = self._normalize_phrase(s)
                        if norm and norm not in seen_phrases and not self._is_too_similar(norm, seen_phrases):
                            seen_phrases.add(norm)
                            results.append(norm)
                            sources["alphabet"].append(norm)
                            if len(results) >= max_keywords:
                                break
                if len(results) >= max_keywords:
                    break

        return results[:max_keywords], sources

keyword_expander = KeywordExpander()
