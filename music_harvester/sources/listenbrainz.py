from __future__ import annotations

import re
from urllib.parse import quote

from music_harvester.engine.normalize import normalize_text
from music_harvester.http import request_json
from music_harvester.models import RawTrack, SourceConfig
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


LISTENBRAINZ_API = "https://api.listenbrainz.org/1"
MUSICBRAINZ_API = "https://musicbrainz.org/ws/2"
USER_AGENT = "QRator/0.2 (personal music discovery; local application)"
MBID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class ListenBrainzClient:
    def artist_mbid(self, artist_name: str) -> str:
        result = request_json(
            "GET",
            f"{MUSICBRAINZ_API}/artist/",
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
            params={"query": f'artist:"{artist_name}"', "limit": 5, "fmt": "json"},
            polite_delay=1.05,
            retries=1,
            provider="musicbrainz",
        )
        wanted = normalize_text(artist_name).casefold()
        artists = result.get("artists") or []
        exact = [item for item in artists if normalize_text(item.get("name", "")).casefold() == wanted]
        match = (exact or artists or [None])[0]
        if not match or not MBID_RE.fullmatch(match.get("id", "")):
            raise SourceUnavailable(f"MusicBrainz could not identify artist: {artist_name}")
        return match["id"]

    def artist_radio(
        self,
        artist_mbid: str,
        *,
        mode: str = "medium",
        max_similar_artists: int = 8,
        max_recordings_per_artist: int = 3,
    ) -> list[dict]:
        result = request_json(
            "GET",
            f"{LISTENBRAINZ_API}/lb-radio/artist/{quote(artist_mbid)}",
            params={
                "mode": mode,
                "max_similar_artists": max(1, min(max_similar_artists, 12)),
                "max_recordings_per_artist": max(1, min(max_recordings_per_artist, 5)),
                "pop_begin": 18,
                "pop_end": 85,
            },
            retries=1,
            provider="listenbrainz",
        )
        if isinstance(result, list):
            return result
        for key in ("payload", "recordings"):
            if isinstance(result.get(key), list):
                return result[key]
        return [item for value in result.values() if isinstance(value, list) for item in value if isinstance(item, dict)]

    def recording_metadata(self, recording_mbids: list[str]) -> dict:
        if not recording_mbids:
            return {}
        return request_json(
            "GET",
            f"{LISTENBRAINZ_API}/metadata/recording/",
            params={"recording_mbids": ",".join(recording_mbids[:100]), "inc": "artist release"},
            retries=1,
            provider="listenbrainz",
        )


class ListenBrainzSource(SourceAdapter):
    def __init__(self, source: SourceConfig, client: ListenBrainzClient | None = None):
        super().__init__(source)
        self.client = client or ListenBrainzClient()

    def harvest(self) -> list[RawTrack]:
        if self.source.source_type not in {"listenbrainz_radio", "artist_radio"}:
            raise SourceUnavailable(f"Unsupported ListenBrainz source type: {self.source.source_type}")
        artist_name = self.source.locator.strip()
        if not artist_name:
            raise SourceUnavailable("ListenBrainz artist radio requires an artist name.")

        artist_mbid = self.client.artist_mbid(artist_name)
        radio = self.client.artist_radio(artist_mbid)
        recording_ids = list(
            dict.fromkeys(
                item.get("recording_mbid")
                for item in radio
                if isinstance(item, dict) and MBID_RE.fullmatch(item.get("recording_mbid", ""))
            )
        )
        metadata = self.client.recording_metadata(recording_ids)
        tracks: list[RawTrack] = []
        by_id = {item.get("recording_mbid"): item for item in radio if isinstance(item, dict)}
        for position, recording_mbid in enumerate(recording_ids, 1):
            details = metadata.get(recording_mbid) or {}
            recording = details.get("recording") or {}
            artist = details.get("artist") or {}
            release = details.get("release") or {}
            title = recording.get("name") or recording.get("title")
            artist_credit = artist.get("name") or by_id.get(recording_mbid, {}).get("similar_artist_name")
            if not title or not artist_credit:
                continue
            tracks.append(
                RawTrack(
                    source_name=self.source.name,
                    platform="listenbrainz",
                    artist=artist_credit,
                    title=title,
                    album=release.get("name"),
                    platform_track_id=recording_mbid,
                    url=f"https://musicbrainz.org/recording/{recording_mbid}",
                    payload={
                        "musicbrainz_id": recording_mbid,
                        "seed_artist": artist_name,
                        "seed_artist_mbid": artist_mbid,
                        "listen_count": by_id.get(recording_mbid, {}).get("total_listen_count"),
                    },
                    source_context="listenbrainz_artist_radio",
                    playlist_title=f"ListenBrainz radio: {artist_name}",
                    position=position,
                )
            )
        if not tracks:
            raise SourceUnavailable(f"ListenBrainz returned no hydrated radio tracks for {artist_name}.")
        return tracks
