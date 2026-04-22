"""v6 API — build graph JSON from the corpus DB.

Returns ``{nodes, edges, matrix}``. No HTML, no templates.
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
    title: str
    state: str
    lane: str | None
    milestone: str | None
    size: str | None


class Edge(TypedDict):
    src: str
    dst: str
    kind: str  # "blocks" | "parent" | "child"


class GraphPayload(TypedDict):
    nodes: list[Node]
    edges: list[Edge]


async def build_graph_json(db_path: Path) -> GraphPayload:
    """Read the corpus DB and project issues + deps as a graph payload.

    Schema mirrors what the frontend expects. Pure read; no writes.
    """
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        nodes: list[Node] = []
        async with db.execute(
            "SELECT key, repo, number, title, state, lane, milestone, size FROM issues"
        ) as cur:
            async for row in cur:
                nodes.append(
                    Node(
                        key=row["key"],
                        repo=row["repo"],
                        number=row["number"],
                        title=row["title"],
                        state=row["state"],
                        lane=row["lane"],
                        milestone=row["milestone"],
                        size=row["size"],
                    )
                )

        edges: list[Edge] = []
        async with db.execute("SELECT src_key, dst_key, kind FROM issue_edges") as cur:
            async for row in cur:
                edges.append(
                    Edge(src=row["src_key"], dst=row["dst_key"], kind=row["kind"])
                )

    return GraphPayload(nodes=nodes, edges=edges)
