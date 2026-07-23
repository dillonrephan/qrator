from __future__ import annotations

import unittest

from music_harvester.models import SourceConfig
from music_harvester.sources.lastfm import LastFmSource, lastfm_username


class FakeLastFmClient:
    def get(self, method: str, **params: object) -> dict:
        self.request = (method, params)
        return {
            "toptracks": {
                "track": [
                    {"name": "Roads", "artist": {"name": "Portishead"}, "url": "https://last.fm/track/roads"}
                ]
            }
        }


class LastFmSourceTests(unittest.TestCase):
    def test_extracts_username_from_profile_url(self) -> None:
        self.assertEqual(lastfm_username("https://www.last.fm/user/ice%20burg"), "ice burg")

    def test_harvests_profile_top_tracks(self) -> None:
        client = FakeLastFmClient()
        source = SourceConfig(
            name="profile",
            platform="lastfm",
            source_type="lastfm_profile",
            url="https://www.last.fm/user/example",
        )
        tracks = LastFmSource(source, client=client).harvest()
        self.assertEqual(client.request[0], "user.getTopTracks")
        self.assertEqual(tracks[0].artist, "Portishead")
        self.assertEqual(tracks[0].title, "Roads")
        self.assertEqual(tracks[0].platform, "lastfm")


if __name__ == "__main__":
    unittest.main()
