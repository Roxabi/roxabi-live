"""FastAPI application factory."""

from fastapi import FastAPI

app = FastAPI(title="Roxabi Dashboard", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check — smoke test only.

    Full implementation (db_reachable, issue_count) lands in spec #866 slice 3.
    """
    return {"status": "ok"}
