import re
from collections import Counter
from typing import List, Dict, Any, Tuple
from schemas.research_schemas import TopicClusterSchema

STOP_WORDS = {
    "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by", "from",
    "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "and", "or", "but", "so", "if", "this", "that", "these",
    "those", "my", "your", "his", "her", "its", "our", "their", "it", "we", "you",
    "video", "youtube", "watch", "new", "2024", "2025", "2026", "how", "why", "what"
}

def clean_tokens(title: str) -> List[str]:
    clean = re.sub(r"[^\w\s]", " ", title.lower())
    words = clean.split()
    return [w for w in words if len(w) > 2 and w not in STOP_WORDS]

class TopicClusteringService:
    def cluster_videos(self, videos: List[Dict[str, Any]]) -> List[TopicClusterSchema]:
        if not videos:
            return []

        # 1. Extract bigrams and trigrams
        phrase_counter = Counter()
        video_phrases_map = {}

        for idx, v in enumerate(videos):
            tokens = clean_tokens(v.get("title", ""))
            phrases = []
            
            # Bigrams
            for i in range(len(tokens) - 1):
                p = f"{tokens[i]} {tokens[i+1]}"
                phrases.append(p)
                phrase_counter[p] += 1
                
            # Trigrams
            for i in range(len(tokens) - 2):
                p = f"{tokens[i]} {tokens[i+1]} {tokens[i+2]}"
                phrases.append(p)
                phrase_counter[p] += 1

            # Fallback to key single nouns if short
            for t in tokens:
                phrase_counter[t] += 1

            video_phrases_map[idx] = phrases + tokens

        # Top recurring phrases (min count 2)
        top_phrases = [p for p, count in phrase_counter.most_common(15) if count >= 2]
        if not top_phrases and phrase_counter:
            top_phrases = [p for p, _ in phrase_counter.most_common(5)]

        clusters: List[TopicClusterSchema] = []
        assigned_indices = set()

        for c_idx, phrase in enumerate(top_phrases[:6]):
            cluster_videos = []
            for v_idx, v in enumerate(videos):
                if phrase in video_phrases_map.get(v_idx, []):
                    cluster_videos.append(v)
                    assigned_indices.add(v_idx)

            if len(cluster_videos) >= 2:
                channels = set(v.get("channel_id") for v in cluster_videos)
                velocities = [v.get("views_per_day", 0.0) for v in cluster_videos]
                median_vel = sorted(velocities)[len(velocities) // 2] if velocities else 0.0
                titles = [v.get("title", "") for v in cluster_videos[:5]]

                label = phrase.title()
                summary = f"{len(cluster_videos)} videos analyzed across {len(channels)} unique channels covering '{label}'."

                clusters.append(
                    TopicClusterSchema(
                        id=f"cluster_{c_idx + 1}",
                        label=label,
                        summary=summary,
                        video_count=len(cluster_videos),
                        unique_channels=len(channels),
                        median_velocity=round(median_vel, 1),
                        top_titles=titles,
                        sample_keywords=[phrase, f"why {phrase}", f"{phrase} explained"]
                    )
                )

        return clusters

clustering_service = TopicClusteringService()
