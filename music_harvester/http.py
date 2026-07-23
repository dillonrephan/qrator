from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


@dataclass
class ApiError(Exception):
    status: int
    message: str

    def __str__(self) -> str:
        return f"{self.status}: {self.message}"


def request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    form: dict[str, Any] | None = None,
    polite_delay: float = 0.12,
    retries: int = 2,
) -> dict[str, Any]:
    if params:
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}{urlencode(params)}"

    data = None
    final_headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        final_headers.setdefault("Content-Type", "application/json")
    elif form is not None:
        data = urlencode(form).encode("utf-8")
        final_headers.setdefault("Content-Type", "application/x-www-form-urlencoded")

    for attempt in range(retries + 1):
        req = Request(url, data=data, headers=final_headers, method=method.upper())
        try:
            with urlopen(req, timeout=30) as response:
                payload = response.read().decode("utf-8")
                time.sleep(polite_delay)
                return json.loads(payload) if payload else {}
        except HTTPError as exc:
            if exc.code == 429 and attempt < retries:
                retry_after = retry_after_seconds(exc)
                time.sleep(retry_after)
                continue
            message = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(message)
                message = parsed.get("error_description") or parsed.get("message") or parsed.get("error", {}).get("message") or message
            except json.JSONDecodeError:
                pass
            raise ApiError(exc.code, message) from exc
        except URLError as exc:
            raise ApiError(0, str(exc.reason)) from exc

    raise ApiError(0, "request retry loop exited unexpectedly")


def retry_after_seconds(exc: HTTPError) -> float:
    raw = exc.headers.get("Retry-After")
    if not raw:
        return 2.0
    try:
        return max(1.0, min(float(raw), 30.0))
    except ValueError:
        return 2.0
