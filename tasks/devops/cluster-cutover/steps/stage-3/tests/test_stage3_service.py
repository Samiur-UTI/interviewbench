"""Stage 3: once running, the payments service follows the credentials file, keeps the last
valid values while the file is missing or invalid, and still fails closed at start."""

import os
import sys

sys.path.insert(0, os.environ["TESTS_DIR"])

import pytest  # noqa: E402

from sim import service_checks as service  # noqa: E402
from sim.payments_app import (KEY_A, KEY_B, WEBHOOK_A, WEBHOOK_B, Clock, FakeStripe,  # noqa: E402
                              capture_logs, signature_header, webhook_event)

pytest_plugins = ("sim.fixtures",)

INVALID = {
    "text that is not JSON": service.NOT_AN_OBJECT["text that is not JSON"],
    "a JSON list": service.NOT_AN_OBJECT["a JSON list"],
    "an empty webhook_secret": service.bad_field_contents()["an empty webhook_secret"],
}


class Running:
    """A service built on a credentials file holding the A values, and a Stripe that takes A and B."""

    def __init__(self, payments, folder):
        self.payments = payments
        self.clock = Clock()
        self.file = service.CredentialsFile(folder, self.clock)
        self.file.write_pair(KEY_A, WEBHOOK_A)
        self.stripe = FakeStripe(KEY_A, KEY_B)
        self.service = payments.build_service(service.environment(self.file.path), self.stripe, self.clock)

    def charge_key(self):
        """The key the next charge is sent with."""
        try:
            self.service.charge("ord-3003", 1200, "eur")
        except self.payments.StripeError:
            pass
        return self.stripe.last_authorization

    def accepts_webhook(self, secret):
        payload = webhook_event()
        try:
            self.service.handle_webhook(payload, signature_header(payload, secret, self.clock()))
        except self.payments.SignatureError:
            return False
        return True


@pytest.fixture
def running(payments, tmp_path):
    return Running(payments, tmp_path)


def test_the_first_charge_after_the_file_is_replaced_uses_the_new_key(running):
    running.charge_key()
    running.file.write_pair(KEY_B, WEBHOOK_B)
    sent = running.charge_key()
    assert sent == f"Bearer {KEY_B}", "the first charge after the file was replaced used the old key"


def test_the_first_webhook_after_the_file_is_replaced_is_verified_with_the_new_secret(running):
    running.accepts_webhook(WEBHOOK_A)
    running.file.write_pair(KEY_B, WEBHOOK_B)
    assert running.accepts_webhook(WEBHOOK_B), (
        "the first webhook after the file was replaced, signed with the new secret, was rejected")


def test_a_missing_file_keeps_the_last_values_until_a_valid_one_returns(running):
    found = []
    running.file.remove()
    if running.charge_key() != f"Bearer {KEY_A}" or not running.accepts_webhook(WEBHOOK_A):
        found.append("with the file removed, the service stopped using the last valid values")
    running.file.write_pair(KEY_B, WEBHOOK_B)
    if running.charge_key() != f"Bearer {KEY_B}" or not running.accepts_webhook(WEBHOOK_B):
        found.append("when a valid file came back, the service did not use its values")
    assert not found, "\n".join(found)


def test_an_invalid_file_keeps_the_last_values_until_a_valid_one_returns(running):
    found = []
    for name, content in INVALID.items():
        running.file.write(content)
        if running.charge_key() != f"Bearer {KEY_A}" or not running.accepts_webhook(WEBHOOK_A):
            found.append(f"with {name} in the file, the service stopped using the last valid values")
    running.file.write_pair(KEY_B, WEBHOOK_B)
    if running.charge_key() != f"Bearer {KEY_B}" or not running.accepts_webhook(WEBHOOK_B):
        found.append("when a valid file came back, the service did not use its values")
    assert not found, "\n".join(found)


CHANGES = (
    lambda file: file.write_pair(KEY_B, WEBHOOK_B),
    lambda file: file.remove(),
    lambda file: file.write(INVALID["text that is not JSON"]),
    lambda file: file.write(service.NOT_AN_OBJECT["a cut-off JSON object"]),
    lambda file: file.write(INVALID["an empty webhook_secret"]),
    lambda file: file.write_pair(KEY_A, WEBHOOK_A),
)


def test_stripe_never_gets_an_empty_or_partial_key(running):
    for change in CHANGES:
        change(running.file)
        running.charge_key()
    sent = {request.authorization for request in running.stripe.requests}
    odd = sent - {f"Bearer {KEY_A}", f"Bearer {KEY_B}"}
    assert not odd, f"Stripe received Authorization {sorted(map(repr, odd))}"


def test_old_and_new_values_stay_out_of_logs_repr_and_exceptions(payments, tmp_path):
    found, raised = [], []
    payload = webhook_event()
    with capture_logs() as logs:
        running = Running(payments, tmp_path)
        running.stripe.valid_keys = {KEY_B}
        for change in CHANGES:
            change(running.file)
            found += service.leaks((repr(running.service), str(running.service)),
                                   "repr() or str() of the service")
            calls = (lambda: running.service.charge("ord-3004", 700, "eur"),
                     lambda: running.service.handle_webhook(payload, signature_header(
                         payload, "whsec_fake-Z9-interviewbench", running.clock())))
            for call in calls:
                try:
                    call()
                except Exception as exc:
                    raised.append(exc)
    for exc in raised:
        found += service.leaks((str(exc), repr(exc)), f"the message of a {type(exc).__name__}")
    found += service.leaks(logs.texts(), "a log record")
    assert not found, "\n".join(sorted(set(found)))


def test_build_service_still_fails_closed_at_start(payments, tmp_path):
    found = service.fail_closed_problems(payments, service.all_fail_closed_setups(tmp_path))
    assert not found, "\n".join(found)
