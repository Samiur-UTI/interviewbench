"""The small part of Stripe's API we use."""

from __future__ import annotations

import logging
from collections.abc import Callable
from urllib.parse import urlencode

from .config import Settings

logger = logging.getLogger(__name__)

# (method, url, headers, body) -> (HTTP status, parsed JSON body)
Transport = Callable[[str, str, dict[str, str], bytes], tuple[int, dict]]


class StripeError(Exception):
    """Stripe answered with an error status."""

    def __init__(self, status: int, code: str | None, message: str) -> None:
        detail = f" ({code})" if code else ""
        super().__init__(f"Stripe returned {status}{detail}: {message}")
        self.status = status
        self.code = code


class StripeClient:
    def __init__(self, settings: Settings, transport: Transport) -> None:
        self._settings = settings
        self._transport = transport

    def create_payment_intent(self, order_id: str, amount_minor: int, currency: str) -> dict:
        """Create a PaymentIntent for an order. Retries with the same order reuse the intent."""
        url = f"{self._settings.stripe_api_base}/v1/payment_intents"
        headers = {
            "Authorization": f"Bearer {self._settings.stripe_secret_key}",
            "Idempotency-Key": f"order-{order_id}",
            "Content-Type": "application/x-www-form-urlencoded",
        }
        body = urlencode(
            {
                "amount": str(amount_minor),
                "currency": currency.lower(),
                "automatic_payment_methods[enabled]": "true",
                "metadata[order_id]": order_id,
            }
        ).encode("ascii")
        return self._send("POST", url, headers, body)

    def _send(self, method: str, url: str, headers: dict[str, str], body: bytes) -> dict:
        status, payload = self._transport(method, url, headers, body)
        if status >= 400:
            logger.warning("stripe request failed: %s %s %s", method, url, status)
            error = payload.get("error") if isinstance(payload, dict) else None
            if not isinstance(error, dict):
                error = {}
            code = error.get("code") if isinstance(error.get("code"), str) else None
            message = error.get("message") if isinstance(error.get("message"), str) else None
            raise StripeError(status, code, message or "no error message")
        return payload
