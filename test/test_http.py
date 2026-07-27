from __future__ import annotations

import unittest
from email.message import Message
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

from music_harvester.http import ApiError, request_json, retry_after_seconds


class HttpRateLimitTests(unittest.TestCase):
    def test_retry_after_is_not_clamped(self) -> None:
        headers = Message()
        headers["Retry-After"] = "123"
        error = SimpleNamespace(headers=headers)
        self.assertEqual(retry_after_seconds(error), 123)

    @patch("music_harvester.http.urlopen")
    def test_string_error_payload_is_reported_without_parser_crash(self, mocked_urlopen) -> None:
        mocked_urlopen.side_effect = HTTPError(
            "https://example.test",
            400,
            "Bad Request",
            {},
            BytesIO(b'{"error":"bad query"}'),
        )

        with self.assertRaisesRegex(ApiError, "bad query"):
            request_json("GET", "https://example.test", retries=0, polite_delay=0)

    @patch("music_harvester.http.time.sleep")
    @patch("music_harvester.http.urlopen")
    def test_temporary_server_error_is_retried(self, mocked_urlopen, _mocked_sleep) -> None:
        temporary_error = HTTPError(
            "https://example.test",
            503,
            "Unavailable",
            {},
            BytesIO(b'{"error":"temporary"}'),
        )
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        mocked_urlopen.side_effect = [temporary_error, response]

        self.assertEqual(
            request_json("GET", "https://example.test", retries=1, polite_delay=0),
            {"ok": True},
        )

    @patch("music_harvester.http.save_provider_cooldown")
    @patch("music_harvester.http.time.sleep")
    @patch("music_harvester.http.urlopen")
    def test_ordinary_429_retries_after_saving_full_cooldown(
        self,
        mocked_urlopen,
        _mocked_sleep,
        mocked_cooldown,
    ) -> None:
        headers = Message()
        headers["Retry-After"] = "12"
        rate_limit = HTTPError(
            "https://api.spotify.com/v1/search",
            429,
            "Too Many Requests",
            headers,
            BytesIO(b'{"error":{"status":429,"message":"Too many requests"}}'),
        )
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"tracks":{"items":[]}}'
        mocked_urlopen.side_effect = [rate_limit, response]

        result = request_json(
            "GET",
            "https://api.spotify.com/v1/search",
            retries=1,
            polite_delay=0,
            deadline=float("inf"),
        )

        self.assertEqual(result, {"tracks": {"items": []}})
        self.assertEqual(mocked_urlopen.call_count, 2)
        mocked_cooldown.assert_called_once_with("spotify", 12)

    @patch("music_harvester.http.save_provider_cooldown")
    @patch("music_harvester.http.time.sleep")
    @patch("music_harvester.http.urlopen")
    def test_quota_exceeded_is_structured_and_never_retried(
        self,
        mocked_urlopen,
        mocked_sleep,
        mocked_cooldown,
    ) -> None:
        headers = Message()
        headers["Retry-After"] = "3600"
        mocked_urlopen.side_effect = HTTPError(
            "https://api.spotify.com/v1/search",
            429,
            "Too Many Requests",
            headers,
            BytesIO(
                b'{"error":{"status":429,"message":"Too many requests",'
                b'"reason":"QUOTA_EXCEEDED"}}'
            ),
        )

        with self.assertRaises(ApiError) as raised:
            request_json(
                "GET",
                "https://api.spotify.com/v1/search",
                retries=3,
                polite_delay=0,
                deadline=float("inf"),
            )

        self.assertEqual(raised.exception.status, 429)
        self.assertEqual(raised.exception.reason, "QUOTA_EXCEEDED")
        self.assertEqual(mocked_urlopen.call_count, 1)
        mocked_cooldown.assert_called_once_with("spotify", 3600)
        mocked_sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
