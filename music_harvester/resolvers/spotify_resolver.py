from __future__ import annotations

import os
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from rapidfuzz.fuzz import ratio

from music_harvester.engine.normalize import normalize_key, normalize_text
from music_harvester.models import Candidate
from music_harvester.sources.spotify import SpotifyClient


CACHE_VERSION = "spotify-strict-v2"


@dataclass
class Match:
    item: dict
    confidence: float


class ResolutionCache:
    def __init__(self, path: Path | None = None):
        state_dir = Path(os.environ.get("QRATOR_STATE_DIR", "data"))
        state_dir.mkdir(parents=True, exist_ok=True)
        self.path = path or state_dir / "resolution-cache.sqlite"
        self.conn = sqlite3.connect(self.path)
        self.conn.execute(
            """
            create table if not exists resolutions (
              target text not null,
              algorithm text not null,
              candidate_key text not null,
              uri text,
              confidence real not null,
              checked_at integer not null,
              primary key (target, algorithm, candidate_key)
            )
            """
        )
        self.conn.commit()

    def get(self, key: str) -> tuple[str | None, float] | None:
        row = self.conn.execute(
            """
            select uri, confidence, checked_at
            from resolutions
            where target = 'spotify' and algorithm = ? and candidate_key = ?
            """,
            (CACHE_VERSION, key),
        ).fetchone()
        if not row:
            return None
        uri, confidence, checked_at = row
        ttl = 30 * 86400 if uri else 3 * 86400
        if int(checked_at) + ttl < int(time.time()):
            return None
        return uri, float(confidence)

    def put(self, key: str, uri: str | None, confidence: float) -> None:
        self.conn.execute(
            """
            insert into resolutions (target, algorithm, candidate_key, uri, confidence, checked_at)
            values ('spotify', ?, ?, ?, ?, ?)
            on conflict(target, algorithm, candidate_key) do update set
              uri=excluded.uri,
              confidence=excluded.confidence,
              checked_at=excluded.checked_at
            """,
            (CACHE_VERSION, key, uri, confidence, int(time.time())),
        )
        self.conn.commit()


class SpotifyResolver:
    def __init__(
        self,
        client: SpotifyClient | None = None,
        *,
        cache: ResolutionCache | None = None,
        query_budget: int | None = None,
    ):
        self.client = client or SpotifyClient()
        self.cache = cache or ResolutionCache()
        self.query_budget = query_budget if query_budget is not None else int(os.environ.get("QRATOR_SPOTIFY_RESOLVE_LIMIT", "12"))
        self.queries = 0

    def resolve(self, candidate: Candidate) -> Candidate:
        if candidate.spotify_uri:
            candidate.spotify_resolution_confidence = max(candidate.spotify_resolution_confidence, 1.0)
            return candidate

        key = normalize_key(candidate.artist, candidate.title)
        cached = self.cache.get(key)
        if cached is not None:
            candidate.spotify_uri, candidate.spotify_resolution_confidence = cached
            return candidate
        if self.queries >= self.query_budget:
            return candidate

        self.queries += 1
        query = f'artist:"{search_artist(candidate.artist)}" track:"{candidate.title}"'
        result = self.client.get(
            "/search",
            params={"type": "track", "limit": 10, "q": query},
            polite_delay=0.15,
            retries=0,
        )
        match = best_match(candidate, result.get("tracks", {}).get("items", []))
        candidate.spotify_uri = match.item.get("uri") if match else None
        candidate.spotify_resolution_confidence = match.confidence if match else 0.0
        self.cache.put(key, candidate.spotify_uri, candidate.spotify_resolution_confidence)
        return candidate


def best_match(candidate: Candidate, items: list[dict]) -> Match | None:
    ranked: list[tuple[float, dict]] = []
    wanted_artist = normalize_text(candidate.artist).casefold()
    wanted_title = normalize_text(candidate.title).casefold()
    wanted_qualifiers = version_qualifiers(wanted_title)

    for item in items:
        item_title = normalize_text(item.get("name") or "").casefold()
        item_artists = [normalize_text(artist.get("name", "")).casefold() for artist in item.get("artists", [])]
        if not item_title or not item_artists:
            continue
        joined_artists = " featuring ".join(item_artists)
        artist_score = max(
            ratio(normalize_artist_credit(wanted_artist), normalize_artist_credit(artist))
            for artist in [*item_artists, joined_artists]
        )
        title_score = ratio(wanted_title, item_title)
        if version_qualifiers(item_title) != wanted_qualifiers:
            title_score -= 18
        score = (artist_score * 0.45) + (title_score * 0.55)
        ranked.append((score, item))

    ranked.sort(key=lambda pair: pair[0], reverse=True)
    if not ranked or ranked[0][0] < 88:
        return None
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 3 and ranked[0][0] < 99:
        return None
    return Match(ranked[0][1], round(ranked[0][0] / 100, 3))


def version_qualifiers(value: str) -> frozenset[str]:
    words = ("live", "remix", "edit", "instrumental", "acoustic", "demo", "remaster", "karaoke")
    return frozenset(word for word in words if word in value)


def search_artist(value: str) -> str:
    return re_split_credit(value)[0].strip() or value


def normalize_artist_credit(value: str) -> str:
    parts = re_split_credit(value)
    return " ".join(part.strip() for part in parts if part.strip())


def re_split_credit(value: str) -> list[str]:
    import re

    return re.split(r"\s+(?:feat(?:uring)?\.?|with)\s+", value, flags=re.I)
