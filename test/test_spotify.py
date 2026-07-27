from __future__ import annotations

import unittest
from unittest.mock import patch

from music_harvester.http import ApiError
from music_harvester.models import SourceConfig
from music_harvester.sources.base import SourceUnavailable
from music_harvester.sources.spotify import (
    SpotifySource,
    extract_user_id,
    playlist_item_track,
    spotify_profile_identifiers,
)


def track(track_id: str, name: str) -> dict:
    return {
        "type": "track",
        "id": track_id,
        "name": name,
        "uri": f"spotify:track:{track_id}",
        "artists": [{"name": "Portishead"}],
        "album": {"name": "Dummy"},
        "external_urls": {"spotify": f"https://open.spotify.com/track/{track_id}"},
    }


class PlaylistFixtureClient:
    def __init__(self):
        self.calls: list[tuple[str, dict | None]] = []

    def get(self, path: str, params: dict | None = None, **_kwargs: object) -> dict:
        self.calls.append((path, params))
        if path == "/playlists/fixture":
            return {"name": "Compatibility fixture"}
        if path == "/playlists/fixture/items" and params == {"limit": 1}:
            return {"total": 4}
        if path == "/playlists/fixture/items":
            return {
                "items": [
                    {"item": track("current", "Current shape")},
                    {"item": None, "track": track("legacy", "Legacy shape")},
                    {
                        "item": {"type": "episode", "name": "Not a track"},
                        "track": track("wrong-fallback", "Must not replace current item"),
                    },
                    {"item": None, "track": None},
                ],
                "next": None,
            }
        raise AssertionError(f"unexpected request: {path} {params}")


class ProfileFixtureClient:
    def __init__(self, profile: dict, playlists: list[dict] | None = None):
        self.profile = profile
        self.playlists = playlists or []
        self.calls: list[str] = []

    def get(self, path: str, params: dict | None = None, **_kwargs: object) -> dict:
        self.calls.append(path)
        if path == "/me":
            return self.profile
        if path == "/me/playlists":
            return {"items": self.playlists, "next": None}
        raise AssertionError(f"unexpected request: {path} {params}")


class PartialRateLimitClient:
    def __init__(self, error: ApiError | None = None):
        self.page_calls = 0
        self.error = error or ApiError(429, "Too many requests")

    def get(self, path: str, params: dict | None = None, **_kwargs: object) -> dict:
        if path == "/playlists/partial":
            return {"name": "Partial fixture"}
        if path == "/playlists/partial/items" and params == {"limit": 1}:
            return {"total": 2}
        if path == "/playlists/partial/items":
            self.page_calls += 1
            if self.page_calls == 1:
                return {
                    "items": [{"item": track("kept", "Collected before cooldown")}],
                    "next": "https://api.spotify.com/v1/playlists/partial/items?offset=1",
                }
        if path.endswith("offset=1"):
            raise self.error
        raise AssertionError(f"unexpected request: {path} {params}")


class SpotifySourceCompatibilityTests(unittest.TestCase):
    def test_current_item_is_primary_with_legacy_track_fallback(self) -> None:
        client = PlaylistFixtureClient()
        source = SourceConfig(
            name="fixture",
            platform="spotify",
            source_type="spotify_playlist",
            url="https://open.spotify.com/playlist/fixture",
        )

        tracks = SpotifySource(source, client=client).harvest()

        self.assertEqual([item.title for item in tracks], ["Current shape", "Legacy shape"])
        self.assertEqual([item.platform_track_id for item in tracks], ["current", "legacy"])
        self.assertEqual(playlist_item_track({"item": None, "track": track("old", "Old")})["id"], "old")
        self.assertEqual(playlist_item_track({"item": None, "track": None}), {})

    def test_ordinary_mid_pagination_429_returns_collected_tracks(self) -> None:
        source = SourceConfig(
            name="partial",
            platform="spotify",
            source_type="spotify_playlist",
            url="https://open.spotify.com/playlist/partial",
        )

        tracks = SpotifySource(source, client=PartialRateLimitClient()).harvest()

        self.assertEqual([item.platform_track_id for item in tracks], ["kept"])

    def test_quota_exhaustion_after_a_partial_page_is_not_hidden(self) -> None:
        source = SourceConfig(
            name="partial",
            platform="spotify",
            source_type="spotify_playlist",
            url="https://open.spotify.com/playlist/partial",
        )
        client = PartialRateLimitClient(
            ApiError(429, "Too many requests", reason="QUOTA_EXCEEDED")
        )

        with self.assertRaises(ApiError) as raised:
            SpotifySource(source, client=client).harvest()

        self.assertEqual(raised.exception.status, 429)
        self.assertEqual(raised.exception.reason, "QUOTA_EXCEEDED")

    def test_profile_input_cannot_silently_become_the_current_user(self) -> None:
        client = ProfileFixtureClient({"id": "authenticated-user"})
        source = SourceConfig(
            name="other_profile",
            platform="spotify",
            source_type="spotify_profile",
            url="https://open.spotify.com/user/someone-else",
        )

        with self.assertRaisesRegex(SourceUnavailable, "cannot enumerate another user's playlists"):
            SpotifySource(source, client=client).harvest()

        self.assertEqual(client.calls, ["/me"])

    def test_current_profile_reads_only_owned_or_collaborative_playlists(self) -> None:
        client = ProfileFixtureClient(
            {
                "id": "authenticated-user",
                "uri": "spotify:user:authenticated-user",
                "external_urls": {
                    "spotify": "https://open.spotify.com/user/authenticated-user"
                },
            },
            [
                {"id": "owned", "owner": {"id": "authenticated-user"}, "collaborative": False},
                {"id": "shared", "owner": {"id": "friend"}, "collaborative": True},
                {"id": "followed", "owner": {"id": "friend"}, "collaborative": False},
            ],
        )
        source = SpotifySource(
            SourceConfig(
                name="my_profile",
                platform="spotify",
                source_type="spotify_profile",
                url="spotify:user:authenticated-user",
            ),
            client=client,
        )

        with patch.object(source, "_playlist_tracks", return_value=[]) as playlist_tracks:
            self.assertEqual(source.harvest(), [])

        self.assertEqual(
            [call.args[0] for call in playlist_tracks.call_args_list],
            ["owned", "shared"],
        )
        self.assertEqual(extract_user_id("spotify:user:authenticated-user"), "authenticated-user")
        self.assertEqual(
            spotify_profile_identifiers(client.profile),
            {"authenticated-user"},
        )

    def test_403_is_capability_denial_but_429_remains_provider_state(self) -> None:
        source = SourceConfig(
            name="restricted",
            platform="spotify",
            source_type="spotify_playlist",
            url="https://open.spotify.com/playlist/restricted",
        )

        for error in (
            ApiError(403, "Forbidden"),
            ApiError(429, "Too many requests"),
            ApiError(429, "Too many requests", reason="QUOTA_EXCEEDED"),
        ):
            client = ProfileFixtureClient({})
            client.get = lambda *_args, _error=error, **_kwargs: (_ for _ in ()).throw(_error)
            if error.status == 403:
                with self.assertRaisesRegex(SourceUnavailable, "owns or collaborates"):
                    SpotifySource(source, client=client).harvest()
            else:
                with self.assertRaises(ApiError) as raised:
                    SpotifySource(source, client=client).harvest()
                self.assertEqual(raised.exception.status, 429)
                self.assertEqual(raised.exception.reason, error.reason)


if __name__ == "__main__":
    unittest.main()
