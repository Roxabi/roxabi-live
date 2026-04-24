"""Webhook event handlers for GitHub `issues`, `issue_dependencies`, and `sub_issues` events."""  # noqa: E501

from __future__ import annotations

from typing import Any, cast

import aiosqlite

from roxabi_live.corpus.mutations import (
    add_edge_async,
    delete_issue_async,
    remove_edge_async,
    replace_labels_async,
    upsert_issue_async,
)


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

    # Build partial from webhook payload (non-payload columns preserved by SQL)
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
    }
    await upsert_issue_async(conn, issue_partial)

    raw_labels: list[Any] = issue.get("labels") or []
    names: list[str] = []
    for label in raw_labels:
        if isinstance(label, dict):
            names.append(str(cast(dict[str, Any], label)["name"]))
        else:
            names.append(str(label))

    await replace_labels_async(conn, key, names)
    await conn.commit()


async def handle_deps(payload: dict[str, Any], conn: aiosqlite.Connection) -> None:
    """Process a GitHub `issue_dependencies` webhook event.

    Acted upon: blocked_by_added, blocked_by_removed.
    Ignored (duplicate-direction): blocking_added, blocking_removed.
    """
    action = payload.get("action")

    if action in ("blocking_added", "blocking_removed"):
        return

    if action == "blocked_by_added":
        blocker = payload["blocking_issue"]
        blocked = payload["issue"]
        blocker_key = f"{blocker['repository']['full_name']}#{blocker['number']}"
        blocked_key = f"{blocked['repository']['full_name']}#{blocked['number']}"
        await add_edge_async(conn, blocker_key, blocked_key, "blocks")
        await conn.commit()
        return

    if action == "blocked_by_removed":
        blocker = payload["blocking_issue"]
        blocked = payload["issue"]
        blocker_key = f"{blocker['repository']['full_name']}#{blocker['number']}"
        blocked_key = f"{blocked['repository']['full_name']}#{blocked['number']}"
        await remove_edge_async(conn, blocker_key, blocked_key, "blocks")
        await conn.commit()


async def handle_sub_issues(
    payload: dict[str, Any], conn: aiosqlite.Connection
) -> None:
    """Process a GitHub `sub_issues` webhook event.

    Acted upon: sub_issue_added, sub_issue_removed.
    Ignored (duplicate-direction): parent_issue_added, parent_issue_removed.
    """
    action = payload.get("action")

    if action in ("parent_issue_added", "parent_issue_removed"):
        return

    if action == "sub_issue_added":
        parent = payload["issue"]
        child = payload["sub_issue"]
        parent_key = f"{parent['repository']['full_name']}#{parent['number']}"
        child_key = f"{child['repository']['full_name']}#{child['number']}"
        await add_edge_async(conn, parent_key, child_key, "parent")
        await conn.commit()
        return

    if action == "sub_issue_removed":
        parent = payload["issue"]
        child = payload["sub_issue"]
        parent_key = f"{parent['repository']['full_name']}#{parent['number']}"
        child_key = f"{child['repository']['full_name']}#{child['number']}"
        await remove_edge_async(conn, parent_key, child_key, "parent")
        await conn.commit()
