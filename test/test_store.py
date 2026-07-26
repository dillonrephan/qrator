from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from music_harvester.db.store import Store
from music_harvester.models import RawTrack, SourceConfig


class StoreTests(unittest.TestCase):
    def test_repeated_observation_does_not_multiply_source_weight(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "test.sqlite")
            store.init()
            source = SourceConfig(
                name="radio",
                platform="listenbrainz",
                source_type="listenbrainz_radio",
                url="Portishead",
                weight=2.4,
            )
            source_id = store.upsert_source(source)
            track = RawTrack(
                source_name=source.name,
                platform="listenbrainz",
                artist="Tricky",
                title="Hell Is Round the Corner",
                platform_track_id="0a8e5f68-c64d-4d3f-980a-5f8f5ff0cccf",
                payload={"musicbrainz_id": "0a8e5f68-c64d-4d3f-980a-5f8f5ff0cccf"},
                source_context="listenbrainz_artist_radio",
                playlist_title="ListenBrainz radio: Portishead",
                position=1,
            )
            store.add_raw_tracks(source_id, [track])
            store.add_raw_tracks(source_id, [track])

            candidates = store.candidates()
            self.assertEqual(len(candidates), 1)
            self.assertEqual(candidates[0].score, 2.4)
            self.assertEqual(candidates[0].musicbrainz_id, track.platform_track_id)
            resolution = store.conn.execute(
                "select target, external_id from platform_resolutions"
            ).fetchone()
            self.assertEqual(tuple(resolution), ("musicbrainz", track.platform_track_id))


if __name__ == "__main__":
    unittest.main()
