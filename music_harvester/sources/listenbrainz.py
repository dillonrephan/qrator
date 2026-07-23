from __future__ import annotations

from music_harvester.models import RawTrack
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


class ListenBrainzSource(SourceAdapter):
    def harvest(self) -> list[RawTrack]:
        raise SourceUnavailable("ListenBrainz is planned for V2; source skipped.")
