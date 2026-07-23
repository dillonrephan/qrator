from __future__ import annotations

from pathlib import Path

from music_harvester.engine.extract import extract_csv_candidates
from music_harvester.models import MusicCandidate
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


class CsvImportSource(SourceAdapter):
    def harvest(self) -> list[MusicCandidate]:
        if not self.source.url:
            raise SourceUnavailable("csv_import sources need a file path.")
        path = Path(self.source.url)
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            raise SourceUnavailable(f"CSV import not found: {path}")
        return extract_csv_candidates(path.read_text(encoding="utf-8"), self.source)
