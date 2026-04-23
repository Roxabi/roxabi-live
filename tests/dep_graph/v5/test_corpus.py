"""Tests for v5.data.corpus — corpus.db adapter + projectV2 field reader.

Tests cover:
- _project_fields() — unit tests for the column-based projector
- load_issues() — integration tests seeding a real sqlite DB via
  roxabi_live.corpus.schema.bootstrap + raw INSERTs, asserting the projected
  issue dict shape matches spec §Data Model.
- Static grep gate: LANE_LABEL_PREFIX / SIZE_LABEL_PREFIX must not appear
  in the production corpus.py (AC-3).
"""

from __future__ import annotations

import sqlite3
import subprocess
from pathlib import Path

import pytest

from roxabi_live.dep_graph.v5.data.corpus import _project_fields, load_issues

# --- Unit: _project_fields ---------------------------------------------------


def test_project_fields_reads_columns() -> None:
    """_project_fields() returns correct dict from column values (AC-9)."""
    fields = _project_fields("a2", "P1", "S", "Ready")
    assert fields == {
        "lane_label": "a2",
        "priority": "P1",
        "size": "S",
        "status": "Ready",
    }


def test_project_fields_none_columns() -> None:
    """All-None column args -> all-None dict values (AC-9)."""
    fields = _project_fields(None, None, None, None)
    assert all(v is None for v in fields.values())


def test_project_fields_exact_ac9() -> None:
    """AC-9 exact assertion: _project_fields('a1','P1','M','In Progress')."""
    result = _project_fields("a1", "P1", "M", "In Progress")
    assert result == {
        "lane_label": "a1",
        "priority": "P1",
        "size": "M",
        "status": "In Progress",
    }


# --- Static grep gate (AC-3) -------------------------------------------------


def test_no_label_prefix_constants_in_v5_corpus() -> None:
    """AC-3: LANE_LABEL_PREFIX and SIZE_LABEL_PREFIX must not appear in corpus.py."""
    src = (
        Path(__file__).parents[3]
        / "src/roxabi_live/dep_graph/v5/data/corpus.py"
    )
    for constant in ("LANE_LABEL_PREFIX", "SIZE_LABEL_PREFIX"):
        result = subprocess.run(
            ["grep", "-n", constant, str(src)],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0, (
            f"{constant} still referenced in corpus.py:\n{result.stdout}"
        )


# --- Integration: load_issues ------------------------------------------------


def _seed_db(db_path: Path) -> None:
    """Bootstrap schema and insert one issue with labels, no edges."""
    from roxabi_live.corpus.schema import bootstrap  # noqa: PLC0415

    bootstrap(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """INSERT INTO issues (key, repo, number, title, state, milestone, is_stub)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                "Roxabi/lyra#1",
                "Roxabi/lyra",
                1,
                "Test issue",
                "open",
                "M1 alpha",
                0,
            ),
        )
        for label in ["graph:lane/a1", "size:M", "graph:standalone"]:
            conn.execute(
                "INSERT INTO labels (issue_key, name) VALUES (?, ?)",
                ("Roxabi/lyra#1", label),
            )
        conn.commit()
    finally:
        conn.close()


def test_load_issues_projects_all_fields(tmp_path: Path) -> None:
    """Projected dict carries every field documented in spec §Data Model (AC-4, AC-10)."""
    from roxabi_live.corpus.schema import bootstrap  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)

    # Seed with explicit column values for all four projectV2 fields
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """INSERT INTO issues
                   (key, repo, number, title, state, milestone, is_stub,
                    lane, priority, size, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "Roxabi/lyra#1",
                "Roxabi/lyra",
                1,
                "Test issue",
                "open",
                "M1 alpha",
                0,
                "a1",
                "P1",
                "M",
                "Ready",
            ),
        )
        for label in ["graph:lane/a1", "size:M", "graph:standalone"]:
            conn.execute(
                "INSERT INTO labels (issue_key, name) VALUES (?, ?)",
                ("Roxabi/lyra#1", label),
            )
        conn.commit()
    finally:
        conn.close()

    issues = load_issues(db_path)

    assert "Roxabi/lyra#1" in issues
    issue = issues["Roxabi/lyra#1"]

    assert issue["repo"] == "Roxabi/lyra"
    assert issue["number"] == 1
    assert issue["title"] == "Test issue"
    assert issue["state"] == "open"
    assert set(issue["labels"]) == {"graph:lane/a1", "size:M", "graph:standalone"}
    assert issue["lane_label"] == "a1"      # sourced from DB column
    assert issue["size"] == "M"             # sourced from DB column
    assert issue["priority"] == "P1"        # sourced from DB column
    assert issue["status"] == "Ready"       # sourced from DB column
    assert issue["standalone"] is True
    assert issue["defer"] is False
    assert issue["milestone"] == "M1 alpha"
    assert issue["blocking"] == []
    assert issue["blocked_by"] == []


def test_edges_populate_blocking_and_blocked_by(tmp_path: Path) -> None:
    """Edge src blocks dst -> A.blocking has B ref; B.blocked_by has A ref."""
    from roxabi_live.corpus.schema import bootstrap  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """INSERT INTO issues (key, repo, number, title, state, is_stub)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [
                ("Roxabi/lyra#1", "Roxabi/lyra", 1, "Issue A", "open", 0),
                ("Roxabi/voiceCLI#10", "Roxabi/voiceCLI", 10, "Issue B", "open", 0),
            ],
        )
        conn.execute(
            "INSERT INTO edges (src_key, dst_key) VALUES (?, ?)",
            ("Roxabi/lyra#1", "Roxabi/voiceCLI#10"),
        )
        conn.commit()
    finally:
        conn.close()

    issues = load_issues(db_path)

    assert issues["Roxabi/lyra#1"]["blocking"] == [
        {"repo": "Roxabi/voiceCLI", "issue": 10}
    ]
    assert issues["Roxabi/lyra#1"]["blocked_by"] == []
    assert issues["Roxabi/voiceCLI#10"]["blocked_by"] == [
        {"repo": "Roxabi/lyra", "issue": 1}
    ]
    assert issues["Roxabi/voiceCLI#10"]["blocking"] == []


def test_missing_db_hints_make_corpus_sync(tmp_path: Path) -> None:
    """Missing db_path raises FileNotFoundError hinting at make corpus-sync."""
    db_path = tmp_path / "nonexistent.db"
    with pytest.raises(FileNotFoundError, match="make corpus-sync"):
        load_issues(db_path)


def test_load_issues_is_stub_true_projection(tmp_path: Path) -> None:
    """is_stub=1 in SQLite -> is_stub: True in projected dict."""
    from roxabi_live.corpus.schema import bootstrap  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """INSERT INTO issues (key, repo, number, title, state, is_stub)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("Roxabi/lyra#1", "Roxabi/lyra", 1, "stub", "closed", 1),
        )
        conn.commit()
    finally:
        conn.close()

    issues = load_issues(db_path)
    assert issues["Roxabi/lyra#1"]["is_stub"] is True


def test_load_issues_dangling_edge_produces_orphan_ref(tmp_path: Path) -> None:
    """Edge whose dst_key has no issues row -> src.blocking still lists the orphan ref."""
    from roxabi_live.corpus.schema import bootstrap  # noqa: PLC0415

    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """INSERT INTO issues (key, repo, number, title, state, is_stub)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("Roxabi/lyra#1", "Roxabi/lyra", 1, "A", "open", 0),
        )
        conn.execute(
            "INSERT INTO edges (src_key, dst_key) VALUES (?, ?)",
            ("Roxabi/lyra#1", "Roxabi/voiceCLI#999"),
        )
        conn.commit()
    finally:
        conn.close()

    issues = load_issues(db_path)

    assert issues["Roxabi/lyra#1"]["blocking"] == [
        {"repo": "Roxabi/voiceCLI", "issue": 999}
    ]
    assert "Roxabi/voiceCLI#999" not in issues
