"""A running service follows its credentials file: Vault Agent renames a new file over the old one
when the secret changes in Vault. Missing or invalid files keep the last valid values."""

import hashlib
import hmac
import json
import logging
import os

import pytest

from payments.config import ConfigError
from payments.service import build_service
from payments.webhooks import SignatureError

OLD = ("sk_test_fake-old-key", "whsec_fake-old-secret")
NEW = ("sk_test_fake-new-key", "whsec_fake-new-secret")
NOW = 1_760_000_000.0


class Stripe:
    def __init__(self):
        self.authorizations = []

    def __call__(self, method, url, headers, body):
        self.authorizations.append(headers["Authorization"])
        return 200, {"id": "pi_fake_1"}


class CredentialsFile:
    """Written the way Vault Agent writes it: a temporary file renamed over the old one."""

    def __init__(self, folder):
        self.path = folder / "stripe.json"
        self.writes = 0

    def write(self, content):
        self.writes += 1
        temp = self.path.with_name(f".stripe.json.{self.writes}")
        temp.write_bytes(content if isinstance(content, bytes) else json.dumps(content).encode())
        os.replace(temp, self.path)
        stamp = int(NOW * 1e9) + self.writes * 1_000_000  # distinct mtimes, as on a real clock
        os.utime(self.path, ns=(stamp, stamp))

    def write_pair(self, pair):
        self.write({"secret_key": pair[0], "webhook_secret": pair[1]})


@pytest.fixture
def running(tmp_path):
    file = CredentialsFile(tmp_path)
    file.write_pair(OLD)
    stripe = Stripe()
    service = build_service({"STRIPE_CREDENTIALS_FILE": str(file.path)}, stripe, clock=lambda: NOW)
    return file, stripe, service


def key_used(service, stripe):
    service.charge("ord_1", 100, "eur")
    return stripe.authorizations[-1].removeprefix("Bearer ")


def accepts(service, secret):
    payload = b'{"id": "evt_fake_1"}'
    digest = hmac.new(secret.encode(), f"{int(NOW)}.".encode() + payload, hashlib.sha256).hexdigest()
    try:
        service.handle_webhook(payload, f"t={int(NOW)},v1={digest}")
    except SignatureError:
        return False
    return True


def test_the_first_calls_after_a_replace_use_the_new_values(running):
    file, stripe, service = running
    assert key_used(service, stripe) == OLD[0]
    file.write_pair(NEW)
    assert key_used(service, stripe) == NEW[0]
    assert accepts(service, NEW[1]) and not accepts(service, OLD[1])


def test_a_missing_file_keeps_the_last_values_until_a_valid_one_returns(running):
    file, stripe, service = running
    file.path.unlink()
    assert key_used(service, stripe) == OLD[0] and accepts(service, OLD[1])
    file.write_pair(NEW)
    assert key_used(service, stripe) == NEW[0] and accepts(service, NEW[1])


@pytest.mark.parametrize("content", [
    b"", b"not json", b'{"secret_key": "sk_test_fa', b"[]",
    {"secret_key": "", "webhook_secret": NEW[1]}, {"secret_key": NEW[0]},
], ids=["empty", "not-json", "cut-off", "list", "empty-key", "no-webhook-secret"])
def test_an_invalid_file_keeps_the_last_values_until_a_valid_one_returns(running, content):
    file, stripe, service = running
    file.write(content)
    assert key_used(service, stripe) == OLD[0] and accepts(service, OLD[1])
    file.write_pair(NEW)
    assert key_used(service, stripe) == NEW[0] and accepts(service, NEW[1])


def test_neither_old_nor_new_values_are_logged_or_shown(running, caplog):
    file, stripe, service = running
    caplog.set_level(logging.DEBUG)
    for change in (lambda: file.write_pair(NEW), lambda: file.write(b"{"), lambda: file.path.unlink(),
                   lambda: file.write_pair(OLD)):
        change()
        key_used(service, stripe)
    texts = [r.getMessage() for r in caplog.records] + [repr(service), str(service), repr(service.settings)]
    assert caplog.records
    assert not [t for t in texts for value in OLD + NEW if value in t]


def test_the_service_still_fails_closed_at_start(tmp_path):
    file = CredentialsFile(tmp_path)
    file.write({"secret_key": OLD[0]})
    with pytest.raises(ConfigError):
        build_service({"STRIPE_CREDENTIALS_FILE": str(file.path)}, Stripe())
