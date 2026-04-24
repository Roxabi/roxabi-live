"""POST /webhook/github — GitHub webhook dispatcher."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

import aiosqlite
from fastapi import APIRouter, Header, HTTPException, Request

from roxabi_live.config import Settings
from roxabi_live.webhook import hmac_auth
from roxabi_live.webhook.handlers import handle_deps, handle_issues, handle_sub_issues

if TYPE_CHECKING:
    from roxabi_live.reconciler import TriggerHeal

log = logging.getLogger(__name__)

MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024  # 25 MB

router = APIRouter(tags=["webhook"])


def _get_db_path(request: Request) -> Path:
    """Resolve corpus_db_path from app.state.settings if available."""
    settings: Settings | None = getattr(request.app.state, "settings", None)
    if settings is not None:
        return settings.corpus_db_path
    return Settings.from_env().corpus_db_path


def _get_webhook_secret(request: Request) -> str:
    """Resolve github_webhook_secret from app.state.settings if available."""
    settings: Settings | None = getattr(request.app.state, "settings", None)
    if settings is not None:
        return settings.github_webhook_secret
    return Settings.from_env().github_webhook_secret


def get_trigger_heal(request: Request) -> TriggerHeal:
    """FastAPI dependency: retrieve the injected TriggerHeal from app.state."""
    return request.app.state.trigger_heal  # type: ignore[no-any-return]


async def _read_capped_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > MAX_WEBHOOK_BODY_BYTES:
                log.warning(
                    "webhook content-length %s exceeds cap %d; rejecting",
                    declared,
                    MAX_WEBHOOK_BODY_BYTES,
                )
                raise HTTPException(status_code=413, detail="payload too large")
        except ValueError:
            # Malformed Content-Length — fall through to streaming guard
            pass
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
    try:
        body = await asyncio.wait_for(_read_capped_body(request), timeout=30.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail="request timeout") from None
    secret = _get_webhook_secret(request)
    if not secret:
        raise HTTPException(status_code=503, detail="webhook not configured")
    if not hmac_auth.verify(body, x_hub_signature_256, secret):
        raise HTTPException(status_code=401, detail="invalid signature")

    # Body already read above — parse directly, do not call request.json() again.
    try:
        payload: dict[str, object] = json.loads(body or b"{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid JSON payload") from None

    trigger_heal: TriggerHeal = get_trigger_heal(request)

    async with aiosqlite.connect(_get_db_path(request)) as conn:
        if x_github_event == "issues":
            await handle_issues(payload, conn)
            repo: str = str(payload["repository"]["full_name"])  # type: ignore[index]
            await trigger_heal(repo, conn)
        elif x_github_event == "issue_dependencies":
            await handle_deps(payload, conn)
            repo = str(payload["repository"]["full_name"])  # type: ignore[index]
            await trigger_heal(repo, conn)
        elif x_github_event == "sub_issues":
            await handle_sub_issues(payload, conn)
            repo = str(payload["repository"]["full_name"])  # type: ignore[index]
            await trigger_heal(repo, conn)
        else:
            return {"ok": True, "ignored": x_github_event}

    return {"ok": True}
