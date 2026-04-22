"""v6 API — build graph JSON from the corpus DB.

Returns ``{nodes, edges}``. No HTML, no templates.
The dashboard FastAPI app exposes this via ``GET /api/graph``.
"""

from __future__ import annotations

from pathlib import Path
from typing import TypedDict

import aiosqlite


class Node(TypedDict):
    key: str
    repo: str
    number: int
    title: str | None
    state: str
    url: str | None
    milestone: str | None
    labels: list[str]
    size: str | None
    priority: str | None
    is_stub: bool


class Edge(TypedDict):
    src: str
    dst: str


class GraphPayload(TypedDict):
    nodes: list[Node]
    edges: list[Edge]


_SIZE_LABELS = {"XS", "S", "M", "L", "XL"}


def _derive_size(labels: list[str]) -> str | None:
    for label in labels:
        if label in _SIZE_LABELS:
            return label
    return None


def _derive_priority(labels: list[str]) -> str | None:
    for label in labels:
        if label.startswith("P") and len(label) >= 2 and label[1].isdigit():
            return label
    return None


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
                nodes.append(
                    Node(
                        key=row["key"],
                        repo=row["repo"],
                        number=row["number"],
                        title=row["title"],
                        state=row["state"],
                        url=row["url"],
                        milestone=row["milestone"],
                        labels=issue_labels,
                        size=_derive_size(issue_labels),
                        priority=_derive_priority(issue_labels),
                        is_stub=bool(row["is_stub"]),
                    )
                )

        edges: list[Edge] = []
        async with db.execute("SELECT src_key, dst_key FROM edges") as cur:
            async for row in cur:
                edges.append(Edge(src=row["src_key"], dst=row["dst_key"]))

    return GraphPayload(nodes=nodes, edges=edges)
