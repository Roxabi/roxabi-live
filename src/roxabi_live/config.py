"""Central configuration for roxabi_live.

Single source of truth for all environment-variable-based settings.
All consumers (api, webhook, reconciler, app) should read from a
Settings instance rather than calling os.environ.get() directly.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Mapping

if TYPE_CHECKING:
    from fastapi import Request

_DEFAULT_DB = Path.home() / ".roxabi" / "corpus.db"
_DEFAULT_ORG = "Roxabi"
_DEFAULT_INTERVAL = 3600.0


@dataclass(frozen=True)
class Settings:
    """Immutable application settings derived from environment variables."""

    corpus_db_path: Path
    github_org: str
    github_webhook_secret: str
    corpus_sync_interval_seconds: float

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        """Build a Settings instance from environment variables.

        Args:
            env: Mapping to read from. Defaults to ``os.environ``.
                 Pass a plain dict in tests for isolation.

        Returns:
            Frozen :class:`Settings` instance.
        """
        if env is None:
            env = os.environ

        raw_interval = env.get("CORPUS_SYNC_INTERVAL_SECONDS", "")
        if raw_interval:
            try:
                interval = float(raw_interval)
            except ValueError as exc:
                raise ValueError(
                    f"CORPUS_SYNC_INTERVAL_SECONDS={raw_interval!r}"
                    " is not a valid float"
                ) from exc
        else:
            interval = _DEFAULT_INTERVAL

        return cls(
            corpus_db_path=Path(env.get("CORPUS_DB_PATH", _DEFAULT_DB)),
            github_org=env.get("GITHUB_ORG", _DEFAULT_ORG),
            github_webhook_secret=env.get("GITHUB_WEBHOOK_SECRET", ""),
            corpus_sync_interval_seconds=interval,
        )


def get_settings(request: Request) -> Settings:
    """FastAPI-friendly resolver for app settings.

    Reads from ``request.app.state.settings`` when the lifespan has run, and
    falls back to ``Settings.from_env()`` for tests that bypass lifespan
    (e.g. bare ``TestClient(app)`` without a ``with`` block).
    """
    settings: Settings | None = getattr(request.app.state, "settings", None)
    if settings is not None:
        return settings
    return Settings.from_env()
