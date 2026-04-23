"""Adapter: read Roxabi org corpus (~/.roxabi/corpus.db) and project rows into the
issue-dict shape v5 already consumes (same keys as the legacy gh.json cache).

Single data source for v5: callers pass db_path or rely on the DEFAULT_DB constant.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from roxabi_live.corpus.schema import connect as _connect_corpus

DEFAULT_DB = Path.home() / ".roxabi" / "corpus.db"

STANDALONE_LABEL = "graph:standalone"
DEFER_LABEL = "graph:defer"


def load_issues(db_path: Path | None = None) -> dict[str, dict[str, Any]]:
    """Load every issue + labels + edges from corpus.db into the v5 projected shape.

    Returns `{key: dict}` keyed by canonical `owner/repo#N`. No repo filter —
    caller (v5 compute_visible) handles visibility.

    Raises FileNotFoundError (with a hint referencing `make corpus-sync`) when
    the DB does not exist.
    """
    resolved = db_path if db_path is not None else DEFAULT_DB
    # TOCTOU window between .exists() and connect() is acceptable for a
    # local ~/.roxabi/corpus.db — no remote-mount concern today.
    if not resolved.exists():
        raise FileNotFoundError(
            f"corpus.db not found at {resolved}. Run `make corpus-sync` to populate it."
        )

    # Use schema.connect for the single source of truth on connection pragmas
    # (foreign_keys = ON). The adapter is read-only today; using the same
    # connection contract prevents pragma drift if a write path is ever added.
    conn = _connect_corpus(resolved)
    try:
        labels_by_key = _fetch_labels(conn)
        blocking_by_key, blocked_by_key = _fetch_edges(conn)
        return _fetch_issues(conn, labels_by_key, blocking_by_key, blocked_by_key)
    finally:
        conn.close()


def _project_fields(
    lane: str | None,
    priority: str | None,
    size: str | None,
    status: str | None,
) -> dict[str, str | None]:
    """Map corpus.db projectV2 column values to the v5 projected-dict keys.

    Key `lane_label` is preserved (not renamed to `lane`) — v5 consumers
    already reference issue["lane_label"] and renaming would break all
    downstream callers without a separate migration.
    """
    return {
        "lane_label": lane,
        "priority": priority,
        "size": size,
        "status": status,
    }


# --- Private helpers ----------------------------------------------------------


def _fetch_labels(conn: sqlite3.Connection) -> dict[str, list[str]]:
    """Return {issue_key: [label_name, ...]} preserving insertion order."""
    result: dict[str, list[str]] = {}
    for issue_key, name in conn.execute(
        "SELECT issue_key, name FROM labels ORDER BY rowid"
    ):
        result.setdefault(issue_key, []).append(name)
    return result


def _key_to_ref(key: str) -> dict[str, Any]:
    """Parse `owner/repo#N` into an IssueRef dict `{repo, issue}`.

    Raises ValueError with the offending key in the message on malformed
    input (e.g. missing `#`), instead of an opaque unpack error.
    """
    repo, sep, num = key.rpartition("#")
    if not sep or not repo:
        raise ValueError(f"malformed corpus key (expected 'owner/repo#N'): {key!r}")
    return {"repo": repo, "issue": int(num)}


def _fetch_edges(
    conn: sqlite3.Connection,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    """Return (blocking_by_key, blocked_by_key) from the edges table.

    edge (src, dst) means src blocks dst:
      blocking_by_key[src]  -> refs of issues that src blocks
      blocked_by_key[dst]   -> refs of issues that block dst
    """
    blocking_by_key: dict[str, list[dict[str, Any]]] = {}
    blocked_by_key: dict[str, list[dict[str, Any]]] = {}

    for src_key, dst_key in conn.execute("SELECT src_key, dst_key FROM edges"):
        blocking_by_key.setdefault(src_key, []).append(_key_to_ref(dst_key))
        blocked_by_key.setdefault(dst_key, []).append(_key_to_ref(src_key))

    return blocking_by_key, blocked_by_key


def _fetch_issues(
    conn: sqlite3.Connection,
    labels_by_key: dict[str, list[str]],
    blocking_by_key: dict[str, list[dict[str, Any]]],
    blocked_by_key: dict[str, list[dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    """Build the final projected issue dict from the issues table."""
    result: dict[str, dict[str, Any]] = {}

    for row in conn.execute(
        "SELECT key, repo, number, title, state, url, "
        "created_at, updated_at, closed_at, milestone, is_stub, "
        "lane, priority, size, status "
        "FROM issues"
    ):
        (
            key,
            repo,
            number,
            title,
            state,
            url,
            created_at,
            updated_at,
            closed_at,
            milestone,
            is_stub,
            lane,
            priority,
            size,
            status,
        ) = row

        # Copy the label list so downstream mutation of the projected dict's
        # `labels` cannot alias back into labels_by_key (which feeds derived
        # fields below).
        labels = list(labels_by_key.get(key, []))
        fields = _project_fields(lane, priority, size, status)

        result[key] = {
            "repo": repo,
            "number": number,
            "title": title,
            "state": state,
            "url": url,
            "created_at": created_at,
            "updated_at": updated_at,
            "closed_at": closed_at,
            "milestone": milestone,
            "is_stub": bool(is_stub),
            "labels": labels,
            "lane_label": fields["lane_label"],
            "size": fields["size"],
            "priority": fields["priority"],
            "status": fields["status"],
            "standalone": STANDALONE_LABEL in labels,
            "defer": DEFER_LABEL in labels,
            "blocking": blocking_by_key.get(key, []),
            "blocked_by": blocked_by_key.get(key, []),
        }

    return result
