"""v6 — API-first dep-graph.

Serves graph data as JSON via ``/api/graph``; frontend renders client-side.
Async aiosqlite against the corpus DB; no Jinja, no static HTML build step.
Milestones/columns are configurable (not hardcoded per-project).
"""
