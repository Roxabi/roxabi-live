"""HMAC signature verification for GitHub webhooks (X-Hub-Signature-256)."""

from __future__ import annotations

import hashlib
import hmac

PREFIX = "sha256="


def verify(body: bytes, header: str | None, secret: str) -> bool:
    """Return True iff header is a valid sha256 HMAC signature of body using secret.

    Args:
        body: Raw request body bytes.
        header: Value of the X-Hub-Signature-256 header (e.g. ``sha256=<hex>``).
        secret: Webhook secret used to compute the expected signature.

    Returns:
        True if the signature matches, False otherwise.
    """
    if not header or not header.startswith(PREFIX):
        return False
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    received = header[len(PREFIX) :]
    return hmac.compare_digest(expected, received)
