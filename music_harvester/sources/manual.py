from __future__ import annotations

from music_harvester.engine.extract import extract_music_candidates
from music_harvester.models import MusicCandidate
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


class ManualSource(SourceAdapter):
    def harvest(self) -> list[MusicCandidate]:
        text = self.source.url or self.source.username or ""
        if not text:
            raise SourceUnavailable("manual sources need text in url or username.")
        return extract_music_candidates(text, self.source)
