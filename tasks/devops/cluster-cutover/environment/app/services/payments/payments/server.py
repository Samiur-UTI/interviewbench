"""HTTP front end. Run with `python -m payments.server`.

- `GET /healthz`, `GET /readyz`
- `POST /charges` with `{"order_id": "...", "amount": <minor units>, "currency": "eur"}`
- `POST /webhooks/stripe`: Stripe's webhook endpoint (forwarded by the storefront)
"""

from __future__ import annotations

import json
import logging
import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .config import ConfigError
from .service import PaymentsService, build_service
from .stripe_api import StripeError
from .transport import urllib_transport
from .webhooks import SignatureError

logger = logging.getLogger("payments.server")

MAX_BODY_BYTES = 1 << 20


def make_handler(service: PaymentsService) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "payments"
        sys_version = ""

        def do_GET(self) -> None:
            if self.path in ("/healthz", "/readyz"):
                self._reply(HTTPStatus.OK, {"status": "ok"})
            else:
                self._reply(HTTPStatus.NOT_FOUND, {"error": "not_found"})

        def do_POST(self) -> None:
            if self.path not in ("/charges", "/webhooks/stripe"):
                self._reply(HTTPStatus.NOT_FOUND, {"error": "not_found"})
                return
            body = self._read_body()
            if body is None:
                return
            if self.path == "/charges":
                self._charge(body)
            else:
                self._webhook(body)

        def _charge(self, body: bytes) -> None:
            try:
                request = json.loads(body)
                order_id = request["order_id"]
                amount = request["amount"]
                currency = request["currency"]
            except (ValueError, KeyError, TypeError):
                self._reply(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            try:
                intent = service.charge(order_id, amount, currency)
            except ValueError as exc:
                self._reply(HTTPStatus.BAD_REQUEST, {"error": "invalid_request", "message": str(exc)})
                return
            except StripeError as exc:
                logger.error("charge for order %s failed: %s", order_id, exc)
                self._reply(HTTPStatus.BAD_GATEWAY, {"error": "stripe_error", "code": exc.code})
                return
            self._reply(
                HTTPStatus.CREATED,
                {
                    "id": intent.get("id"),
                    "status": intent.get("status"),
                    "client_secret": intent.get("client_secret"),
                },
            )

        def _webhook(self, body: bytes) -> None:
            try:
                service.handle_webhook(body, self.headers.get("Stripe-Signature", ""))
            except SignatureError as exc:
                logger.warning("rejected webhook: %s", exc)
                self._reply(HTTPStatus.BAD_REQUEST, {"error": "invalid_signature"})
                return
            except ValueError:
                self._reply(HTTPStatus.BAD_REQUEST, {"error": "invalid_payload"})
                return
            self._reply(HTTPStatus.OK, {"received": True})

        def _read_body(self) -> bytes | None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if length < 0:
                self._reply(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return None
            if length > MAX_BODY_BYTES:
                self._reply(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "too_large"})
                return None
            return self.rfile.read(length)

        def _reply(self, status: HTTPStatus, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: object) -> None:
            logger.info("%s %s", self.address_string(), format % args)

    return Handler


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        service = build_service(os.environ, urllib_transport)
    except ConfigError as exc:
        logger.error("cannot start: %s", exc)
        return 2
    server = ThreadingHTTPServer(("", service.settings.port), make_handler(service))
    logger.info("listening on port %d", server.server_address[1])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
