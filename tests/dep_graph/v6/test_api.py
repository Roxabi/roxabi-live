"""Smoke test for v6 graph API against the real corpus schema."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from roxabi_live.corpus.schema import SCHEMA_SQL
from roxabi_live.dep_graph.v6.api import build_graph_json


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
          ('Roxabi/x#1', 'Roxabi/x', 1, 't1', 'OPEN', 'https://x/1', 'M1', 0),
          ('Roxabi/x#2', 'Roxabi/x', 2, 't2', 'OPEN', 'https://x/2', 'M1', 0);
        INSERT INTO labels (issue_key, name) VALUES
          ('Roxabi/x#1', 'S'), ('Roxabi/x#1', 'P1-high'),
          ('Roxabi/x#2', 'M');
        INSERT INTO edges (src_key, dst_key) VALUES ('Roxabi/x#2', 'Roxabi/x#1');
        """
    )
    conn.commit()
    conn.close()
    return p


async def test_build_graph_json_returns_nodes_and_edges(db: Path) -> None:
    payload = await build_graph_json(db)
    assert len(payload["nodes"]) == 2
    assert len(payload["edges"]) == 1
    assert payload["edges"][0] == {"src": "Roxabi/x#2", "dst": "Roxabi/x#1"}

    by_key = {n["key"]: n for n in payload["nodes"]}
    assert by_key["Roxabi/x#1"]["size"] == "S"
    assert by_key["Roxabi/x#1"]["priority"] == "P1-high"
    assert by_key["Roxabi/x#2"]["size"] == "M"
