from __future__ import annotations

from music_harvester.models import Candidate


class SoundCloudResolver:
    def resolve(self, candidate: Candidate) -> Candidate:
        return candidate
