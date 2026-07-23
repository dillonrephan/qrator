from __future__ import annotations

from collections import Counter, deque

from music_harvester.engine.pools import pool_mix_for_mode
from music_harvester.models import Candidate


def sequence_playlist(candidates: list[Candidate], rules: dict, length: int | None = None, mode: str = "balanced_discovery") -> list[Candidate]:
    target = int(length or rules.get("playlist_length", 40))
    max_per_artist = int(rules.get("max_tracks_per_artist", 3))
    min_artist_distance = int(rules.get("min_distance_same_artist", 10))
    max_per_source = int(rules.get("max_tracks_per_single_source", 5))
    pool_mix = pool_mix_for_mode(rules, mode)

    pool = sorted(candidates, key=lambda item: item.score, reverse=True)
    selected: list[Candidate] = []
    artist_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    pool_counts: Counter[str] = Counter()
    side_counts: Counter[str] = Counter()
    recent_artists: deque[str] = deque(maxlen=min_artist_distance)

    if mode == "bridge_discovery":
        seed_sides = sorted({side for candidate in pool for side in candidate.bridge_seed_sides if side.startswith("seed_")})
        side_target = max(2, min(6, target // max(1, len(seed_sides) * 3))) if seed_sides else 0
        for side in seed_sides:
            for candidate in pool[:]:
                if side_counts[side] >= side_target:
                    break
                if side not in candidate.bridge_seed_sides:
                    continue
                if not can_take(candidate, selected, artist_counts, source_counts, recent_artists, max_per_artist, max_per_source, pool):
                    continue
                pool.remove(candidate)
                take(candidate, selected, artist_counts, source_counts, pool_counts, side_counts, recent_artists)

    while pool and len(selected) < target:
        index = choose_next(
            pool,
            selected,
            artist_counts,
            source_counts,
            pool_counts,
            side_counts,
            recent_artists,
            max_per_artist,
            max_per_source,
            pool_mix,
            target,
        )
        if index is None:
            break
        item = pool.pop(index)
        take(item, selected, artist_counts, source_counts, pool_counts, side_counts, recent_artists)

    return selected


def take(
    item: Candidate,
    selected: list[Candidate],
    artist_counts: Counter[str],
    source_counts: Counter[str],
    pool_counts: Counter[str],
    side_counts: Counter[str],
    recent_artists: deque[str],
) -> None:
    selected.append(item)
    artist_counts[item.artist.lower()] += 1
    for source in item.sources:
        source_counts[source] += 1
    for pool_name in item.pools:
        pool_counts[pool_name] += 1
    for side in item.bridge_seed_sides:
        side_counts[side] += 1
    recent_artists.append(item.artist.lower())


def can_take(
    candidate: Candidate,
    selected: list[Candidate],
    artist_counts: Counter[str],
    source_counts: Counter[str],
    recent_artists: deque[str],
    max_per_artist: int,
    max_per_source: int,
    pool: list[Candidate],
) -> bool:
    artist = candidate.artist.lower()
    if artist_counts[artist] >= max_per_artist:
        return False
    if artist in recent_artists:
        return False
    if any(source_counts[source] >= max_per_source for source in candidate.sources):
        return False
    if would_make_source_run(selected, candidate) and has_source_alternative(pool, selected, candidate):
        return False
    return True


def choose_next(
    pool: list[Candidate],
    selected: list[Candidate],
    artist_counts: Counter[str],
    source_counts: Counter[str],
    pool_counts: Counter[str],
    side_counts: Counter[str],
    recent_artists: deque[str],
    max_per_artist: int,
    max_per_source: int,
    pool_mix: dict[str, float],
    target: int,
) -> int | None:
    viable: list[tuple[float, int]] = []
    for index, candidate in enumerate(pool[:80]):
        artist = candidate.artist.lower()
        if artist_counts[artist] >= max_per_artist:
            continue
        if artist in recent_artists:
            continue
        if any(source_counts[source] >= max_per_source for source in candidate.sources):
            continue
        if would_make_source_run(selected, candidate) and has_source_alternative(pool, selected, candidate):
            continue
        value = candidate.score + pool_need_bonus(candidate, pool_counts, pool_mix, target)
        value += bridge_side_bonus(candidate, selected, side_counts)
        viable.append((value, index))
    if not viable:
        return None
    return max(viable, key=lambda item: item[0])[1]


def would_make_source_run(selected: list[Candidate], candidate: Candidate) -> bool:
    if len(selected) < 2:
        return False
    candidate_sources = set(candidate.sources)
    if not candidate_sources:
        return False
    return all(candidate_sources.intersection(item.sources) for item in selected[-2:])


def has_source_alternative(pool: list[Candidate], selected: list[Candidate], candidate: Candidate) -> bool:
    if len(selected) < 2:
        return False
    current_sources = set(candidate.sources)
    for alternative in pool[:80]:
        if alternative is candidate:
            continue
        if not current_sources.intersection(alternative.sources):
            return True
    return False


def pool_need_bonus(candidate: Candidate, pool_counts: Counter[str], pool_mix: dict[str, float], target: int) -> float:
    if not pool_mix:
        return 0.0
    bonus = 0.0
    for pool_name in candidate.pools:
        desired = pool_mix.get(pool_name)
        if not desired:
            continue
        target_count = max(1, round(desired * target))
        if pool_counts[pool_name] < target_count:
            bonus += 2.0 * (target_count - pool_counts[pool_name]) / target_count
    return min(bonus, 4.0)


def bridge_side_bonus(candidate: Candidate, selected: list[Candidate], side_counts: Counter[str]) -> float:
    sides = candidate.bridge_seed_sides
    if not sides:
        return 0.0
    if len(sides) > 1:
        return 8.0

    side = sides[0]
    counts = [count for key, count in side_counts.items() if key.startswith("seed_")]
    if counts and side_counts[side] == min(counts):
        bonus = 35.0
    elif not counts:
        bonus = 20.0
    else:
        bonus = 0.0

    if selected:
        last_sides = set(selected[-1].bridge_seed_sides)
        if last_sides and side not in last_sides:
            bonus += 10.0
        elif len(selected) >= 2 and all(side in item.bridge_seed_sides for item in selected[-2:]):
            bonus -= 25.0
    return bonus
