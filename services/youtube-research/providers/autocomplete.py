import asyncio
import inspect
import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import List, Dict, Set, Tuple, Optional, Any, Callable
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
    def __init__(self, timeout: float = 4.0, total_timeout: float = 20.0):
        self.timeout = timeout
        self.total_timeout = total_timeout

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

    async def _safe_report_progress(self, progress_callback: Optional[Callable], pct: int, msg: str) -> None:
        if not progress_callback:
            return
        try:
            if inspect.iscoroutinefunction(progress_callback):
                await progress_callback(pct, msg)
            else:
                progress_callback(pct, msg)
        except Exception as e:
            research_logger.debug(f"[KeywordExpand] Progress callback non-fatal error: {e}")

    def build_rule_based_fallback(
        self,
        seed: str,
        max_keywords: int = 25
    ) -> Tuple[List[str], Dict[str, List[str]]]:
        current_year = str(datetime.now(timezone.utc).year)
        seed_norm = self._normalize_phrase(seed)
        if not seed_norm:
            seed_norm = "market"

        results: List[str] = [seed_norm]
        seen_phrases: Set[str] = {seed_norm}
        sources: Dict[str, List[str]] = {
            "seed": [seed_norm],
            "autocomplete": [],
            "intent": [],
            "alphabet": [],
            "year": [],
            "fallback": []
        }

        # Rule-based candidate patterns:
        # {seed}, why {seed}, how {seed}, {seed} explained, {seed} cost, {seed} prices,
        # {seed} problem, {seed} trends, {seed} {current_year}, best {seed}, {seed} guide...
        candidates = [
            f"why {seed_norm}",
            f"how {seed_norm}",
            f"{seed_norm} explained",
            f"{seed_norm} cost",
            f"{seed_norm} prices",
            f"{seed_norm} problem",
            f"{seed_norm} trends",
            f"{seed_norm} {current_year}",
            f"best {seed_norm}",
            f"{seed_norm} guide",
            f"what is {seed_norm}",
            f"truth about {seed_norm}",
            f"{seed_norm} secrets",
            f"worst {seed_norm}",
            f"{seed_norm} vs",
            f"how to fix {seed_norm}",
            f"{seed_norm} analysis",
            f"{seed_norm} breakdown",
            f"{seed_norm} news {current_year}",
            f"future of {seed_norm}",
            f"{seed_norm} review",
            f"is {seed_norm} worth it",
            f"{seed_norm} for beginners",
            f"{seed_norm} comparison",
            f"{seed_norm} market"
        ]

        for cand in candidates:
            norm = self._normalize_phrase(cand)
            if norm and norm not in seen_phrases and not self._is_too_similar(norm, seen_phrases):
                seen_phrases.add(norm)
                results.append(norm)
                sources["fallback"].append(norm)
                if len(results) >= max_keywords:
                    break

        return results[:max_keywords], sources

    async def _query_suggest_with_client(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
        query: str,
        market: str = "US",
        language: str = "en"
    ) -> List[str]:
        q_enc = urllib.parse.quote(query)
        url = f"https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q={q_enc}&gl={market}&hl={language}"
        try:
            async with semaphore:
                res = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                if res.status_code == 200:
                    data = res.json()
                    if isinstance(data, list) and len(data) > 1 and isinstance(data[1], list):
                        return [str(s).strip() for s in data[1] if str(s).strip()]
                elif res.status_code == 429:
                    research_logger.warning(f"[Suggest] Rate limited (429) on query: {query}")
                else:
                    research_logger.debug(f"[Suggest] Status {res.status_code} for query: {query}")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            research_logger.debug(f"[Suggest] Failed {query}: {e}")
        return []

    async def expand_keywords(
        self,
        seed: str,
        market: str = "US",
        language: str = "en",
        max_keywords: int = 25,
        progress_callback: Optional[Callable] = None
    ) -> Tuple[List[str], Dict[str, List[str]]]:
        start_time = time.perf_counter()
        current_year = str(datetime.now(timezone.utc).year)
        seed_norm = self._normalize_phrase(seed)
        if not seed_norm:
            seed_norm = "market"

        research_logger.info(f"[KeywordExpand] start seed={seed_norm}")

        results: List[str] = [seed_norm]
        seen_phrases: Set[str] = {seed_norm}
        sources: Dict[str, List[str]] = {
            "seed": [seed_norm],
            "autocomplete": [],
            "intent": [],
            "alphabet": [],
            "year": [],
            "fallback": []
        }

        await self._safe_report_progress(progress_callback, 15, f"Preparing keyword queries for '{seed_norm}'...")

        semaphore = asyncio.Semaphore(4)
        limits = httpx.Limits(max_keepalive_connections=8, max_connections=12)

        try:
            async with httpx.AsyncClient(timeout=self.timeout, limits=limits) as client:
                # 1. Base autocomplete
                await self._safe_report_progress(progress_callback, 18, f"Fetching base suggestions for '{seed_norm}'...")
                base_suggestions = await self._query_suggest_with_client(client, semaphore, seed_norm, market, language)
                for s in base_suggestions:
                    norm = self._normalize_phrase(s)
                    if norm and norm not in seen_phrases and not self._is_too_similar(norm, seen_phrases):
                        seen_phrases.add(norm)
                        results.append(norm)
                        sources["autocomplete"].append(norm)
                research_logger.info(f"[KeywordExpand] base.complete count={len(sources['autocomplete'])}")

                # 2. Dynamic Year Modifier
                await self._safe_report_progress(progress_callback, 21, f"Checking {current_year} searches for '{seed_norm}'...")
                year_query = f"{seed_norm} {current_year}"
                year_suggestions = await self._query_suggest_with_client(client, semaphore, year_query, market, language)
                if year_suggestions:
                    for s in [year_query] + year_suggestions:
                        norm = self._normalize_phrase(s)
                        if norm and norm not in seen_phrases and not self._is_too_similar(norm, seen_phrases):
                            seen_phrases.add(norm)
                            results.append(norm)
                            sources["year"].append(norm)
                research_logger.info(f"[KeywordExpand] year.complete count={len(sources['year'])}")

                # 3. Intent modifiers (parallel batch with semaphore)
                await self._safe_report_progress(progress_callback, 24, f"Expanding search intent for '{seed_norm}'...")
                intent_queries = [
                    f"{modifier} {seed_norm}" for modifier in DEFAULT_INTENT_MODIFIERS[:8]
                ] + [
                    f"{seed_norm} {modifier}" for modifier in ["explained", "cost", "problem", "secrets"]
                ]

                async def fetch_intent(q: str):
                    suggs = await self._query_suggest_with_client(client, semaphore, q, market, language)
                    return q, suggs

                tasks = [fetch_intent(q) for q in intent_queries]
                intent_results = await asyncio.gather(*tasks, return_exceptions=True)

                for item in intent_results:
                    if isinstance(item, tuple):
                        query_used, suggs = item
                        if suggs:
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
                research_logger.info(f"[KeywordExpand] intent.complete count={len(sources['intent'])}")

                # 4. Alphabet expansion if still under limit
                if len(results) < max_keywords:
                    await self._safe_report_progress(progress_callback, 27, f"Expanding related phrases for '{seed_norm}'...")
                    alpha_letters = ["a", "b", "c", "h", "w"]
                    alpha_tasks = [
                        self._query_suggest_with_client(client, semaphore, f"{seed_norm} {letter}", market, language)
                        for letter in alpha_letters
                    ]
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
                    research_logger.info(f"[KeywordExpand] alphabet.complete count={len(sources['alphabet'])}")

        except asyncio.CancelledError:
            raise
        except Exception as e:
            research_logger.warning(f"[KeywordExpand] Exception during external expansion: {e}")

        # If external sources yielded very few keywords (e.g. Google Suggest blocked, offline, or timed out),
        # supplement with deterministic rule-based fallback candidates!
        if len(results) < 5:
            research_logger.info("[KeywordExpand] Insufficient suggestions from external API, supplementing with rule-based fallback...")
            fb_keywords, _ = self.build_rule_based_fallback(seed_norm, max_keywords=max_keywords)
            for fb_kw in fb_keywords:
                norm = self._normalize_phrase(fb_kw)
                if norm and norm not in seen_phrases and not self._is_too_similar(norm, seen_phrases):
                    seen_phrases.add(norm)
                    results.append(norm)
                    sources["fallback"].append(norm)
                    if len(results) >= max_keywords:
                        break

        await self._safe_report_progress(progress_callback, 29, f"Keyword expansion complete: {len(results)} queries discovered.")
        duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
        research_logger.info(f"[KeywordExpand] complete count={len(results)} duration_ms={duration_ms}")

        return results[:max_keywords], sources

keyword_expander = KeywordExpander()
