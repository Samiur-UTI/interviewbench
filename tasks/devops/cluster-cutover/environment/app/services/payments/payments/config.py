"""The service's settings, read from its environment."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_API_BASE = "https://api.stripe.com"
DEFAULT_PORT = 8080


class ConfigError(Exception):
    """The service cannot start with the configuration it was given."""


@dataclass(frozen=True)
class Settings:
    stripe_secret_key: str
    stripe_webhook_secret: str
    stripe_api_base: str = DEFAULT_API_BASE
    port: int = DEFAULT_PORT


def _required(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name)
    if not value:
        raise ConfigError(f"{name} is not set")
    return value


def _port(environ: Mapping[str, str]) -> int:
    raw = environ.get("PORT") or str(DEFAULT_PORT)
    try:
        port = int(raw)
    except ValueError:
        raise ConfigError(f"PORT must be a number, got {raw!r}") from None
    if not 0 <= port <= 65535:
        raise ConfigError(f"PORT must be between 0 and 65535, got {port}")
    return port


def load_settings(environ: Mapping[str, str]) -> Settings:
    """Build the settings from `environ` (normally `os.environ`).

    `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are required. `STRIPE_API_BASE` and `PORT`
    are optional.
    """
    api_base = (environ.get("STRIPE_API_BASE") or DEFAULT_API_BASE).rstrip("/")
    if not api_base.startswith(("https://", "http://")):
        raise ConfigError(f"STRIPE_API_BASE must be an http(s) URL, got {api_base!r}")
    return Settings(
        stripe_secret_key=_required(environ, "STRIPE_SECRET_KEY"),
        stripe_webhook_secret=_required(environ, "STRIPE_WEBHOOK_SECRET"),
        stripe_api_base=api_base,
        port=_port(environ),
    )
