"""The payments service: what the HTTP layer calls."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Mapping

from .config import Settings, load_settings
from .stripe_api import StripeClient, Transport
from .webhooks import verify_signature

logger = logging.getLogger(__name__)

Clock = Callable[[], float]


class PaymentsService:
    def __init__(self, settings: Settings, client: StripeClient, clock: Clock) -> None:
        self.settings = settings
        self._client = client
        self._clock = clock

    def charge(self, order_id: str, amount_minor: int, currency: str) -> dict:
        """Create the PaymentIntent for an order and return Stripe's JSON for it."""
        if not isinstance(order_id, str) or not order_id:
            raise ValueError("order_id must be a non-empty string")
        if isinstance(amount_minor, bool) or not isinstance(amount_minor, int) or amount_minor <= 0:
            raise ValueError("amount_minor must be a positive integer")
        if not isinstance(currency, str) or len(currency) != 3 or not currency.isalpha():
            raise ValueError("currency must be a three-letter ISO code")
        intent = self._client.create_payment_intent(order_id, amount_minor, currency)
        logger.info("payment intent %s for order %s", intent.get("id"), order_id)
        return intent

    def handle_webhook(self, payload: bytes, signature_header: str) -> dict:
        """Verify a webhook from Stripe and return the event it carries."""
        verify_signature(
            payload, signature_header, self.settings.stripe_webhook_secret, now=self._clock()
        )
        try:
            event = json.loads(payload)
        except (UnicodeDecodeError, ValueError):
            raise ValueError("webhook payload is not JSON") from None
        if not isinstance(event, dict):
            raise ValueError("webhook payload is not a JSON object")
        logger.info("stripe event %s %s", event.get("id"), event.get("type"))
        return event


def build_service(
    environ: Mapping[str, str], transport: Transport, clock: Clock = time.time
) -> PaymentsService:
    settings = load_settings(environ)
    logger.info("payments configured: %s", settings)
    return PaymentsService(settings, StripeClient(settings, transport), clock)
