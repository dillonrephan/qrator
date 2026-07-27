from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from music_harvester.db.store import Store
from music_harvester.engine.explain import escape_md
from music_harvester.engine.normalize import normalize_key, split_artist_track
from music_harvester.http import ApiError
from music_harvester.models import RawTrack, SourceConfig
from music_harvester.sources import SourceUnavailable, adapter_for
from music_harvester.sources.lastfm import LastFmClient
from music_harvester.sources.listenbrainz import listenbrainz_username


BRIDGE_TITLE_WORDS = (
    "weird",
    "strange",
    "experimental",
    "heavy",
    "electronic",
    "rap",
    "leftfield",
    "noise",
    "chaos",
    "bridge",
    "genreless",
    "abrasive",
)


@dataclass
class BridgeResult:
    bridge_run_id: int
    sources_checked: int
    sources_ingested: int
    high_confidence_sources: int
    discovery_notes: list[str]


def bridge_discover(
    store: Store,
    *,
    artists: list[str],
    tracks: list[str],
    source_urls: list[str],
    files: list[str] | None = None,
    texts: list[str] | None = None,
    search_limit: int = 10,
) -> BridgeResult:
    seeds = normalize_seeds(artists, tracks)
    seed_type = "tracks" if tracks and not artists else "artists" if artists and not tracks else "mixed"
    bridge_run_id = store.create_bridge_run(seed_type, artists + tracks)
    sources, discovery_notes = candidate_sources(seeds, source_urls, files or [], texts or [], search_limit)

    checked = 0
    ingested = 0
    high_confidence = 0
    for source in sources:
        checked += 1
        source_id = store.upsert_source(source)
        try:
            harvested = adapter_for(source).harvest()
        except (SourceUnavailable, ApiError, OSError, RuntimeError) as exc:
            store.add_error(source.name, str(exc), source_id)
            match_type, confidence, matched, notes = evaluate_unharvested_source(source, seeds, str(exc))
            store.add_bridge_source(bridge_run_id, source_id, match_type, confidence, matched, seed_sides(seeds, matched), notes)
            continue

        count = store.add_raw_tracks(source_id, harvested)
        ingested += 1 if count else 0
        match_type, confidence, matched, notes = evaluate_bridge_source(source, harvested, seeds)
        if match_type == "exact_all_seeds":
            high_confidence += 1
        store.add_bridge_source(bridge_run_id, source_id, match_type, confidence, matched, seed_sides(seeds, matched), notes)

    write_bridge_sources_md(store, bridge_run_id)
    return BridgeResult(bridge_run_id, checked, ingested, high_confidence, discovery_notes)


def normalize_seeds(artists: list[str], tracks: list[str]) -> list[dict]:
    seeds: list[dict] = []
    for index, artist in enumerate(artists):
        seeds.append({"type": "artist", "value": artist, "artist": artist, "key": artist.lower(), "side": f"seed_{index + 1}"})
    for index, track in enumerate(tracks):
        parsed = split_artist_track(track)
        side = f"seed_{len(seeds) + 1}"
        if parsed:
            artist, title = parsed
            seeds.append({"type": "track", "value": track, "artist": artist, "title": title, "key": normalize_key(artist, title), "side": side})
        else:
            seeds.append({"type": "track", "value": track, "artist": "", "title": track, "key": track.lower(), "side": side})
    return seeds


def candidate_sources(seeds: list[dict], source_urls: list[str], files: list[str], texts: list[str], search_limit: int) -> tuple[list[SourceConfig], list[str]]:
    sources: list[SourceConfig] = []
    notes: list[str] = []
    seen: set[str] = set()
    for index, url in enumerate(source_urls, 1):
        source = source_from_url(f"bridge_user_{index}", url, 3.0)
        if source and source.locator not in seen:
            seen.add(source.locator)
            sources.append(source)
    for index, file_path in enumerate(files, 1):
        key = f"file:{file_path}"
        if key not in seen:
            seen.add(key)
            sources.append(SourceConfig(name=f"bridge_file_{index}", platform="text", source_type="text_import", url=file_path, weight=3.0, category="pasted_text"))
    for index, text in enumerate(texts, 1):
        key = f"text:{text[:80]}"
        if key not in seen:
            seen.add(key)
            sources.append(SourceConfig(name=f"bridge_text_{index}", platform="manual", source_type="manual_seed", url=text, weight=3.0, category="pasted_text"))

    if search_limit > 0:
        radio_artists = list(
            dict.fromkeys(seed["artist"] for seed in seeds if seed.get("artist"))
        )[:4]
        for index, artist in enumerate(radio_artists, 1):
            sources.append(
                SourceConfig(
                    name=slug(f"listenbrainz_radio_{index}_{artist}"),
                    platform="listenbrainz",
                    source_type="listenbrainz_radio",
                    url=artist,
                    weight=2.4,
                    category="structured_api",
                )
            )

        try:
            lastfm = LastFmClient()
            if not lastfm.api_key:
                raise SourceUnavailable("LASTFM_API_KEY is not configured")
            for index, seed in enumerate((item for item in seeds if item.get("artist") and item.get("title")), 1):
                locator = f"{seed['artist']}\n{seed['title']}"
                sources.append(SourceConfig(name=f"bridge_lastfm_similar_{index}", platform="lastfm", source_type="lastfm_similar_tracks", url=locator, weight=2.6, category="structured_api"))
        except Exception as exc:
            sources = [source for source in sources if source.platform != "lastfm"]
            notes.append(f"Last.fm discovery unavailable: {exc}")

        notes.append(
            f"ListenBrainz artist radio enabled for {len(radio_artists)} seed artist(s); "
            "Spotify and unofficial SoundCloud crawling were not used for discovery."
        )

    return sources, notes


def bridge_queries(seeds: list[dict]) -> list[str]:
    values = [seed["value"] for seed in seeds]
    queries = list(values)
    if len(values) >= 2:
        queries.insert(0, " ".join(values))
    for seed in seeds:
        artist = seed.get("artist")
        title = seed.get("title")
        if artist and title:
            queries.append(f"{artist} {title}")
            queries.append(artist)
            queries.append(title)
    result: list[str] = []
    seen: set[str] = set()
    for query in queries:
        normalized = query.lower()
        if normalized not in seen:
            seen.add(normalized)
            result.append(query)
    return result


def source_from_url(name: str, url: str, weight: float) -> SourceConfig | None:
    hostname = (urlsplit(url).hostname or "").lower()
    if "listenbrainz.org" in hostname:
        listenbrainz_username(url)
        return SourceConfig(
            name=name,
            platform="listenbrainz",
            source_type="listenbrainz_user_top",
            url=url,
            weight=weight,
            category="manual_urls",
        )
    if "open.spotify.com/playlist" in url:
        return SourceConfig(name=name, platform="spotify", source_type="spotify_playlist", url=url, weight=weight, category="manual_urls")
    if "soundcloud.com" in url:
        lowered = url.lower().rstrip("/")
        if "/sets/" in lowered:
            source_type = "soundcloud_playlist"
        elif lowered.endswith("/likes"):
            source_type = "soundcloud_likes"
        else:
            source_type = "soundcloud_public_page"
        return SourceConfig(name=name, platform="soundcloud", source_type=source_type, url=url, weight=weight, category="manual_urls")
    if "last.fm/user/" in url.lower():
        return SourceConfig(name=name, platform="lastfm", source_type="lastfm_profile", url=url, weight=weight, category="manual_urls")
    if url.startswith(("http://", "https://")):
        return SourceConfig(name=name, platform="web_page", source_type="html_page", url=url, weight=weight, category="manual_urls")
    return None


def evaluate_bridge_source(source: SourceConfig, tracks: list[RawTrack], seeds: list[dict]) -> tuple[str, float, list[str], str]:
    track_matched = {seed["value"] for seed in seeds if seed_matches_tracks(seed, tracks)}
    metadata_matched = {seed["value"] for seed in seeds if seed_text_match(seed, f"{source.name} {source.locator}")}
    matched = sorted(track_matched | metadata_matched)
    title_score = bridge_title_score([track.playlist_title or "" for track in tracks] + [source.name])
    direct_bonus = 25.0 if source.name.startswith("bridge_user_") else 0.0
    density = bridge_density(tracks, seeds)

    if len(matched) == len(seeds) and seeds:
        has_track_seed = any(seed["type"] == "track" for seed in seeds)
        confidence = (120.0 if has_track_seed else 100.0) + title_score + direct_bonus + density
        return "exact_all_seeds", confidence, matched, "source contains every bridge seed"
    if matched:
        confidence = 30.0 + (10.0 * len(matched)) + title_score + direct_bonus + density
        match_type = "near_bridge" if title_score else "exact_some_seeds"
        return match_type, confidence, matched, "source contains some bridge seeds and may still define useful context"
    if title_score:
        return "title_match_only", title_score + direct_bonus, matched, "source title/context suggests bridge material"
    return "near_bridge", max(5.0, direct_bonus), matched, "weak bridge candidate retained for review"


def evaluate_unharvested_source(source: SourceConfig, seeds: list[dict], error: str) -> tuple[str, float, list[str], str]:
    text = f"{source.name} {source.locator}".lower()
    matched = sorted({seed["value"] for seed in seeds if seed_text_match(seed, text)})
    title_score = bridge_title_score([source.name, source.locator])
    if matched:
        confidence = 15.0 + (10.0 * len(matched)) + title_score
        return "title_match_only", confidence, matched, f"metadata matched but source could not be fully parsed: {error}"
    if title_score:
        return "title_match_only", title_score, [], f"context title matched but source could not be fully parsed: {error}"
    return "inaccessible", 0.0, [], error


def seed_matches_tracks(seed: dict, tracks: list[RawTrack]) -> bool:
    if seed["type"] == "artist":
        needle = seed["artist"].lower()
        return any(needle in track.artist.lower() for track in tracks)
    return any(normalize_key(track.artist, track.title) == seed["key"] for track in tracks)


def seed_text_match(seed: dict, text: str) -> bool:
    normalized_text = normalize_key("", text)
    if seed["type"] == "artist":
        return normalize_key("", seed["artist"]) in normalized_text
    artist = normalize_key("", seed.get("artist", ""))
    title = normalize_key("", seed.get("title", ""))
    if artist and title:
        return artist in normalized_text and title in normalized_text
    return bool((artist and artist in normalized_text) or (title and title in normalized_text))


def seed_sides(seeds: list[dict], matched: list[str]) -> list[str]:
    matched_set = set(matched)
    return [seed["side"] for seed in seeds if seed["value"] in matched_set]


def bridge_density(tracks: list[RawTrack], seeds: list[dict]) -> float:
    if not tracks or not seeds:
        return 0.0
    hits = 0
    for track in tracks:
        text = f"{track.artist} {track.title} {track.playlist_title or ''}".lower()
        if any(seed["artist"].lower() and seed["artist"].lower() in text for seed in seeds):
            hits += 1
    return min(50.0, hits * 3.0)


def bridge_title_score(values: list[str]) -> float:
    text = " ".join(values).lower()
    return 15.0 if any(word in text for word in BRIDGE_TITLE_WORDS) else 0.0


def write_bridge_sources_md(store: Store, bridge_run_id: int) -> None:
    rows = store.bridge_sources_for_run(bridge_run_id)
    output = Path("output")
    output.mkdir(exist_ok=True)
    lines = [
        "| Source | Platform | Match | Confidence | Side(s) | Matched Seeds | Notes |",
        "| ------ | -------- | ----- | ---------- | ------- | ------------- | ----- |",
    ]
    for row in rows:
        matched = ", ".join(json.loads(row["matched_seeds_json"] or "[]"))
        sides = ", ".join(json.loads(row["seed_sides_json"] or "[]"))
        lines.append(
            f"| {escape_md(row['name'] or 'unknown')} | {escape_md(row['platform'] or '')} | {escape_md(row['match_type'])} | {float(row['confidence_score']):.1f} | {escape_md(sides)} | {escape_md(matched)} | {escape_md(row['notes'] or '')} |"
        )
    (output / "bridge_sources.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", value.lower()).strip("_")
    return cleaned[:80] or "bridge_source"
