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


if __name__ == "__main__":
    unittest.main()
