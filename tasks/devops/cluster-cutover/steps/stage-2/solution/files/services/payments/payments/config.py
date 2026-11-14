"""The service's settings: the Stripe credentials from the file Vault Agent renders, the rest from
the environment."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field

DEFAULT_API_BASE = "https://api.stripe.com"
DEFAULT_PORT = 8080
CREDENTIALS_FILE_VARIABLE = "STRIPE_CREDENTIALS_FILE"


class ConfigError(Exception):
    """The service cannot start with the configuration it was given.

    Messages name the setting or the file, never a value read from the credentials file.
    """


@dataclass(frozen=True)
class Settings:
    stripe_secret_key: str = field(repr=False)
    stripe_webhook_secret: str = field(repr=False)
    stripe_api_base: str = DEFAULT_API_BASE
    port: int = DEFAULT_PORT
    credentials_file: str = ""


@dataclass(frozen=True)
class Credentials:
    secret_key: str = field(repr=False)
    webhook_secret: str = field(repr=False)


def read_credentials(path: str) -> Credentials:
    """The Stripe credentials in `path`: a UTF-8 JSON object with the non-empty string fields
    `secret_key` and `webhook_secret` (other fields are ignored)."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc.strerror or type(exc).__name__}") from None
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ConfigError(f"{path} is not UTF-8 JSON") from None
    if not isinstance(document, dict):
        raise ConfigError(f"{path} does not hold a JSON object")
    values = {}
    for name in ("secret_key", "webhook_secret"):
        value = document.get(name)
        if not isinstance(value, str) or not value.strip():
            raise ConfigError(f"{path}: {name} is missing, empty or not a string")
        values[name] = value
    return Credentials(**values)


def _credentials_path(environ: Mapping[str, str]) -> str:
    path = environ.get(CREDENTIALS_FILE_VARIABLE)
    if not path:
        raise ConfigError(f"{CREDENTIALS_FILE_VARIABLE} is not set")
    if not os.path.isabs(path):
        raise ConfigError(f"{CREDENTIALS_FILE_VARIABLE} must be an absolute path, got {path!r}")
    return path


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

    `STRIPE_CREDENTIALS_FILE` is required: the absolute path of the credentials file (see
    `read_credentials`). `STRIPE_API_BASE` and `PORT` are optional. The Stripe values are never
    read from the environment.
    """
    api_base = (environ.get("STRIPE_API_BASE") or DEFAULT_API_BASE).rstrip("/")
    if not api_base.startswith(("https://", "http://")):
        raise ConfigError(f"STRIPE_API_BASE must be an http(s) URL, got {api_base!r}")
    port = _port(environ)
    path = _credentials_path(environ)
    credentials = read_credentials(path)
    return Settings(
        stripe_secret_key=credentials.secret_key,
        stripe_webhook_secret=credentials.webhook_secret,
        stripe_api_base=api_base,
        port=port,
        credentials_file=path,
    )
