from __future__ import annotations

from music_harvester.engine.pools import assign_pools
from music_harvester.models import Candidate


def score_candidates(candidates: list[Candidate]) -> list[Candidate]:
    """Rank evidence paths without pretending to predict personal taste."""

    for candidate in candidates:
        source_count = len(candidate.sources)
        platform_count = len(candidate.platforms)
        direct_input = any(source.startswith(("bridge_user_", "bridge_file_", "bridge_text_")) for source in candidate.sources)
        source_prior = min(20.0, max(0.0, candidate.score) * 6.0)
        bridge_evidence = min(45.0, max(0.0, candidate.bridge_source_score) * 0.45)
        independent_support = min(15.0, max(0, source_count - 1) * 8.0)
        cross_platform = min(8.0, max(0, platform_count - 1) * 5.0)
        seed_coverage = min(7.0, len(candidate.bridge_seed_sides) * 3.5)
        metadata_quality = max(
            0.0,
            min(15.0, ((candidate.extraction_confidence + candidate.normalization_confidence) / 2.0) * 15.0),
        )
        explicit_root = 10.0 if direct_input else 0.0

        components = {
            "source_prior": source_prior,
            "seed_connection": bridge_evidence,
            "independent_shelves": independent_support,
            "cross_platform_support": cross_platform,
            "seed_coverage": seed_coverage,
            "metadata_quality": metadata_quality,
            "explicit_user_source": explicit_root,
        }
        shelf_confidence = min(100.0, sum(components.values()))
        candidate.shelf_confidence = round(shelf_confidence, 1)
        candidate.recording_confidence = round(
            max(0.0, min(100.0, ((candidate.extraction_confidence + candidate.normalization_confidence) / 2.0) * 100.0)),
            1,
        )
        candidate.discovery_distance = discovery_distance(candidate, direct_input)
        candidate.score = candidate.shelf_confidence
        candidate.score_components = {
            key: round(value, 1) for key, value in components.items() if value
        }
        candidate.pools = assign_pools(candidate)
        candidate.why = explain_evidence(candidate)

    return sorted(candidates, key=lambda item: item.shelf_confidence, reverse=True)


def discovery_distance(candidate: Candidate, direct_input: bool) -> str:
    if direct_input:
        return "directly supplied"
    if len(candidate.sources) > 1:
        return "one hop, multiple shelves"
    return "one shelf away"


def explain_evidence(candidate: Candidate) -> str:
    shelves = len(candidate.sources)
    bits = [
        f"pulled from {shelves} shelf{'s' if shelves != 1 else ''}",
        candidate.discovery_distance,
    ]
    if candidate.bridge_seed_sides:
        bits.append(f"the shelf connected to {len(candidate.bridge_seed_sides)} seed side{'s' if len(candidate.bridge_seed_sides) != 1 else ''}")
    if len(candidate.platforms) > 1:
        bits.append("independent platforms also surfaced the recording")
    bits.append("no claim is made about whether you will like it")
    return "Shown because it was " + "; ".join(bits) + "."
