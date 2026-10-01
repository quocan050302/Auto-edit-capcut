from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any, Set
import logging
from schemas.research_schemas import (
    ResearchFilters,
    KeywordRecordSchema,
    BreakoutVideoSchema
)

logger = logging.getLogger(__name__)

@dataclass
class FilterStats:
    raw_videos: int = 0
    matched_metadata: int = 0
    matched_enriched: int = 0
    matched_keywords: int = 0
    excluded_min_views: int = 0
    excluded_min_views_per_day: int = 0
    excluded_max_subscribers: int = 0
    excluded_unknown_subscribers: int = 0
    excluded_min_outlier: int = 0
    excluded_missing_baseline: int = 0
    excluded_min_opportunity: int = 0
    excluded_max_competition: int = 0

def get_val(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)

def get_active_filters(filters: ResearchFilters) -> Dict[str, float]:
    result = {}
    if filters.min_views is not None:
        result['min_views'] = float(filters.min_views)
    if filters.max_subscribers is not None:
        result['max_subscribers'] = float(filters.max_subscribers)
    if filters.min_views_per_day is not None:
        result['min_views_per_day'] = filters.min_views_per_day
    if filters.min_outlier_ratio is not None:
        result['min_outlier_ratio'] = filters.min_outlier_ratio
    if filters.min_opportunity is not None:
        result['min_opportunity'] = filters.min_opportunity
    if filters.max_competition is not None:
        result['max_competition'] = filters.max_competition
    return result

def apply_metadata_filters(
    videos: List[Any],
    filters: ResearchFilters,
    stats: FilterStats
) -> List[Any]:
    if not videos:
        return []

    min_views = filters.min_views
    min_vpd = filters.min_views_per_day
    
    filtered = []
    for v in videos:
        valid = True
        if min_views is not None:
            if get_val(v, 'views', 0) < min_views:
                stats.excluded_min_views += 1
                valid = False
        
        if valid and min_vpd is not None:
            views = get_val(v, 'views', 0)
            from datetime import datetime, timezone
            published_at = get_val(v, 'published_at')
            vpd = 0.0
            if published_at:
                try:
                    pub_dt = datetime.fromisoformat(published_at.replace('Z', '+00:00'))
                    age_days = (datetime.now(timezone.utc) - pub_dt).total_seconds() / 86400.0
                    age_days = max(age_days, 1.0)
                    vpd = views / age_days
                except:
                    pass
            
            if vpd < min_vpd:
                stats.excluded_min_views_per_day += 1
                valid = False
                
        if valid:
            filtered.append(v)
            
    stats.matched_metadata = len(filtered)
    return filtered

def apply_enriched_video_filters(
    videos: List[Any],
    filters: ResearchFilters,
    stats: FilterStats
) -> List[Any]:
    if not videos:
        stats.matched_enriched = 0
        return []

    max_subs = filters.max_subscribers
    min_outlier = filters.min_outlier_ratio
    
    filtered = []
    for v in videos:
        valid = True
        if max_subs is not None:
            subs = get_val(v, 'channel_subscribers')
            if subs is None:
                stats.excluded_unknown_subscribers += 1
                valid = False
            elif subs > max_subs:
                stats.excluded_max_subscribers += 1
                valid = False
                
        if valid and min_outlier is not None:
            baseline = get_val(v, 'channel_median_views')
            if baseline is None:
                baseline = get_val(v, 'channel_median')
            outlier = get_val(v, 'outlier_ratio')
            if baseline is None or outlier is None:
                stats.excluded_missing_baseline += 1
                valid = False
            elif outlier < min_outlier:
                stats.excluded_min_outlier += 1
                valid = False
                
        if valid:
            filtered.append(v)
            
    stats.matched_enriched = len(filtered)
    return filtered

def apply_keyword_filters(
    keywords: List[KeywordRecordSchema],
    filters: ResearchFilters,
    stats: FilterStats
) -> List[KeywordRecordSchema]:
    if not keywords:
        stats.matched_keywords = 0
        return []

    min_opp = filters.min_opportunity
    max_comp = filters.max_competition
    
    filtered = []
    for kw in keywords:
        valid = True
        if min_opp is not None:
            if kw.opportunity_score < min_opp:
                stats.excluded_min_opportunity += 1
                valid = False
                
        if valid and max_comp is not None:
            if kw.competition_score > max_comp:
                stats.excluded_max_competition += 1
                valid = False
                
        if valid:
            filtered.append(kw)
            
    stats.matched_keywords = len(filtered)
    return filtered
