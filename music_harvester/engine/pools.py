from __future__ import annotations

from music_harvester.models import Candidate


POOLS = [
    "direct_shelf",
    "one_shelf_away",
    "corroborated",
    "cross_platform",
    "single_shelf",
    "wildcards",
]


def assign_pools(candidate: Candidate) -> list[str]:
    pools: set[str] = set()
    if candidate.discovery_distance == "directly supplied":
        pools.add("direct_shelf")
    else:
        pools.add("one_shelf_away")
    if len(candidate.sources) > 1:
        pools.add("corroborated")
    else:
        pools.add("single_shelf")
        pools.add("wildcards")
    if len(candidate.platforms) > 1:
        pools.add("cross_platform")
    return sorted(pools)


def pool_mix_for_mode(rules: dict, mode: str) -> dict[str, float]:
    modes = rules.get("modes", {})
    mode_config = modes.get(mode) or modes.get("balanced_discovery") or {}
    return mode_config.get("mix", {})
