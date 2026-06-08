"""v6 API — build graph JSON from the corpus DB.

Returns ``{nodes, edges}``. No HTML, no templates.
The dashboard FastAPI app exposes this via ``GET /api/graph``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal, TypedDict

import aiosqlite

from .parse import parse_milestone

_LANE_LABEL_PREFIX = "graph:lane/"

DevState = Literal["idle", "dev", "pr_open", "pr_reviewed"]


def _lane_from_labels(labels: list[str]) -> str | None:
    """Fallback: derive lane from `graph:lane/X` label when board field unset."""
    for lbl in labels:
        if lbl.startswith(_LANE_LABEL_PREFIX):
            return lbl[len(_LANE_LABEL_PREFIX) :]
    return None


def _compute_dev_state(
    issue_state: str,
    has_active_branch: int,
    open_prs: list[dict[str, int]],
) -> DevState:
    """Compute dev_state for a single issue node.

    Priority (highest wins):
      pr_reviewed — any open PR linked to this issue has has_reviewed_label=1
      pr_open     — any open PR linked to this issue (no reviewed label)
      dev         — has_active_branch=1, no open PR
      idle        — no branch, no open PR; also forced for closed issues
    """
    if issue_state == "closed":
        return "idle"
    if any(pr["has_reviewed_label"] for pr in open_prs):
        return "pr_reviewed"
    if open_prs:
        return "pr_open"
    if has_active_branch:
        return "dev"
    return "idle"


class Node(TypedDict):
    key: str
    repo: str
    number: int
    title: str | None
    state: str
    dev_state: DevState
    url: str | None
    milestone: str | None
    milestone_code: str | None
    milestone_name: str | None
    milestone_sort_key: int
    labels: list[str]
    priority: str | None
    lane: str | None
    size: str | None
    status: str | None
    is_stub: bool


class Edge(TypedDict):
    src: str
    dst: str
    kind: str


class GraphPayload(TypedDict):
    nodes: list[Node]
    edges: list[Edge]


async def build_graph_json(db_path: Path) -> GraphPayload:
    """Read the corpus DB and project issues + deps as a graph payload."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row

        labels_by_issue: dict[str, list[str]] = {}
        async with db.execute("SELECT issue_key, name FROM labels") as cur:
            async for row in cur:
                labels_by_issue.setdefault(row["issue_key"], []).append(row["name"])

        # Fetch all open PRs with their closing_issue_keys once; compute per-issue
        # dev_state in Python. This avoids complex SQL LIKE/JSON joins and keeps
        # the logic readable + testable without SQL string gymnastics.
        # Structure: {issue_key: [{"has_reviewed_label": 0|1}, ...]}
        open_prs_by_issue: dict[str, list[dict[str, int]]] = {}
        async with db.execute(
            "SELECT closing_issue_keys, has_reviewed_label FROM pr_state"
            " WHERE state = 'open'"
        ) as cur:
            async for row in cur:
                raw = row["closing_issue_keys"]
                if not raw:
                    continue
                try:
                    keys: list[str] = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                pr_info = {"has_reviewed_label": int(row["has_reviewed_label"])}
                for key in keys:
                    open_prs_by_issue.setdefault(key, []).append(pr_info)

        nodes: list[Node] = []
        async with db.execute(
            "SELECT key, repo, number, title, state, url, milestone, "
            "lane, priority, size, status, is_stub, has_active_branch FROM issues"
        ) as cur:
            async for row in cur:
                issue_labels = labels_by_issue.get(row["key"], [])
                milestone_code, milestone_name, milestone_sort_key = parse_milestone(
                    row["milestone"]
                )
                open_prs = open_prs_by_issue.get(row["key"], [])
                dev_state = _compute_dev_state(
                    issue_state=row["state"],
                    has_active_branch=int(row["has_active_branch"] or 0),
                    open_prs=open_prs,
                )
                nodes.append(
                    Node(
                        key=row["key"],
                        repo=row["repo"],
                        number=row["number"],
                        title=row["title"],
                        state=row["state"],
                        dev_state=dev_state,
                        url=row["url"],
                        milestone=row["milestone"],
                        milestone_code=milestone_code,
                        milestone_name=milestone_name,
                        milestone_sort_key=milestone_sort_key,
                        labels=issue_labels,
                        priority=row["priority"],
                        lane=row["lane"] or _lane_from_labels(issue_labels),
                        size=row["size"],
                        status=row["status"],
                        is_stub=bool(row["is_stub"]),
                    )
                )

        edges: list[Edge] = []
        async with db.execute("SELECT src_key, dst_key, kind FROM edges") as cur:
            async for row in cur:
                edges.append(
                    Edge(src=row["src_key"], dst=row["dst_key"], kind=row["kind"])
                )

    return GraphPayload(nodes=nodes, edges=edges)
