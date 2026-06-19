import { Hono } from "hono";
import type { Env } from "./types";
import { versionRoute } from "./api/version";
import { graphRoute } from "./api/graph";
import { listIssuesRoute, getIssueRoute } from "./api/issues";
import { adminSyncRoute } from "./api/admin";
import { webhookRoute } from "./webhook/handlers";
import { checkAdminAuth } from "./api/auth";
import { loginRoute, callbackRoute } from "./auth/oauth";
import { authResetRoute } from "./auth/reset";
import { dashboardRoute } from "./auth/dashboard-route";
import { meRoute, logoutRoute } from "./api/me";
import type { AuthEnv } from "./auth/types";
import { requireSession, requireLinkedTenant } from "./auth/session";
import { installCompleteRoute } from "./api/install-complete";
import { activeTenantRoute } from "./api/active-tenant";
import { zkOptInRoute } from "./api/zk-opt-in";
import { listZkPayloadsRoute, putZkPayloadsRoute } from "./api/zk-payloads";
import { consumeZkHandoffRoute } from "./api/zk-handoff";
import { consumeZkReauthRoute } from "./api/zk-reauth";
import {
  getZkKeyBackupRoute,
  putZkKeyBackupRoute,
} from "./api/zk-key-backup";
import { postZkResetRoute } from "./api/zk-reset";
import { zkGithubGraphqlRoute } from "./api/zk-github-proxy";
import { syncStatusRoute } from "./api/sync-status";

const app = new Hono<AuthEnv>();

// ── API routes — evaluated BEFORE the ASSETS fallback ───────────────────────
// S1 scaffold wires /health + /api/version. S5 (#97) adds POST /webhook/github.
// S6 (#98) adds /api/graph, /api/issues, /api/issues/*, /admin/sync.
app.get("/api/version", versionRoute);

// POST /webhook/github — HMAC-verified GitHub org webhooks (S5, #97).
app.post("/webhook/github", webhookRoute);

// GET /api/graph — v6 graph payload: nodes + edges (S6, #98). Session-gated (#148).
app.use("/api/graph", requireLinkedTenant);
app.get("/api/graph", graphRoute);

// GET /api/issues — list with optional repo/state/label/limit/offset filters (S6, #98).
// GET /api/issues/* — single issue by key (key contains owner/repo#N slash) (S6, #98).
// List route MUST be registered before the wildcard so Hono's first-match wins.
// Both paths need their own use() — /api/issues/* does NOT match bare /api/issues (#148).
app.use("/api/issues", requireLinkedTenant);
app.use("/api/issues/*", requireLinkedTenant);
app.get("/api/issues", listIssuesRoute);
app.get("/api/issues/*", getIssueRoute);

// ── /admin/* — defense-in-depth ADMIN_TOKEN gate (#123) ─────────────────────
// When ADMIN_TOKEN is set, ALL /admin/* requests must carry
// `Authorization: Bearer <token>`. Unset = gate disabled (edge Access only).
// This middleware fires before any /admin route handler so future admin routes
// are automatically covered without each handler needing its own auth check.
app.use("/admin/*", async (c, next) => {
  const deny = checkAdminAuth(c.req.raw, c.env.ADMIN_TOKEN);
  if (deny) return deny;
  await next();
});

// POST /admin/sync — out-of-band sync trigger (#123: token-gated above).
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

// ── Auth routes (#145, S2) ───────────────────────────────────────────────────
app.get("/login", loginRoute);
app.get("/oauth/callback", callbackRoute);
app.get("/auth/reset", authResetRoute);
app.get("/install/complete", installCompleteRoute);
app.use("/api/me", requireSession);
app.get("/api/me", meRoute);
app.use("/api/sync/status", requireLinkedTenant);
app.get("/api/sync/status", syncStatusRoute);
app.post("/api/active-tenant", requireLinkedTenant, activeTenantRoute);
app.post("/api/zk-opt-in", requireLinkedTenant, zkOptInRoute);
app.use("/api/zk/payloads", requireLinkedTenant);
app.get("/api/zk/payloads", listZkPayloadsRoute);
app.put("/api/zk/payloads", putZkPayloadsRoute);
app.post("/api/zk/consume-handoff", requireLinkedTenant, consumeZkHandoffRoute);
app.post("/api/zk/consume-reauth", requireLinkedTenant, consumeZkReauthRoute);
app.use("/api/zk/key-backup", requireLinkedTenant);
app.get("/api/zk/key-backup", getZkKeyBackupRoute);
app.put("/api/zk/key-backup", putZkKeyBackupRoute);
app.use("/api/zk/reset", requireLinkedTenant);
app.post("/api/zk/reset", postZkResetRoute);
app.post("/api/zk/github/graphql", requireLinkedTenant, zkGithubGraphqlRoute);
// /logout is intentionally ungated: logoutRoute is null-safe + idempotent, and SameSite=Strict
// blocks cross-site cookie submission — gating it would make a stale/expired cookie impossible to clear.
app.post("/logout", logoutRoute);

// GET /dashboard — session-gated app shell (HTML only; JS/CSS served from ASSETS root).
app.get("/dashboard", dashboardRoute);
app.get("/dashboard/", dashboardRoute);

// ── Static-assets fallback — last resort (frontend populated in S7, #99) ────
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export { app };
