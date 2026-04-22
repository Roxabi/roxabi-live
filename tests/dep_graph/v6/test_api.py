"""Tests for v6 graph API — schema, parse helpers, enriched payload, repos route."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from roxabi_live.corpus.schema import SCHEMA_SQL
from roxabi_live.dep_graph.v6.api import build_graph_json
from roxabi_live.dep_graph.v6.parse import (
    derive_lane_size,
    derive_priority,
    parse_milestone,
)

# ─── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture()
def db(tmp_path: Path) -> Path:
    p = tmp_path / "corpus.db"
    conn = sqlite3.connect(p)
    conn.executescript(SCHEMA_SQL)
    conn.executescript(
        """
        INSERT INTO issues
          (key, repo, number, title, state, url, milestone, is_stub)
        VALUES
          ('Roxabi/x#1', 'Roxabi/x', 1, 't1', 'OPEN', 'https://x/1',
           'M0 — NATS hardening', 0),
          ('Roxabi/x#2', 'Roxabi/x', 2, 't2', 'CLOSED', 'https://x/2',
           'Phase 0 — Foundation', 0),
          ('Roxabi/y#3', 'Roxabi/y', 3, 't3', 'OPEN', 'https://y/3',
           'Final Initiatives', 0);
        INSERT INTO labels (issue_key, name) VALUES
          ('Roxabi/x#1', 'S'),
          ('Roxabi/x#1', 'P1-high'),
          ('Roxabi/x#1', 'graph:lane/infra'),
          ('Roxabi/x#2', 'size:M'),
          ('Roxabi/x#2', 'priority:medium'),
          ('Roxabi/y#3', 'priority:low');
        INSERT INTO edges (src_key, dst_key, kind) VALUES
          ('Roxabi/x#2', 'Roxabi/x#1', 'parent'),
          ('Roxabi/x#1', 'Roxabi/y#3', 'blocks');
        """
    )
    conn.commit()
    conn.close()
    return p


# ─── parse_milestone ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "code", "name", "sort_key"),
    [
        ("M0 — NATS hardening", "M0", "NATS hardening", 0),
        ("M10 — Social Media Bricks", "M10", "Social Media Bricks", 10),
        ("Phase 0 — Foundation", "Ph0", "Foundation", 100),
        ("Phase 5 — Security & Resilience", "Ph5", "Security & Resilience", 105),
        ("Final Initiatives", "FIN", "Final Initiatives", 999),
        (None, None, None, 1000),
        ("unknown text", None, "unknown text", 1000),
    ],
)
def test_parse_milestone(
    raw: str | None,
    code: str | None,
    name: str | None,
    sort_key: int,
) -> None:
    assert parse_milestone(raw) == (code, name, sort_key)


# ─── derive_priority ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("labels", "expected"),
    [
        (["P0"], "P0"),
        (["P1-high"], "P1"),
        (["priority:high"], "P1"),
        (["P2-medium"], "P2"),
        (["priority:medium"], "P2"),
        (["P3-low"], "P3"),
        (["priority:low"], "P3"),
        (["priority: low"], "P3"),
        (["unrelated"], None),
        ([], None),
    ],
)
def test_derive_priority(labels: list[str], expected: str | None) -> None:
    assert derive_priority(labels) == expected


# ─── derive_lane_size ─────────────────────────────────────────────────────────


def test_derive_lane_size_prefixed() -> None:
    lane, size = derive_lane_size(["graph:lane/infra", "size:M"])
    assert lane == "infra"
    assert size == "M"


def test_derive_lane_size_raw_fallback() -> None:
    _, size = derive_lane_size(["S", "some-label"])
    assert size == "S"


def test_derive_lane_size_none() -> None:
    assert derive_lane_size([]) == (None, None)


# ─── build_graph_json ─────────────────────────────────────────────────────────


async def test_nodes_count(db: Path) -> None:
    payload = await build_graph_json(db)
    assert len(payload["nodes"]) == 3


async def test_edge_kinds(db: Path) -> None:
    payload = await build_graph_json(db)
    kinds = {(e["src"], e["dst"]): e["kind"] for e in payload["edges"]}
    assert kinds[("Roxabi/x#2", "Roxabi/x#1")] == "parent"
    assert kinds[("Roxabi/x#1", "Roxabi/y#3")] == "blocks"


async def test_node_milestone_enrichment(db: Path) -> None:
    payload = await build_graph_json(db)
    by_key = {n["key"]: n for n in payload["nodes"]}

    n1 = by_key["Roxabi/x#1"]
    assert n1["milestone_code"] == "M0"
    assert n1["milestone_name"] == "NATS hardening"
    assert n1["milestone_sort_key"] == 0

    n2 = by_key["Roxabi/x#2"]
    assert n2["milestone_code"] == "Ph0"
    assert n2["milestone_name"] == "Foundation"
    assert n2["milestone_sort_key"] == 100

    n3 = by_key["Roxabi/y#3"]
    assert n3["milestone_code"] == "FIN"
    assert n3["milestone_sort_key"] == 999


async def test_node_priority_and_size(db: Path) -> None:
    payload = await build_graph_json(db)
    by_key = {n["key"]: n for n in payload["nodes"]}

    assert by_key["Roxabi/x#1"]["priority"] == "P1"
    assert by_key["Roxabi/x#1"]["size"] == "S"
    assert by_key["Roxabi/x#1"]["lane"] == "infra"

    assert by_key["Roxabi/x#2"]["priority"] == "P2"
    assert by_key["Roxabi/x#2"]["size"] == "M"

    assert by_key["Roxabi/y#3"]["priority"] == "P3"


# ─── /api/repos route ─────────────────────────────────────────────────────────


async def test_get_repos(db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CORPUS_DB_PATH", str(db))

    # Import app after env is set so _db_path() resolves correctly
    from roxabi_live.app import app

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/repos")

    assert resp.status_code == 200
    repos = resp.json()
    assert repos == ["Roxabi/x", "Roxabi/y"]
