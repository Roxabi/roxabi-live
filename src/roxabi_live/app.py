"""FastAPI application factory."""

from fastapi import FastAPI

from roxabi_live.dep_graph.v6.routes import router as dep_graph_v6_router

app = FastAPI(title="Roxabi Live", version="0.1.0")

app.include_router(dep_graph_v6_router)


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check — smoke test only.

    Full implementation (db_reachable, issue_count) lands in spec #866 slice 3.
    """
    return {"status": "ok"}
