from __future__ import annotations

from music_harvester.models import SourceConfig
from music_harvester.sources.base import SourceAdapter, SourceUnavailable
from music_harvester.sources.lastfm import LastFmSource
from music_harvester.sources.listenbrainz import ListenBrainzSource
from music_harvester.sources.soundcloud import SoundCloudSource
from music_harvester.sources.spotify import SpotifySource
from music_harvester.sources.text_import import TextImportSource
from music_harvester.sources.csv_import import CsvImportSource
from music_harvester.sources.manual import ManualSource
from music_harvester.sources.web_page import WebPageSource
from music_harvester.sources.bandcamp import BandcampSource
from music_harvester.sources.musicbrainz import MusicBrainzSource
from music_harvester.sources.youtube import YouTubeSource


def adapter_for(source: SourceConfig) -> SourceAdapter:
    platform = source.platform.lower()
    if platform == "spotify":
        return SpotifySource(source)
    if platform == "soundcloud":
        return SoundCloudSource(source)
    if platform == "text":
        return TextImportSource(source)
    if platform == "csv":
        return CsvImportSource(source)
    if platform in {"web", "web_page", "html"}:
        return WebPageSource(source)
    if platform == "manual":
        return ManualSource(source)
    if platform == "lastfm":
        return LastFmSource(source)
    if platform == "listenbrainz":
        return ListenBrainzSource(source)
    if platform == "musicbrainz":
        return MusicBrainzSource(source)
    if platform == "youtube":
        return YouTubeSource(source)
    if platform == "bandcamp":
        return BandcampSource(source)
    raise SourceUnavailable(f"Unsupported source platform: {source.platform}")
