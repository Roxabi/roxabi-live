"""Webhook event handlers for GitHub `issues`, `issue_dependencies`, and `sub_issues` events."""  # noqa: E501

from __future__ import annotations

import asyncio
import logging
from typing import Any, cast

import aiosqlite

from roxabi_live.corpus.graphql import GraphQLError, fetch_issue_deps
from roxabi_live.corpus.mutations import (
    add_edge_async,
    delete_issue_async,
    remove_edge_async,
    replace_labels_async,
    upsert_edges_async,
    upsert_issue_async,
)
from roxabi_live.corpus.sync import canonical_key, extract_from_labels

log = logging.getLogger(__name__)


async def handle_issues(payload: dict[str, Any], conn: aiosqlite.Connection) -> None:
    """Process a GitHub `issues` webhook event.

    Supported actions: opened, edited, reopened, labeled, unlabeled, closed, deleted.
    Issue upsert + label replacement are committed atomically: both succeed or
    neither is persisted (SC9).
    """
    action = payload.get("action")
    issue = payload["issue"]
    repo = payload["repository"]["full_name"]
    key = f"{repo}#{issue['number']}"

    if action == "deleted":
        await delete_issue_async(conn, key)
        await conn.commit()
        return

    raw_labels: list[Any] = issue.get("labels") or []
    names: list[str] = []
    for label in raw_labels:
        if isinstance(label, dict):
            names.append(str(cast(dict[str, Any], label)["name"]))
        else:
            names.append(str(label))

    milestone_obj = issue.get("milestone")
    milestone_title: str | None = None
    if isinstance(milestone_obj, dict):
        title_val = cast(dict[str, Any], milestone_obj).get("title")
        milestone_title = str(title_val) if title_val is not None else None
    derived = extract_from_labels(names)

    issue_partial: dict[str, Any] = {
        "key": key,
        "repo": repo,
        "number": issue["number"],
        "title": issue["title"],
        "state": issue["state"],
        "url": issue.get("html_url"),
        "created_at": issue.get("created_at"),
        "updated_at": issue.get("updated_at"),
        "closed_at": issue.get("closed_at"),
        "milestone": milestone_title,
        "lane": derived["lane"],
        "priority": derived["priority"],
        "size": derived["size"],
    }

    # Atomic upsert + label replacement (SC9). aiosqlite's connect()
    # context manager only closes — it does not commit. We do an explicit
    # commit on success and rollback on any exception so a crash between
    # the two writes leaves the prior state intact.
    try:
        await upsert_issue_async(conn, issue_partial)
        await replace_labels_async(conn, key, names)
        await conn.commit()
    except Exception:
        await conn.rollback()
        raise


def _issue_key(
    issue: dict[str, Any], repo_override: dict[str, Any] | None = None
) -> str:
    repo = repo_override or issue.get("repository") or {}
    full_name: str = repo.get("full_name", "")
    return f"{full_name}#{issue['number']}"


async def _point_fetch_and_upsert_deps(
    conn: aiosqlite.Connection,
    blocked_issue: dict[str, Any],
    repo: dict[str, Any],
) -> None:
    """Point-fetch the current blockedBy/blocking state for a single issue and
    upsert edges into corpus.db.

    Used when GitHub omits ``blocking_issue`` from cross-repo dependency
    payloads.  Fetches via GraphQL (1 attempt — no retry loop so auth failures
    surface quickly) and rewrites all ``blocks`` edges for the issue via
    ``upsert_edges_async``.
    """
    number: int = blocked_issue["number"]
    full_name: str = repo.get("full_name", "")
    owner, _, name = full_name.partition("/")
    if not owner or not name:
        log.warning(
            "handle_deps: cannot point-fetch — malformed repository.full_name=%r",
            full_name,
        )
        return

    issue_key = canonical_key(number, full_name)

    try:
        deps = await asyncio.get_event_loop().run_in_executor(
            None, fetch_issue_deps, owner, name, number
        )
    except GraphQLError as exc:
        log.warning("handle_deps: point-fetch failed for %s — %s", issue_key, exc)
        return

    await upsert_edges_async(
        conn,
        issue_key,
        deps["blocked_by"],
        deps["blocking"],
        "blocks",
    )
    await conn.commit()


async def handle_deps(payload: dict[str, Any], conn: aiosqlite.Connection) -> None:
    """Process a GitHub `issue_dependencies` webhook event.

    Acted upon: blocked_by_added, blocked_by_removed.
    Ignored (duplicate-direction): blocking_added, blocking_removed.

    Cross-repo case: GitHub omits ``blocking_issue`` from payloads when the
    blocker is in a different repo.  When that field is absent we fall back to a
    point-fetch of the affected issue's current dependency lists and rewrite all
    its ``blocks`` edges via ``upsert_edges``.
    """
    action = payload.get("action")

    if action in ("blocking_added", "blocking_removed"):
        return

    if action not in ("blocked_by_added", "blocked_by_removed"):
        return

    # GitHub docs list `blocking_issue` + `blocked_issue`; log keys on mismatch to
    # capture the real schema if it ever differs.
    blocking_issue: dict[str, Any] | None = payload.get("blocking_issue")
    blocked_issue: dict[str, Any] | None = (
        payload.get("blocked_issue") or payload.get("issue")  # type: ignore[assignment]
    )
    blocking_repo: dict[str, Any] | None = payload.get("blocking_issue_repo")

    if blocked_issue is None:
        log.warning(
            "handle_deps: unexpected payload shape for %s — keys=%s payload=%s",
            action,
            list(payload.keys()),
            payload,
        )
        return

    # Cross-repo case: blocking_issue absent — point-fetch the downstream issue's
    # current dep graph and derive edges from the authoritative GitHub state.
    if blocking_issue is None:
        repo_obj: dict[str, Any] = payload.get("repository") or {}
        await _point_fetch_and_upsert_deps(conn, blocked_issue, repo_obj)
        return

    # Same-repo fast path: both sides are in the payload — use them directly.
    blocker_key = _issue_key(blocking_issue, blocking_repo)
    blocked_key = _issue_key(blocked_issue, payload.get("repository"))  # type: ignore[arg-type]

    if action == "blocked_by_added":
        await add_edge_async(conn, blocker_key, blocked_key, "blocks")
        await conn.commit()

    elif action == "blocked_by_removed":
        await remove_edge_async(conn, blocker_key, blocked_key, "blocks")
        await conn.commit()


async def handle_sub_issues(
    payload: dict[str, Any], conn: aiosqlite.Connection
) -> None:
    """Process a GitHub `sub_issues` webhook event.

    Acted upon: sub_issue_added, sub_issue_removed.
    Ignored (duplicate-direction): parent_issue_added, parent_issue_removed.

    Per GitHub's webhook docs, the payload uses top-level ``parent_issue`` /
    ``parent_issue_repo`` / ``sub_issue`` / ``sub_issue_repo`` keys.  Repo info
    is NOT nested under the issue objects.  Malformed payloads are logged and
    skipped rather than raising — webhooks must always return 200.
    """
    action = payload.get("action")

    if action in ("parent_issue_added", "parent_issue_removed"):
        return

    if action not in ("sub_issue_added", "sub_issue_removed"):
        return

    parent_issue = payload.get("parent_issue")
    parent_repo = payload.get("parent_issue_repo")
    sub_issue = payload.get("sub_issue")
    sub_repo = payload.get("sub_issue_repo")

    if not (parent_issue and parent_repo and sub_issue and sub_repo):
        log.warning(
            "handle_sub_issues: unexpected payload shape for %s — keys=%s",
            action,
            sorted(payload.keys()),
        )
        return

    try:
        parent_key = f"{parent_repo['full_name']}#{parent_issue['number']}"
        child_key = f"{sub_repo['full_name']}#{sub_issue['number']}"
    except KeyError as exc:
        log.warning(
            "handle_sub_issues: malformed payload for %s — missing %s — keys=%s",
            action,
            exc.args[0] if exc.args else "?",
            sorted(payload.keys()),
        )
        return

    if action == "sub_issue_added":
        await add_edge_async(conn, parent_key, child_key, "parent")
    else:  # sub_issue_removed
        await remove_edge_async(conn, parent_key, child_key, "parent")
    await conn.commit()
