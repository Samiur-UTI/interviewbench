import hashlib
import hmac

import pytest

from payments.webhooks import SignatureError, verify_signature

SECRET = "whsec_fake-unit-secret"
NOW = 1_760_000_000
PAYLOAD = b'{"id": "evt_fake_1", "type": "payment_intent.succeeded"}'


def sign(payload, secret=SECRET, timestamp=NOW):
    digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256)
    return digest.hexdigest()


def header(payload=PAYLOAD, secret=SECRET, timestamp=NOW):
    return f"t={timestamp},v1={sign(payload, secret, timestamp)}"


def test_valid_signature_passes():
    verify_signature(PAYLOAD, header(), SECRET, now=NOW)


def test_any_matching_v1_is_enough():
    value = f"t={NOW},v1={sign(PAYLOAD, 'whsec_fake-other')},v1={sign(PAYLOAD)},v0=ignored"
    verify_signature(PAYLOAD, value, SECRET, now=NOW)


def test_wrong_secret_is_rejected():
    with pytest.raises(SignatureError):
        verify_signature(PAYLOAD, header(secret="whsec_fake-other"), SECRET, now=NOW)


def test_changed_payload_is_rejected():
    with pytest.raises(SignatureError):
        verify_signature(PAYLOAD + b" ", header(), SECRET, now=NOW)


@pytest.mark.parametrize("skew", [-301, 301])
def test_timestamp_outside_tolerance_is_rejected(skew):
    with pytest.raises(SignatureError):
        verify_signature(PAYLOAD, header(), SECRET, now=NOW + skew)


@pytest.mark.parametrize("skew", [-300, 300])
def test_timestamp_at_the_tolerance_passes(skew):
    verify_signature(PAYLOAD, header(), SECRET, now=NOW + skew)


@pytest.mark.parametrize(
    "value",
    [
        "",
        "garbage",
        f"v1={sign(PAYLOAD)}",
        f"t={NOW}",
        f"t=soon,v1={sign(PAYLOAD)}",
        f"t={NOW},t={NOW},v1={sign(PAYLOAD)}",
        f"t={NOW},v1=",
        f"t={NOW},v1=not-hex-at-all",
    ],
)
def test_malformed_header_is_rejected(value):
    with pytest.raises(SignatureError):
        verify_signature(PAYLOAD, value, SECRET, now=NOW)
