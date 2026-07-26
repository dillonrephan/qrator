from __future__ import annotations

import unittest

from music_harvester.engine.score import score_candidates
from music_harvester.models import Candidate


def candidate() -> Candidate:
    return Candidate(
        id=1,
        artist="Unknown Artist",
        title="Unpredicted Track",
        album=None,
        spotify_uri=None,
        soundcloud_url=None,
        score=2.4,
        sources=["listenbrainz_radio_seed"],
        platforms=["listenbrainz"],
        playlist_titles=["ListenBrainz radio: Seed"],
        why="",
        bridge_source_score=90,
        bridge_seed_sides=["seed_1"],
    )


class EvidenceScoreTests(unittest.TestCase):
    def test_score_is_bounded_shelf_evidence_not_taste_prediction(self) -> None:
        item = score_candidates([candidate()])[0]
        self.assertGreater(item.shelf_confidence, 0)
        self.assertLessEqual(item.shelf_confidence, 100)
        self.assertEqual(item.discovery_distance, "one shelf away")
        self.assertIn("no claim is made about whether you will like it", item.why)
        self.assertNotIn("taste", item.score_components)
        self.assertNotIn("feedback", item.score_components)


if __name__ == "__main__":
    unittest.main()
