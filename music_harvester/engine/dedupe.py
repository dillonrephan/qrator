from __future__ import annotations

from music_harvester.models import Candidate


def dedupe_candidates(candidates: list[Candidate]) -> list[Candidate]:
    seen: set[str] = set()
    result: list[Candidate] = []
    for item in candidates:
        key = f"{item.artist.lower()}::{item.title.lower()}"
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result
