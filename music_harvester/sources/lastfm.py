from __future__ import annotations

import os
import re
from urllib.parse import unquote, urlparse

from music_harvester.http import request_json
from music_harvester.models import RawTrack
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


API_URL = "https://ws.audioscrobbler.com/2.0/"
USER_RE = re.compile(r"(?:www\.)?last\.fm/user/([^/?#]+)", re.IGNORECASE)


class LastFmClient:
    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.environ.get("LASTFM_API_KEY")

    def get(self, method: str, **params: object) -> dict:
        if not self.api_key:
            raise SourceUnavailable("LASTFM_API_KEY is required for Last.fm sources.")
        return request_json(
            "GET",
            API_URL,
            params={"method": method, "api_key": self.api_key, "format": "json", **params},
            polite_delay=0.2,
            retries=1,
        )

    def similar_tracks(self, artist: str, title: str, limit: int = 12) -> list[dict]:
        payload = self.get("track.getSimilar", artist=artist, track=title, autocorrect=1, limit=limit)
        return payload.get("similartracks", {}).get("track", [])


class LastFmSource(SourceAdapter):
    def __init__(self, source, client: LastFmClient | None = None):
        super().__init__(source)
        self.client = client or LastFmClient()

    def harvest(self) -> list[RawTrack]:
        if self.source.source_type == "lastfm_similar_tracks":
            artist, _, title = self.source.locator.partition("\n")
            if not artist or not title:
                raise SourceUnavailable("Last.fm similar-track source requires artist and title.")
            tracks = self.client.similar_tracks(artist, title)
            return [self._raw(item, f"Similar to {artist} - {title}", index) for index, item in enumerate(tracks, 1) if item]

        username = lastfm_username(self.source.locator) or self.source.username
        if not username:
            raise SourceUnavailable("Could not parse a Last.fm username from the source.")

        if self.source.source_type in {"lastfm_loved", "loved_tracks"}:
            payload = self.client.get("user.getLovedTracks", user=username, limit=50)
            items = payload.get("lovedtracks", {}).get("track", [])
            title = f"{username} loved tracks"
        elif self.source.source_type in {"lastfm_recent", "recent_tracks"}:
            payload = self.client.get("user.getRecentTracks", user=username, limit=50, extended=1)
            items = payload.get("recenttracks", {}).get("track", [])
            title = f"{username} recent tracks"
        else:
            payload = self.client.get("user.getTopTracks", user=username, period="6month", limit=50)
            items = payload.get("toptracks", {}).get("track", [])
            title = f"{username} top tracks"
        return [self._raw(item, title, index) for index, item in enumerate(items, 1) if item]

    def _raw(self, item: dict, playlist_title: str, position: int) -> RawTrack:
        artist_data = item.get("artist") or {}
        artist = str(artist_data)
        if isinstance(artist_data, dict):
            artist = artist_data.get("name") or artist_data.get("#text") or ""
        return RawTrack(
            source_name=self.source.name,
            platform="lastfm",
            artist=artist,
            title=item.get("name") or "",
            platform_track_id=item.get("mbid") or None,
            url=item.get("url") or None,
            payload=item,
            source_context=playlist_title,
            playlist_title=playlist_title,
            position=position,
        )


def lastfm_username(url_or_name: str | None) -> str | None:
    if not url_or_name:
        return None
    match = USER_RE.search(url_or_name)
    if match:
        return unquote(match.group(1))
    if "/" not in url_or_name and ":" not in url_or_name:
        return url_or_name
    parsed = urlparse(url_or_name)
    return parsed.path.split("/")[2] if parsed.netloc.endswith("last.fm") and parsed.path.startswith("/user/") else None
