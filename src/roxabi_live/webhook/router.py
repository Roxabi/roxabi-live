"""POST /webhook/github — GitHub webhook dispatcher."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

import aiosqlite
from fastapi import APIRouter, Depends, Header, HTTPException, Request

from roxabi_live.config import get_settings
from roxabi_live.webhook import hmac_auth
from roxabi_live.webhook.handlers import (
    handle_deps,
    handle_issues,
    handle_milestone,
    handle_pull_request,
    handle_ref_create,
    handle_ref_delete,
    handle_sub_issues,
)

if TYPE_CHECKING:
    from roxabi_live.reconciler import TriggerHeal

log = logging.getLogger(__name__)

MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024  # 25 MB

router = APIRouter(tags=["webhook"])


def _get_db_path(request: Request) -> Path:
    return get_settings(request).corpus_db_path


def _get_webhook_secret(request: Request) -> str:
    return get_settings(request).github_webhook_secret


def get_trigger_heal(request: Request) -> TriggerHeal:
    """FastAPI dependency: retrieve the injected TriggerHeal from app.state.

    Raises 503 when lifespan has not run (e.g. bare TestClient(app) without a
    `with` block), mirroring the guard pattern used by `_get_db_path` and
    `_get_webhook_secret`.
    """
    trigger_heal: TriggerHeal | None = getattr(request.app.state, "trigger_heal", None)
    if trigger_heal is None:
        raise HTTPException(status_code=503, detail="trigger_heal not configured")
    return trigger_heal


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
async def github_webhook(  # noqa: PLR0913 C901 — FastAPI deps + branching dispatcher
    request: Request,
    x_github_event: str | None = Header(default=None),
    x_hub_signature_256: str | None = Header(default=None),
    trigger_heal: TriggerHeal = Depends(get_trigger_heal),
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

    db_path = _get_db_path(request)
    async with aiosqlite.connect(db_path) as conn:
        if x_github_event == "issues":
            await handle_issues(payload, conn)
            repo: str = str(payload["repository"]["full_name"])  # type: ignore[index]
            await trigger_heal(repo, conn)
        elif x_github_event == "issue_dependencies":
            delta = await handle_deps(payload, conn)
            repo = str(payload["repository"]["full_name"])  # type: ignore[index]
            await trigger_heal(repo, conn, force=delta > 0)
        elif x_github_event == "sub_issues":
            delta = await handle_sub_issues(payload, conn)
            repo = str(payload["repository"]["full_name"])  # type: ignore[index]
            await trigger_heal(repo, conn, force=delta > 0)
        elif x_github_event == "create":
            await handle_ref_create(payload, conn)
        elif x_github_event == "delete":
            await handle_ref_delete(payload, conn, db_path=db_path)
        elif x_github_event == "pull_request":
            await handle_pull_request(payload, conn)
        elif x_github_event == "milestone":
            await handle_milestone(payload, conn)
        else:
            return {"ok": True, "ignored": x_github_event}

    return {"ok": True}
