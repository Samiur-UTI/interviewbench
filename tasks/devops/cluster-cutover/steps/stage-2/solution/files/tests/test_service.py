import hashlib
import hmac
import json
import logging
from urllib.parse import parse_qs

import pytest

from payments.config import ConfigError
from payments.service import build_service
from payments.stripe_api import StripeError
from payments.webhooks import SignatureError

KEY = "sk_test_fake-unit-key"
WEBHOOK_SECRET = "whsec_fake-unit-secret"
NOW = 1_760_000_000.0


@pytest.fixture
def environ(tmp_path):
    path = tmp_path / "stripe.json"
    path.write_text(json.dumps({"secret_key": KEY, "webhook_secret": WEBHOOK_SECRET}), encoding="utf-8")
    return {"STRIPE_CREDENTIALS_FILE": str(path)}


class FakeStripe:
    """A Transport that records requests and answers with a canned response."""

    def __init__(self, status=200, payload=None):
        self.status = status
        self.payload = payload if payload is not None else {"id": "pi_fake_1", "status": "requires_payment_method"}
        self.requests = []

    def __call__(self, method, url, headers, body):
        self.requests.append({"method": method, "url": url, "headers": dict(headers), "body": body})
        return self.status, self.payload


def service_with(stripe, environ):
    return build_service(environ, stripe, clock=lambda: NOW)


def signed(event, secret=WEBHOOK_SECRET, timestamp=int(NOW)):
    payload = json.dumps(event).encode()
    digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256)
    return payload, f"t={timestamp},v1={digest.hexdigest()}"


def test_charge_creates_a_payment_intent(environ):
    stripe = FakeStripe()
    result = service_with(stripe, environ).charge("ord_123", 2599, "EUR")

    assert result == stripe.payload
    [request] = stripe.requests
    assert request["method"] == "POST"
    assert request["url"] == "https://api.stripe.com/v1/payment_intents"
    assert request["headers"]["Authorization"] == f"Bearer {KEY}"
    assert request["headers"]["Idempotency-Key"] == "order-ord_123"
    assert request["headers"]["Content-Type"] == "application/x-www-form-urlencoded"
    form = parse_qs(request["body"].decode())
    assert form["amount"] == ["2599"]
    assert form["currency"] == ["eur"]
    assert form["metadata[order_id]"] == ["ord_123"]


def test_charge_uses_the_configured_api_base(environ):
    stripe = FakeStripe()
    service_with(stripe, {**environ, "STRIPE_API_BASE": "http://127.0.0.1:12111"}).charge("ord_1", 100, "eur")
    assert stripe.requests[0]["url"] == "http://127.0.0.1:12111/v1/payment_intents"


def test_stripe_error_is_raised_with_status_and_code(environ):
    stripe = FakeStripe(402, {"error": {"code": "card_declined", "message": "Your card was declined."}})
    with pytest.raises(StripeError) as caught:
        service_with(stripe, environ).charge("ord_123", 2599, "eur")
    assert caught.value.status == 402
    assert caught.value.code == "card_declined"


def test_stripe_error_without_a_body(environ):
    with pytest.raises(StripeError) as caught:
        service_with(FakeStripe(503, {}), environ).charge("ord_123", 2599, "eur")
    assert caught.value.status == 503
    assert caught.value.code is None


@pytest.mark.parametrize(
    "order_id, amount, currency",
    [("", 100, "eur"), ("ord_1", 0, "eur"), ("ord_1", -5, "eur"), ("ord_1", 1.5, "eur"),
     ("ord_1", True, "eur"), ("ord_1", 100, "euro")],
)
def test_bad_charge_is_rejected_before_stripe(environ, order_id, amount, currency):
    stripe = FakeStripe()
    with pytest.raises(ValueError):
        service_with(stripe, environ).charge(order_id, amount, currency)
    assert stripe.requests == []


def test_webhook_returns_the_event(environ):
    event = {"id": "evt_fake_1", "type": "payment_intent.succeeded"}
    payload, header = signed(event)
    assert service_with(FakeStripe(), environ).handle_webhook(payload, header) == event


def test_webhook_signed_with_another_secret_is_rejected(environ):
    payload, header = signed({"id": "evt_fake_2"}, secret="whsec_fake-other")
    with pytest.raises(SignatureError):
        service_with(FakeStripe(), environ).handle_webhook(payload, header)


def test_webhook_checks_the_service_clock(environ):
    payload, header = signed({"id": "evt_fake_3"}, timestamp=int(NOW) - 3600)
    with pytest.raises(SignatureError):
        service_with(FakeStripe(), environ).handle_webhook(payload, header)


def test_build_service_fails_without_configuration():
    with pytest.raises(ConfigError):
        build_service({}, FakeStripe())


def test_build_service_fails_without_a_credentials_file(tmp_path):
    with pytest.raises(ConfigError):
        build_service({"STRIPE_CREDENTIALS_FILE": str(tmp_path / "missing.json"),
                       "STRIPE_SECRET_KEY": KEY, "STRIPE_WEBHOOK_SECRET": WEBHOOK_SECRET}, FakeStripe())


def test_neither_value_is_logged_shown_or_raised(environ, caplog):
    raised = []
    caplog.set_level(logging.DEBUG)
    service = service_with(FakeStripe(401, {"error": {"code": "api_key_expired", "message": "Expired API Key provided."}}),
                           environ)
    payload, header = signed({"id": "evt_fake_4"}, secret="whsec_fake-other")
    for call in (lambda: service.charge("ord_9", 100, "eur"), lambda: service.handle_webhook(payload, header)):
        with pytest.raises((StripeError, SignatureError)) as caught:
            call()
        raised.append(caught.value)
    texts = [record.getMessage() for record in caplog.records]
    texts += [repr(service), str(service), repr(service.settings), str(service.settings)]
    texts += [text for exc in raised for text in (str(exc), repr(exc))]
    assert caplog.records, "nothing was logged, so this test checks nothing"
    leaked = [text for text in texts if KEY in text or WEBHOOK_SECRET in text]
    assert not leaked, leaked
