"""Verifying Stripe's webhook signatures.

Stripe sends `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]`. Each `v1` is
HMAC-SHA256 of `"<t>." + payload` keyed with the endpoint's signing secret. One matching `v1` is
enough; other schemes (`v0`) are ignored.
"""

from __future__ import annotations

import hashlib
import hmac

DEFAULT_TOLERANCE = 300


class SignatureError(Exception):
    """The webhook's signature is missing, malformed, too old or wrong."""


def _parse(header: str) -> tuple[int, list[str]]:
    timestamp: int | None = None
    signatures: list[str] = []
    for item in header.split(","):
        key, sep, value = item.strip().partition("=")
        if not sep or not value:
            raise SignatureError("malformed signature header")
        if key == "t":
            if timestamp is not None or not (value.isascii() and value.isdigit()):
                raise SignatureError("malformed signature timestamp")
            timestamp = int(value)
        elif key == "v1":
            signatures.append(value)
    if timestamp is None:
        raise SignatureError("signature header has no timestamp")
    if not signatures:
        raise SignatureError("signature header has no v1 signature")
    return timestamp, signatures


def verify_signature(
    payload: bytes, header: str, secret: str, now: float, tolerance: int = DEFAULT_TOLERANCE
) -> None:
    """Raise `SignatureError` unless `header` is a valid, recent signature of `payload`."""
    if not isinstance(header, str) or not header:
        raise SignatureError("missing signature header")
    timestamp, signatures = _parse(header)
    if abs(now - timestamp) > tolerance:
        raise SignatureError("signature timestamp outside the tolerance")
    signed = f"{timestamp}.".encode() + payload
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest().encode()
    if not any(hmac.compare_digest(expected, candidate.encode()) for candidate in signatures):
        raise SignatureError("no signature matches")
