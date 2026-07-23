from __future__ import annotations

import csv
import html
import re
from io import StringIO

from music_harvester.models import MusicCandidate, SourceConfig


PATTERNS: list[tuple[re.Pattern[str], float]] = [
    (re.compile(r"^\s*(?:\d+[\).:-]\s*)?(?P<artist>[^-\u2013\u2014:\/]{2,80})\s[-\u2013\u2014:\/]\s(?P<title>.{2,120})\s*$"), 0.92),
    (re.compile(r"^\s*(?:\d+[\).:-]\s*)?(?P<title>.{2,120})\s+by\s+(?P<artist>.{2,80})\s*$", re.I), 0.78),
]


def strip_html(text: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|li|tr|h[1-6])>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(text)


def extract_music_candidates(text: str, source: SourceConfig, *, html_input: bool = False) -> list[MusicCandidate]:
    if html_input:
        text = strip_html(text)

    candidates: list[MusicCandidate] = []
    for index, line in enumerate(text.splitlines(), 1):
        cleaned = clean_line(line)
        if not cleaned:
            continue
        parsed = parse_line(cleaned)
        if not parsed:
            continue
        artist, title, confidence = parsed
        candidates.append(
            MusicCandidate(
                raw_artist=artist,
                raw_title=title,
                source_platform=source.platform,
                source_type=source.source_type,
                source_name=source.name,
                source_url=source.locator,
                source_weight=source.weight,
                source_context=f"line {index}",
                raw_payload_json={"line": line, "extraction_confidence": confidence},
                extraction_confidence=confidence,
                normalization_confidence=0.85 if confidence >= 0.9 else 0.7,
                playlist_title=source.name,
                position=index,
            )
        )
    return candidates


def extract_csv_candidates(text: str, source: SourceConfig) -> list[MusicCandidate]:
    candidates: list[MusicCandidate] = []
    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        return extract_music_candidates(text, source)

    fields = {field.lower(): field for field in reader.fieldnames}
    artist_field = fields.get("artist") or fields.get("raw_artist")
    title_field = fields.get("title") or fields.get("track") or fields.get("raw_title")
    album_field = fields.get("album")
    if not artist_field or not title_field:
        return extract_music_candidates(text, source)

    for index, row in enumerate(reader, 2):
        artist = (row.get(artist_field) or "").strip()
        title = (row.get(title_field) or "").strip()
        if not artist or not title:
            continue
        candidates.append(
            MusicCandidate(
                raw_artist=artist,
                raw_title=title,
                raw_album=(row.get(album_field) or "").strip() if album_field else None,
                source_platform=source.platform,
                source_type=source.source_type,
                source_name=source.name,
                source_url=source.locator,
                source_weight=source.weight,
                source_context=f"csv row {index}",
                raw_payload_json={"row": row},
                extraction_confidence=0.98,
                normalization_confidence=0.9,
                playlist_title=source.name,
                position=index,
            )
        )
    return candidates


def parse_line(line: str) -> tuple[str, str, float] | None:
    for pattern, confidence in PATTERNS:
        match = pattern.match(line)
        if match:
            artist = trim_noise(match.group("artist"))
            title = trim_noise(match.group("title"))
            if artist and title:
                return artist, title, confidence
    return None


def clean_line(line: str) -> str:
    if line.lstrip().startswith("#"):
        return ""
    line = re.sub(r"^\s*[-*+]\s+", "", line)
    line = re.sub(r"^\s*\|?[-:\s|]+\|?\s*$", "", line)
    line = line.strip().strip("|").strip()
    return line


def trim_noise(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip(" \t-:|")
    return value[:160]
