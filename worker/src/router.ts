import { Hono } from "hono";
import type { Env } from "./types";
import { versionRoute } from "./api/version";
import { graphRoute } from "./api/graph";
import { listIssuesRoute, getIssueRoute } from "./api/issues";
import { adminSyncRoute } from "./api/admin";
import { webhookRoute } from "./webhook/handlers";

const app = new Hono<{ Bindings: Env }>();

// ── API routes — evaluated BEFORE the ASSETS fallback ───────────────────────
// S1 scaffold wires /health + /api/version. S5 (#97) adds POST /webhook/github.
// S6 (#98) adds /api/graph, /api/issues, /api/issues/*, /admin/sync.
app.get("/api/version", versionRoute);

// POST /webhook/github — HMAC-verified GitHub org webhooks (S5, #97).
app.post("/webhook/github", webhookRoute);

// GET /api/graph — v6 graph payload: nodes + edges (S6, #98).
app.get("/api/graph", graphRoute);

// GET /api/issues — list with optional repo/state/label/limit/offset filters (S6, #98).
// GET /api/issues/* — single issue by key (key contains owner/repo#N slash) (S6, #98).
// List route MUST be registered before the wildcard so Hono's first-match wins.
app.get("/api/issues", listIssuesRoute);
app.get("/api/issues/*", getIssueRoute);

// POST /admin/sync — out-of-band sync trigger; Access edge enforces OTP (S6, #98).
app.post("/admin/sync", adminSyncRoute);

// GET /health — db reachability + issue count (mirrors Python app.py::health).
app.get("/health", async (c) => {
  let dbReachable = false;
  let issueCount = 0;
  try {
    const row = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM issues",
    ).first<{ n: number }>();
    dbReachable = true;
    issueCount = row?.n ?? 0;
  } catch {
    // db unreachable → report status without failing the request
  }
  return c.json({ status: "ok", db_reachable: dbReachable, issue_count: issueCount });
});

// ── Static-assets fallback — last resort (frontend populated in S7, #99) ────
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export { app };
