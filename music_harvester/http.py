from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
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
    provider: str | None = None,
    deadline: float | None = None,
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

    provider = provider or provider_for_url(url)
    deadline = deadline or run_deadline()
    for attempt in range(retries + 1):
        wait_for_provider(provider, deadline)
        req = Request(url, data=data, headers=final_headers, method=method.upper())
        try:
            with urlopen(req, timeout=30) as response:
                payload = response.read().decode("utf-8")
                time.sleep(polite_delay)
                return json.loads(payload) if payload else {}
        except HTTPError as exc:
            if exc.code == 429:
                retry_after = retry_after_seconds(exc)
                save_provider_cooldown(provider, retry_after)
                if attempt < retries and retry_after <= max_rate_limit_wait() and time.monotonic() + retry_after < deadline:
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
        return max(1.0, float(raw))
    except ValueError:
        try:
            delay = parsedate_to_datetime(raw).timestamp() - time.time()
            return max(1.0, delay)
        except (TypeError, ValueError, OverflowError):
            return 2.0


def provider_for_url(url: str) -> str:
    host = (urlparse(url).hostname or "unknown").lower()
    if host.endswith("spotify.com"):
        return "spotify"
    if host.endswith("listenbrainz.org"):
        return "listenbrainz"
    if host.endswith("musicbrainz.org"):
        return "musicbrainz"
    if host.endswith("last.fm") or host.endswith("audioscrobbler.com"):
        return "lastfm"
    if host.endswith("soundcloud.com"):
        return "soundcloud"
    return host.replace("/", "_")


def run_deadline() -> float:
    raw = os.environ.get("QRATOR_RUN_DEADLINE_UNIX")
    if raw:
        try:
            return time.monotonic() + max(0.0, float(raw) - time.time())
        except ValueError:
            pass
    seconds = float(os.environ.get("QRATOR_DISCOVERY_DEADLINE_SECONDS", "180"))
    return time.monotonic() + max(1.0, seconds)


def max_rate_limit_wait() -> float:
    return max(0.0, float(os.environ.get("QRATOR_MAX_RATE_LIMIT_WAIT_SECONDS", "15")))


def state_dir() -> Path:
    configured = os.environ.get("QRATOR_STATE_DIR")
    path = Path(configured) if configured else Path("data")
    path.mkdir(parents=True, exist_ok=True)
    return path


def cooldown_path(provider: str) -> Path:
    safe = "".join(character for character in provider if character.isalnum() or character in "-_") or "unknown"
    return state_dir() / f"cooldown-{safe}.json"


def load_provider_cooldown(provider: str) -> float:
    try:
        payload = json.loads(cooldown_path(provider).read_text(encoding="utf-8"))
        return float(payload.get("until", 0))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return 0.0


def save_provider_cooldown(provider: str, seconds: float) -> None:
    path = cooldown_path(provider)
    until = max(load_provider_cooldown(provider), time.time() + max(0.0, seconds))
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps({"provider": provider, "until": until}), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def wait_for_provider(provider: str, deadline: float) -> None:
    remaining = load_provider_cooldown(provider) - time.time()
    if remaining <= 0:
        return
    if remaining > max_rate_limit_wait() or time.monotonic() + remaining >= deadline:
        raise ApiError(429, f"{provider} is cooling down for another {remaining:.0f}s; returning partial results")
    time.sleep(remaining)
