"""Corpus sync helpers — canonical key, upserts, rate-limit logging.

This module holds pure helpers used by the V2 per-repo sync loop (T13) and
the V3 org-wide orchestrator (T20). No network I/O here — transport lives
in roxabi_live.corpus.graphql.
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Any

from roxabi_live.corpus.graphql import (
    ISSUES_QUERY,
    PRS_QUERY,
    REFS_QUERY,
    REPOS_QUERY,
    STUB_ISSUE_QUERY,
    GraphQLError,
    gh_graphql,
)

_BARE_INT = re.compile(r"^\d+$")
_SHORT_FORM = re.compile(r"^#(\d+)$")
_FULL_KEY = re.compile(r"^[\w.-]+/[\w.-]+#\d+$")

# Matches branch names that reference an issue number.
# Accepts: feat/123-slug, fix/456-x, 789-bare, chore/101-...
# Rejects: dependabot/..., release-please--..., main, staging
BRANCH_ISSUE_RE = re.compile(r"^(?:[a-z]+/)?(\d+)-")

# ---------------------------------------------------------------------------
# SQL constants — shared by corpus.sync (sync path) and corpus.mutations (async path)
# ---------------------------------------------------------------------------

# Full upsert: used by corpus.sync for complete issue data from GraphQL.
# Updates ALL columns including milestone, is_stub, lane, priority, size, status.
UPSERT_ISSUE_SQL = """
    INSERT INTO issues
        (key, repo, number, title, state, url, created_at, updated_at,
         closed_at, milestone, is_stub, lane, priority, size, status,
         has_active_branch)
    VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
        repo              = excluded.repo,
        number            = excluded.number,
        title             = excluded.title,
        state             = excluded.state,
        url               = excluded.url,
        created_at        = excluded.created_at,
        updated_at        = excluded.updated_at,
        closed_at         = excluded.closed_at,
        milestone         = excluded.milestone,
        is_stub           = excluded.is_stub,
        lane              = excluded.lane,
        priority          = excluded.priority,
        size              = excluded.size,
        status            = excluded.status,
        has_active_branch = excluded.has_active_branch
"""

# Webhook upsert: used by corpus.mutations for webhook payload data.
# The `issues` event payload is always complete for milestone + labels (GitHub
# re-emits the full issue object on every action, including milestoned /
# demilestoned / labeled / unlabeled), so we propagate them through on
# conflict.  Only `status` is preserved on conflict — it comes from a
# GitHub Project v2 board, not from the `issues` payload, and would otherwise
# get clobbered to NULL.
UPSERT_ISSUE_FROM_WEBHOOK_SQL = """
    INSERT INTO issues
        (key, repo, number, title, state, url, created_at, updated_at, closed_at,
         milestone, is_stub, lane, priority, size, status, has_active_branch)
    VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, 0, ?, ?, ?, NULL, 0)
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
        size       = excluded.size
"""

DELETE_LABELS_SQL = "DELETE FROM labels WHERE issue_key = ?"
INSERT_LABEL_SQL = "INSERT OR IGNORE INTO labels (issue_key, name) VALUES (?, ?)"

DELETE_EDGES_BY_KIND_SQL = (
    "DELETE FROM edges WHERE (src_key = ? OR dst_key = ?) AND kind = ?"
)
INSERT_EDGE_SQL = (
    "INSERT OR IGNORE INTO edges (src_key, dst_key, kind) VALUES (?, ?, ?)"
)
DELETE_EDGE_SQL = "DELETE FROM edges WHERE src_key = ? AND dst_key = ? AND kind = ?"

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


def extract_from_labels(labels: list[str]) -> dict[str, str | None]:
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
            issue.get("has_active_branch", 0),
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
            issue.update(extract_from_labels(labels))
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
    """Return list of (owner, name) for every active public repo in the org.

    Excludes archived and private repos (filtered at the GraphQL query level).
    """
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


def run_single_repo_sync(conn: sqlite3.Connection, repo: str) -> dict[str, int]:
    """Sync ONE repo. Used by webhook-driven heal — does NOT enumerate the
    org and does NOT run closed_hop_pass (those stay in the hourly run_sync).

    Args:
        conn: SQLite connection.
        repo: Repository in 'owner/name' form (e.g. 'Roxabi/lyra').

    Returns counts: {"pages": N, "issues": N}.

    Raises ValueError on malformed repo.
    """
    owner, sep, name = repo.partition("/")
    if not owner or not sep or not name:
        raise ValueError(f"repo must be in 'owner/name' form, got: {repo!r}")
    row = conn.execute(
        "SELECT last_synced_at FROM sync_state WHERE repo = ?",
        (repo,),
    ).fetchone()
    since: str | None = row[0] if row else None
    return run_repo_sync(conn, owner, name, since=since)


def run_sync(conn: sqlite3.Connection, org: str, full: bool = False) -> dict[str, int]:
    """Org-wide sync: enumerate repos, per-repo sync with since cursor, closed-hop pass.

    Args:
        conn: SQLite connection.
        org: GitHub organization name.
        full: If True, ignore since cursor and fetch all issues.

    Returns counts: {"repos": N, "pages": N, "issues": N, "stubs": N, "errors": N}.
    """
    repos = enumerate_org_repos(org)

    # Filter by allowlist; warn and bail if empty.
    allowlist = {row[0] for row in conn.execute("SELECT repo FROM repo_allowlist")}
    if not allowlist:
        print(
            "[corpus] repo_allowlist is empty — nothing to sync."
            " Add repos with `corpus repo add OWNER/NAME`.",
            file=sys.stderr,
        )
        return {
            "repos": 0,
            "pages": 0,
            "issues": 0,
            "stubs": 0,
            "errors": 0,
            "pruned": 0,
        }
    repos = [(o, n) for (o, n) in repos if f"{o}/{n}" in allowlist]

    active_keys = {f"{owner}/{name}" for owner, name in repos}
    cur = conn.execute("SELECT repo FROM sync_state")
    stale = [row[0] for row in cur.fetchall() if row[0] not in active_keys]
    if stale:
        conn.executemany("DELETE FROM sync_state WHERE repo = ?", [(k,) for k in stale])
        conn.commit()
        print(
            f"[corpus] pruned {len(stale)} stale sync_state row(s): {stale}",
            file=sys.stderr,
        )
    total: dict[str, int] = {
        "repos": len(repos),
        "pages": 0,
        "issues": 0,
        "stubs": 0,
        "errors": 0,
        "pruned": len(stale),
    }
    for owner, name in repos:
        row = conn.execute(
            "SELECT last_synced_at FROM sync_state WHERE repo = ?",
            (f"{owner}/{name}",),
        ).fetchone()
        since = None if full else (row[0] if row else None)
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


def sync_branches(repo: str, conn: sqlite3.Connection) -> None:
    """Compute has_active_branch flag for all issues in `repo` based on live refs.

    Paginates repository.refs(refPrefix: "refs/heads/") via GraphQL, applies
    BRANCH_ISSUE_RE to each branch name, then writes:
    - has_active_branch=1 for issues whose number appears in any matched branch
    - has_active_branch=0 for all other issues in this repo

    Args:
        repo: Repository in 'owner/name' form (e.g. 'Roxabi/lyra').
        conn: SQLite connection (caller controls the transaction).

    Raises:
        ValueError: If repo is not in 'owner/name' form.
        GraphQLError: On network or auth failure.
    """
    owner, sep, name = repo.partition("/")
    if not owner or not sep or not name:
        raise ValueError(f"repo must be in 'owner/name' form, got: {repo!r}")

    matched_numbers: set[int] = set()
    cursor: str | None = None

    while True:
        response = gh_graphql(
            REFS_QUERY,
            {"owner": owner, "name": name, "cursor": cursor},
        )
        refs_page = response["data"]["repository"]["refs"]
        for node in refs_page["nodes"]:
            m = BRANCH_ISSUE_RE.match(node["name"])
            if m:
                matched_numbers.add(int(m.group(1)))

        page_info = refs_page["pageInfo"]
        if page_info["hasNextPage"]:
            cursor = page_info["endCursor"]
        else:
            break

    if matched_numbers:
        placeholders = ",".join("?" * len(matched_numbers))
        conn.execute(
            f"UPDATE issues SET has_active_branch=1"
            f" WHERE repo=? AND number IN ({placeholders})",
            (repo, *matched_numbers),
        )
        conn.execute(
            f"UPDATE issues SET has_active_branch=0"
            f" WHERE repo=? AND number NOT IN ({placeholders})",
            (repo, *matched_numbers),
        )
    else:
        conn.execute(
            "UPDATE issues SET has_active_branch=0 WHERE repo=?",
            (repo,),
        )


def sync_prs(repo: str, conn: sqlite3.Connection) -> None:
    """Sync pr_state table with open PRs for `repo`.

    Paginates repository.pullRequests(states: OPEN) via GraphQL and upserts
    each PR into pr_state. Computes:
    - has_reviewed_label: 1 if any label name is exactly 'reviewed', else 0
    - closing_issue_keys: JSON array of 'owner/repo#N' strings from
      closingIssuesReferences nodes
    - updated_at: current UTC timestamp

    Args:
        repo: Repository in 'owner/name' form (e.g. 'Roxabi/lyra').
        conn: SQLite connection (caller controls the transaction).

    Raises:
        ValueError: If repo is not in 'owner/name' form.
        GraphQLError: On network or auth failure.
    """
    owner, sep, name = repo.partition("/")
    if not owner or not sep or not name:
        raise ValueError(f"repo must be in 'owner/name' form, got: {repo!r}")

    upsert_sql = """
        INSERT INTO pr_state
            (repo, number, state, has_reviewed_label, closing_issue_keys, updated_at)
        VALUES
            (?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo, number) DO UPDATE SET
            state               = excluded.state,
            has_reviewed_label  = excluded.has_reviewed_label,
            closing_issue_keys  = excluded.closing_issue_keys,
            updated_at          = excluded.updated_at
    """

    cursor: str | None = None
    now_iso = datetime.now(timezone.utc).isoformat()

    while True:
        response = gh_graphql(
            PRS_QUERY,
            {"owner": owner, "name": name, "cursor": cursor},
        )
        prs_page = response["data"]["repository"]["pullRequests"]

        for pr in prs_page["nodes"]:
            label_names = [lbl["name"] for lbl in pr["labels"]["nodes"]]
            has_reviewed_label = 1 if "reviewed" in label_names else 0

            closing_refs = pr.get("closingIssuesReferences", {}).get("nodes", [])
            closing_issue_keys: list[str] = [
                f"{ref['repository']['nameWithOwner']}#{ref['number']}"
                for ref in closing_refs
            ]

            conn.execute(
                upsert_sql,
                (
                    repo,
                    pr["number"],
                    pr["state"].lower(),
                    has_reviewed_label,
                    json.dumps(closing_issue_keys),
                    now_iso,
                ),
            )

        page_info = prs_page["pageInfo"]
        if page_info["hasNextPage"]:
            cursor = page_info["endCursor"]
        else:
            break
