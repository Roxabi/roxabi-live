"""Tests for GET /api/issues and GET /api/issues/{key} endpoints.

RED — routes not yet implemented.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from roxabi_live.app import app

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
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
    status      TEXT,
    has_active_branch INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS labels (
    issue_key   TEXT NOT NULL,
    name        TEXT NOT NULL,
    PRIMARY KEY (issue_key, name),
    FOREIGN KEY (issue_key) REFERENCES issues(key) ON DELETE CASCADE
);
"""

_SEED_ISSUES = [
    # (key, repo, number, title, state, updated_at)
    ("repo-a#1", "repo-a", 1, "Issue A1 open", "open", "2024-01-01T00:00:00Z"),
    ("repo-a#2", "repo-a", 2, "Issue A2 closed", "closed", "2024-01-02T00:00:00Z"),
    ("repo-b#1", "repo-b", 1, "Issue B1 open", "open", "2024-01-03T00:00:00Z"),
]

_SEED_LABELS = [
    # (issue_key, label_name)
    ("repo-a#1", "bug"),
    ("repo-a#1", "urgent"),
    ("repo-a#2", "enhancement"),
    # repo-b#1 has no labels
]


@pytest.fixture()
def corpus_db(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Generator[Path, None, None]:
    """Temporary SQLite DB seeded with fixture data; CORPUS_DB_PATH is overridden."""
    db_path = tmp_path / "corpus_test.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_SQL)
    conn.executemany(
        "INSERT INTO issues"
        " (key, repo, number, title, state, updated_at) VALUES (?,?,?,?,?,?)",
        _SEED_ISSUES,
    )
    conn.executemany(
        "INSERT INTO labels (issue_key, name) VALUES (?,?)",
        _SEED_LABELS,
    )
    conn.commit()
    conn.close()

    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))
    yield db_path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get(path: str) -> tuple[int, dict[str, Any]]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get(path)
    return resp.status_code, resp.json()


# ---------------------------------------------------------------------------
# Tests — all must return 404 until the route is implemented
# ---------------------------------------------------------------------------


async def test_list_returns_all_issues(corpus_db: Path) -> None:
    """No filters → total equals seeded count, items carry expected keys."""
    # Arrange — DB seeded by fixture (3 issues)
    # Act
    status, body = await _get("/api/issues")
    # Assert
    assert status == 200, f"Expected 200, got {status}"
    assert body["total"] == 3
    assert len(body["issues"]) == 3
    expected_keys = {
        "key",
        "repo",
        "number",
        "title",
        "state",
        "labels",
        "updated_at",
        "url",
        "milestone",
        "is_stub",
        "created_at",
        "closed_at",
    }
    for item in body["issues"]:
        assert expected_keys <= item.keys(), f"Missing keys in item: {item.keys()}"


async def test_list_filter_by_repo(corpus_db: Path) -> None:
    """?repo=repo-a returns only the 2 issues that belong to repo-a."""
    # Arrange — 2 issues in repo-a, 1 in repo-b
    # Act
    status, body = await _get("/api/issues?repo=repo-a")
    # Assert
    assert status == 200
    assert body["total"] == 2
    assert all(item["repo"] == "repo-a" for item in body["issues"])


async def test_list_filter_by_state(corpus_db: Path) -> None:
    """?state=open returns only open issues (2 out of 3)."""
    # Arrange — 2 open issues (repo-a#1, repo-b#1), 1 closed (repo-a#2)
    # Act
    status, body = await _get("/api/issues?state=open")
    # Assert
    assert status == 200
    assert body["total"] == 2
    assert all(item["state"] == "open" for item in body["issues"])


async def test_list_filter_by_label(corpus_db: Path) -> None:
    """?label=bug returns only issues tagged with 'bug' (repo-a#1)."""
    # Arrange — only repo-a#1 has label 'bug'
    # Act
    status, body = await _get("/api/issues?label=bug")
    # Assert
    assert status == 200
    assert body["total"] == 1
    assert body["issues"][0]["key"] == "repo-a#1"
    assert "bug" in body["issues"][0]["labels"]


async def test_list_combined_filters(corpus_db: Path) -> None:
    """?repo=repo-a&state=open narrows to the single open issue in repo-a."""
    # Arrange — repo-a has 2 issues: 1 open, 1 closed
    # Act
    status, body = await _get("/api/issues?repo=repo-a&state=open")
    # Assert
    assert status == 200
    assert body["total"] == 1
    assert body["issues"][0]["key"] == "repo-a#1"
    assert body["issues"][0]["state"] == "open"
    assert body["issues"][0]["repo"] == "repo-a"


# ---------------------------------------------------------------------------
# Fixtures — GET /api/issues/{key} (T9)
# Uses a dedicated fixture so T7's corpus_db stays minimal (no edges table).
# ---------------------------------------------------------------------------

_EDGES_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS edges (
    src_key     TEXT NOT NULL,
    dst_key     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'parent',
    PRIMARY KEY (src_key, dst_key)
);
"""


@pytest.fixture()
def issues_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """DB seeded with 2 issues and 1 blocks edge; CORPUS_DB_PATH is overridden.

    owner/repo1#1 (blocker)  --blocks-->  owner/repo1#2 (blockee)
    """
    p = tmp_path / "issues_corpus.db"
    conn = sqlite3.connect(p)
    conn.executescript(SCHEMA_SQL)
    conn.executescript(_EDGES_SCHEMA_SQL)
    conn.executescript(
        """
        INSERT INTO issues
          (key, repo, number, title, state, url,
           created_at, updated_at, closed_at, is_stub)
        VALUES
          ('owner/repo1#1', 'owner/repo1', 1, 'Blocker issue', 'open',
           'https://github.com/owner/repo1/issues/1',
           '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', NULL, 0),
          ('owner/repo1#2', 'owner/repo1', 2, 'Blocked issue', 'open',
           'https://github.com/owner/repo1/issues/2',
           '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z', NULL, 0);

        INSERT INTO labels (issue_key, name) VALUES
          ('owner/repo1#1', 'feat'),
          ('owner/repo1#2', 'bug');

        -- src_key blocks dst_key
        INSERT INTO edges (src_key, dst_key, kind)
        VALUES ('owner/repo1#1', 'owner/repo1#2', 'blocks');
        """
    )
    conn.commit()
    conn.close()

    monkeypatch.setenv("CORPUS_DB_PATH", str(p))
    return p


# ---------------------------------------------------------------------------
# Tests — GET /api/issues/{key}  (all must 404 until route is implemented)
# ---------------------------------------------------------------------------


async def test_get_returns_issue_with_edges(issues_db: Path) -> None:
    """Seed 2 issues + 1 blocks edge; GET each and verify blocking/blocked_by arrays."""
    # Arrange — DB seeded by issues_db fixture
    # Act
    status_blocker, body_blocker = await _get("/api/issues/owner%2Frepo1%231")
    status_blockee, body_blockee = await _get("/api/issues/owner%2Frepo1%232")

    # Assert — blocker (owner/repo1#1 blocks owner/repo1#2)
    assert status_blocker == 200
    assert body_blocker["key"] == "owner/repo1#1"
    assert body_blocker["repo"] == "owner/repo1"
    assert body_blocker["number"] == 1
    assert body_blocker["title"] == "Blocker issue"
    assert "feat" in body_blocker["labels"]
    assert body_blocker["blocking"] == [
        {"key": "owner/repo1#2", "number": 2, "repo": "owner/repo1"}
    ]
    assert body_blocker["blocked_by"] == []

    # Assert — blockee (owner/repo1#2 is blocked by owner/repo1#1)
    assert status_blockee == 200
    assert body_blockee["key"] == "owner/repo1#2"
    assert body_blockee["blocking"] == []
    assert body_blockee["blocked_by"] == [
        {"key": "owner/repo1#1", "number": 1, "repo": "owner/repo1"}
    ]


async def test_get_unknown_key_returns_404(issues_db: Path) -> None:
    """GET /api/issues/{key} with an unknown key must return 404."""
    # Arrange — no issue with number 999
    # Act
    status, body = await _get("/api/issues/owner%2Frepo1%23999")
    # Assert
    assert status == 404
    assert body == {"detail": "Issue not found"}


async def test_get_url_encoded_hash(issues_db: Path) -> None:
    """Key ``owner/repo1#42`` is accessed via URL ``/api/issues/owner%2Frepo1%2342``.

    %23 is the percent-encoding for '#', %2F for '/'.  The route must decode
    them before looking up the issue in the DB.
    """
    # Arrange — insert an extra issue specifically for this key
    conn = sqlite3.connect(issues_db)
    conn.execute(
        "INSERT INTO issues (key, repo, number, title, state, url, is_stub) "
        "VALUES ('owner/repo1#42', 'owner/repo1', 42, 'URL-encoded hash test', 'open', "
        "'https://github.com/owner/repo1/issues/42', 0)"
    )
    conn.commit()
    conn.close()

    # Act
    status, body = await _get("/api/issues/owner%2Frepo1%2342")

    # Assert
    assert status == 200
    assert body["key"] == "owner/repo1#42"
    assert body["number"] == 42


# ---------------------------------------------------------------------------
# Tests — T4 [RED]: strict key validation on GET /api/issues/{key:path}
# Production regex: ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+$
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_key",
    [
        "foo",
        "not-a-key",
        "owner/repo",
        "no-slash#42",
        "a/b#notanumber",
    ],
)
async def test_get_issue_invalid_key_returns_400(issues_db: Path, bad_key: str) -> None:
    """Malformed key (not matching <owner>/<repo>#<number>) must return 400.

    The route must reject the request before touching the DB.
    """
    # Arrange — bad_key does not match ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+$
    encoded = bad_key.replace("#", "%23").replace("/", "%2F")
    # Act
    status, body = await _get(f"/api/issues/{encoded}")
    # Assert
    assert status == 400, f"Expected 400 for key {bad_key!r}, got {status}"
    assert "detail" in body
    detail = body["detail"].lower()
    # Detail must hint at the expected shape
    assert "<owner>" in detail or "owner" in detail or "#" in detail, (
        f"Detail does not mention expected shape: {body['detail']!r}"
    )


async def test_get_issue_traversal_returns_400(issues_db: Path) -> None:
    """Path-traversal attempt must be rejected with 400, never 404 or 500."""
    # Arrange — percent-encoded traversal sequence
    traversal_path = "..%2F..%2Fetc%2Fpasswd"
    # Act
    status, body = await _get(f"/api/issues/{traversal_path}")
    # Assert
    assert status == 400, f"Expected 400 for traversal path, got {status}"
    assert "detail" in body


async def test_get_issue_valid_present_returns_200(issues_db: Path) -> None:
    """A valid-shaped key that exists in the DB must return 200.

    Uses owner/repo#N format (Roxabi/roxabi-live style) seeded explicitly.
    """
    # Arrange — insert a fully-qualified owner/repo#N issue
    conn = sqlite3.connect(issues_db)
    conn.execute(
        "INSERT INTO issues (key, repo, number, title, state, url, is_stub) "
        "VALUES ('Roxabi/roxabi-live#1', 'Roxabi/roxabi-live', 1, "
        "'Valid key test', 'open', 'https://github.com/Roxabi/roxabi-live/issues/1', 0)"
    )
    conn.commit()
    conn.close()

    encoded_key = "Roxabi%2Froxabi-live%231"
    # Act
    status, body = await _get(f"/api/issues/{encoded_key}")
    # Assert
    assert status == 200, f"Expected 200 for valid present key, got {status}"
    assert body["key"] == "Roxabi/roxabi-live#1"
    assert body["number"] == 1


async def test_get_issue_valid_absent_returns_404(issues_db: Path) -> None:
    """A valid-shaped key that is absent from the DB must return 404, not 400/500."""
    # Arrange — key has correct shape but is not seeded
    encoded_key = "Roxabi%2Froxabi-live%2399999"
    # Act
    status, body = await _get(f"/api/issues/{encoded_key}")
    # Assert
    assert status == 404, f"Expected 404 for valid-shaped absent key, got {status}"
    assert body == {"detail": "Issue not found"}
