"""POST /webhook/github — GitHub webhook dispatcher."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite
from fastapi import APIRouter, Header, HTTPException, Request

from roxabi_live import reconciler
from roxabi_live.webhook import hmac_auth
from roxabi_live.webhook.handlers import handle_deps, handle_issues, handle_sub_issues

log = logging.getLogger(__name__)

MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024  # 25 MB

router = APIRouter(tags=["webhook"])


def _db_path() -> Path:
    return Path(os.environ.get("CORPUS_DB_PATH", Path.home() / ".roxabi" / "corpus.db"))


async def _maybe_trigger_heal(repo: str, conn: aiosqlite.Connection) -> None:
    """Fire-and-forget reconcile if sync_state for repo is stale (> 1h) or missing."""
    cur = await conn.execute(
        "SELECT last_synced_at FROM sync_state WHERE repo = ?", (repo,)
    )
    row = await cur.fetchone()
    now = datetime.now(timezone.utc)
    stale = True
    if row is not None:
        last = datetime.fromisoformat(row[0]) if isinstance(row[0], str) else row[0]
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        stale = (now - last).total_seconds() > 3600
    if stale:
        asyncio.create_task(reconciler.run_once())


async def _read_capped_body(request: Request) -> bytes:
    total = 0
    chunks: list[bytes] = []
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_WEBHOOK_BODY_BYTES:
            log.warning(
                "webhook body exceeded %d bytes; rejecting",
                MAX_WEBHOOK_BODY_BYTES,
            )
            raise HTTPException(status_code=413, detail="payload too large")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/webhook/github")
async def github_webhook(
    request: Request,
    x_github_event: str | None = Header(default=None),
    x_hub_signature_256: str | None = Header(default=None),
) -> dict[str, object]:
    """Receive and dispatch GitHub webhook events."""
    body = await _read_capped_body(request)
    secret = os.environ.get("GITHUB_WEBHOOK_SECRET", "")
    if not secret:
        raise HTTPException(status_code=503, detail="webhook not configured")
    if not hmac_auth.verify(body, x_hub_signature_256, secret):
        raise HTTPException(status_code=401, detail="invalid signature")

    payload = json.loads(body)

    async with aiosqlite.connect(_db_path()) as conn:
        if x_github_event == "issues":
            await handle_issues(payload, conn)
            repo: str = payload["repository"]["full_name"]
            await _maybe_trigger_heal(repo, conn)
        elif x_github_event == "issue_dependencies":
            await handle_deps(payload, conn)
            repo = payload["repository"]["full_name"]
            await _maybe_trigger_heal(repo, conn)
        elif x_github_event == "sub_issues":
            await handle_sub_issues(payload, conn)
            repo = payload["repository"]["full_name"]
            await _maybe_trigger_heal(repo, conn)
        else:
            return {"ok": True, "ignored": x_github_event}

    return {"ok": True}
