"""v6 API — build graph JSON from the corpus DB.

Returns ``{nodes, edges}``. No HTML, no templates.
The dashboard FastAPI app exposes this via ``GET /api/graph``.
"""

from __future__ import annotations

from pathlib import Path
from typing import TypedDict

import aiosqlite

from .parse import derive_lane_size, derive_priority, parse_milestone


class Node(TypedDict):
    key: str
    repo: str
    number: int
    title: str | None
    state: str
    url: str | None
    milestone: str | None
    milestone_code: str | None
    milestone_name: str | None
    milestone_sort_key: int
    labels: list[str]
    priority: str | None
    lane: str | None
    size: str | None
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

        nodes: list[Node] = []
        async with db.execute(
            "SELECT key, repo, number, title, state, url, milestone, is_stub "
            "FROM issues"
        ) as cur:
            async for row in cur:
                issue_labels = labels_by_issue.get(row["key"], [])
                milestone_code, milestone_name, milestone_sort_key = parse_milestone(
                    row["milestone"]
                )
                lane, size = derive_lane_size(issue_labels)
                nodes.append(
                    Node(
                        key=row["key"],
                        repo=row["repo"],
                        number=row["number"],
                        title=row["title"],
                        state=row["state"],
                        url=row["url"],
                        milestone=row["milestone"],
                        milestone_code=milestone_code,
                        milestone_name=milestone_name,
                        milestone_sort_key=milestone_sort_key,
                        labels=issue_labels,
                        priority=derive_priority(issue_labels),
                        lane=lane,
                        size=size,
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
