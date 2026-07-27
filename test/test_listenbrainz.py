from __future__ import annotations

import unittest
from unittest.mock import patch

from music_harvester.engine.bridge import source_from_url
from music_harvester.models import SourceConfig
from music_harvester.sources.base import SourceUnavailable
from music_harvester.sources.listenbrainz import (
    LISTENBRAINZ_USER_TOP_COUNT,
    LISTENBRAINZ_USER_TOP_RANGE,
    ListenBrainzClient,
    ListenBrainzSource,
    listenbrainz_username,
)


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


class FakeListenBrainzUserClient:
    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.calls: list[str] = []

    def user_top_recordings(self, username: str) -> list[dict]:
        self.calls.append(username)
        return self.rows


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

    def test_accepts_only_canonical_listenbrainz_user_urls(self) -> None:
        self.assertEqual(
            listenbrainz_username("https://listenbrainz.org/user/Shelf.Keeper"),
            "Shelf.Keeper",
        )
        self.assertEqual(
            listenbrainz_username("https://listenbrainz.org/user/shelf-keeper/"),
            "shelf-keeper",
        )
        rejected = [
            "http://listenbrainz.org/user/example",
            "https://www.listenbrainz.org/user/example",
            "https://listenbrainz.org.evil.test/user/example",
            "https://listenbrainz.org:443/user/example",
            "https://user@listenbrainz.org/user/example",
            "https://listenbrainz.org/user/example/extra",
            "https://listenbrainz.org/user/example?range=all_time",
            "https://listenbrainz.org/user/example#top",
            "https://listenbrainz.org/user/a%2Fb",
        ]
        for url in rejected:
            with self.subTest(url=url), self.assertRaises(SourceUnavailable):
                listenbrainz_username(url)

    def test_user_top_client_makes_one_fixed_bounded_stats_request(self) -> None:
        response = {"payload": {"recordings": [{"artist_name": "A", "track_name": "B"}]}}
        with patch(
            "music_harvester.sources.listenbrainz.request_json",
            return_value=response,
        ) as request:
            rows = ListenBrainzClient().user_top_recordings("Shelf.Keeper")

        self.assertEqual(rows, response["payload"]["recordings"])
        request.assert_called_once()
        _, url = request.call_args.args
        self.assertEqual(
            url,
            "https://api.listenbrainz.org/1/stats/user/Shelf.Keeper/recordings",
        )
        self.assertEqual(
            request.call_args.kwargs["params"],
            {
                "count": LISTENBRAINZ_USER_TOP_COUNT,
                "offset": 0,
                "range": LISTENBRAINZ_USER_TOP_RANGE,
            },
        )
        self.assertLessEqual(request.call_args.kwargs["params"]["count"], 100)
        self.assertEqual(request.call_args.kwargs["retries"], 0)

    def test_harvests_user_top_rows_with_optional_mbid_and_provenance(self) -> None:
        valid_mbid = "e97f805a-ab48-4c52-855e-07049142113d"
        client = FakeListenBrainzUserClient(
            [
                {
                    "artist_name": "Portishead",
                    "track_name": "Roads",
                    "release_name": "Dummy",
                    "recording_mbid": valid_mbid,
                    "listen_count": 42,
                },
                {
                    "artist_name": "Nina Simone",
                    "track_name": "Sinnerman",
                    "recording_mbid": None,
                    "listen_count": 17,
                },
            ]
        )
        source = SourceConfig(
            name="trusted_shelf",
            platform="listenbrainz",
            source_type="listenbrainz_user_top",
            url="https://listenbrainz.org/user/Shelf.Keeper",
            weight=3.0,
            category="manual_urls",
        )

        tracks = ListenBrainzSource(source, client=client).harvest()

        self.assertEqual(client.calls, ["Shelf.Keeper"])
        self.assertEqual(len(tracks), 2)
        self.assertEqual(tracks[0].platform_track_id, valid_mbid)
        self.assertEqual(tracks[0].url, f"https://musicbrainz.org/recording/{valid_mbid}")
        self.assertIsNone(tracks[1].platform_track_id)
        self.assertIsNone(tracks[1].url)
        self.assertEqual(tracks[1].artist, "Nina Simone")
        self.assertEqual(tracks[1].title, "Sinnerman")
        self.assertEqual(tracks[0].payload["listen_count"], 42)
        self.assertEqual(tracks[0].payload["listenbrainz_range"], "half_yearly")
        self.assertEqual(tracks[0].payload["listenbrainz_user"], "Shelf.Keeper")
        self.assertEqual(tracks[0].source_context, "listenbrainz_user_top")
        self.assertEqual(
            tracks[0].playlist_title,
            "ListenBrainz six-month shelf: Shelf.Keeper",
        )

    def test_user_top_empty_or_invalid_rows_fail_loudly(self) -> None:
        source = SourceConfig(
            name="empty_shelf",
            platform="listenbrainz",
            source_type="listenbrainz_user_top",
            url="https://listenbrainz.org/user/empty",
        )
        for rows in ([], [{"artist_name": "", "track_name": "No artist"}], [{}]):
            with self.subTest(rows=rows), self.assertRaisesRegex(
                SourceUnavailable,
                "no usable six-month top recordings",
            ):
                ListenBrainzSource(
                    source,
                    client=FakeListenBrainzUserClient(rows),
                ).harvest()

    def test_create_seeds_routes_canonical_profile_to_user_top_source(self) -> None:
        source = source_from_url(
            "bridge_user_1",
            "https://listenbrainz.org/user/Shelf.Keeper",
            3.0,
        )
        self.assertIsNotNone(source)
        self.assertEqual(source.platform, "listenbrainz")
        self.assertEqual(source.source_type, "listenbrainz_user_top")
        self.assertEqual(source.category, "manual_urls")


if __name__ == "__main__":
    unittest.main()
