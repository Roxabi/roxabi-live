"""Tests for roxabi_live.config.Settings — T1 [RED].

Covers:
- Settings.from_env() reads env vars with defaults.
- Settings.from_env() uses provided env dict for isolation.
- Fields are typed correctly.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from roxabi_live.config import Settings


class TestSettingsFromEnv:
    """Settings.from_env() reads env vars with fallback defaults."""

    def test_defaults_when_no_env_vars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """from_env() returns default values when no relevant env vars are set."""
        monkeypatch.delenv("CORPUS_DB_PATH", raising=False)
        monkeypatch.delenv("GITHUB_ORG", raising=False)
        monkeypatch.delenv("GITHUB_WEBHOOK_SECRET", raising=False)
        monkeypatch.delenv("CORPUS_SYNC_INTERVAL_SECONDS", raising=False)

        s = Settings.from_env()

        assert isinstance(s.corpus_db_path, Path)
        assert s.corpus_db_path == Path.home() / ".roxabi" / "corpus.db"
        assert s.github_org == "Roxabi"
        assert s.github_webhook_secret == ""
        assert s.corpus_sync_interval_seconds == 3600.0

    def test_reads_corpus_db_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """CORPUS_DB_PATH env var sets corpus_db_path."""
        monkeypatch.setenv("CORPUS_DB_PATH", "/tmp/test.db")
        s = Settings.from_env()
        assert s.corpus_db_path == Path("/tmp/test.db")

    def test_reads_github_org(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """GITHUB_ORG env var sets github_org."""
        monkeypatch.setenv("GITHUB_ORG", "MyOrg")
        s = Settings.from_env()
        assert s.github_org == "MyOrg"

    def test_reads_github_webhook_secret(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """GITHUB_WEBHOOK_SECRET env var sets github_webhook_secret."""
        monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "my-secret")
        s = Settings.from_env()
        assert s.github_webhook_secret == "my-secret"

    def test_reads_corpus_sync_interval(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """CORPUS_SYNC_INTERVAL_SECONDS env var sets corpus_sync_interval_seconds."""
        monkeypatch.setenv("CORPUS_SYNC_INTERVAL_SECONDS", "120.5")
        s = Settings.from_env()
        assert s.corpus_sync_interval_seconds == 120.5

    def test_from_env_accepts_env_dict(self) -> None:
        """from_env(env=...) uses provided mapping instead of os.environ."""
        env = {
            "CORPUS_DB_PATH": "/data/corpus.db",
            "GITHUB_ORG": "TestOrg",
            "GITHUB_WEBHOOK_SECRET": "secret123",
            "CORPUS_SYNC_INTERVAL_SECONDS": "1800",
        }
        s = Settings.from_env(env=env)
        assert s.corpus_db_path == Path("/data/corpus.db")
        assert s.github_org == "TestOrg"
        assert s.github_webhook_secret == "secret123"
        assert s.corpus_sync_interval_seconds == 1800.0

    def test_settings_is_frozen(self) -> None:
        """Settings must be a frozen dataclass — mutation raises AttributeError."""
        s = Settings.from_env(env={})
        with pytest.raises((AttributeError, TypeError)):
            s.github_org = "mutate"  # type: ignore[misc]
