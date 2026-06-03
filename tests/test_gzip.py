"""Assert GZipMiddleware compresses GET /api/graph responses.

httpx auto-decodes the body but preserves the Content-Encoding response header,
so we assert on the header.  /api/graph easily exceeds minimum_size=1000 bytes.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from roxabi_live.app import app
from roxabi_live.corpus.schema import SCHEMA_SQL

_COLUMNS = (
    "key, repo, number, title, state, url, "
    "milestone, lane, priority, size, status, is_stub"
)


def _row(i: int) -> tuple[object, ...]:
    """One issue row with enough text to bulk up the JSON payload."""
    return (
        f"Roxabi/lyra#{i}",
        "Roxabi/lyra",
        i,
        f"Issue title number {i} — a longer title to bulk up the payload",
        "OPEN",
        f"https://github.com/Roxabi/lyra/issues/{i}",
        "M0 — NATS hardening",
        "infra",
        "P1",
        "M",
        "In Progress",
        0,
    )


# 20 issues comfortably exceed GZipMiddleware's minimum_size=1000 threshold.
_ROWS = [_row(i) for i in range(1, 21)]
_INSERT_ISSUES = f"INSERT INTO issues ({_COLUMNS}) VALUES ({', '.join('?' * 12)})"


@pytest.fixture()
def graph_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Temp SQLite DB populated with 20 issues so the JSON exceeds 1000 bytes.

    GZipMiddleware only compresses responses above minimum_size=1000.  An empty
    graph (23 bytes) would not be compressed; 20 issues comfortably exceed the
    threshold (each node serialises to ~300 bytes).
    """
    db_path = tmp_path / "corpus_gzip_test.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_SQL)
    conn.executemany(_INSERT_ISSUES, _ROWS)
    conn.commit()
    conn.close()
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))
    return db_path


@pytest.mark.asyncio
async def test_api_graph_gzip_compressed(graph_db: Path) -> None:
    """/api/graph with Accept-Encoding: gzip must return Content-Encoding: gzip."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/graph", headers={"Accept-Encoding": "gzip"})

    assert response.status_code == 200
    assert response.headers.get("content-encoding") == "gzip"
