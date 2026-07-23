from __future__ import annotations

from music_harvester.models import MusicCandidate
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


class MusicBrainzSource(SourceAdapter):
    def harvest(self) -> list[MusicCandidate]:
        raise SourceUnavailable("MusicBrainz source discovery is planned; use resolver hooks for now.")
