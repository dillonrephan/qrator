from __future__ import annotations

from music_harvester.models import MusicCandidate
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


class BandcampSource(SourceAdapter):
    def harvest(self) -> list[MusicCandidate]:
        raise SourceUnavailable("Bandcamp collection ingestion is planned; use web_page/text imports for exports now.")
