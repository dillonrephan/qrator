from __future__ import annotations

import ipaddress
import json
import os
import socket
import ssl
import time
import xml.etree.ElementTree as ET
from http.client import HTTPResponse
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from music_harvester.http import run_deadline
from music_harvester.models import RawTrack, SourceConfig
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


_HYDRATION_MARKER = "window.__sc_hydration"
_ALLOWED_HOSTS = {"soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"}
_FEED_HOST = "feeds.soundcloud.com"
_DEFAULT_MAX_BYTES = 2 * 1024 * 1024
_HARD_MAX_BYTES = 4 * 1024 * 1024
_DEFAULT_MAX_ITEMS = 100
_HARD_MAX_ITEMS = 200
_DEFAULT_MAX_REDIRECTS = 3
_USER_AGENT = "QRator/0.1 experimental-public-page-reader"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


class ExperimentalSoundCloudScraper:
    """Bounded reader for metadata already embedded in public SoundCloud HTML.

    This deliberately does not call api-v2, inspect JavaScript bundles, or
    extract/reuse SoundCloud web-client credentials.
    """

    def __init__(
        self,
        *,
        fetch: Callable[[str], str] | None = None,
        deadline: float | None = None,
        max_items: int | None = None,
    ):
        self.deadline = deadline or run_deadline()
        self.max_bytes = _bounded_env("QRATOR_SOUNDCLOUD_SCRAPE_MAX_BYTES", _DEFAULT_MAX_BYTES, _HARD_MAX_BYTES)
        self.max_items = min(max_items or _bounded_env("QRATOR_SOUNDCLOUD_SCRAPE_MAX_ITEMS", _DEFAULT_MAX_ITEMS, _HARD_MAX_ITEMS), _HARD_MAX_ITEMS)
        self.max_redirects = _bounded_env("QRATOR_SOUNDCLOUD_SCRAPE_MAX_REDIRECTS", _DEFAULT_MAX_REDIRECTS, _DEFAULT_MAX_REDIRECTS)
        self._custom_fetch = fetch is not None
        self._fetch = fetch or self._fetch_public_html

    def harvest(self, source: SourceConfig) -> list[RawTrack]:
        url = validate_public_soundcloud_url(source.locator)
        html = self._fetch(url)
        payload = extract_hydration(html)
        tracks = extract_tracks(payload, self.max_items)
        if not tracks and not self._custom_fetch:
            user = _hydrated_user(payload)
            urn = user.get("urn") if user else None
            if isinstance(urn, str) and urn.startswith("soundcloud:users:"):
                return self._harvest_public_rss(source, urn, _short_text(user.get("username")))
        if not tracks:
            raise SourceUnavailable(
                "Experimental SoundCloud reader found no public track metadata. "
                "The page layout may have changed, the shelf may be private, or login may be required."
            )

        result: list[RawTrack] = []
        for position, track in enumerate(tracks, 1):
            artist, title = track_identity(track)
            if not artist or not title:
                continue
            permalink = track.get("permalink_url")
            if not isinstance(permalink, str) or not permalink.startswith("https://soundcloud.com/"):
                permalink = None
            urn = track.get("urn")
            if not isinstance(urn, str) or not urn.startswith("soundcloud:tracks:"):
                urn = None
            result.append(
                RawTrack(
                    source_name=source.name,
                    platform="soundcloud",
                    artist=artist,
                    title=title,
                    album=None,
                    platform_track_id=urn,
                    url=permalink,
                    payload={
                        "experimental_public_page": True,
                        "playback_count": _nonnegative_int(track.get("playback_count")),
                        "likes_count": _nonnegative_int(track.get("likes_count")),
                        "genre": _short_text(track.get("genre")),
                        "extraction_confidence": 0.82,
                    },
                    source_context="experimental SoundCloud public-page hydration",
                    playlist_title=_playlist_title(payload),
                    position=position,
                )
            )
        if not result:
            raise SourceUnavailable("Experimental SoundCloud reader found metadata, but no tracks had a usable artist and title.")
        return result

    def _harvest_public_rss(self, source: SourceConfig, user_urn: str, username: str | None) -> list[RawTrack]:
        feed_url = f"https://{_FEED_HOST}/users/{user_urn}/sounds.rss"
        xml = self._fetch_public_feed(feed_url)
        try:
            root = ET.fromstring(xml)
        except ET.ParseError as exc:
            raise SourceUnavailable("SoundCloud public RSS metadata could not be decoded.") from exc
        result: list[RawTrack] = []
        for position, item in enumerate(root.findall("./channel/item")[: self.max_items], 1):
            label = _short_text(item.findtext("title"))
            link = _short_text(item.findtext("link"))
            if not label or not link or not link.startswith("https://soundcloud.com/"):
                continue
            artist, separator, title = label.partition(" - ")
            if not separator:
                artist, title = username, label
            if not artist or not title:
                continue
            result.append(
                RawTrack(
                    source_name=source.name,
                    platform="soundcloud",
                    artist=artist,
                    title=title,
                    url=link,
                    payload={"experimental_public_page": True, "public_rss_fallback": True, "extraction_confidence": 0.76},
                    source_context="experimental SoundCloud public RSS fallback",
                    playlist_title=f"{username or 'SoundCloud user'} recent uploads",
                    position=position,
                )
            )
        if not result:
            raise SourceUnavailable("SoundCloud public profile and RSS feed exposed no usable tracks.")
        return result

    def _fetch_public_html(self, initial_url: str) -> str:
        opener = build_opener(_NoRedirect)
        url = initial_url
        for redirect_number in range(self.max_redirects + 1):
            validate_public_soundcloud_url(url)
            _assert_public_dns(url)
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise SourceUnavailable("Experimental SoundCloud scrape exceeded the discovery deadline.")
            request = Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
            try:
                response = opener.open(request, timeout=min(15.0, remaining))
            except HTTPError as exc:
                if exc.code in {301, 302, 303, 307, 308}:
                    location = exc.headers.get("Location")
                    exc.close()
                    if not location or redirect_number >= self.max_redirects:
                        raise SourceUnavailable("Experimental SoundCloud scrape exceeded its redirect limit.")
                    url = urljoin(url, location)
                    continue
                message = f"SoundCloud public page returned HTTP {exc.code}"
                exc.close()
                raise SourceUnavailable(message) from exc
            except (URLError, TimeoutError, ssl.SSLError, OSError) as exc:
                raise SourceUnavailable(f"SoundCloud public page could not be read: {exc}") from exc
            return _read_bounded_html(response, self.max_bytes)
        raise SourceUnavailable("Experimental SoundCloud scrape exceeded its redirect limit.")

    def _fetch_public_feed(self, url: str) -> str:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != _FEED_HOST or parsed.username or parsed.password or parsed.port not in {None, 443}:
            raise SourceUnavailable("Invalid SoundCloud public RSS URL.")
        _assert_public_dns(url)
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise SourceUnavailable("Experimental SoundCloud scrape exceeded the discovery deadline.")
        request = Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "application/rss+xml,application/xml"})
        try:
            response = build_opener(_NoRedirect).open(request, timeout=min(15.0, remaining))
        except (HTTPError, URLError, TimeoutError, ssl.SSLError, OSError) as exc:
            if isinstance(exc, HTTPError):
                exc.close()
            raise SourceUnavailable(f"SoundCloud public RSS feed could not be read: {exc}") from exc
        return _read_bounded_xml(response, self.max_bytes)


class SoundCloudSource(SourceAdapter):
    """Official integration placeholder plus explicit experimental fallback."""

    def __init__(self, source: SourceConfig, scraper: ExperimentalSoundCloudScraper | None = None):
        super().__init__(source)
        self.scraper = scraper

    def harvest(self) -> list[RawTrack]:
        if not _enabled():
            raise SourceUnavailable(
                "Official SoundCloud discovery is not enabled yet. "
                "Set QRATOR_EXPERIMENTAL_SOUNDCLOUD_SCRAPE=1 to explicitly allow the bounded "
                "public-page reader; it does not use api-v2 or extract web-client credentials."
            )
        return (self.scraper or ExperimentalSoundCloudScraper()).harvest(self.source)


def validate_public_soundcloud_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError as exc:
        raise SourceUnavailable("Invalid SoundCloud URL.") from exc
    if parsed.scheme != "https" or (parsed.hostname or "").lower() not in _ALLOWED_HOSTS:
        raise SourceUnavailable("Experimental SoundCloud reads accept only HTTPS public soundcloud.com URLs.")
    if parsed.username or parsed.password or port not in {None, 443}:
        raise SourceUnavailable("SoundCloud URLs may not contain credentials or a non-HTTPS port.")
    if not parsed.path or parsed.path == "/":
        raise SourceUnavailable("Provide a specific public SoundCloud user, likes, track, or playlist URL.")
    return url


def extract_hydration(html: str) -> list[dict]:
    marker_index = html.find(_HYDRATION_MARKER)
    if marker_index < 0:
        raise SourceUnavailable("SoundCloud page contained no public hydration metadata.")
    equals_index = html.find("=", marker_index + len(_HYDRATION_MARKER))
    if equals_index < 0:
        raise SourceUnavailable("SoundCloud hydration metadata was malformed.")
    json_index = equals_index + 1
    while json_index < len(html) and html[json_index].isspace():
        json_index += 1
    try:
        payload, _ = json.JSONDecoder().raw_decode(html, json_index)
    except json.JSONDecodeError as exc:
        raise SourceUnavailable("SoundCloud hydration metadata could not be decoded.") from exc
    if not isinstance(payload, list):
        raise SourceUnavailable("SoundCloud hydration metadata had an unexpected shape.")
    return [item for item in payload if isinstance(item, dict)]


def extract_tracks(payload: list[dict], limit: int) -> list[dict]:
    tracks: list[dict] = []
    seen: set[str] = set()

    def visit(value: object) -> None:
        if len(tracks) >= limit:
            return
        if isinstance(value, list):
            for item in value:
                visit(item)
                if len(tracks) >= limit:
                    break
            return
        if not isinstance(value, dict):
            return
        if value.get("kind") == "track":
            key = str(value.get("urn") or value.get("permalink_url") or value.get("id") or "")
            if key and key not in seen:
                seen.add(key)
                tracks.append(value)
            return
        for key in ("data", "tracks", "collection", "track", "playlist", "sound"):
            if key in value:
                visit(value[key])

    visit(payload)
    return tracks


def track_identity(track: dict) -> tuple[str, str]:
    publisher = track.get("publisher_metadata")
    publisher = publisher if isinstance(publisher, dict) else {}
    user = track.get("user")
    user = user if isinstance(user, dict) else {}
    artist = _short_text(publisher.get("artist")) or _short_text(user.get("username"))
    title = _short_text(publisher.get("release_title")) or _short_text(track.get("title"))
    if artist and title:
        prefix = f"{artist} - "
        if title.casefold().startswith(prefix.casefold()):
            title = title[len(prefix) :].strip()
    return artist, title


def _playlist_title(payload: list[dict]) -> str | None:
    for item in payload:
        data = item.get("data")
        if isinstance(data, dict) and data.get("kind") in {"playlist", "system-playlist"}:
            return _short_text(data.get("title"))
    return None


def _hydrated_user(payload: list[dict]) -> dict | None:
    for item in payload:
        if item.get("hydratable") == "user" and isinstance(item.get("data"), dict):
            return item["data"]
    return None


def _read_bounded_html(response: HTTPResponse, max_bytes: int) -> str:
    content_type = (response.headers.get("Content-Type") or "").lower()
    if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
        response.close()
        raise SourceUnavailable(f"SoundCloud returned unsupported content type {content_type or 'unknown'}.")
    declared = response.headers.get("Content-Length")
    if declared:
        try:
            if int(declared) > max_bytes:
                response.close()
                raise SourceUnavailable("SoundCloud public page exceeded the response-size limit.")
        except ValueError:
            pass
    body = response.read(max_bytes + 1)
    response.close()
    if len(body) > max_bytes:
        raise SourceUnavailable("SoundCloud public page exceeded the response-size limit.")
    return body.decode("utf-8", errors="replace")


def _read_bounded_xml(response: HTTPResponse, max_bytes: int) -> str:
    content_type = (response.headers.get("Content-Type") or "").lower()
    if not any(kind in content_type for kind in ("xml", "rss")):
        response.close()
        raise SourceUnavailable(f"SoundCloud feed returned unsupported content type {content_type or 'unknown'}.")
    body = response.read(max_bytes + 1)
    response.close()
    if len(body) > max_bytes:
        raise SourceUnavailable("SoundCloud public RSS feed exceeded the response-size limit.")
    return body.decode("utf-8", errors="replace")


def _assert_public_dns(url: str) -> None:
    hostname = urlparse(url).hostname or ""
    try:
        addresses = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise SourceUnavailable(f"SoundCloud hostname could not be resolved: {exc}") from exc
    if not addresses:
        raise SourceUnavailable("SoundCloud hostname resolved to no addresses.")
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise SourceUnavailable("SoundCloud hostname resolved to a non-public address.")


def _enabled() -> bool:
    return os.environ.get("QRATOR_EXPERIMENTAL_SOUNDCLOUD_SCRAPE", "").strip().lower() in {"1", "true", "yes", "on"}


def _bounded_env(name: str, default: int, maximum: int) -> int:
    try:
        return max(1, min(int(os.environ.get(name, default)), maximum))
    except ValueError:
        return default


def _nonnegative_int(value: object) -> int | None:
    try:
        return max(0, int(value)) if value is not None else None
    except (TypeError, ValueError):
        return None


def _short_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split()).strip()
    return text[:300] or None
