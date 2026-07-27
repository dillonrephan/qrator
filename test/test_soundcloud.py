from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from music_harvester.models import SourceConfig
from music_harvester.sources.base import SourceUnavailable
from music_harvester.sources.soundcloud import (
    ExperimentalSoundCloudScraper,
    SoundCloudSource,
    extract_hydration,
    extract_tracks,
    validate_public_soundcloud_url,
)


HYDRATION = """
<html><script>
window.__sc_hydration = [
  {"hydratable":"playlist","data":{"kind":"playlist","title":"Trusted shelf","tracks":[
    {"kind":"track","urn":"soundcloud:tracks:alpha","title":"Producer - Deep Cut",
     "permalink_url":"https://soundcloud.com/producer/deep-cut",
     "playback_count":4200,"likes_count":250,"genre":"Hip-hop & Rap",
     "user":{"username":"Producer"}},
    {"kind":"track","urn":"soundcloud:tracks:beta","title":"Loose One",
     "permalink_url":"https://soundcloud.com/guest/loose-one",
     "publisher_metadata":{"artist":"Guest","release_title":"Loose One"},
     "user":{"username":"Uploader"}}
  ]}}
];</script></html>
"""


def source(url: str = "https://soundcloud.com/producer/sets/trusted") -> SourceConfig:
    return SourceConfig(
        name="trusted",
        platform="soundcloud",
        source_type="soundcloud_playlist",
        url=url,
        weight=3.0,
    )


class SoundCloudSourceTests(unittest.TestCase):
    def test_disabled_by_default(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(SourceUnavailable, "explicitly allow"):
                SoundCloudSource(source()).harvest()

    def test_extracts_bounded_public_hydration(self) -> None:
        scraper = ExperimentalSoundCloudScraper(fetch=lambda _: HYDRATION, max_items=1)
        with patch.dict(os.environ, {"QRATOR_EXPERIMENTAL_SOUNDCLOUD_SCRAPE": "1"}):
            tracks = SoundCloudSource(source(), scraper=scraper).harvest()

        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0].artist, "Producer")
        self.assertEqual(tracks[0].title, "Deep Cut")
        self.assertEqual(tracks[0].platform_track_id, "soundcloud:tracks:alpha")
        self.assertEqual(tracks[0].playlist_title, "Trusted shelf")
        self.assertEqual(tracks[0].payload["playback_count"], 4200)
        self.assertNotIn("client_id", tracks[0].payload)

    def test_prefers_publisher_identity(self) -> None:
        scraper = ExperimentalSoundCloudScraper(fetch=lambda _: HYDRATION)
        tracks = scraper.harvest(source())
        self.assertEqual((tracks[1].artist, tracks[1].title), ("Guest", "Loose One"))

    def test_rejects_non_soundcloud_and_credentials(self) -> None:
        rejected = [
            "http://soundcloud.com/user",
            "https://example.com/user",
            "https://user:pass@soundcloud.com/user",
            "https://soundcloud.com:444/user",
            "https://soundcloud.com/",
        ]
        for url in rejected:
            with self.subTest(url=url), self.assertRaises(SourceUnavailable):
                validate_public_soundcloud_url(url)

    def test_malformed_hydration_fails_loudly(self) -> None:
        with self.assertRaisesRegex(SourceUnavailable, "could not be decoded"):
            extract_hydration("<script>window.__sc_hydration = nope;</script>")

    def test_deduplicates_nested_track_objects(self) -> None:
        payload = extract_hydration(HYDRATION)
        payload.append({"data": payload[0]["data"]["tracks"][0]})
        self.assertEqual(len(extract_tracks(payload, 100)), 2)

    def test_profile_hydration_can_fall_back_to_public_rss(self) -> None:
        profile = """
        <script>window.__sc_hydration = [
          {"hydratable":"user","data":{"urn":"soundcloud:users:123","username":"Shelf Keeper"}}
        ];</script>
        """
        rss = """<?xml version="1.0"?>
        <rss><channel><item>
          <title>Guest Rapper - Pocket Jazz</title>
          <link>https://soundcloud.com/guest-rapper/pocket-jazz</link>
        </item></channel></rss>"""
        scraper = ExperimentalSoundCloudScraper()
        scraper._fetch = lambda _: profile
        scraper._fetch_public_feed = lambda _: rss
        tracks = scraper.harvest(source("https://soundcloud.com/shelf-keeper"))
        self.assertEqual((tracks[0].artist, tracks[0].title), ("Guest Rapper", "Pocket Jazz"))
        self.assertTrue(tracks[0].payload["public_rss_fallback"])


if __name__ == "__main__":
    unittest.main()
