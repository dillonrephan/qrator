from __future__ import annotations

from abc import ABC, abstractmethod

from music_harvester.models import MusicCandidate, RawTrack, SourceConfig


class SourceAdapter(ABC):
    def __init__(self, source: SourceConfig):
        self.source = source

    @abstractmethod
    def harvest(self) -> list[MusicCandidate | RawTrack]:
        raise NotImplementedError


class SourceUnavailable(RuntimeError):
    pass
