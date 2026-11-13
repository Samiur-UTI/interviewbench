import hashlib
import hmac
import json
from urllib.parse import parse_qs

import pytest

from payments.config import ConfigError
from payments.service import build_service
from payments.stripe_api import StripeError
from payments.webhooks import SignatureError

KEY = "sk_test_fake-unit-key"
WEBHOOK_SECRET = "whsec_fake-unit-secret"
NOW = 1_760_000_000.0
ENV = {"STRIPE_SECRET_KEY": KEY, "STRIPE_WEBHOOK_SECRET": WEBHOOK_SECRET}


class FakeStripe:
    """A Transport that records requests and answers with a canned response."""

    def __init__(self, status=200, payload=None):
        self.status = status
        self.payload = payload if payload is not None else {"id": "pi_fake_1", "status": "requires_payment_method"}
        self.requests = []

    def __call__(self, method, url, headers, body):
        self.requests.append({"method": method, "url": url, "headers": dict(headers), "body": body})
        return self.status, self.payload


def service_with(stripe, environ=ENV):
    return build_service(environ, stripe, clock=lambda: NOW)


def signed(event, secret=WEBHOOK_SECRET, timestamp=int(NOW)):
    payload = json.dumps(event).encode()
    digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256)
    return payload, f"t={timestamp},v1={digest.hexdigest()}"


def test_charge_creates_a_payment_intent():
    stripe = FakeStripe()
    result = service_with(stripe).charge("ord_123", 2599, "EUR")

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


def test_charge_uses_the_configured_api_base():
    stripe = FakeStripe()
    service_with(stripe, {**ENV, "STRIPE_API_BASE": "http://127.0.0.1:12111"}).charge("ord_1", 100, "eur")
    assert stripe.requests[0]["url"] == "http://127.0.0.1:12111/v1/payment_intents"


def test_stripe_error_is_raised_with_status_and_code():
    stripe = FakeStripe(402, {"error": {"code": "card_declined", "message": "Your card was declined."}})
    with pytest.raises(StripeError) as caught:
        service_with(stripe).charge("ord_123", 2599, "eur")
    assert caught.value.status == 402
    assert caught.value.code == "card_declined"


def test_stripe_error_without_a_body():
    with pytest.raises(StripeError) as caught:
        service_with(FakeStripe(503, {})).charge("ord_123", 2599, "eur")
    assert caught.value.status == 503
    assert caught.value.code is None


@pytest.mark.parametrize(
    "order_id, amount, currency",
    [("", 100, "eur"), ("ord_1", 0, "eur"), ("ord_1", -5, "eur"), ("ord_1", 1.5, "eur"),
     ("ord_1", True, "eur"), ("ord_1", 100, "euro")],
)
def test_bad_charge_is_rejected_before_stripe(order_id, amount, currency):
    stripe = FakeStripe()
    with pytest.raises(ValueError):
        service_with(stripe).charge(order_id, amount, currency)
    assert stripe.requests == []


def test_webhook_returns_the_event():
    event = {"id": "evt_fake_1", "type": "payment_intent.succeeded"}
    payload, header = signed(event)
    assert service_with(FakeStripe()).handle_webhook(payload, header) == event


def test_webhook_signed_with_another_secret_is_rejected():
    payload, header = signed({"id": "evt_fake_2"}, secret="whsec_fake-other")
    with pytest.raises(SignatureError):
        service_with(FakeStripe()).handle_webhook(payload, header)


def test_webhook_checks_the_service_clock():
    payload, header = signed({"id": "evt_fake_3"}, timestamp=int(NOW) - 3600)
    with pytest.raises(SignatureError):
        service_with(FakeStripe()).handle_webhook(payload, header)


def test_build_service_fails_without_configuration():
    with pytest.raises(ConfigError):
        build_service({}, FakeStripe())
