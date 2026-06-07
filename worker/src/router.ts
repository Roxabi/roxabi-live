import { Hono } from "hono";
import type { Env } from "./types";
import { versionRoute } from "./api/version";
import { webhookRoute } from "./webhook/handlers";

const app = new Hono<{ Bindings: Env }>();

// ── API routes — evaluated BEFORE the ASSETS fallback ───────────────────────
// S1 scaffold wires /health + /api/version. S5 (#97) adds POST /webhook/github.
// Remaining slices: S6 (#98) issues/graph, S8 (#100) admin.
app.get("/api/version", versionRoute);

// POST /webhook/github — HMAC-verified GitHub org webhooks (S5, #97).
app.post("/webhook/github", webhookRoute);

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
