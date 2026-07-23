from __future__ import annotations

from music_harvester.models import Candidate
from music_harvester.engine.pools import assign_pools


FEEDBACK_BONUS = {
    "holy_shit": 8.0,
    "more_like_this": 5.0,
    "keep": 3.0,
    "too_much_right_now": -1.5,
    "almost_wrong": -2.0,
    "never_again": -20.0,
}


def score_candidates(
    candidates: list[Candidate],
    *,
    rules: dict,
    taste_profile: dict,
    feedback: dict[int, list[str]],
    recently_played: set[int],
) -> list[Candidate]:
    anchors = {item.lower() for item in taste_profile.get("anchors", {}).get("artists", [])}

    for candidate in candidates:
        trusted_source_score = candidate.score
        source_count = len(candidate.sources)
        platform_count = len(candidate.platforms)
        title_relevance = playlist_context_score(candidate.playlist_titles, rules)

        components = {
            "provenance_strength": trusted_source_score,
            "source_trust": trusted_source_score,
            "source_specificity": min(trusted_source_score, 4.0),
            "source_context_relevance": title_relevance,
            "multi_source_overlap": max(0, source_count - 1) * 6.0,
            "multi_platform_overlap": max(0, platform_count - 1) * 5.0,
            "bridge_cooccurrence": candidate.bridge_source_score,
            "bridge_side_balance": 12.0 if len(candidate.bridge_seed_sides) > 1 else 0.0,
            "extraction_confidence": candidate.extraction_confidence * 3.0,
            "resolution_confidence": candidate.spotify_resolution_confidence,
            "novelty_score": 0.0,
            "familiarity_score": 0.0,
            "texture_fit_score": title_relevance,
            "energy_fit_score": 0.0,
            "bridge_value_score": 2.5 if platform_count > 1 else 0.0,
            "exact_seed_cooccurrence_score": 20.0 if "exact_all_seeds" in candidate.bridge_match_types else 0.0,
            "near_bridge_score": 8.0 if "near_bridge" in candidate.bridge_match_types else 0.0,
            "cross_platform_bridge_score": 5.0 if candidate.bridge_source_score and platform_count > 1 else 0.0,
            "source_bridge_density": min(candidate.bridge_source_score / 10.0, 12.0),
            "contrast_value_score": 1.0 if source_count == 1 and platform_count == 1 else 0.0,
            "sequencing_value": 0.0,
            "feedback_history": 0.0,
            "recently_played": 0.0,
            "weak_provenance": -2.5 if source_count == 1 and trusted_source_score < 1.2 else 0.0,
            "noisy_source": -1.5 if source_count == 1 and any("likes" in title.lower() for title in candidate.playlist_titles) else 0.0,
            "low_confidence_extraction": -4.0 if candidate.extraction_confidence < 0.7 else 0.0,
            "almost_wrong_similarity_penalty": 0.0,
        }

        if candidate.artist.lower() in anchors:
            components["familiarity_score"] += 4.0

        if candidate.id not in recently_played:
            components["novelty_score"] += 2.0
        else:
            components["recently_played"] -= 7.0

        for rating in feedback.get(candidate.id, []):
            value = FEEDBACK_BONUS.get(rating, 0.0)
            components["feedback_history"] += value
            if rating == "almost_wrong":
                components["almost_wrong_similarity_penalty"] -= 1.5

        score = sum(components.values())
        candidate.score = round(score, 2)
        candidate.score_components = {key: round(value, 2) for key, value in components.items() if value}
        candidate.pools = assign_pools(candidate, taste_profile)
        candidate.why = explain_score(candidate)

    return sorted(candidates, key=lambda item: item.score, reverse=True)


def playlist_context_score(titles: list[str], rules: dict) -> float:
    buckets = rules.get("context_words", {})
    score = 0.0
    text = " ".join(titles).lower()
    for word in buckets.get("high", []):
        if word in text:
            score += 2.5
    for word in buckets.get("medium", []):
        if word in text:
            score += 1.25
    for word in buckets.get("low", []):
        if word in text:
            score += 0.25
    for word in buckets.get("reject", []):
        if word in text:
            score -= 3.0
    return score


def explain_score(candidate: Candidate) -> str:
    bits: list[str] = []
    if len(candidate.sources) > 1:
        bits.append(f"came from {len(candidate.sources)} high-trust sources")
    else:
        bits.append(f"came from {candidate.sources[0] if candidate.sources else 'one source'}")
    if "texture_match" in candidate.pools:
        bits.append("has texture fit")
    if "energy_match" in candidate.pools:
        bits.append("has energy fit")
    if "bridge_tracks" in candidate.pools:
        bits.append("can bridge distant source worlds")
    if len(candidate.bridge_seed_sides) > 1:
        bits.append("has evidence from multiple seed sides")
    elif candidate.bridge_seed_sides:
        bits.append(f"represents {candidate.bridge_seed_sides[0]}")
    if "exact_all_seeds" in candidate.bridge_match_types:
        bits.append("came from a source that contains every bridge seed")
    elif candidate.bridge_source_score:
        bits.append("came from a bridge candidate source")
    if "outer_ring" in candidate.pools:
        bits.append("sits in the outer ring rather than being an obvious anchor")
    if "wildcards" in candidate.pools:
        bits.append("adds justified risk")
    return "Selected because it " + ", ".join(bits) + "."
