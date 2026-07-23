from __future__ import annotations

import base64
import hashlib
import html
import json
import os
import random
import re
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from music_harvester.http import ApiError, request_json
from music_harvester.models import RawTrack, SourceConfig
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


PLAYLIST_RE = re.compile(r"playlist/([A-Za-z0-9]+)")
PLAYLIST_TRACK_META_RE = re.compile(r'<meta\s+name="music:song"\s+content="https://open\.spotify\.com/track/([A-Za-z0-9]+)"')
SPOTIFY_FAST_SAMPLE_SIZE = 8
SPOTIFY_THOROUGH_SAMPLE_SIZE = 30
SPOTIFY_FAST_FULL_API_READ_LIMIT = 250
SPOTIFY_THOROUGH_FULL_API_READ_LIMIT = 500
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.IGNORECASE | re.DOTALL)
USER_RE = re.compile(r"user/([^/?]+)")


class SpotifyClient:
    def __init__(self, token_path: Path = Path(".spotify-token.json")):
        self.token_path = token_path

    def get(
        self,
        path_or_url: str,
        params: dict | None = None,
        *,
        polite_delay: float = 0.12,
        retries: int = 2,
    ) -> dict:
        return request_json(
            "GET",
            self._url(path_or_url),
            headers=self._headers(),
            params=params,
            polite_delay=polite_delay,
            retries=retries,
        )

    def post(self, path_or_url: str, body: dict | None = None) -> dict:
        return request_json("POST", self._url(path_or_url), headers=self._headers(), body=body or {})

    def search_playlists(self, query: str, limit: int = 10) -> list[dict]:
        result = self.get("/search", params={"type": "playlist", "limit": limit, "q": query})
        return [item for item in result.get("playlists", {}).get("items", []) if item]

    def _headers(self) -> dict[str, str]:
        token = self._valid_token()
        return {"Authorization": f"Bearer {token['access_token']}"}

    def _valid_token(self) -> dict:
        if not self.token_path.exists():
            raise SourceUnavailable("Spotify is not authorized yet. Run the web app and Connect Spotify first.")

        token = json.loads(self.token_path.read_text(encoding="utf-8"))
        if time.time() * 1000 < float(token.get("expires_at", 0)) - 60_000:
            return token
        if not token.get("refresh_token"):
            raise SourceUnavailable("Spotify token expired and has no refresh token.")

        client_id = os.environ.get("SPOTIFY_CLIENT_ID")
        client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
        if not client_id or not client_secret:
            raise SourceUnavailable("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required to refresh Spotify auth.")

        auth = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
        refreshed = request_json(
            "POST",
            "https://accounts.spotify.com/api/token",
            headers={"Authorization": f"Basic {auth}"},
            form={"grant_type": "refresh_token", "refresh_token": token["refresh_token"]},
        )
        token.update(refreshed)
        token["expires_at"] = int(time.time() * 1000) + int(refreshed.get("expires_in", 3600)) * 1000
        self.token_path.write_text(json.dumps(token, indent=2), encoding="utf-8")
        return token

    @staticmethod
    def _url(path_or_url: str) -> str:
        if path_or_url.startswith("http"):
            return path_or_url
        return f"https://api.spotify.com/v1{path_or_url}"


class SpotifySource(SourceAdapter):
    def __init__(self, source: SourceConfig, client: SpotifyClient | None = None):
        super().__init__(source)
        self.client = client or SpotifyClient()

    def harvest(self) -> list[RawTrack]:
        if self.source.source_type in {"playlist", "spotify_playlist"}:
            playlist_id = extract_playlist_id(self.source.locator)
            if not playlist_id:
                raise SourceUnavailable(f"Could not parse Spotify playlist URL for {self.source.name}.")
            return self._playlist_tracks(playlist_id)

        if self.source.source_type in {"profile", "spotify_profile", "user", "user_playlists"}:
            user_id = extract_user_id(self.source.locator) or self.source.username
            if not user_id:
                raise SourceUnavailable(f"Could not parse Spotify user/profile URL for {self.source.name}.")
            return self._user_playlists(user_id)

        raise SourceUnavailable(f"Unsupported Spotify source type: {self.source.source_type}")

    def _playlist_tracks(self, playlist_id: str) -> list[RawTrack]:
        try:
            playlist = self.client.get(f"/playlists/{playlist_id}", params={"fields": "name"})
            playlist_title = playlist.get("name") or self.source.name
        except ApiError as exc:
            if exc.status in {403, 404, 429}:
                return self._playlist_tracks_from_public_page(playlist_id, self.source.name)
            raise
        tracks: list[RawTrack] = []
        url = f"/playlists/{playlist_id}/items"
        params = {"limit": 50}
        position = 0
        try:
            first_page = self.client.get(url, params={"limit": 1})
        except ApiError as exc:
            if exc.status in {403, 404, 429}:
                return self._playlist_tracks_from_public_page(playlist_id, playlist_title)
            raise
        total = int(first_page.get("total") or 0)
        budget = spotify_source_budget()
        if total > budget["full_api_read_limit"]:
            return self._sampled_playlist_tracks(playlist_id, playlist_title, total)

        while url:
            try:
                page = self.client.get(url, params=params)
            except ApiError as exc:
                if exc.status == 429 and tracks:
                    return tracks
                if exc.status in {403, 404, 429}:
                    return self._playlist_tracks_from_public_page(playlist_id, playlist_title)
                raise
            params = None
            for item in page.get("items", []):
                position += 1
                track = item.get("track") or {}
                raw = self._raw_track(track, playlist_title, position, "playlist")
                if raw:
                    tracks.append(raw)
            url = page.get("next")
        return tracks

    def _sampled_playlist_tracks(self, playlist_id: str, playlist_title: str, total: int) -> list[RawTrack]:
        tracks: list[RawTrack] = []
        budget = spotify_source_budget()
        for position in sampled_positions(total, budget["sample_size"], playlist_id):
            try:
                page = self.client.get(
                    f"/playlists/{playlist_id}/items",
                    params={"limit": 1, "offset": position},
                    polite_delay=budget["polite_delay"],
                    retries=budget["retries"],
                )
            except ApiError as exc:
                if exc.status == 429 and tracks:
                    return tracks
                if exc.status in {403, 404}:
                    return self._playlist_tracks_from_public_page(playlist_id, playlist_title)
                raise
            item = (page.get("items") or [{}])[0]
            raw = self._raw_track(item.get("track") or {}, playlist_title, position + 1, "playlist_sample")
            if raw:
                tracks.append(raw)
        return tracks

    def _playlist_tracks_from_public_page(self, playlist_id: str, playlist_title: str) -> list[RawTrack]:
        html = fetch_spotify_playlist_page(playlist_id)
        playlist_title = playlist_title_from_html(html) or playlist_title
        track_ids = list(dict.fromkeys(PLAYLIST_TRACK_META_RE.findall(html)))
        budget = spotify_source_budget()
        track_ids = sampled_track_ids(track_ids, budget["sample_size"], playlist_id)
        tracks: list[RawTrack] = []
        position = 0
        for track_id in track_ids:
            try:
                track = self.client.get(
                    f"/tracks/{track_id}",
                    polite_delay=budget["polite_delay"],
                    retries=budget["retries"],
                )
            except ApiError as exc:
                if exc.status == 429 and tracks:
                    return tracks
                raise
            position += 1
            raw = self._raw_track(track, playlist_title, position, "playlist_public_page")
            if raw:
                tracks.append(raw)
        return tracks

    def _raw_track(self, track: dict, playlist_title: str, position: int, source_context: str) -> RawTrack | None:
        if not track or track.get("is_local"):
            return None
        artists = track.get("artists") or []
        if not artists:
            return None
        return RawTrack(
            source_name=self.source.name,
            platform="spotify",
            artist=artists[0].get("name", ""),
            title=track.get("name", ""),
            album=(track.get("album") or {}).get("name"),
            platform_track_id=track.get("id"),
            url=(track.get("external_urls") or {}).get("spotify"),
            payload={"spotify_uri": track.get("uri"), "track": track},
            source_context=source_context,
            playlist_title=playlist_title,
            position=position,
        )

    def _user_playlists(self, user_id: str) -> list[RawTrack]:
        tracks: list[RawTrack] = []
        url = f"/users/{user_id}/playlists"
        params = {"limit": 50}
        while url:
            page = self.client.get(url, params=params)
            params = None
            for playlist in page.get("items", []):
                try:
                    tracks.extend(self._playlist_tracks(playlist["id"]))
                except ApiError:
                    continue
            url = page.get("next")
        return tracks


def extract_playlist_id(value: str) -> str | None:
    match = PLAYLIST_RE.search(value or "")
    if match:
        return match.group(1)
    if value and "/" not in value and "spotify" not in value:
        return value
    return None


def fetch_spotify_playlist_page(playlist_id: str) -> str:
    request = Request(
        f"https://open.spotify.com/playlist/{playlist_id}",
        headers={"User-Agent": "Mozilla/5.0"},
    )
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def playlist_title_from_html(body: str) -> str | None:
    match = TITLE_RE.search(body)
    if not match:
        return None
    title = html.unescape(match.group(1)).strip()
    return title.removesuffix(" | Spotify").strip() or None


def sampled_track_ids(track_ids: list[str], sample_size: int, key: str) -> list[str]:
    if len(track_ids) <= sample_size:
        return track_ids

    return [track_ids[index] for index in sampled_positions(len(track_ids), sample_size, key)]


def sampled_positions(total: int, sample_size: int, key: str) -> list[int]:
    if total <= sample_size:
        return list(range(total))

    seed = int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:16], 16)
    rng = random.Random(seed)
    sampled: list[int] = []
    for index in range(sample_size):
        start = round(index * total / sample_size)
        end = round((index + 1) * total / sample_size)
        sampled.append(rng.randrange(start, max(start + 1, end)))
    return sampled


def spotify_source_budget() -> dict[str, float | int]:
    if os.environ.get("QRATOR_SOURCE_PROCESSING") == "thorough":
        return {
            "sample_size": SPOTIFY_THOROUGH_SAMPLE_SIZE,
            "full_api_read_limit": SPOTIFY_THOROUGH_FULL_API_READ_LIMIT,
            "polite_delay": 1.0,
            "retries": 8,
        }
    return {
        "sample_size": SPOTIFY_FAST_SAMPLE_SIZE,
        "full_api_read_limit": SPOTIFY_FAST_FULL_API_READ_LIMIT,
        "polite_delay": 0.25,
        "retries": 0,
    }


def extract_user_id(value: str) -> str | None:
    match = USER_RE.search(value or "")
    if match:
        return match.group(1)
    parsed = urlparse(value or "")
    if parsed.netloc.endswith("spotify.com") and parsed.path:
        return parsed.path.strip("/").split("/")[-1]
    return None
