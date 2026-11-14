"""Stage 2: the payments service reads STRIPE_CREDENTIALS_FILE, fails closed, and never shows
either value in a log record, a repr() or str(), or an exception message."""

import json
import os
import sys

sys.path.insert(0, os.environ["TESTS_DIR"])

import pytest  # noqa: E402

from sim import service_checks as service  # noqa: E402
from sim.payments_app import (KEY_A, WEBHOOK_A, Clock, FakeStripe, capture_logs,  # noqa: E402
                              credentials, signature_header, webhook_event)

pytest_plugins = ("sim.fixtures",)

OTHER_KEY = "sk_live_fake-E5-environment-interviewbench"
OTHER_WEBHOOK_SECRET = "whsec_fake-E5-environment-interviewbench"


def credentials_file(folder, content, name="stripe.json"):
    path = folder / name
    path.write_bytes(content)
    return path


def test_the_service_charges_and_verifies_with_the_values_in_the_credentials_file(payments, tmp_path):
    content = json.dumps({"secret_key": KEY_A, "webhook_secret": WEBHOOK_A, "rotated_by": "finance"})
    stripe, clock = FakeStripe(KEY_A), Clock()
    built = payments.build_service(service.environment(credentials_file(tmp_path, content.encode())),
                                   stripe, clock)
    built.charge("ord-1001", 2500, "eur")
    assert stripe.last_authorization == f"Bearer {KEY_A}", "the charge was not sent with secret_key"
    payload = webhook_event()
    built.handle_webhook(payload, signature_header(payload, WEBHOOK_A, clock()))


def test_load_settings_fails_closed_without_a_readable_credentials_file(payments, tmp_path):
    found = service.fail_closed_problems(payments, service.without_a_readable_file(tmp_path))
    assert not found, "\n".join(found)


def test_load_settings_fails_closed_when_the_file_is_not_a_json_object(payments, tmp_path):
    found = service.fail_closed_problems(payments, service.with_contents(tmp_path, service.NOT_AN_OBJECT))
    assert not found, "\n".join(found)


def test_load_settings_fails_closed_when_a_field_is_missing_not_a_string_or_empty(payments, tmp_path):
    setups = service.with_contents(tmp_path, service.bad_field_contents())
    found = service.fail_closed_problems(payments, setups)
    assert not found, "\n".join(found)


def test_the_stripe_values_in_the_environment_are_ignored(payments, tmp_path):
    env = service.environment(credentials_file(tmp_path, credentials(KEY_A, WEBHOOK_A)))
    env.update(STRIPE_SECRET_KEY=OTHER_KEY, STRIPE_WEBHOOK_SECRET=OTHER_WEBHOOK_SECRET)
    stripe = FakeStripe(KEY_A)
    try:
        payments.build_service(env, stripe, Clock()).charge("ord-1001", 2500, "eur")
    except payments.StripeError:
        pass
    assert stripe.last_authorization == f"Bearer {KEY_A}", (
        "with both the file and STRIPE_SECRET_KEY set, the charge was not sent with the file's key")
    only_environment = {"STRIPE_SECRET_KEY": OTHER_KEY, "STRIPE_WEBHOOK_SECRET": OTHER_WEBHOOK_SECRET}
    with pytest.raises(payments.ConfigError):
        payments.load_settings(only_environment)


def test_neither_value_appears_in_repr_or_str_of_the_settings_or_the_service(payments, tmp_path):
    env = service.environment(credentials_file(tmp_path, credentials(KEY_A, WEBHOOK_A)))
    settings = payments.load_settings(env)
    built = payments.build_service(env, FakeStripe(KEY_A), Clock())
    found = []
    for name, value in (("the settings", settings), ("the service", built)):
        found += service.leaks((repr(value), str(value)), f"repr() or str() of {name}")
    assert not found, "\n".join(found)


def test_neither_value_appears_in_any_log_record(payments, tmp_path):
    env = service.environment(credentials_file(tmp_path, credentials(KEY_A, WEBHOOK_A)))
    payload = webhook_event()
    with capture_logs() as logs:
        clock = Clock()
        built = payments.build_service(env, FakeStripe(KEY_A), clock)
        built.charge("ord-1001", 2500, "eur")
        built.handle_webhook(payload, signature_header(payload, WEBHOOK_A, clock()))
        rejecting = payments.build_service(env, FakeStripe(), clock)
        for call in (lambda: rejecting.charge("ord-1002", 990, "eur"),
                     lambda: built.handle_webhook(payload, signature_header(payload, OTHER_WEBHOOK_SECRET, clock())),
                     lambda: payments.load_settings(service.environment(credentials_file(
                         tmp_path, credentials(KEY_A, ""), "empty-webhook-secret.json")))):
            try:
                call()
            except Exception:
                pass
    found = service.leaks(logs.texts(), "a log record")
    assert not found, "\n".join(found)


def test_neither_value_appears_in_an_exception_message(payments, tmp_path):
    raised = []
    env = service.environment(credentials_file(tmp_path, credentials(KEY_A, WEBHOOK_A)))
    payload = webhook_event()
    attempts = [
        lambda: payments.build_service(env, FakeStripe(), Clock()).charge("ord-1002", 990, "eur"),
        lambda: payments.build_service(env, FakeStripe(KEY_A), Clock()).handle_webhook(
            payload, signature_header(payload, OTHER_WEBHOOK_SECRET, Clock()())),
    ]
    for index, content in enumerate((credentials(KEY_A, ""), credentials("", WEBHOOK_A),
                                     service.NOT_AN_OBJECT["a cut-off JSON object"],
                                     service.NOT_AN_OBJECT["text that is not JSON"])):
        bad = service.environment(credentials_file(tmp_path, content, f"bad-{index}.json"))
        attempts.append(lambda bad=bad: payments.load_settings(bad))
    for attempt in attempts:
        try:
            attempt()
        except Exception as exc:
            raised.append(exc)
    found = []
    for exc in raised:
        found += service.leaks((str(exc), repr(exc)), f"the message of a {type(exc).__name__}")
    assert not found, "\n".join(found)
