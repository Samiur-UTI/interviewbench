"""Driving the payments service on its own with real temporary files (stage 2 and 3 briefs,
"The service").

The credentials file contract: STRIPE_CREDENTIALS_FILE is the absolute path of a UTF-8 JSON file
holding an object with the string fields secret_key and webhook_secret. load_settings (and so
build_service) raises ConfigError when the variable is unset or empty, the file is missing or
unreadable, its content is not a JSON object, or either field is missing, not a string, or empty.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .payments_app import (CREDENTIALS_ENV, KEY_A, KEY_B, WEBHOOK_A, WEBHOOK_B, Clock, FakeStripe,
                           Payments, credentials, replace_file)

SECRET_NAMES = {KEY_A: "the secret key", WEBHOOK_A: "the webhook signing secret",
                KEY_B: "the rolled secret key", WEBHOOK_B: "the rolled webhook signing secret"}

NOT_AN_OBJECT: dict[str, bytes] = {
    "text that is not JSON": f"secret_key={KEY_A}\nwebhook_secret={WEBHOOK_A}\n".encode(),
    "bytes that are not UTF-8": b"\xff\xfe{\x00}\x00",
    "a cut-off JSON object": f'{{"secret_key": "{KEY_A}", "webhook_secret": "whsec_fa'.encode(),
    "an empty file": b"",
    "a JSON list": json.dumps([KEY_A, WEBHOOK_A]).encode(),
    "a JSON string": json.dumps(KEY_A).encode(),
    "JSON null": b"null",
    "a JSON number": b"42",
}

BAD_FIELDS: dict[str, dict[str, Any]] = {
    "no secret_key": {"webhook_secret": WEBHOOK_A},
    "no webhook_secret": {"secret_key": KEY_A},
    "a numeric secret_key": {"secret_key": 4242, "webhook_secret": WEBHOOK_A},
    "a list as secret_key": {"secret_key": [KEY_A], "webhook_secret": WEBHOOK_A},
    "a null webhook_secret": {"secret_key": KEY_A, "webhook_secret": None},
    "an empty secret_key": {"secret_key": "", "webhook_secret": WEBHOOK_A},
    "an empty webhook_secret": {"secret_key": KEY_A, "webhook_secret": ""},
}


def environment(path: Path | str) -> dict[str, str]:
    """The payments container's environment with the credentials file at `path`."""
    return {CREDENTIALS_ENV: str(path), "STRIPE_API_BASE": "https://api.stripe.com", "PORT": "8080"}


def without_a_readable_file(folder: Path) -> dict[str, dict[str, str]]:
    """Environments where there is no file to read: unset, empty, missing, a folder."""
    unreadable = folder / "a-folder.json"
    unreadable.mkdir(exist_ok=True)
    return {
        "STRIPE_CREDENTIALS_FILE unset": {"STRIPE_API_BASE": "https://api.stripe.com"},
        "STRIPE_CREDENTIALS_FILE empty": environment(""),
        "no file at the path": environment(folder / "missing.json"),
        "a folder at the path (unreadable as a file)": environment(unreadable),
    }


def with_contents(folder: Path, contents: dict[str, bytes]) -> dict[str, dict[str, str]]:
    """One environment per content, each with its own file."""
    setups = {}
    for index, (name, content) in enumerate(contents.items()):
        path = folder / f"credentials-{index}.json"
        path.write_bytes(content)
        setups[f"a file with {name}"] = environment(path)
    return setups


def bad_field_contents() -> dict[str, bytes]:
    return {name: json.dumps(fields).encode() for name, fields in BAD_FIELDS.items()}


def fail_closed_problems(payments: Payments, setups: dict[str, dict[str, str]]) -> list[str]:
    """Every setup where load_settings or build_service does not raise ConfigError."""
    found = []
    for name, env in setups.items():
        calls = (("load_settings", lambda env=env: payments.load_settings(env)),
                 ("build_service", lambda env=env: payments.build_service(env, FakeStripe(KEY_A), Clock())))
        for call, run in calls:
            try:
                run()
            except payments.ConfigError:
                continue
            except Exception as exc:
                found.append(f"with {name}, {call} raised {type(exc).__name__} instead of ConfigError")
            else:
                found.append(f"with {name}, {call} succeeded")
    return found


def all_fail_closed_setups(folder: Path) -> dict[str, dict[str, str]]:
    return {**without_a_readable_file(folder), **with_contents(folder, NOT_AN_OBJECT),
            **with_contents(folder, bad_field_contents())}


def leaks(texts: Iterable[str], where: str) -> list[str]:
    """Each fixture secret that appears in one of `texts`."""
    return [f"{label} appears in {where}" for text in texts
            for value, label in SECRET_NAMES.items() if value in text]


class CredentialsFile:
    """The file Vault Agent maintains, written the way it writes it (temp file and rename)."""

    def __init__(self, folder: Path, clock: Clock) -> None:
        self.path = folder / "stripe.json"
        self.clock = clock
        self._writes = 0

    def write(self, content: bytes) -> None:
        self._writes += 1
        self.clock.advance(1)
        replace_file(self.path, content, self.clock, self._writes)

    def write_pair(self, secret_key: str, webhook_secret: str) -> None:
        self.write(credentials(secret_key, webhook_secret))

    def remove(self) -> None:
        self.clock.advance(1)
        self.path.unlink()
