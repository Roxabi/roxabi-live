"""Tests for roxabi_live.corpus.sync — V2 sync helpers.

Covers canonical_key normalisation, upsert_edges dedup on repeat calls,
log_rate_limit stderr format, and closed_hop_pass stub insertion.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from roxabi_live.corpus.schema import bootstrap, connect
from roxabi_live.corpus.sync import (
    canonical_key,
    log_rate_limit,
    upsert_edges,
    upsert_issue,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_BASE_ISSUE: dict[str, Any] = {
    "key": "Roxabi/lyra#1",
    "repo": "Roxabi/lyra",
    "number": 1,
    "title": "x",
    "state": "open",
    "url": "https://github.com/Roxabi/lyra/issues/1",
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-01-01T00:00:00Z",
    "closed_at": None,
    "milestone": None,
    "is_stub": 0,
    "lane": None,
    "priority": None,
    "size": None,
    "status": None,
}


def _make_graphql_response(issue_node: dict[str, Any]) -> dict[str, Any]:
    """Wrap a single issue node in the full GraphQL response envelope."""
    return {
        "data": {
            "repository": {
                "issues": {
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": [issue_node],
                }
            },
            "rateLimit": {
                "cost": 1,
                "remaining": 4999,
                "resetAt": "2026-04-21T10:00:00Z",
            },
        }
    }


def _base_node(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Minimal GraphQL issue node with empty relationship fields."""
    node: dict[str, Any] = {
        "number": 1,
        "title": "Test issue",
        "state": "OPEN",
        "url": "https://github.com/Roxabi/lyra/issues/1",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
        "closedAt": None,
        "milestone": None,
        "labels": {"nodes": []},
        "subIssues": {"nodes": []},
        "parent": None,
        "blockedBy": {"nodes": []},
        "blocking": {"nodes": []},
        "projectItems": {"nodes": []},
    }
    if extra:
        node.update(extra)
    return node


# ---------------------------------------------------------------------------
# Existing tests (unchanged contract)
# ---------------------------------------------------------------------------


def test_edge_dedup(tmp_path: Path) -> None:
    """upsert_edges() called twice must not create duplicate rows."""
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)
    try:
        upsert_issue(conn, _BASE_ISSUE)
        upsert_edges(conn, "Roxabi/lyra#1", blocked_by=["Roxabi/lyra#2"], blocking=[])
        upsert_edges(conn, "Roxabi/lyra#1", blocked_by=["Roxabi/lyra#2"], blocking=[])
        count = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
        assert count == 1, f"Expected 1 edge row, got {count}"
        row = conn.execute("SELECT src_key, dst_key FROM edges").fetchone()
        assert row == ("Roxabi/lyra#2", "Roxabi/lyra#1")
    finally:
        conn.close()


def test_canonical_key() -> None:
    assert canonical_key(42, "Roxabi/lyra") == "Roxabi/lyra#42"
    assert canonical_key("Roxabi/voiceCLI#7", "Roxabi/lyra") == "Roxabi/voiceCLI#7"
    assert canonical_key("#9", "Roxabi/lyra") == "Roxabi/lyra#9"


def test_rate_limit_log(capsys: pytest.CaptureFixture[str]) -> None:
    rl = {"cost": 3, "remaining": 4997, "resetAt": "2026-04-21T10:00:00Z"}
    log_rate_limit(rl)
    captured = capsys.readouterr()
    assert re.search(
        r"\[corpus\] cost=3 remaining=4997 reset=2026-04-21T10:00:00Z",
        captured.err,
    )


def test_closed_hop_triggers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """closed_hop_pass must fetch stubs for referenced-but-missing blocker keys."""
    from roxabi_live.corpus.sync import closed_hop_pass  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)
    upsert_issue(
        conn,
        {
            **_BASE_ISSUE,
            "key": "Roxabi/lyra#100",
            "number": 100,
            "title": "needs closed ancestor",
            "url": "https://github.com/Roxabi/lyra/issues/100",
            "updated_at": "2026-01-02T00:00:00Z",
        },
    )
    upsert_edges(conn, "Roxabi/lyra#100", blocked_by=["Roxabi/lyra#42"], blocking=[])
    conn.commit()

    def fake_gh_graphql(query: str, variables: dict[str, Any]) -> dict[str, Any]:
        return {
            "data": {
                "repository": {
                    "issue": {
                        "number": 42,
                        "title": "ancient closed blocker",
                        "state": "CLOSED",
                        "url": "https://github.com/Roxabi/lyra/issues/42",
                        "createdAt": "2025-06-01T00:00:00Z",
                        "updatedAt": "2025-06-15T00:00:00Z",
                        "closedAt": "2025-06-15T00:00:00Z",
                    }
                },
                "rateLimit": {
                    "cost": 1,
                    "remaining": 4999,
                    "resetAt": "2026-04-21T10:00:00Z",
                },
            },
        }

    monkeypatch.setattr("roxabi_live.corpus.sync.gh_graphql", fake_gh_graphql)
    closed_hop_pass(conn)

    row = conn.execute(
        "SELECT key, state, is_stub, title FROM issues WHERE key = ?",
        ("Roxabi/lyra#42",),
    ).fetchone()
    conn.close()
    assert row is not None
    assert row[0] == "Roxabi/lyra#42"
    assert row[1] == "closed"
    assert row[2] == 1
    assert row[3] == "ancient closed blocker"


# ---------------------------------------------------------------------------
# New V2 tests — projectV2 field hydration
# ---------------------------------------------------------------------------


def test_upsert_issue_stores_projectv2_fields(tmp_path: Path) -> None:
    """upsert_issue writes lane/priority/size/status columns (AC-5)."""
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)
    try:
        issue = {
            **_BASE_ISSUE,
            "lane": "a1",
            "priority": "P1",
            "size": "M",
            "status": "In Progress",
        }
        upsert_issue(conn, issue)
        conn.commit()
        row = conn.execute(
            "SELECT lane, priority, size, status FROM issues WHERE key = ?",
            ("Roxabi/lyra#1",),
        ).fetchone()
        assert row == ("a1", "P1", "M", "In Progress"), f"Got {row}"
    finally:
        conn.close()


def test_run_repo_sync_hydrates_projectv2_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """run_repo_sync with a mocked gh_graphql writes project fields (AC-7)."""
    from roxabi_live.corpus.sync import run_repo_sync  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)

    project_node = _base_node(
        {
            "projectItems": {
                "nodes": [
                    {
                        "project": {"title": "lyra board"},
                        "fieldValues": {
                            "nodes": [
                                {
                                    "name": "a1",
                                    "field": {"name": "Lane"},
                                },
                                {
                                    "name": "P1",
                                    "field": {"name": "Priority"},
                                },
                                {
                                    "name": "M",
                                    "field": {"name": "Size"},
                                },
                                {
                                    "name": "In Progress",
                                    "field": {"name": "Status"},
                                },
                            ]
                        },
                    }
                ]
            }
        }
    )

    def fake_gh_graphql(q: str, v: dict[str, Any]) -> dict[str, Any]:
        return _make_graphql_response(project_node)

    monkeypatch.setattr("roxabi_live.corpus.sync.gh_graphql", fake_gh_graphql)

    run_repo_sync(conn, "Roxabi", "lyra")

    row = conn.execute(
        "SELECT lane, priority, size, status FROM issues LIMIT 1"
    ).fetchone()
    conn.close()
    assert row == ("a1", "P1", "M", "In Progress"), f"Got {row}"


def test_run_repo_sync_null_project_fields_on_no_enrollment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """projectItems nodes=[] -> all four columns NULL, no error (AC-8)."""
    from roxabi_live.corpus.sync import run_repo_sync  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)

    def fake_gh_graphql(q: str, v: dict[str, Any]) -> dict[str, Any]:
        return _make_graphql_response(_base_node())

    monkeypatch.setattr("roxabi_live.corpus.sync.gh_graphql", fake_gh_graphql)

    run_repo_sync(conn, "Roxabi", "lyra")

    row = conn.execute(
        "SELECT lane, priority, size, status FROM issues LIMIT 1"
    ).fetchone()
    conn.close()
    assert row == (None, None, None, None), f"Got {row}"


def test_parent_and_blocks_edges_coexist(tmp_path: Path) -> None:
    """Same (src, dst) pair must support both `parent` and `blocks` edges."""
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)
    try:
        upsert_edges(conn, "K", blocked_by=["A"], blocking=["Z"], kind="parent")
        upsert_edges(conn, "K", blocked_by=["A"], blocking=["Z"], kind="blocks")

        rows = set(
            conn.execute(
                "SELECT src_key, dst_key, kind FROM edges ORDER BY kind, src_key"
            ).fetchall()
        )
    finally:
        conn.close()

    assert rows == {
        ("A", "K", "parent"),
        ("K", "Z", "parent"),
        ("A", "K", "blocks"),
        ("K", "Z", "blocks"),
    }


@pytest.mark.parametrize(
    ("wipe_kind", "surviving_kind"),
    [("parent", "blocks"), ("blocks", "parent")],
)
def test_upsert_edges_delete_one_kind_preserves_other(
    tmp_path: Path, wipe_kind: str, surviving_kind: str
) -> None:
    """Clearing one kind for an issue must leave rows of the other kind intact."""
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)
    try:
        upsert_edges(conn, "K", blocked_by=["A"], blocking=["Z"], kind="parent")
        upsert_edges(conn, "K", blocked_by=["A"], blocking=["Z"], kind="blocks")

        # Wipe only `wipe_kind` edges touching K.
        upsert_edges(conn, "K", blocked_by=[], blocking=[], kind=wipe_kind)

        rows = set(conn.execute("SELECT src_key, dst_key, kind FROM edges").fetchall())
    finally:
        conn.close()

    assert rows == {
        ("A", "K", surviving_kind),
        ("K", "Z", surviving_kind),
    }
