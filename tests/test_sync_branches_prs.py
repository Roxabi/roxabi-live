"""Tests for sync_branches regex + sync_prs upsert — T10 [RED-GATE].

Covers:
- BRANCH_ISSUE_RE regex matches: feat/123-x, fix/456-slug, 123-bare-prefix
- BRANCH_ISSUE_RE rejects: dependabot/..., release-please--..., staging, main
- sync_prs upsert: reviewed label flag, closing_issue_keys JSON, idempotency
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any
from unittest.mock import patch

from roxabi_live.corpus.schema import bootstrap
from roxabi_live.corpus.sync import BRANCH_ISSUE_RE, sync_prs

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_db(tmp_path: Path) -> sqlite3.Connection:
    """Create a temp DB with full schema and return a connection."""
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _fake_prs_response(
    nodes: list[dict[str, Any]], has_next: bool = False
) -> dict[str, Any]:
    """Build a fake gh_graphql response for PRS_QUERY."""
    return {
        "data": {
            "repository": {
                "pullRequests": {
                    "pageInfo": {"hasNextPage": has_next, "endCursor": None},
                    "nodes": nodes,
                }
            },
            "rateLimit": {
                "cost": 1,
                "remaining": 4999,
                "resetAt": "2099-01-01T00:00:00Z",
            },
        }
    }


def _pr_node(
    number: int,
    state: str = "OPEN",
    label_names: list[str] | None = None,
    closing_refs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a minimal fake PR node as returned by GitHub GraphQL."""
    return {
        "number": number,
        "state": state,
        "labels": {"nodes": [{"name": n} for n in (label_names or [])]},
        "closingIssuesReferences": {"nodes": closing_refs or []},
    }


def _closing_ref(repo: str, number: int) -> dict[str, Any]:
    """Build a closing issue reference node."""
    return {
        "number": number,
        "repository": {"nameWithOwner": repo},
    }


# ---------------------------------------------------------------------------
# Tests — BRANCH_ISSUE_RE
# ---------------------------------------------------------------------------


class TestBranchIssueRe:
    """BRANCH_ISSUE_RE regex matches and rejects branch names correctly."""

    def test_feat_prefix_matches(self) -> None:
        """feat/123-x → match, group(1)='123'."""
        m = BRANCH_ISSUE_RE.match("feat/123-x")
        assert m is not None
        assert m.group(1) == "123"

    def test_fix_prefix_matches(self) -> None:
        """fix/456-some-slug → match, group(1)='456'."""
        m = BRANCH_ISSUE_RE.match("fix/456-some-slug")
        assert m is not None
        assert m.group(1) == "456"

    def test_chore_prefix_matches(self) -> None:
        """chore/789-foo → match."""
        m = BRANCH_ISSUE_RE.match("chore/789-foo")
        assert m is not None
        assert m.group(1) == "789"

    def test_bare_number_no_prefix_matches(self) -> None:
        """123-bare-no-prefix → match (gh issue develop pattern)."""
        m = BRANCH_ISSUE_RE.match("123-bare-no-prefix")
        assert m is not None
        assert m.group(1) == "123"

    def test_dependabot_does_not_match(self) -> None:
        """dependabot/github_actions/checkout-6.0.2 → NO match."""
        assert BRANCH_ISSUE_RE.match("dependabot/github_actions/checkout-6.0.2") is None

    def test_release_please_does_not_match(self) -> None:
        """release-please--branches--staging → NO match."""
        assert BRANCH_ISSUE_RE.match("release-please--branches--staging") is None

    def test_staging_does_not_match(self) -> None:
        """staging → NO match."""
        assert BRANCH_ISSUE_RE.match("staging") is None

    def test_main_does_not_match(self) -> None:
        """main → NO match."""
        assert BRANCH_ISSUE_RE.match("main") is None


# ---------------------------------------------------------------------------
# Tests — sync_prs upsert
# ---------------------------------------------------------------------------


class TestSyncPrsUpsert:
    """sync_prs() upserts pr_state rows correctly."""

    def test_reviewed_label_sets_flag(self, tmp_path: Path) -> None:
        """PR with 'reviewed' label → has_reviewed_label=1."""
        conn = _make_db(tmp_path)
        pr = _pr_node(number=1, label_names=["reviewed", "bug"])
        fake_resp = _fake_prs_response([pr])

        with patch("roxabi_live.corpus.sync.gh_graphql", return_value=fake_resp):
            sync_prs("Roxabi/lyra", conn)
        conn.commit()

        row = conn.execute(
            "SELECT has_reviewed_label FROM pr_state WHERE repo=? AND number=?",
            ("Roxabi/lyra", 1),
        ).fetchone()
        assert row is not None
        assert row[0] == 1

    def test_no_reviewed_label_flag_zero(self, tmp_path: Path) -> None:
        """PR without 'reviewed' label → has_reviewed_label=0."""
        conn = _make_db(tmp_path)
        pr = _pr_node(number=2, label_names=["enhancement"])
        fake_resp = _fake_prs_response([pr])

        with patch("roxabi_live.corpus.sync.gh_graphql", return_value=fake_resp):
            sync_prs("Roxabi/lyra", conn)
        conn.commit()

        row = conn.execute(
            "SELECT has_reviewed_label FROM pr_state WHERE repo=? AND number=?",
            ("Roxabi/lyra", 2),
        ).fetchone()
        assert row is not None
        assert row[0] == 0

    def test_two_closing_references_in_json(self, tmp_path: Path) -> None:
        """PR with 2 closing refs → closing_issue_keys is JSON array with 2 entries."""
        conn = _make_db(tmp_path)
        pr = _pr_node(
            number=3,
            closing_refs=[
                _closing_ref("Roxabi/lyra", 10),
                _closing_ref("Roxabi/lyra", 20),
            ],
        )
        fake_resp = _fake_prs_response([pr])

        with patch("roxabi_live.corpus.sync.gh_graphql", return_value=fake_resp):
            sync_prs("Roxabi/lyra", conn)
        conn.commit()

        row = conn.execute(
            "SELECT closing_issue_keys FROM pr_state WHERE repo=? AND number=?",
            ("Roxabi/lyra", 3),
        ).fetchone()
        assert row is not None
        parsed: list[str] = json.loads(row[0])
        assert isinstance(parsed, list)
        assert len(parsed) == 2
        assert "Roxabi/lyra#10" in parsed
        assert "Roxabi/lyra#20" in parsed

    def test_upsert_idempotent_updates_label(self, tmp_path: Path) -> None:
        """Re-upsert same (repo, number) with changed label → row updates."""
        conn = _make_db(tmp_path)

        # First sync: no reviewed label
        pr_first = _pr_node(number=4, label_names=[])
        with patch(
            "roxabi_live.corpus.sync.gh_graphql",
            return_value=_fake_prs_response([pr_first]),
        ):
            sync_prs("Roxabi/lyra", conn)
        conn.commit()

        row = conn.execute(
            "SELECT has_reviewed_label FROM pr_state WHERE repo=? AND number=?",
            ("Roxabi/lyra", 4),
        ).fetchone()
        assert row is not None
        assert row[0] == 0, "Expected has_reviewed_label=0 on first upsert"

        # Second sync: reviewed label added
        pr_second = _pr_node(number=4, label_names=["reviewed"])
        with patch(
            "roxabi_live.corpus.sync.gh_graphql",
            return_value=_fake_prs_response([pr_second]),
        ):
            sync_prs("Roxabi/lyra", conn)
        conn.commit()

        row = conn.execute(
            "SELECT has_reviewed_label FROM pr_state WHERE repo=? AND number=?",
            ("Roxabi/lyra", 4),
        ).fetchone()
        assert row is not None
        assert row[0] == 1, (
            "Expected has_reviewed_label=1 after upsert with reviewed label"
        )

        # Verify only one row for (repo, number) — no duplicates
        count = conn.execute(
            "SELECT COUNT(*) FROM pr_state WHERE repo=? AND number=?",
            ("Roxabi/lyra", 4),
        ).fetchone()
        assert count is not None
        assert count[0] == 1, "Expected exactly 1 row after idempotent upsert"
