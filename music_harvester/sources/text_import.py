from __future__ import annotations

from pathlib import Path

from music_harvester.engine.extract import extract_music_candidates
from music_harvester.models import MusicCandidate
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


class TextImportSource(SourceAdapter):
    def harvest(self) -> list[MusicCandidate]:
        if not self.source.url:
            raise SourceUnavailable("Text imports need a file path in url.")
        path = Path(self.source.url)
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            raise SourceUnavailable(f"Text import not found: {path}")

        return extract_music_candidates(path.read_text(encoding="utf-8"), self.source)
