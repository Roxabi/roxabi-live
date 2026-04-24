"""Tests for 25 MB body cap on POST /webhook/github (T1 — RED phase, issue #56).

Covers:
  - test_post_body_over_cap_returns_413
  - test_post_body_at_cap_passes_through
  - test_post_body_one_byte_over_cap_returns_413
  - test_post_body_under_cap_unchanged
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from collections.abc import Generator
from pathlib import Path
from typing import Any

import aiosqlite
import pytest
from fastapi.testclient import TestClient

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS issues (
    key         TEXT PRIMARY KEY,
    repo        TEXT NOT NULL,
    number      INTEGER NOT NULL,
    title       TEXT,
    state       TEXT NOT NULL,
    url         TEXT,
    created_at  TEXT,
    updated_at  TEXT,
    closed_at   TEXT,
    milestone   TEXT,
    is_stub     INTEGER NOT NULL DEFAULT 0,
    lane        TEXT,
    priority    TEXT,
    size        TEXT,
    status      TEXT
);

CREATE TABLE IF NOT EXISTS labels (
    issue_key   TEXT NOT NULL,
    name        TEXT NOT NULL,
    PRIMARY KEY (issue_key, name),
    FOREIGN KEY (issue_key) REFERENCES issues(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS edges (
    src_key     TEXT NOT NULL,
    dst_key     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'parent',
    PRIMARY KEY (src_key, dst_key)
);

CREATE TABLE IF NOT EXISTS sync_state (
    repo            TEXT PRIMARY KEY,
    last_cursor     TEXT,
    last_synced_at  TEXT
);
"""

_SECRET = "cap-test-secret"
_CAP_BYTES = 25 * 1024 * 1024  # 25 MB


def _sign(body: bytes, secret: str = _SECRET) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def _issues_payload(
    action: str = "opened",
    number: int = 1,
    title: str = "Cap test issue",
    state: str = "open",
    repo: str = "Roxabi/lyra",
) -> dict[str, Any]:
    return {
        "action": action,
        "issue": {
            "number": number,
            "title": title,
            "state": state,
            "html_url": f"https://github.com/{repo}/issues/{number}",
            "labels": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-04-24T12:00:00Z",
            "closed_at": None,
            "milestone": None,
        },
        "repository": {
            "full_name": repo,
            "name": repo.split("/", 1)[-1],
            "owner": {"login": repo.split("/", 1)[0]},
        },
    }


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    """Create a real sqlite file with the corpus schema and return its path."""
    path = tmp_path / "corpus.db"

    async def _init() -> None:
        async with aiosqlite.connect(path) as conn:
            await conn.executescript(_SCHEMA_SQL)
            await conn.commit()

    asyncio.run(_init())
    return path


@pytest.fixture()
def client(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Generator[TestClient, None, None]:
    """TestClient with env vars pointing at the tmp db.

    Uses context-manager form so FastAPI lifespan runs (sets app.state.settings,
    app.state.trigger_heal, app.state.background_tasks).
    """
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))

    from roxabi_live.app import app

    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_post_body_over_cap_returns_413(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """POST body of 26 MB (1 MB over cap) → 413 Request Entity Too Large."""
    # Arrange
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))

    from roxabi_live.app import app

    # raise_server_exceptions=False so oversized bodies return a response
    # rather than re-raising internal errors (before the cap middleware exists,
    # the server will 500; after implementation it should 413).
    with TestClient(app, raise_server_exceptions=False) as client:
        body = b"A" * (26 * 1024 * 1024)
        sig = _sign(body)

        # Act
        resp = client.post(
            "/webhook/github",
            content=body,
            headers={
                "X-GitHub-Event": "issues",
                "Content-Type": "application/json",
                "X-Hub-Signature-256": sig,
            },
        )

    # Assert
    assert resp.status_code == 413


def test_post_body_at_cap_passes_through(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """POST body of exactly 25 MB (at cap) → not 413 (size gate allows through)."""
    # Arrange
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))

    from roxabi_live.app import app

    with TestClient(app, raise_server_exceptions=False) as client:
        body = b"A" * _CAP_BYTES
        sig = _sign(body)

        # Act
        resp = client.post(
            "/webhook/github",
            content=body,
            headers={
                "X-GitHub-Event": "issues",
                "Content-Type": "application/json",
                "X-Hub-Signature-256": sig,
            },
        )

    # Assert — size gate must not reject exactly-at-cap bodies
    assert resp.status_code != 413, "25 MB body should pass the size gate"
    assert resp.status_code != 500, (
        "25 MB raw-bytes body should map to a 4xx (invalid JSON), not 500"
    )


def test_post_body_one_byte_over_cap_returns_413(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """POST body of 25 MB + 1 byte → 413 (boundary: one byte over the cap)."""
    # Arrange
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))

    from roxabi_live.app import app

    with TestClient(app, raise_server_exceptions=False) as client:
        body = b"A" * (_CAP_BYTES + 1)
        sig = _sign(body)

        # Act
        resp = client.post(
            "/webhook/github",
            content=body,
            headers={
                "X-GitHub-Event": "issues",
                "Content-Type": "application/json",
                "X-Hub-Signature-256": sig,
            },
        )

    # Assert
    assert resp.status_code == 413


def test_post_body_under_cap_unchanged(client: TestClient) -> None:
    """Small valid payload with correct HMAC → normal 200 behaviour preserved."""
    # Arrange
    payload = _issues_payload(action="opened", number=99)
    body = json.dumps(payload).encode()
    sig = _sign(body)

    # Act
    resp = client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-GitHub-Event": "issues",
            "Content-Type": "application/json",
            "X-Hub-Signature-256": sig,
        },
    )

    # Assert — normal dispatch path unaffected by the cap
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_post_malformed_json_returns_400(client: TestClient, db_path: Path) -> None:
    body = b"not json"
    sig = "sha256=" + hmac.new(_SECRET.encode(), body, hashlib.sha256).hexdigest()
    resp = client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-Hub-Signature-256": sig,
            "X-GitHub-Event": "issues",
            "Content-Type": "application/json",
        },
    )
    assert resp.status_code == 400
    assert "invalid JSON" in resp.json()["detail"]


def test_post_body_over_cap_bad_sig_returns_413(client: TestClient) -> None:
    """413 fires before HMAC — even with a wrong signature."""
    body = b"A" * (26 * 1024 * 1024)
    resp = client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-Hub-Signature-256": "sha256=deadbeef",
            "X-GitHub-Event": "issues",
            "Content-Type": "application/json",
        },
    )
    assert resp.status_code == 413
