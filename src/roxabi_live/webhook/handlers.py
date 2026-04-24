"""Webhook event handlers for GitHub `issues`, `issue_dependencies`, and `sub_issues` events."""  # noqa: E501

from __future__ import annotations

from typing import Any, cast

import aiosqlite


async def handle_issues(payload: dict[str, Any], conn: aiosqlite.Connection) -> None:
    """Process a GitHub `issues` webhook event.

    Supported actions: opened, edited, reopened, labeled, unlabeled, closed, deleted.
    """
    action = payload.get("action")
    issue = payload["issue"]
    repo = payload["repository"]["full_name"]
    key = f"{repo}#{issue['number']}"

    if action == "deleted":
        await conn.execute("DELETE FROM issues WHERE key = ?", (key,))
        await conn.commit()
        return

    await conn.execute(
        """
        INSERT INTO issues
            (key, repo, number, title, state, url, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            title      = excluded.title,
            state      = excluded.state,
            url        = excluded.url,
            updated_at = excluded.updated_at,
            closed_at  = excluded.closed_at
        """,
        (
            key,
            repo,
            issue["number"],
            issue["title"],
            issue["state"],
            issue.get("html_url"),
            issue.get("created_at"),
            issue.get("updated_at"),
            issue.get("closed_at"),
        ),
    )

    await conn.execute("DELETE FROM labels WHERE issue_key = ?", (key,))
    raw_labels: list[Any] = issue.get("labels") or []
    for label in raw_labels:
        if isinstance(label, dict):
            name: str = str(cast(dict[str, Any], label)["name"])
        else:
            name = str(label)
        await conn.execute(
            "INSERT INTO labels (issue_key, name) VALUES (?, ?)", (key, name)
        )

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
        await conn.execute(
            "INSERT OR IGNORE INTO edges (src_key, dst_key, kind)"
            " VALUES (?, ?, 'blocks')",
            (blocker_key, blocked_key),
        )
        await conn.commit()
        return

    if action == "blocked_by_removed":
        blocker = payload["blocking_issue"]
        blocked = payload["issue"]
        blocker_key = f"{blocker['repository']['full_name']}#{blocker['number']}"
        blocked_key = f"{blocked['repository']['full_name']}#{blocked['number']}"
        await conn.execute(
            "DELETE FROM edges WHERE src_key = ? AND dst_key = ? AND kind = 'blocks'",
            (blocker_key, blocked_key),
        )
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
        await conn.execute(
            "INSERT OR IGNORE INTO edges (src_key, dst_key, kind)"
            " VALUES (?, ?, 'parent')",
            (parent_key, child_key),
        )
        await conn.commit()
        return

    if action == "sub_issue_removed":
        parent = payload["issue"]
        child = payload["sub_issue"]
        parent_key = f"{parent['repository']['full_name']}#{parent['number']}"
        child_key = f"{child['repository']['full_name']}#{child['number']}"
        await conn.execute(
            "DELETE FROM edges WHERE src_key = ? AND dst_key = ? AND kind = 'parent'",
            (parent_key, child_key),
        )
        await conn.commit()
