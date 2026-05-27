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
    extract_from_labels,
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
    }
    if extra:
        node.update(extra)
    return node


# ---------------------------------------------------------------------------
# extract_from_labels — derive lane/priority/size from label vocab (#54)
# ---------------------------------------------------------------------------


def testextract_from_labels_canonical_size() -> None:
    assert extract_from_labels(["size:S"]) == {
        "lane": None,
        "priority": None,
        "size": "S",
    }
    assert extract_from_labels(["size:F-lite"])["size"] == "F-lite"
    assert extract_from_labels(["size:F-full"])["size"] == "F-full"


def testextract_from_labels_canonical_priority() -> None:
    assert extract_from_labels(["priority:P0"])["priority"] == "P0"
    assert extract_from_labels(["priority:P1"])["priority"] == "P1"
    assert extract_from_labels(["priority:P2"])["priority"] == "P2"
    assert extract_from_labels(["priority:P3"])["priority"] == "P3"
    assert extract_from_labels(["P0"])["priority"] == "P0"


def testextract_from_labels_legacy_priority() -> None:
    assert extract_from_labels(["P1-high"])["priority"] == "P1"
    assert extract_from_labels(["priority:high"])["priority"] == "P1"
    assert extract_from_labels(["P2-medium"])["priority"] == "P2"
    assert extract_from_labels(["priority:medium"])["priority"] == "P2"
    assert extract_from_labels(["P3-low"])["priority"] == "P3"
    assert extract_from_labels(["priority:low"])["priority"] == "P3"
    assert extract_from_labels(["priority: low"])["priority"] == "P3"


def testextract_from_labels_legacy_size_m_maps_to_flite() -> None:
    """Legacy drift: `size:M` (seen only on closed issues) → canonical F-lite."""
    assert extract_from_labels(["size:M"])["size"] == "F-lite"


def testextract_from_labels_lane() -> None:
    assert extract_from_labels(["graph:lane/a1"])["lane"] == "a1"
    assert extract_from_labels(["graph:lane/standalone"])["lane"] == "standalone"


def testextract_from_labels_all_fields() -> None:
    result = extract_from_labels(
        ["size:F-lite", "priority:P2", "graph:lane/a1", "random-label"]
    )
    assert result == {"lane": "a1", "priority": "P2", "size": "F-lite"}


def testextract_from_labels_empty() -> None:
    assert extract_from_labels([]) == {"lane": None, "priority": None, "size": None}


def testextract_from_labels_first_match_wins() -> None:
    """First matching label wins per field — mirrors dep_graph/v6/parse.py semantics."""
    result = extract_from_labels(["size:S", "size:F-full"])
    assert result["size"] == "S"
    result = extract_from_labels(["priority:P1", "priority:P3"])
    assert result["priority"] == "P1"


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
# Label-sourced lane/priority/size hydration (#54)
# ---------------------------------------------------------------------------


def test_upsert_issue_stores_lane_priority_size(tmp_path: Path) -> None:
    """upsert_issue writes lane/priority/size/status columns."""
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)
    try:
        issue = {
            **_BASE_ISSUE,
            "lane": "a1",
            "priority": "P1",
            "size": "F-lite",
            "status": None,
        }
        upsert_issue(conn, issue)
        conn.commit()
        row = conn.execute(
            "SELECT lane, priority, size, status FROM issues WHERE key = ?",
            ("Roxabi/lyra#1",),
        ).fetchone()
        assert row == ("a1", "P1", "F-lite", None), f"Got {row}"
    finally:
        conn.close()


def test_run_repo_sync_populates_from_labels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """run_repo_sync derives lane/priority/size from labels; status stays NULL."""
    from roxabi_live.corpus.sync import run_repo_sync  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)

    node = _base_node(
        {
            "labels": {
                "nodes": [
                    {"name": "size:F-lite"},
                    {"name": "priority:P2"},
                    {"name": "graph:lane/a1"},
                    {"name": "random"},
                ]
            }
        }
    )

    def fake_gh_graphql(q: str, v: dict[str, Any]) -> dict[str, Any]:
        return _make_graphql_response(node)

    monkeypatch.setattr("roxabi_live.corpus.sync.gh_graphql", fake_gh_graphql)

    run_repo_sync(conn, "Roxabi", "lyra")

    row = conn.execute(
        "SELECT lane, priority, size, status FROM issues LIMIT 1"
    ).fetchone()
    conn.close()
    assert row == ("a1", "P2", "F-lite", None), f"Got {row}"


def test_run_repo_sync_null_fields_when_no_labels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Issue with no size/priority/lane labels → all three columns NULL, no error."""
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


# ---------------------------------------------------------------------------
# run_single_repo_sync
# ---------------------------------------------------------------------------


def test_run_single_repo_sync_calls_run_repo_sync(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """run_single_repo_sync delegates to run_repo_sync with owner/name/since."""
    from roxabi_live.corpus.sync import run_single_repo_sync  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)

    calls: list[tuple[Any, ...]] = []

    def fake_run_repo_sync(
        c: Any, owner: str, name: str, since: str | None = None
    ) -> dict[str, int]:
        calls.append((owner, name, since))
        return {"pages": 1, "issues": 2}

    monkeypatch.setattr("roxabi_live.corpus.sync.run_repo_sync", fake_run_repo_sync)

    result = run_single_repo_sync(conn, "Roxabi/lyra")
    conn.close()

    assert result == {"pages": 1, "issues": 2}
    assert len(calls) == 1
    assert calls[0][0] == "Roxabi"
    assert calls[0][1] == "lyra"
    assert calls[0][2] is None  # no sync_state row → since=None


def test_run_single_repo_sync_uses_since_cursor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """run_single_repo_sync reads since from sync_state when a row exists."""
    from roxabi_live.corpus.sync import run_single_repo_sync  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO sync_state(repo, last_cursor, last_synced_at)"
        " VALUES (?, ?, ?)",
        ("Roxabi/lyra", None, "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()

    captured_since: list[str | None] = []

    def fake_run_repo_sync(
        c: Any, owner: str, name: str, since: str | None = None
    ) -> dict[str, int]:
        captured_since.append(since)
        return {"pages": 0, "issues": 0}

    monkeypatch.setattr("roxabi_live.corpus.sync.run_repo_sync", fake_run_repo_sync)

    run_single_repo_sync(conn, "Roxabi/lyra")
    conn.close()

    assert captured_since == ["2026-01-01T00:00:00+00:00"]


def test_run_single_repo_sync_does_not_call_enumerate_or_hop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """run_single_repo_sync must NOT call enumerate_org_repos or closed_hop_pass."""
    from roxabi_live.corpus import sync as sync_mod  # noqa: PLC0415
    from roxabi_live.corpus.sync import run_single_repo_sync  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)

    enumerate_called = False
    hop_called = False

    def fake_enumerate(org: str) -> list[Any]:
        nonlocal enumerate_called
        enumerate_called = True
        return []

    def fake_hop(c: Any) -> int:
        nonlocal hop_called
        hop_called = True
        return 0

    def fake_run_repo_sync(
        c: Any, owner: str, name: str, since: str | None = None
    ) -> dict[str, int]:
        return {"pages": 0, "issues": 0}

    monkeypatch.setattr(sync_mod, "enumerate_org_repos", fake_enumerate)
    monkeypatch.setattr(sync_mod, "closed_hop_pass", fake_hop)
    monkeypatch.setattr(sync_mod, "run_repo_sync", fake_run_repo_sync)

    run_single_repo_sync(conn, "Roxabi/lyra")
    conn.close()

    assert not enumerate_called, "enumerate_org_repos must NOT be called"
    assert not hop_called, "closed_hop_pass must NOT be called"


def test_run_single_repo_sync_malformed_repo_raises(tmp_path: Path) -> None:
    """run_single_repo_sync raises ValueError for repos without a slash."""
    from roxabi_live.corpus.sync import run_single_repo_sync  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)
    try:
        with pytest.raises(ValueError, match="owner/name"):
            run_single_repo_sync(conn, "no-slash-here")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# run_sync allowlist filtering
# ---------------------------------------------------------------------------


def _make_repos_response(repos: list[tuple[str, str]]) -> dict[str, Any]:
    """Wrap repo list in the GraphQL org repositories envelope."""
    return {
        "data": {
            "organization": {
                "repositories": {
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": [{"owner": {"login": o}, "name": n} for o, n in repos],
                }
            },
            "rateLimit": {
                "cost": 1,
                "remaining": 4999,
                "resetAt": "2026-04-21T10:00:00Z",
            },
        }
    }


def test_run_sync_empty_allowlist_returns_zeros(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """run_sync with an empty allowlist returns zero counts and prints a warning."""
    from roxabi_live.corpus.sync import run_sync  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)

    # enumerate_org_repos returns something but allowlist is empty
    def fake_enum_empty(_org: str) -> list[tuple[str, str]]:
        return [("Roxabi", "lyra"), ("Roxabi", "voiceCLI")]

    monkeypatch.setattr("roxabi_live.corpus.sync.enumerate_org_repos", fake_enum_empty)

    result = run_sync(conn, "Roxabi")
    conn.close()

    assert result == {
        "repos": 0,
        "pages": 0,
        "issues": 0,
        "stubs": 0,
        "errors": 0,
        "pruned": 0,
    }
    err = capsys.readouterr().err
    assert "repo_allowlist is empty" in err
    assert "corpus repo add" in err


def test_run_sync_filters_by_allowlist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """run_sync with allowlist=[lyra] only calls run_repo_sync for lyra, not others."""
    from roxabi_live.corpus.sync import run_sync  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = connect(db_path)

    # Seed allowlist with only lyra
    conn.execute("INSERT INTO repo_allowlist(repo) VALUES('Roxabi/lyra')")
    conn.commit()

    def fake_enum_three(_org: str) -> list[tuple[str, str]]:
        return [("Roxabi", "lyra"), ("Roxabi", "voiceCLI"), ("Roxabi", "noise")]

    monkeypatch.setattr("roxabi_live.corpus.sync.enumerate_org_repos", fake_enum_three)

    synced: list[str] = []

    def fake_run_repo_sync(
        c: Any, owner: str, name: str, since: str | None = None
    ) -> dict[str, int]:
        synced.append(f"{owner}/{name}")
        return {"pages": 1, "issues": 2}

    monkeypatch.setattr("roxabi_live.corpus.sync.run_repo_sync", fake_run_repo_sync)

    # closed_hop_pass also needs mocking to avoid DB issues
    def fake_closed_hop(_c: Any) -> int:
        return 0

    monkeypatch.setattr("roxabi_live.corpus.sync.closed_hop_pass", fake_closed_hop)

    result = run_sync(conn, "Roxabi")
    conn.close()

    assert synced == ["Roxabi/lyra"], f"Expected only lyra to be synced, got {synced}"
    assert result["repos"] == 1
    assert result["issues"] == 2
