from __future__ import annotations

import re
import unicodedata


NOISE = re.compile(r"\s+")
BRACKETED = re.compile(r"\s*[\[(].*?(remaster|explicit|official video|audio|visualizer).*?[\])]\s*", re.I)


def normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", value or "").strip()
    text = BRACKETED.sub(" ", text)
    text = NOISE.sub(" ", text)
    return text


def normalize_key(artist: str, title: str) -> str:
    combined = f"{artist}::{title}".lower()
    combined = unicodedata.normalize("NFKD", combined).encode("ascii", "ignore").decode("ascii")
    combined = re.sub(r"[^a-z0-9]+", " ", combined)
    return NOISE.sub(" ", combined).strip()


def split_artist_track(value: str) -> tuple[str, str] | None:
    for separator in (" - ", " – ", " — ", "\t"):
        if separator in value:
            artist, title = value.split(separator, 1)
            if artist.strip() and title.strip():
                return normalize_text(artist), normalize_text(title)
    return None
