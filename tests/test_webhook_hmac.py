"""Failing tests for roxabi_live.webhook.hmac_auth.verify.

RED state: src/roxabi_live/webhook/hmac_auth.py does not exist yet.
All tests will fail with ImportError until the implementation lands.

verify(body: bytes, header: str | None, secret: str) -> bool
- header format: sha256=<hex>  (GitHub X-Hub-Signature-256)
- Uses hmac.compare_digest internally (constant-time compare)
- Returns False on missing header, malformed format, or signature mismatch
"""

from __future__ import annotations

import hashlib
import hmac

import pytest

from roxabi_live.webhook.hmac_auth import verify


def _make_sig(body: bytes, secret: str) -> str:
    """Compute the expected sha256 HMAC signature for a body and secret."""
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


class TestVerify:
    def test_valid_signature_returns_true(self) -> None:
        # Arrange
        secret = "my-secret"
        body = b'{"action": "opened"}'
        header = _make_sig(body, secret)

        # Act
        result = verify(body, header, secret)

        # Assert
        assert result is True

    def test_invalid_signature_returns_false(self) -> None:
        # Arrange
        secret = "my-secret"
        body = b'{"action": "opened"}'
        valid_sig = _make_sig(body, secret)
        # Flip the last hex character to produce a bad signature
        flipped = valid_sig[:-1] + ("0" if valid_sig[-1] != "0" else "1")
        header = flipped

        # Act
        result = verify(body, header, secret)

        # Assert
        assert result is False

    def test_missing_header_returns_false(self) -> None:
        # Arrange
        secret = "my-secret"
        body = b'{"action": "opened"}'

        # Act
        result = verify(body, None, secret)

        # Assert
        assert result is False

    def test_empty_header_returns_false(self) -> None:
        # Arrange
        secret = "my-secret"
        body = b'{"action": "opened"}'

        # Act
        result = verify(body, "", secret)

        # Assert
        assert result is False

    def test_malformed_header_no_prefix_returns_false(self) -> None:
        # Arrange — raw hex with no "sha256=" prefix
        secret = "my-secret"
        body = b'{"action": "opened"}'
        header = "abc123"

        # Act
        result = verify(body, header, secret)

        # Assert
        assert result is False

    def test_malformed_header_wrong_algorithm_returns_false(self) -> None:
        # Arrange — valid-looking HMAC but wrong algorithm prefix
        secret = "my-secret"
        body = b'{"action": "opened"}'
        header = "md5=abc123"

        # Act
        result = verify(body, header, secret)

        # Assert
        assert result is False

    def test_different_body_returns_false(self) -> None:
        # Arrange — signature computed for body_a, but body_b is passed
        secret = "my-secret"
        body_a = b'{"action": "opened"}'
        body_b = b'{"action": "closed"}'
        header = _make_sig(body_a, secret)

        # Act
        result = verify(body_b, header, secret)

        # Assert
        assert result is False

    def test_uses_constant_time_compare(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Arrange
        secret = "my-secret"
        body = b'{"action": "opened"}'
        header = _make_sig(body, secret)

        called_with: list[tuple[str, str]] = []

        original = hmac.compare_digest

        def spy(a: str, b: str) -> bool:  # type: ignore[override]
            called_with.append((a, b))
            return original(a, b)

        monkeypatch.setattr(hmac, "compare_digest", spy)

        # Act
        verify(body, header, secret)

        # Assert
        assert len(called_with) == 1, (
            "hmac.compare_digest must be called exactly once per verify() invocation"
        )
