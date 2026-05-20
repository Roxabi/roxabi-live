"""Tests for `corpus repo` subcommand (add / remove / list)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from roxabi_live.corpus.cli import main
from roxabi_live.corpus.schema import bootstrap


def _allowlist(db_path: Path) -> list[str]:
    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT repo FROM repo_allowlist ORDER BY repo").fetchall()
    conn.close()
    return [r[0] for r in rows]


def test_repo_list_empty(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    rc = main(["--db", str(db_path), "repo", "list"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "(empty)" in out


def test_repo_add(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    rc = main(["--db", str(db_path), "repo", "add", "Roxabi/lyra"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "added Roxabi/lyra" in out
    assert _allowlist(db_path) == ["Roxabi/lyra"]


def test_repo_add_idempotent(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    main(["--db", str(db_path), "repo", "add", "Roxabi/lyra"])
    capsys.readouterr()
    rc = main(["--db", str(db_path), "repo", "add", "Roxabi/lyra"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "already present Roxabi/lyra" in out
    assert _allowlist(db_path) == ["Roxabi/lyra"]


def test_repo_remove(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    main(["--db", str(db_path), "repo", "add", "Roxabi/lyra"])
    capsys.readouterr()
    rc = main(["--db", str(db_path), "repo", "remove", "Roxabi/lyra"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "removed Roxabi/lyra" in out
    assert _allowlist(db_path) == []


def test_repo_remove_missing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    rc = main(["--db", str(db_path), "repo", "remove", "Roxabi/lyra"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "not in allowlist Roxabi/lyra" in out


def test_repo_list_with_entries(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    main(["--db", str(db_path), "repo", "add", "Roxabi/lyra"])
    main(["--db", str(db_path), "repo", "add", "Roxabi/voiceCLI"])
    capsys.readouterr()
    rc = main(["--db", str(db_path), "repo", "list"])
    out = capsys.readouterr().out
    assert rc == 0
    lines = [line for line in out.splitlines() if line]
    assert "Roxabi/lyra" in lines
    assert "Roxabi/voiceCLI" in lines


def test_repo_add_invalid_format(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    rc = main(["--db", str(db_path), "repo", "add", "notaslash"])
    err = capsys.readouterr().err
    assert rc == 1
    assert "OWNER/NAME" in err


def test_repo_remove_invalid_format(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    rc = main(["--db", str(db_path), "repo", "remove", "bad format!"])
    err = capsys.readouterr().err
    assert rc == 1
    assert "OWNER/NAME" in err
