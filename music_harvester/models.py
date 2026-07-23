from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SourceConfig:
    name: str
    platform: str
    source_type: str
    weight: float = 1.0
    url: str | None = None
    username: str | None = None
    category: str = "structured_api"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SourceConfig":
        return cls(
            name=data["name"],
            platform=data["platform"],
            source_type=data.get("type") or data.get("source_type"),
            weight=float(data.get("weight", 1.0)),
            url=data.get("url"),
            username=data.get("username"),
            category=data.get("category", "structured_api"),
        )

    @property
    def locator(self) -> str:
        return self.url or self.username or ""


@dataclass
class MusicCandidate:
    raw_artist: str
    raw_title: str
    source_platform: str
    source_type: str
    source_name: str
    source_url: str | None
    source_weight: float
    source_context: str | None = None
    raw_album: str | None = None
    raw_url: str | None = None
    discovered_at: str | None = None
    raw_payload_json: dict[str, Any] = field(default_factory=dict)
    extraction_confidence: float = 1.0
    normalization_confidence: float = 1.0
    spotify_resolution_confidence: float = 0.0
    platform_track_id: str | None = None
    playlist_title: str | None = None
    position: int | None = None

    @property
    def artist(self) -> str:
        return self.raw_artist

    @property
    def title(self) -> str:
        return self.raw_title

    @property
    def album(self) -> str | None:
        return self.raw_album

    @property
    def platform(self) -> str:
        return self.source_platform

    @property
    def url(self) -> str | None:
        return self.raw_url

    @property
    def payload(self) -> dict[str, Any]:
        return self.raw_payload_json


@dataclass
class RawTrack:
    source_name: str
    platform: str
    artist: str
    title: str
    album: str | None = None
    platform_track_id: str | None = None
    url: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    source_context: str | None = None
    playlist_title: str | None = None
    position: int | None = None

    def to_music_candidate(self, source: SourceConfig) -> MusicCandidate:
        return MusicCandidate(
            raw_artist=self.artist,
            raw_title=self.title,
            raw_album=self.album,
            raw_url=self.url,
            source_platform=self.platform,
            source_type=source.source_type,
            source_name=source.name,
            source_url=source.locator,
            source_weight=source.weight,
            source_context=self.source_context,
            raw_payload_json=self.payload,
            extraction_confidence=float(self.payload.get("extraction_confidence", 1.0)),
            normalization_confidence=float(self.payload.get("normalization_confidence", 1.0)),
            spotify_resolution_confidence=1.0 if self.payload.get("spotify_uri") else 0.0,
            platform_track_id=self.platform_track_id,
            playlist_title=self.playlist_title,
            position=self.position,
        )


@dataclass
class Candidate:
    id: int
    artist: str
    title: str
    album: str | None
    spotify_uri: str | None
    soundcloud_url: str | None
    score: float
    sources: list[str]
    platforms: list[str]
    playlist_titles: list[str]
    why: str
    pools: list[str] = field(default_factory=list)
    score_components: dict[str, float] = field(default_factory=dict)
    bridge_source_score: float = 0.0
    bridge_match_types: list[str] = field(default_factory=list)
    bridge_seed_sides: list[str] = field(default_factory=list)
    extraction_confidence: float = 1.0
    normalization_confidence: float = 1.0
    spotify_resolution_confidence: float = 0.0
    rejected: bool = False
    rejection_reason: str | None = None
