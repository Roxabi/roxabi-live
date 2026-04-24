"""Corpus sync helpers — canonical key, upserts, rate-limit logging.

This module holds pure helpers used by the V2 per-repo sync loop (T13) and
the V3 org-wide orchestrator (T20). No network I/O here — transport lives
in roxabi_live.corpus.graphql.
"""

from __future__ import annotations

import re
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Any

from roxabi_live.corpus.graphql import (
    ISSUES_QUERY,
    REPOS_QUERY,
    STUB_ISSUE_QUERY,
    GraphQLError,
    gh_graphql,
)

_BARE_INT = re.compile(r"^\d+$")
_SHORT_FORM = re.compile(r"^#(\d+)$")
_FULL_KEY = re.compile(r"^[\w.-]+/[\w.-]+#\d+$")

# ---------------------------------------------------------------------------
# SQL constants — shared by corpus.sync (sync path) and corpus.mutations (async path)
# ---------------------------------------------------------------------------

# Full upsert: used by corpus.sync for complete issue data from GraphQL.
# Updates ALL columns including milestone, is_stub, lane, priority, size, status.
UPSERT_ISSUE_SQL = """
    INSERT INTO issues
        (key, repo, number, title, state, url, created_at, updated_at,
         closed_at, milestone, is_stub, lane, priority, size, status)
    VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
        repo       = excluded.repo,
        number     = excluded.number,
        title      = excluded.title,
        state      = excluded.state,
        url        = excluded.url,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        closed_at  = excluded.closed_at,
        milestone  = excluded.milestone,
        is_stub    = excluded.is_stub,
        lane       = excluded.lane,
        priority   = excluded.priority,
        size       = excluded.size,
        status     = excluded.status
"""

# Webhook upsert: used by corpus.mutations for partial webhook payload data.
# Inserts with milestone/is_stub/lane/priority/size/status as NULL on new rows,
# but on conflict ONLY updates the fields present in a webhook payload so that
# pre-existing values (set by a full sync) are never overwritten with NULL.
UPSERT_ISSUE_FROM_WEBHOOK_SQL = """
    INSERT INTO issues
        (key, repo, number, title, state, url, created_at, updated_at, closed_at,
         milestone, is_stub, lane, priority, size, status)
    VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?,
         NULL, 0, NULL, NULL, NULL, NULL)
    ON CONFLICT(key) DO UPDATE SET
        repo       = excluded.repo,
        number     = excluded.number,
        title      = excluded.title,
        state      = excluded.state,
        url        = excluded.url,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        closed_at  = excluded.closed_at
"""

DELETE_LABELS_SQL = "DELETE FROM labels WHERE issue_key = ?"
INSERT_LABEL_SQL = "INSERT OR IGNORE INTO labels (issue_key, name) VALUES (?, ?)"

DELETE_EDGES_BY_KIND_SQL = (
    "DELETE FROM edges WHERE (src_key = ? OR dst_key = ?) AND kind = ?"
)
INSERT_EDGE_SQL = "INSERT OR IGNORE INTO edges (src_key, dst_key, kind) VALUES (?, ?, ?)"
DELETE_EDGE_SQL = (
    "DELETE FROM edges WHERE src_key = ? AND dst_key = ? AND kind = ?"
)

_LANE_PREFIX = "graph:lane/"
_SIZE_PREFIX = "size:"
_LEGACY_SIZE_RAW = {"XS", "S", "M", "L", "XL"}
_LEGACY_SIZE_MAP = {"M": "F-lite"}  # closed-issue drift → canonical

_PRIORITY_EXACT: dict[str, str] = {
    "P0": "P0",
    "priority:P0": "P0",
    "P1-high": "P1",
    "priority:high": "P1",
    "priority:P1": "P1",
    "P2-medium": "P2",
    "priority:medium": "P2",
    "priority:P2": "P2",
    "P3-low": "P3",
    "priority:low": "P3",
    "priority: low": "P3",
    "priority:P3": "P3",
}


def _derive_lane(labels: list[str]) -> str | None:
    for lbl in labels:
        if lbl.startswith(_LANE_PREFIX):
            return lbl[len(_LANE_PREFIX) :]
    return None


def _derive_priority(labels: list[str]) -> str | None:
    for lbl in labels:
        if lbl in _PRIORITY_EXACT:
            return _PRIORITY_EXACT[lbl]
    return None


def _derive_size(labels: list[str]) -> str | None:
    for lbl in labels:
        if lbl.startswith(_SIZE_PREFIX):
            raw = lbl[len(_SIZE_PREFIX) :]
            return _LEGACY_SIZE_MAP.get(raw, raw)
    for lbl in labels:
        if lbl in _LEGACY_SIZE_RAW:
            return lbl
    return None


def _extract_from_labels(labels: list[str]) -> dict[str, str | None]:
    """Derive lane/priority/size from an issue's label list.

    Vocabulary (first match wins per field):
    - lane:     ``graph:lane/<x>`` → ``<x>``
    - priority: canonical ``priority:P0..P3`` / bare ``P0``; legacy
                ``P1-high`` / ``priority:high`` → ``P1`` (and P2/P3 variants)
    - size:     canonical ``size:S|F-lite|F-full``; legacy ``size:M`` →
                ``F-lite``; fallback to raw ``XS|S|M|L|XL`` bare labels
    """
    return {
        "lane": _derive_lane(labels),
        "priority": _derive_priority(labels),
        "size": _derive_size(labels),
    }


def canonical_key(ref: int | str, repo: str) -> str:
    """Canonicalise an issue reference to 'owner/repo#N' form.

    - int 42 + 'Roxabi/lyra' -> 'Roxabi/lyra#42'
    - '42' + 'Roxabi/lyra' -> 'Roxabi/lyra#42'
    - '#9' + 'Roxabi/lyra' -> 'Roxabi/lyra#9'
    - 'Roxabi/voiceCLI#7' + anything -> 'Roxabi/voiceCLI#7' (pass-through)

    Raises ValueError on invalid input.
    """
    if isinstance(ref, int):
        return f"{repo}#{ref}"
    s = str(ref)
    if _FULL_KEY.match(s):
        return s
    m = _SHORT_FORM.match(s)
    if m:
        return f"{repo}#{m.group(1)}"
    if _BARE_INT.match(s):
        return f"{repo}#{s}"
    raise ValueError(f"Cannot canonicalise issue ref: {ref!r}")


def upsert_issue(conn: sqlite3.Connection, issue: dict[str, Any]) -> None:
    """Insert-or-update a row in issues keyed on `key`.

    Uses ON CONFLICT DO UPDATE so FK children (labels) are preserved across
    upserts — INSERT OR REPLACE would trigger ON DELETE CASCADE first.
    Expected keys: key, repo, number, title, state, url, created_at,
    updated_at, closed_at (nullable), milestone (nullable), is_stub (0 or 1),
    lane (nullable), priority (nullable), size (nullable), status (nullable).
    """
    conn.execute(
        UPSERT_ISSUE_SQL,
        (
            issue["key"],
            issue["repo"],
            issue["number"],
            issue["title"],
            issue["state"],
            issue["url"],
            issue["created_at"],
            issue["updated_at"],
            issue["closed_at"],
            issue["milestone"],
            issue["is_stub"],
            issue["lane"],
            issue["priority"],
            issue["size"],
            issue["status"],
        ),
    )


def upsert_labels(conn: sqlite3.Connection, issue_key: str, names: list[str]) -> None:
    """Wipe and rewrite labels for issue_key."""
    conn.execute(DELETE_LABELS_SQL, (issue_key,))
    conn.executemany(
        INSERT_LABEL_SQL,
        [(issue_key, name) for name in names],
    )


def upsert_edges(
    conn: sqlite3.Connection,
    issue_key: str,
    blocked_by: list[str],
    blocking: list[str],
    kind: str = "parent",
) -> None:
    """Wipe all edges touching issue_key (as src OR dst) of the same kind, then rewrite.

    Canonical direction:
    - Every blocker b in blocked_by -> row (src=b, dst=issue_key).
    - Every blockee b in blocking -> row (src=issue_key, dst=b).

    Idempotent. Duplicate (src, dst) pairs coalesce via PRIMARY KEY.
    All inputs are assumed already canonical — caller must use canonical_key first.
    """
    conn.execute(
        DELETE_EDGES_BY_KIND_SQL,
        (issue_key, issue_key, kind),
    )
    rows: list[tuple[str, str, str]] = []
    for blocker in blocked_by:
        rows.append((blocker, issue_key, kind))
    for blockee in blocking:
        rows.append((issue_key, blockee, kind))
    conn.executemany(
        INSERT_EDGE_SQL,
        rows,
    )


def log_rate_limit(rl: dict[str, Any]) -> None:
    print(
        f"[corpus] cost={rl['cost']} remaining={rl['remaining']} reset={rl['resetAt']}",
        file=sys.stderr,
    )


def run_repo_sync(
    conn: sqlite3.Connection,
    owner: str,
    name: str,
    since: str | None = None,
) -> dict[str, int]:
    """Paginate ISSUES_QUERY for owner/name, upsert all issues/labels/edges,
    log rate-limit per page, write sync_state row on success.

    Returns counts dict: {"pages": N, "issues": N}.
    """
    repo = f"{owner}/{name}"
    cursor: str | None = None
    pages = 0
    total_issues = 0

    while True:
        response = gh_graphql(
            ISSUES_QUERY,
            {"owner": owner, "name": name, "cursor": cursor, "since": since},
        )
        log_rate_limit(response["data"]["rateLimit"])

        issues_page = response["data"]["repository"]["issues"]
        nodes = issues_page["nodes"]

        for node in nodes:
            key = canonical_key(node["number"], repo)
            issue: dict[str, Any] = {
                "key": key,
                "repo": repo,
                "number": node["number"],
                "title": node["title"],
                "state": node["state"].lower(),
                "url": node["url"],
                "created_at": node["createdAt"],
                "updated_at": node["updatedAt"],
                "closed_at": node["closedAt"],
                "milestone": (
                    (node["milestone"] or {}).get("title")  # type: ignore[union-attr]
                ),
                "is_stub": 0,
            }
            labels = [n["name"] for n in node["labels"]["nodes"]]
            issue.update(_extract_from_labels(labels))
            issue["status"] = None
            upsert_issue(conn, issue)

            upsert_labels(conn, key, labels)

            # Parent/child relationships (subIssues/parent)
            # Edge direction: src=parent, dst=child
            children = [
                canonical_key(t["number"], t["repository"]["nameWithOwner"])
                for t in node.get("subIssues", {}).get("nodes", [])
            ]
            parent_node = node.get("parent")
            parents = (
                [
                    canonical_key(
                        parent_node["number"],
                        parent_node["repository"]["nameWithOwner"],
                    )
                ]
                if parent_node
                else []
            )

            # Dependency relationships (blockedBy/blocking)
            # Edge direction: src=blocker, dst=blocked
            deps_blocked_by = [
                canonical_key(t["number"], t["repository"]["nameWithOwner"])
                for t in node.get("blockedBy", {}).get("nodes", [])
            ]
            deps_blocking = [
                canonical_key(t["number"], t["repository"]["nameWithOwner"])
                for t in node.get("blocking", {}).get("nodes", [])
            ]

            # Upsert parent edges: parents -> this issue, this issue -> children
            upsert_edges(conn, key, parents, children, kind="parent")

            # Upsert blocks edges: blockers -> this issue, this issue -> blockees
            if deps_blocked_by or deps_blocking:
                upsert_edges(conn, key, deps_blocked_by, deps_blocking, kind="blocks")

        conn.commit()
        pages += 1
        total_issues += len(nodes)

        page_info = issues_page["pageInfo"]
        if page_info["hasNextPage"]:
            cursor = page_info["endCursor"]
        else:
            break

    now_iso = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT OR REPLACE INTO sync_state(repo, last_cursor, last_synced_at)"
        " VALUES (?, ?, ?)",
        (repo, None, now_iso),
    )
    conn.commit()

    return {"pages": pages, "issues": total_issues}


def enumerate_org_repos(org: str) -> list[tuple[str, str]]:
    """Return list of (owner, name) for every non-archived repo in the org."""
    repos: list[tuple[str, str]] = []
    cursor: str | None = None
    while True:
        response = gh_graphql(REPOS_QUERY, {"org": org, "cursor": cursor})
        log_rate_limit(response["data"]["rateLimit"])
        page = response["data"]["organization"]["repositories"]
        for node in page["nodes"]:
            repos.append((node["owner"]["login"], node["name"]))
        if not page["pageInfo"]["hasNextPage"]:
            break
        cursor = page["pageInfo"]["endCursor"]
    return repos


def closed_hop_pass(conn: sqlite3.Connection) -> int:
    """Find edge rows whose endpoints are missing from issues and stub-fetch them.

    Select DISTINCT keys from edges (src_key u dst_key) that don't appear in issues.
    For each missing key, fetch minimal metadata via GraphQL and INSERT with is_stub=1.

    Returns the number of stubs inserted.
    """
    rows = conn.execute(
        "SELECT DISTINCT k FROM ("
        "  SELECT src_key AS k FROM edges "
        "  UNION SELECT dst_key AS k FROM edges"
        ") WHERE k NOT IN (SELECT key FROM issues)"
    ).fetchall()
    inserted = 0
    for (key,) in rows:
        owner_repo, _, number_str = key.rpartition("#")
        if not owner_repo or not number_str.isdigit():
            continue  # malformed key — defensive
        owner, _, name = owner_repo.partition("/")
        try:
            response = gh_graphql(
                STUB_ISSUE_QUERY,
                {
                    "owner": owner,
                    "name": name,
                    "number": int(number_str),
                },
            )
        except GraphQLError:
            # Orphan — repo outside Roxabi or access denied. Per spec:
            # "Stored as-is in edges; stub fetched if accessible, else logged as orphan"
            print(f"[corpus] orphan reference: {key}", file=sys.stderr)
            continue
        log_rate_limit(response["data"]["rateLimit"])
        node = response["data"]["repository"]["issue"]
        if node is None:
            print(f"[corpus] orphan reference: {key}", file=sys.stderr)
            continue
        stub = {
            "key": key,
            "repo": owner_repo,
            "number": node["number"],
            "title": node["title"],
            "state": node["state"].lower(),
            "url": node["url"],
            "created_at": node["createdAt"],
            "updated_at": node["updatedAt"],
            "closed_at": node["closedAt"],
            "milestone": None,
            "is_stub": 1,
            "lane": None,
            "priority": None,
            "size": None,
            "status": None,
        }
        upsert_issue(conn, stub)
        inserted += 1
    conn.commit()
    return inserted


def run_sync(conn: sqlite3.Connection, org: str) -> dict[str, int]:
    """Org-wide sync: enumerate repos, per-repo sync with since cursor, closed-hop pass.

    Returns counts: {"repos": N, "pages": N, "issues": N, "stubs": N, "errors": N}.
    """
    repos = enumerate_org_repos(org)
    total: dict[str, int] = {
        "repos": len(repos),
        "pages": 0,
        "issues": 0,
        "stubs": 0,
        "errors": 0,
    }
    for owner, name in repos:
        row = conn.execute(
            "SELECT last_synced_at FROM sync_state WHERE repo = ?",
            (f"{owner}/{name}",),
        ).fetchone()
        since = row[0] if row else None
        try:
            counts = run_repo_sync(conn, owner, name, since=since)
        except GraphQLError as e:
            print(f"[corpus] skipping {owner}/{name}: {e}", file=sys.stderr)
            total["errors"] += 1
            continue
        total["pages"] += counts["pages"]
        total["issues"] += counts["issues"]
    total["stubs"] = closed_hop_pass(conn)
    return total
