"""The real `Transport`: HTTPS with urllib."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

DEFAULT_TIMEOUT = 10.0


def urllib_transport(
    method: str, url: str, headers: dict[str, str], body: bytes, timeout: float = DEFAULT_TIMEOUT
) -> tuple[int, dict]:
    """Send one request. Error statuses are returned, not raised; network errors are raised."""
    request = urllib.request.Request(url, data=body or None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read()
    try:
        payload = json.loads(raw) if raw else {}
    except ValueError:
        payload = {}
    return status, payload if isinstance(payload, dict) else {}
