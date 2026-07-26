from __future__ import annotations

import unittest
from email.message import Message
from types import SimpleNamespace

from music_harvester.http import retry_after_seconds


class HttpRateLimitTests(unittest.TestCase):
    def test_retry_after_is_not_clamped(self) -> None:
        headers = Message()
        headers["Retry-After"] = "123"
        error = SimpleNamespace(headers=headers)
        self.assertEqual(retry_after_seconds(error), 123)


if __name__ == "__main__":
    unittest.main()
