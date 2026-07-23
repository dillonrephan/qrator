from __future__ import annotations

from music_harvester.models import Candidate
from music_harvester.sources.spotify import SpotifyClient


class SpotifyResolver:
    def __init__(self, client: SpotifyClient | None = None):
        self.client = client or SpotifyClient()
        self.cache: dict[tuple[str, str], str | None] = {}

    def resolve(self, candidate: Candidate) -> Candidate:
        if candidate.spotify_uri:
            candidate.spotify_resolution_confidence = max(candidate.spotify_resolution_confidence, 1.0)
            return candidate

        key = (candidate.artist.casefold(), candidate.title.casefold())
        if key not in self.cache:
            query = f'artist:"{candidate.artist}" track:"{candidate.title}"'
            result = self.client.get("/search", params={"type": "track", "limit": 3, "q": query}, polite_delay=0.3, retries=1)
            match = best_match(candidate, result.get("tracks", {}).get("items", []))
            self.cache[key] = match.get("uri") if match else None
        candidate.spotify_uri = self.cache[key]
        candidate.spotify_resolution_confidence = 0.92 if candidate.spotify_uri else 0.0
        return candidate


def best_match(candidate: Candidate, items: list[dict]) -> dict | None:
    artist = candidate.artist.lower()
    title = candidate.title.lower()
    for item in items:
        item_title = (item.get("name") or "").lower()
        item_artists = " ".join(artist.get("name", "") for artist in item.get("artists", [])).lower()
        if title in item_title and artist in item_artists:
            return item
    return items[0] if items else None
