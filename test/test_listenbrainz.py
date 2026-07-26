from __future__ import annotations

import unittest

from music_harvester.models import SourceConfig
from music_harvester.sources.listenbrainz import ListenBrainzSource


class FakeListenBrainzClient:
    def artist_mbid(self, artist_name: str) -> str:
        self.artist_name = artist_name
        return "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11"

    def artist_radio(self, artist_mbid: str) -> list[dict]:
        self.artist_mbid_value = artist_mbid
        return [
            {
                "recording_mbid": "e97f805a-ab48-4c52-855e-07049142113d",
                "similar_artist_name": "Portishead",
                "total_listen_count": 100,
            }
        ]

    def recording_metadata(self, recording_mbids: list[str]) -> dict:
        self.recording_mbids = recording_mbids
        return {
            recording_mbids[0]: {
                "recording": {"name": "Roads"},
                "artist": {"name": "Portishead"},
                "release": {"name": "Dummy"},
            }
        }


class ListenBrainzSourceTests(unittest.TestCase):
    def test_hydrates_artist_radio_without_credentials(self) -> None:
        client = FakeListenBrainzClient()
        source = SourceConfig(
            name="portishead_radio",
            platform="listenbrainz",
            source_type="listenbrainz_radio",
            url="Portishead",
            weight=2.4,
        )
        tracks = ListenBrainzSource(source, client=client).harvest()

        self.assertEqual(client.artist_name, "Portishead")
        self.assertEqual(tracks[0].artist, "Portishead")
        self.assertEqual(tracks[0].title, "Roads")
        self.assertEqual(tracks[0].album, "Dummy")
        self.assertEqual(tracks[0].payload["musicbrainz_id"], tracks[0].platform_track_id)


if __name__ == "__main__":
    unittest.main()
