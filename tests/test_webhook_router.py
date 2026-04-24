"""Tests for POST /webhook/github router (T19, T20).

Covers:
  - test_post_rejects_missing_signature_401
  - test_post_rejects_invalid_signature_401
  - test_post_valid_signature_issues_event
  - test_post_ping_event_acks
  - test_post_unknown_event_acks
  - test_stale_sync_triggers_reconcile
  - test_fresh_sync_does_not_trigger_reconcile
  - test_missing_sync_state_triggers_reconcile
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from collections.abc import Generator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

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

_SECRET = "test-secret"


def _sign(body: bytes, secret: str = _SECRET) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def _issues_payload(
    action: str = "opened",
    number: int = 42,
    title: str = "Router test issue",
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
    """Create a real sqlite file with the corpus schema and return its path.

    Uses synchronous sqlite3 — pure DDL needs no async; avoids `asyncio.run`
    in a sync fixture under pytest-asyncio strict/auto mode.
    """
    import sqlite3

    path = tmp_path / "corpus.db"
    conn = sqlite3.connect(path)
    try:
        conn.executescript(_SCHEMA_SQL)
        conn.commit()
    finally:
        conn.close()
    return path


@pytest.fixture()
def client(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Generator[TestClient, None, None]:
    """TestClient with env vars pointing at the tmp db.

    Uses context manager form so that the FastAPI lifespan runs (which sets
    app.state.settings, app.state.trigger_heal, etc.).
    """
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))

    # Import app AFTER env vars are set
    from roxabi_live.app import app

    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_post_rejects_missing_signature_401(client: TestClient) -> None:
    """No X-Hub-Signature-256 header → 401."""
    body = json.dumps(_issues_payload()).encode()
    resp = client.post(
        "/webhook/github",
        content=body,
        headers={"X-GitHub-Event": "issues", "Content-Type": "application/json"},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "invalid signature"


def test_post_rejects_invalid_signature_401(client: TestClient) -> None:
    """Wrong X-Hub-Signature-256 value → 401."""
    body = json.dumps(_issues_payload()).encode()
    resp = client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-GitHub-Event": "issues",
            "Content-Type": "application/json",
            "X-Hub-Signature-256": "sha256=deadbeef",
        },
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "invalid signature"


def test_post_valid_signature_issues_event(client: TestClient, db_path: Path) -> None:
    """Valid sig + X-GitHub-Event: issues → 200, issue row inserted in db."""
    payload = _issues_payload(action="opened", number=42)
    body = json.dumps(payload).encode()
    sig = _sign(body)

    resp = client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-GitHub-Event": "issues",
            "Content-Type": "application/json",
            "X-Hub-Signature-256": sig,
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    # Verify the row was actually written
    async def _check() -> bool:
        async with aiosqlite.connect(db_path) as conn:
            cur = await conn.execute(
                "SELECT key FROM issues WHERE key = ?", ("Roxabi/lyra#42",)
            )
            row = await cur.fetchone()
            return row is not None

    import asyncio

    assert asyncio.run(_check()), (
        "Expected issue row Roxabi/lyra#42 to be present in db"
    )


def test_post_ping_event_acks(client: TestClient) -> None:
    """X-GitHub-Event: ping → 200 with ignored field."""
    body = json.dumps({"zen": "Keep it logically awesome."}).encode()
    sig = _sign(body)

    resp = client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-GitHub-Event": "ping",
            "Content-Type": "application/json",
            "X-Hub-Signature-256": sig,
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "ignored": "ping"}


def test_post_unknown_event_acks(client: TestClient) -> None:
    """X-GitHub-Event: star (unknown) → 200 with ignored field."""
    body = json.dumps({"action": "created"}).encode()
    sig = _sign(body)

    resp = client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-GitHub-Event": "star",
            "Content-Type": "application/json",
            "X-Hub-Signature-256": sig,
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "ignored": "star"}


# ---------------------------------------------------------------------------
# Stale-sync heal trigger tests (T20)
# ---------------------------------------------------------------------------


def _seed_sync_state(db_path: Path, repo: str, last_synced_at: str) -> None:
    """Synchronously insert a sync_state row into the test DB."""
    import sqlite3

    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (repo, last_synced_at) VALUES (?, ?)",
        (repo, last_synced_at),
    )
    conn.commit()
    conn.close()


def test_stale_sync_triggers_reconcile(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 2h-old sync_state triggers the heal scheduler."""
    two_hours_ago = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    _seed_sync_state(db_path, "Roxabi/lyra", two_hours_ago)

    mock_run_once = AsyncMock(return_value=None)
    # The trigger_heal factory calls roxabi_live.reconciler.run_once.
    # Patch before TestClient enters lifespan; lifespan startup call = call 1,
    # webhook-triggered heal = call 2 (total >= 2).
    monkeypatch.setattr("roxabi_live.reconciler.run_once", mock_run_once)
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))

    from roxabi_live.app import app

    payload = _issues_payload(repo="Roxabi/lyra")
    body = json.dumps(payload).encode()
    sig = _sign(body)

    with TestClient(app) as client:
        call_count_after_startup = mock_run_once.call_count  # startup call
        resp = client.post(
            "/webhook/github",
            content=body,
            headers={
                "X-GitHub-Event": "issues",
                "Content-Type": "application/json",
                "X-Hub-Signature-256": sig,
            },
        )
        assert resp.status_code == 200
        # Drain the event loop so the fire-and-forget task executes
        asyncio.run(asyncio.sleep(0))

    # One additional call triggered by the stale webhook heal
    assert mock_run_once.call_count > call_count_after_startup, (
        "Expected trigger_heal to schedule an additional run_once call"
    )


def test_fresh_sync_does_not_trigger_reconcile(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fresh sync_state (5min ago) skips the heal scheduling."""
    five_min_ago = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    _seed_sync_state(db_path, "Roxabi/lyra", five_min_ago)

    mock_run_once = AsyncMock(return_value=None)
    monkeypatch.setattr("roxabi_live.reconciler.run_once", mock_run_once)
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))

    from roxabi_live.app import app

    payload = _issues_payload(repo="Roxabi/lyra")
    body = json.dumps(payload).encode()
    sig = _sign(body)

    with TestClient(app) as client:
        call_count_after_startup = mock_run_once.call_count
        resp = client.post(
            "/webhook/github",
            content=body,
            headers={
                "X-GitHub-Event": "issues",
                "Content-Type": "application/json",
                "X-Hub-Signature-256": sig,
            },
        )
        assert resp.status_code == 200
        asyncio.run(asyncio.sleep(0))

    # No additional calls — sync is fresh
    assert mock_run_once.call_count == call_count_after_startup, (
        "Expected trigger_heal NOT to schedule run_once for a fresh sync"
    )


def test_missing_sync_state_triggers_reconcile(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No row in sync_state for the repo → trigger_heal schedules run_once."""
    mock_run_once = AsyncMock(return_value=None)
    monkeypatch.setattr("roxabi_live.reconciler.run_once", mock_run_once)
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))

    from roxabi_live.app import app

    payload = _issues_payload(repo="Roxabi/lyra")
    body = json.dumps(payload).encode()
    sig = _sign(body)

    with TestClient(app) as client:
        call_count_after_startup = mock_run_once.call_count
        resp = client.post(
            "/webhook/github",
            content=body,
            headers={
                "X-GitHub-Event": "issues",
                "Content-Type": "application/json",
                "X-Hub-Signature-256": sig,
            },
        )
        assert resp.status_code == 200
        asyncio.run(asyncio.sleep(0))

    assert mock_run_once.call_count > call_count_after_startup, (
        "Expected trigger_heal to schedule run_once when sync_state is missing"
    )


# ---------------------------------------------------------------------------
# T8 [RED] — Decoupling, body fix, transactional handlers
# ---------------------------------------------------------------------------


def test_router_does_not_import_reconciler() -> None:
    """SC4: webhook/router.py must not have a runtime import of roxabi_live.reconciler.

    TYPE_CHECKING-only imports (inside `if TYPE_CHECKING:` block) are allowed
    since they are never executed at runtime — they satisfy the decoupling
    requirement (no runtime dependency on the reconciler module).
    """
    router_src = (
        __import__("pathlib").Path(__file__).parent.parent
        / "src"
        / "roxabi_live"
        / "webhook"
        / "router.py"
    ).read_text()

    # Collect lines with reconciler imports, skipping those inside TYPE_CHECKING blocks
    in_type_checking = False
    runtime_import_lines: list[str] = []
    for line in router_src.splitlines():
        stripped = line.strip()
        if "TYPE_CHECKING" in stripped and stripped.startswith("if"):
            in_type_checking = True
        # Dedent back to top-level ends the TYPE_CHECKING block
        if (
            in_type_checking
            and stripped
            and not stripped.startswith("#")
            and not line.startswith(" ")
            and not line.startswith("\t")
            and "TYPE_CHECKING" not in stripped
        ):
            in_type_checking = False
        if "import" in line and "reconciler" in line and not in_type_checking:
            runtime_import_lines.append(line)

    assert runtime_import_lines == [], (
        f"router.py has runtime reconciler imports: {runtime_import_lines}"
    )


def test_json_loads_body_no_request_json(client: TestClient) -> None:
    """SC10: body parsed via json.loads, not await request.json() after request.body().

    Verifies that a valid webhook with body read once succeeds without 422/500.
    """
    payload = _issues_payload(action="opened", number=99)
    body = json.dumps(payload).encode()
    sig = _sign(body)

    resp = client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-GitHub-Event": "issues",
            "Content-Type": "application/json",
            "X-Hub-Signature-256": sig,
        },
    )
    # If body was double-read, the second parse would fail → 500 or empty payload
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
