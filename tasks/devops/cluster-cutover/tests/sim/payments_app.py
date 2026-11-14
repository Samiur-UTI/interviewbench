"""The candidate's payments package and the fakes it is driven with (SPEC sections 2.7 and 4).

The package is imported from $APP_DIR/services/payments, appended to the END of sys.path so
nothing in the candidate's repository can shadow the standard library, yaml, pytest or sim.
"""

from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import logging
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

EPOCH = 1_780_000_000
KEY_A = "sk_live_fake-A1-interviewbench"
WEBHOOK_A = "whsec_fake-A1-interviewbench"
KEY_B = "sk_live_fake-B2-interviewbench"
WEBHOOK_B = "whsec_fake-B2-interviewbench"
CREDENTIALS_ENV = "STRIPE_CREDENTIALS_FILE"
PUBLIC_NAMES = (("config", "load_settings"), ("config", "ConfigError"), ("service", "build_service"),
                ("webhooks", "SignatureError"), ("stripe_api", "StripeError"))


class PaymentsImportError(Exception):
    pass


@dataclass(frozen=True)
class Payments:
    """The modules the hidden tests use."""

    config: ModuleType
    service: ModuleType
    webhooks: ModuleType
    stripe_api: ModuleType

    @property
    def ConfigError(self) -> type[BaseException]:  # noqa: N802 (the package's own name)
        return self.config.ConfigError

    @property
    def SignatureError(self) -> type[BaseException]:  # noqa: N802
        return self.webhooks.SignatureError

    @property
    def StripeError(self) -> type[BaseException]:  # noqa: N802
        return self.stripe_api.StripeError

    def load_settings(self, environ: dict[str, str]) -> Any:
        return self.config.load_settings(environ)

    def build_service(self, environ: dict[str, str], transport: Any, clock: Any) -> Any:
        return self.service.build_service(environ, transport, clock)


def import_payments(app: Path) -> Payments:
    """A fresh import of the payments package from services/payments."""
    package_root = (app / "services" / "payments").resolve()
    for name in [n for n in sys.modules if n == "payments" or n.startswith("payments.")]:
        del sys.modules[name]
    entry = str(package_root)
    if entry in sys.path:
        sys.path.remove(entry)
    sys.path.append(entry)
    importlib.invalidate_caches()
    try:
        modules = {name: importlib.import_module(f"payments.{name}")
                   for name in ("config", "service", "webhooks", "stripe_api")}
    except (Exception, SystemExit) as exc:
        raise PaymentsImportError(f"importing payments from services/payments failed: "
                                  f"{type(exc).__name__}: {exc}") from None
    origin = Path(getattr(sys.modules["payments"], "__file__", "") or "").resolve()
    if package_root not in origin.parents:
        raise PaymentsImportError(f"the payments package was found at {origin}, "
                                  "not under services/payments")
    missing = [f"payments.{m}.{n}" for m, n in PUBLIC_NAMES if not hasattr(modules[m], n)]
    if missing:
        raise PaymentsImportError(f"services/payments has no {', '.join(missing)}")
    return Payments(**modules)


@dataclass(frozen=True)
class SentRequest:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes

    @property
    def authorization(self) -> str | None:
        return next((v for k, v in self.headers.items() if k.lower() == "authorization"), None)


class FakeStripe:
    """A Transport that answers like Stripe: 200 for a key it accepts, 401 otherwise."""

    def __init__(self, *valid_keys: str) -> None:
        self.valid_keys = set(valid_keys)
        self.requests: list[SentRequest] = []

    def __call__(self, method: str, url: str, headers: Any, body: Any) -> tuple[int, dict]:
        headers = {str(k): str(v) for k, v in dict(headers or {}).items()}
        raw = body if isinstance(body, bytes) else str(body or "").encode()
        request = SentRequest(str(method), str(url), headers, raw)
        self.requests.append(request)
        if request.authorization in {f"Bearer {key}" for key in self.valid_keys}:
            return 200, {"id": "pi_fake_0001", "object": "payment_intent",
                         "status": "requires_confirmation"}
        return 401, {"error": {"type": "invalid_request_error", "code": "api_key_expired",
                               "message": "Expired API Key provided."}}

    @property
    def last_authorization(self) -> str | None:
        return self.requests[-1].authorization if self.requests else None


class Clock:
    """Simulated wall-clock time: EPOCH plus the seconds advanced so far."""

    def __init__(self) -> None:
        self.elapsed = 0.0

    def __call__(self) -> float:
        return EPOCH + self.elapsed

    def advance(self, seconds: float) -> None:
        self.elapsed += seconds

    def stamp_ns(self, sequence: int) -> int:
        """An mtime for the sequence-th write: this clock's time plus `sequence` milliseconds."""
        return EPOCH * 1_000_000_000 + round(self.elapsed * 1e9) + sequence * 1_000_000


def replace_file(target: Path, content: bytes, clock: Clock, sequence: int) -> None:
    """Write like Vault Agent: a temp file in the same folder renamed over the target, with an
    mtime from the clock so that two writes never share one."""
    temp = target.with_name(f".{target.name}.{sequence}.tmp")
    with open(temp, "wb") as handle:
        handle.write(content)
    os.replace(temp, target)
    stamp = clock.stamp_ns(sequence)
    os.utime(target, ns=(stamp, stamp))


def credentials(secret_key: str, webhook_secret: str) -> bytes:
    return json.dumps({"secret_key": secret_key, "webhook_secret": webhook_secret}).encode()


def webhook_event() -> bytes:
    return json.dumps({"id": "evt_fake_0001", "object": "event", "type": "payment_intent.succeeded",
                       "data": {"object": {"id": "pi_fake_0001"}}}).encode()


def signature_header(payload: bytes, secret: str, timestamp: float) -> str:
    """Stripe-Signature: t=<ts>,v1=HMAC-SHA256(secret, "<ts>." + payload)."""
    stamp = int(timestamp)
    digest = hmac.new(secret.encode(), f"{stamp}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={stamp},v1={digest}"


@dataclass
class LogCapture:
    """Every log record any logger creates, at any level, while active."""

    records: list[logging.LogRecord]

    def texts(self) -> Iterator[str]:
        formatter = logging.Formatter()
        for record in self.records:
            try:
                yield record.getMessage()
            except Exception:  # a broken format string still leaks its arguments
                yield f"{record.msg!r} {record.args!r}"
            if record.exc_info:
                yield formatter.formatException(record.exc_info)
            if record.stack_info:
                yield str(record.stack_info)


@contextmanager
def capture_logs() -> Iterator[LogCapture]:
    """Record every LogRecord at DEBUG and above from every logger (propagating or not)."""
    capture = LogCapture([])
    manager = logging.Logger.manager
    loggers = [logging.root] + [lg for lg in manager.loggerDict.values() if isinstance(lg, logging.Logger)]
    saved = [(lg, lg.level, lg.disabled) for lg in loggers]
    saved_disable = manager.disable
    original_handle = logging.Logger.handle

    def handle(self: logging.Logger, record: logging.LogRecord) -> None:
        capture.records.append(record)
        original_handle(self, record)

    logging.disable(logging.NOTSET)
    for logger in loggers:
        logger.setLevel(logging.DEBUG)
        logger.disabled = False
    logging.Logger.handle = handle  # type: ignore[method-assign]
    try:
        yield capture
    finally:
        logging.Logger.handle = original_handle  # type: ignore[method-assign]
        for logger, level, disabled in saved:
            logger.setLevel(level)
            logger.disabled = disabled
        logging.disable(saved_disable)
