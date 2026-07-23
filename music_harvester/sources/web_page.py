from __future__ import annotations

from urllib.request import Request, urlopen

from music_harvester.engine.extract import extract_music_candidates
from music_harvester.models import MusicCandidate
from music_harvester.sources.base import SourceAdapter, SourceUnavailable


class WebPageSource(SourceAdapter):
    def harvest(self) -> list[MusicCandidate]:
        if not self.source.url:
            raise SourceUnavailable("web_page sources need a URL.")
        req = Request(self.source.url, headers={"User-Agent": "qrator/0.1"})
        with urlopen(req, timeout=30) as response:
            content_type = response.headers.get("content-type", "")
            body = response.read().decode("utf-8", errors="replace")
        return extract_music_candidates(body, self.source, html_input="html" in content_type or "<html" in body.lower())
