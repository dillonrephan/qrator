from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import re
import time
from pathlib import Path
from urllib.parse import urlparse

from music_harvester.http import ApiError, request_json
from music_harvester.models import RawTrack, SourceConfig
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


PLAYLIST_RE = re.compile(r"playlist/([A-Za-z0-9]+)")
SPOTIFY_FAST_SAMPLE_SIZE = 8
SPOTIFY_THOROUGH_SAMPLE_SIZE = 30
SPOTIFY_FAST_FULL_API_READ_LIMIT = 250
SPOTIFY_THOROUGH_FULL_API_READ_LIMIT = 500
USER_RE = re.compile(r"user/([^/?]+)")
USER_URI_RE = re.compile(r"^spotify:user:([^:]+)$")


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
            provider="spotify",
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
            raise_spotify_playlist_error(exc)
        tracks: list[RawTrack] = []
        url = f"/playlists/{playlist_id}/items"
        params = {"limit": 50}
        position = 0
        try:
            first_page = self.client.get(url, params={"limit": 1})
        except ApiError as exc:
            raise_spotify_playlist_error(exc)
        total = int(first_page.get("total") or 0)
        budget = spotify_source_budget()
        if total > budget["full_api_read_limit"]:
            return self._sampled_playlist_tracks(playlist_id, playlist_title, total)

        while url:
            try:
                page = self.client.get(url, params=params)
            except ApiError as exc:
                if exc.status == 429 and exc.reason != "QUOTA_EXCEEDED" and tracks:
                    return tracks
                raise_spotify_playlist_error(exc)
            params = None
            for item in page.get("items", []):
                position += 1
                track = playlist_item_track(item)
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
                if exc.status == 429 and exc.reason != "QUOTA_EXCEEDED" and tracks:
                    return tracks
                raise_spotify_playlist_error(exc)
            item = (page.get("items") or [{}])[0]
            raw = self._raw_track(playlist_item_track(item), playlist_title, position + 1, "playlist_sample")
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
        profile = self.client.get("/me")
        current_user_ids = spotify_profile_identifiers(profile)
        if not current_user_ids:
            raise SourceUnavailable("Spotify did not return an identity for the authenticated user.")
        if user_id not in current_user_ids:
            raise SourceUnavailable(
                "Spotify Development Mode cannot enumerate another user's playlists. "
                "Use the authenticated user's profile, an owned/collaborative playlist, or paste an export."
            )

        tracks: list[RawTrack] = []
        url = "/me/playlists"
        params = {"limit": 50}
        while url:
            page = self.client.get(url, params=params)
            params = None
            for playlist in page.get("items", []):
                owner_id = (playlist.get("owner") or {}).get("id")
                if owner_id not in current_user_ids and not playlist.get("collaborative"):
                    continue
                playlist_id = playlist.get("id")
                if playlist_id:
                    tracks.extend(self._playlist_tracks(playlist_id))
            url = page.get("next")
        return tracks


def playlist_item_track(item: dict) -> dict:
    if not isinstance(item, dict):
        return {}
    current = item.get("item")
    if isinstance(current, dict):
        return current
    legacy = item.get("track")
    return legacy if isinstance(legacy, dict) else {}


def raise_spotify_playlist_error(exc: ApiError) -> None:
    if exc.status == 403:
        raise SourceUnavailable(
            "Spotify Development Mode exposes playlist items only when the authenticated "
            "user owns or collaborates on the playlist; copy it to an owned playlist or paste an export."
        ) from exc
    if exc.status == 404:
        raise SourceUnavailable("Spotify could not find that playlist or it is not visible to this user.") from exc
    raise exc


def spotify_profile_identifiers(profile: dict) -> set[str]:
    identifiers = set()
    profile_id = profile.get("id")
    if isinstance(profile_id, str) and profile_id:
        identifiers.add(profile_id)
    uri = profile.get("uri")
    if isinstance(uri, str):
        match = USER_URI_RE.fullmatch(uri)
        if match:
            identifiers.add(match.group(1))
    external_url = (profile.get("external_urls") or {}).get("spotify")
    extracted = extract_user_id(external_url) if isinstance(external_url, str) else None
    if extracted:
        identifiers.add(extracted)
    return identifiers


def extract_playlist_id(value: str) -> str | None:
    match = PLAYLIST_RE.search(value or "")
    if match:
        return match.group(1)
    if value and "/" not in value and "spotify" not in value:
        return value
    return None


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
    uri_match = USER_URI_RE.fullmatch(value or "")
    if uri_match:
        return uri_match.group(1)
    match = USER_RE.search(value or "")
    if match:
        return match.group(1)
    parsed = urlparse(value or "")
    if parsed.netloc.endswith("spotify.com") and parsed.path:
        return parsed.path.strip("/").split("/")[-1]
    return None
