from __future__ import annotations

import unittest

from music_harvester.models import Candidate
from music_harvester.resolvers.spotify_resolver import best_match, search_artist


def candidate(title: str = "Roads") -> Candidate:
    return Candidate(
        id=1,
        artist="Portishead",
        title=title,
        album=None,
        spotify_uri=None,
        soundcloud_url=None,
        score=1,
        sources=["radio"],
        platforms=["listenbrainz"],
        playlist_titles=[],
        why="",
    )


class SpotifyMatchTests(unittest.TestCase):
    def test_rejects_unrelated_first_result(self) -> None:
        items = [{"name": "Roads", "uri": "spotify:track:wrong", "artists": [{"name": "Foo Fighters"}]}]
        self.assertIsNone(best_match(candidate(), items))

    def test_accepts_strict_artist_and_title_match(self) -> None:
        item = {"name": "Roads", "uri": "spotify:track:right", "artists": [{"name": "Portishead"}]}
        match = best_match(candidate(), [item])
        self.assertIsNotNone(match)
        self.assertEqual(match.item["uri"], "spotify:track:right")

    def test_does_not_substitute_live_version(self) -> None:
        item = {"name": "Roads - Live", "uri": "spotify:track:live", "artists": [{"name": "Portishead"}]}
        self.assertIsNone(best_match(candidate(), [item]))

    def test_search_uses_primary_artist_from_feature_credit(self) -> None:
        self.assertEqual(search_artist("Charli xcx featuring Julian Casablancas"), "Charli xcx")


if __name__ == "__main__":
    unittest.main()
