from __future__ import annotations

import re
from urllib.parse import quote, unquote, urlsplit

from music_harvester.engine.normalize import normalize_text
from music_harvester.http import request_json
from music_harvester.models import RawTrack, SourceConfig
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


LISTENBRAINZ_API = "https://api.listenbrainz.org/1"
MUSICBRAINZ_API = "https://musicbrainz.org/ws/2"
USER_AGENT = "QRator/0.2 (personal music discovery; local application)"
MBID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
LISTENBRAINZ_USER_PATH_RE = re.compile(r"^/user/([^/]+)/?$")
LISTENBRAINZ_USER_TOP_COUNT = 100
LISTENBRAINZ_USER_TOP_RANGE = "half_yearly"


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

    def user_top_recordings(self, username: str) -> list[dict]:
        result = request_json(
            "GET",
            f"{LISTENBRAINZ_API}/stats/user/{quote(username, safe='')}/recordings",
            params={
                "count": LISTENBRAINZ_USER_TOP_COUNT,
                "offset": 0,
                "range": LISTENBRAINZ_USER_TOP_RANGE,
            },
            retries=0,
            provider="listenbrainz",
        )
        recordings = (result.get("payload") or {}).get("recordings")
        return recordings if isinstance(recordings, list) else []


class ListenBrainzSource(SourceAdapter):
    def __init__(self, source: SourceConfig, client: ListenBrainzClient | None = None):
        super().__init__(source)
        self.client = client or ListenBrainzClient()

    def harvest(self) -> list[RawTrack]:
        if self.source.source_type == "listenbrainz_user_top":
            return self._harvest_user_top()
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

    def _harvest_user_top(self) -> list[RawTrack]:
        username = listenbrainz_username(self.source.locator)
        rows = self.client.user_top_recordings(username)
        tracks: list[RawTrack] = []
        for position, row in enumerate(rows[:LISTENBRAINZ_USER_TOP_COUNT], 1):
            if not isinstance(row, dict):
                continue
            artist = row.get("artist_name")
            title = row.get("track_name")
            if not isinstance(artist, str) or not artist.strip():
                continue
            if not isinstance(title, str) or not title.strip():
                continue
            recording_mbid = row.get("recording_mbid")
            if not isinstance(recording_mbid, str) or not MBID_RE.fullmatch(recording_mbid):
                recording_mbid = None
            release_name = row.get("release_name")
            if not isinstance(release_name, str) or not release_name.strip():
                release_name = None
            tracks.append(
                RawTrack(
                    source_name=self.source.name,
                    platform="listenbrainz",
                    artist=artist.strip(),
                    title=title.strip(),
                    album=release_name.strip() if release_name else None,
                    platform_track_id=recording_mbid,
                    url=f"https://musicbrainz.org/recording/{recording_mbid}" if recording_mbid else None,
                    payload={
                        "musicbrainz_id": recording_mbid,
                        "listen_count": row.get("listen_count"),
                        "listenbrainz_range": LISTENBRAINZ_USER_TOP_RANGE,
                        "listenbrainz_user": username,
                    },
                    source_context="listenbrainz_user_top",
                    playlist_title=f"ListenBrainz six-month shelf: {username}",
                    position=position,
                )
            )
        if not tracks:
            raise SourceUnavailable(
                f"ListenBrainz returned no usable six-month top recordings for {username}."
            )
        return tracks


def listenbrainz_username(url: str | None) -> str:
    if not url:
        raise SourceUnavailable("A canonical ListenBrainz user URL is required.")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise SourceUnavailable(
            "Use a canonical https://listenbrainz.org/user/<username> URL."
        ) from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != "listenbrainz.org"
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise SourceUnavailable(
            "Use a canonical https://listenbrainz.org/user/<username> URL."
        )
    match = LISTENBRAINZ_USER_PATH_RE.fullmatch(parsed.path)
    if not match:
        raise SourceUnavailable(
            "ListenBrainz user URLs must contain exactly one username path segment."
        )
    raw_username = match.group(1)
    username = unquote(raw_username)
    if (
        not username
        or username in {".", ".."}
        or any(character in username for character in "/\\\x00\r\n")
        or quote(username, safe="._~-") != raw_username
    ):
        raise SourceUnavailable("ListenBrainz username path segment is not canonical.")
    return username
