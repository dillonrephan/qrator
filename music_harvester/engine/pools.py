from __future__ import annotations

from music_harvester.models import Candidate


POOLS = [
    "anchors",
    "adjacent",
    "outer_ring",
    "wildcards",
    "bridge_tracks",
    "texture_match",
    "energy_match",
    "deep_source",
    "confirmed",
    "rejected",
    "almost",
]


def assign_pools(candidate: Candidate, taste_profile: dict) -> list[str]:
    pools: set[str] = set()
    anchors = {item.lower() for item in taste_profile.get("anchors", {}).get("artists", [])}
    text = " ".join([candidate.artist, candidate.title, *candidate.playlist_titles]).lower()

    if candidate.artist.lower() in anchors:
        pools.add("anchors")
    if len(candidate.sources) > 1:
        pools.add("deep_source")
        pools.add("adjacent")
    if len(candidate.platforms) > 1:
        pools.add("bridge_tracks")
        pools.add("outer_ring")
    if candidate.bridge_source_score >= 80:
        pools.add("bridge_tracks")
        pools.add("deep_source")
    elif candidate.bridge_source_score >= 35:
        pools.add("bridge_tracks")
        pools.add("outer_ring")
    if any(word in text for word in texture_words(taste_profile)):
        pools.add("texture_match")
    if any(word in text for word in energy_words(taste_profile)):
        pools.add("energy_match")
    if candidate.score >= 12 and "anchors" not in pools:
        pools.add("adjacent")
    if candidate.score < 8 and candidate.sources:
        pools.add("outer_ring")
    if candidate.score >= 9 and len(candidate.sources) == 1 and "anchors" not in pools:
        pools.add("wildcards")

    return sorted(pools or {"outer_ring"})


def texture_words(taste_profile: dict) -> list[str]:
    explicit = taste_profile.get("texture_words")
    if explicit:
        return [str(item).lower() for item in explicit]
    traits = taste_profile.get("traits", {}).get("positive", [])
    return [str(item).lower() for item in traits if any(word in str(item).lower() for word in ("texture", "production", "voice", "vocal", "raw", "harsh", "dust", "sinister"))]


def energy_words(taste_profile: dict) -> list[str]:
    explicit = taste_profile.get("energy_words")
    if explicit:
        return [str(item).lower() for item in explicit]
    traits = taste_profile.get("traits", {}).get("positive", [])
    return [str(item).lower() for item in traits if any(word in str(item).lower() for word in ("energy", "motion", "animated", "aggressive", "unhinged", "intensity"))]


def pool_mix_for_mode(rules: dict, mode: str) -> dict[str, float]:
    modes = rules.get("modes", {})
    mode_config = modes.get(mode) or modes.get("balanced_discovery") or {}
    return mode_config.get("mix", {})
