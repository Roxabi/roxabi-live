"""Tests for dev_state field on GET /api/graph — T16 [RED-GATE].

Covers:
- idle: no branch, no open PR
- dev: has_active_branch=1, no open PR
- pr_open: open PR closes the issue, no reviewed label
- pr_reviewed: open PR with reviewed label
- multi-PR precedence: any PR with reviewed → pr_reviewed wins
- closed PR (state=closed): does not trigger pr_open
- closed issue + active branch: dev_state forced to idle
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from roxabi_live.app import app

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS issues (
    key                 TEXT PRIMARY KEY,
    repo                TEXT NOT NULL,
    number              INTEGER NOT NULL,
    title               TEXT,
    state               TEXT NOT NULL,
    url                 TEXT,
    created_at          TEXT,
    updated_at          TEXT,
    closed_at           TEXT,
    milestone           TEXT,
    is_stub             INTEGER NOT NULL DEFAULT 0,
    lane                TEXT,
    priority            TEXT,
    size                TEXT,
    status              TEXT,
    has_active_branch   INTEGER NOT NULL DEFAULT 0
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
    PRIMARY KEY (src_key, dst_key, kind)
);

CREATE TABLE IF NOT EXISTS pr_state (
    repo                TEXT NOT NULL,
    number              INTEGER NOT NULL,
    state               TEXT NOT NULL,
    has_reviewed_label  INTEGER NOT NULL DEFAULT 0,
    closing_issue_keys  TEXT,
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (repo, number)
);

CREATE INDEX IF NOT EXISTS ix_pr_state_state ON pr_state(state);
"""

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _insert_issue(  # noqa: PLR0913
    conn: sqlite3.Connection,
    key: str,
    state: str = "open",
    has_active_branch: int = 0,
    repo: str = "Roxabi/lyra",
    number: int = 1,
) -> None:
    conn.execute(
        "INSERT INTO issues (key, repo, number, title, state, has_active_branch)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (key, repo, number, f"Issue {key}", state, has_active_branch),
    )


def _insert_pr(  # noqa: PLR0913
    conn: sqlite3.Connection,
    repo: str,
    number: int,
    state: str,
    has_reviewed_label: int,
    closing_issue_keys: list[str],
) -> None:
    conn.execute(
        "INSERT INTO pr_state"
        " (repo, number, state, has_reviewed_label, closing_issue_keys, updated_at)"
        " VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')",
        (
            repo,
            number,
            state,
            has_reviewed_label,
            json.dumps(closing_issue_keys),
        ),
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def graph_db(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Generator[sqlite3.Connection, None, None]:
    """Temp SQLite DB with full schema; CORPUS_DB_PATH is overridden."""
    db_path = tmp_path / "corpus_graph_test.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA_SQL)
    conn.commit()
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))
    yield conn
    conn.close()


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------


async def _get_graph() -> tuple[int, dict[str, Any]]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/graph")
    return resp.status_code, resp.json()


def _node_by_key(body: dict[str, Any], key: str) -> dict[str, Any]:
    for node in body["nodes"]:
        if node["key"] == key:
            return node
    raise KeyError(f"Node {key!r} not found in response")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_dev_state_idle_no_branch_no_pr(
    graph_db: sqlite3.Connection,
) -> None:
    """Issue with no branch and no PR → dev_state='idle'."""
    _insert_issue(graph_db, "Roxabi/lyra#1", state="open", has_active_branch=0)
    graph_db.commit()

    status, body = await _get_graph()

    assert status == 200
    node = _node_by_key(body, "Roxabi/lyra#1")
    assert node["dev_state"] == "idle"


async def test_dev_state_dev_branch_no_pr(
    graph_db: sqlite3.Connection,
) -> None:
    """Issue with has_active_branch=1, no open PR → dev_state='dev'."""
    _insert_issue(
        graph_db, "Roxabi/lyra#2", state="open", has_active_branch=1, number=2
    )
    graph_db.commit()

    status, body = await _get_graph()

    assert status == 200
    node = _node_by_key(body, "Roxabi/lyra#2")
    assert node["dev_state"] == "dev"


async def test_dev_state_pr_open_no_reviewed(
    graph_db: sqlite3.Connection,
) -> None:
    """Issue linked to open PR without reviewed label → dev_state='pr_open'."""
    _insert_issue(
        graph_db, "Roxabi/lyra#3", state="open", has_active_branch=0, number=3
    )
    _insert_pr(
        graph_db,
        repo="Roxabi/lyra",
        number=10,
        state="open",
        has_reviewed_label=0,
        closing_issue_keys=["Roxabi/lyra#3"],
    )
    graph_db.commit()

    status, body = await _get_graph()

    assert status == 200
    node = _node_by_key(body, "Roxabi/lyra#3")
    assert node["dev_state"] == "pr_open"


async def test_dev_state_pr_reviewed(
    graph_db: sqlite3.Connection,
) -> None:
    """Issue linked to open PR with reviewed label → dev_state='pr_reviewed'."""
    _insert_issue(
        graph_db, "Roxabi/lyra#4", state="open", has_active_branch=0, number=4
    )
    _insert_pr(
        graph_db,
        repo="Roxabi/lyra",
        number=11,
        state="open",
        has_reviewed_label=1,
        closing_issue_keys=["Roxabi/lyra#4"],
    )
    graph_db.commit()

    status, body = await _get_graph()

    assert status == 200
    node = _node_by_key(body, "Roxabi/lyra#4")
    assert node["dev_state"] == "pr_reviewed"


async def test_dev_state_multi_pr_reviewed_wins(
    graph_db: sqlite3.Connection,
) -> None:
    """2 open PRs, one with reviewed → pr_reviewed takes priority over pr_open."""
    _insert_issue(
        graph_db, "Roxabi/lyra#5", state="open", has_active_branch=0, number=5
    )
    # PR without reviewed label
    _insert_pr(
        graph_db,
        repo="Roxabi/lyra",
        number=20,
        state="open",
        has_reviewed_label=0,
        closing_issue_keys=["Roxabi/lyra#5"],
    )
    # PR with reviewed label
    _insert_pr(
        graph_db,
        repo="Roxabi/lyra",
        number=21,
        state="open",
        has_reviewed_label=1,
        closing_issue_keys=["Roxabi/lyra#5"],
    )
    graph_db.commit()

    status, body = await _get_graph()

    assert status == 200
    node = _node_by_key(body, "Roxabi/lyra#5")
    assert node["dev_state"] == "pr_reviewed"


async def test_dev_state_closed_pr_ignored(
    graph_db: sqlite3.Connection,
) -> None:
    """Closed PR does not contribute to dev_state; issue falls back to idle."""
    _insert_issue(
        graph_db, "Roxabi/lyra#6", state="open", has_active_branch=0, number=6
    )
    _insert_pr(
        graph_db,
        repo="Roxabi/lyra",
        number=30,
        state="closed",
        has_reviewed_label=0,
        closing_issue_keys=["Roxabi/lyra#6"],
    )
    graph_db.commit()

    status, body = await _get_graph()

    assert status == 200
    node = _node_by_key(body, "Roxabi/lyra#6")
    # Closed PR must not trigger pr_open
    assert node["dev_state"] == "idle"


async def test_dev_state_closed_issue_active_branch_idle(
    graph_db: sqlite3.Connection,
) -> None:
    """Closed issue with has_active_branch=1 → dev_state='idle' (closed overrides)."""
    _insert_issue(
        graph_db, "Roxabi/lyra#7", state="closed", has_active_branch=1, number=7
    )
    graph_db.commit()

    status, body = await _get_graph()

    assert status == 200
    node = _node_by_key(body, "Roxabi/lyra#7")
    assert node["dev_state"] == "idle"
