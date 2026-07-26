from __future__ import annotations

from music_harvester.models import RawTrack, SourceConfig
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


class SoundCloudSource(SourceAdapter):
    """Fail closed until the official OAuth/URN adapter is enabled."""

    def __init__(self, source: SourceConfig):
        super().__init__(source)

    def harvest(self) -> list[RawTrack]:
        raise SourceUnavailable(
            "Official SoundCloud discovery is not enabled yet. "
            "The retired api-v2/client-id extraction path will not be used; "
            "paste a tracklist or keep the SoundCloud URL for manual review."
        )
