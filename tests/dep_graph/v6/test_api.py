"""Smoke test for v6 graph API."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from roxabi_live.dep_graph.v6.api import build_graph_json


@pytest.fixture()
def db(tmp_path: Path) -> Path:
    p = tmp_path / "corpus.db"
    conn = sqlite3.connect(p)
    conn.executescript(
        """
        CREATE TABLE issues (
            key TEXT PRIMARY KEY,
            repo TEXT, number INTEGER, title TEXT, state TEXT,
            lane TEXT, milestone TEXT, size TEXT
        );
        CREATE TABLE issue_edges (
            src_key TEXT, dst_key TEXT, kind TEXT
        );
        INSERT INTO issues VALUES
          ('Roxabi/x#1', 'Roxabi/x', 1, 't1', 'OPEN', 'core', 'M1', 'S'),
          ('Roxabi/x#2', 'Roxabi/x', 2, 't2', 'OPEN', 'core', 'M1', 'M');
        INSERT INTO issue_edges VALUES ('Roxabi/x#2', 'Roxabi/x#1', 'blocks');
        """
    )
    conn.commit()
    conn.close()
    return p


async def test_build_graph_json_returns_nodes_and_edges(db: Path) -> None:
    payload = await build_graph_json(db)
    assert len(payload["nodes"]) == 2
    assert len(payload["edges"]) == 1
    assert payload["edges"][0]["kind"] == "blocks"
