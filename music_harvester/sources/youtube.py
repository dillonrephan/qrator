from __future__ import annotations

from music_harvester.models import MusicCandidate
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


class YouTubeSource(SourceAdapter):
    def harvest(self) -> list[MusicCandidate]:
        raise SourceUnavailable("YouTube playlist ingestion is planned; use web_page/text imports for exports now.")
