"""Smoke test — GET /health returns {"status": "ok"}."""

import pytest
from httpx import ASGITransport, AsyncClient

from roxabi_dashboard.app import app


@pytest.mark.asyncio
async def test_health_ok() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
