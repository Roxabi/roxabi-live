import { Hono } from "hono";
import { activeTenantRoute } from "./api/active-tenant";
import { adminSyncRoute } from "./api/admin";
import { checkAdminAuth } from "./api/auth";
import { consentRoute } from "./api/consent";
import { graphRoute } from "./api/graph";
import { installCompleteRoute } from "./api/install-complete";
import { installRefreshRoute } from "./api/install-refresh";
import { getIssueRoute, listIssuesRoute } from "./api/issues";
import { logoutRoute, meRoute } from "./api/me";
import { releaseRoute } from "./api/release";
import { syncStatusRoute } from "./api/sync-status";
import { versionRoute } from "./api/version";
import { zkGithubGraphqlRoute } from "./api/zk-github-proxy";
import { consumeZkHandoffRoute } from "./api/zk-handoff";
import { getZkKeyBackupRoute, putZkKeyBackupRoute } from "./api/zk-key-backup";
import { zkOptInRoute } from "./api/zk-opt-in";
import { listZkPayloadsRoute, putZkPayloadsRoute } from "./api/zk-payloads";
import { consumeZkReauthRoute } from "./api/zk-reauth";
import { postZkResetRoute } from "./api/zk-reset";
import { signInPageRoute, signUpPageRoute } from "./auth/auth-page-route";
import { requireSameOriginPost } from "./auth/csrf";
import { dashboardRoute } from "./auth/dashboard-route";
import { callbackRoute, loginRoute } from "./auth/oauth";
import { authExchangeRoute } from "./auth/oauthExchange";
import { authResetRoute } from "./auth/reset";
import { requireLinkedTenant, requireSession } from "./auth/session";
import { authStatusRoute } from "./auth/status";
import type { AuthEnv } from "./auth/types";
import { webhookRoute } from "./webhook/handlers";

const app = new Hono<AuthEnv>();

// ── API routes — evaluated BEFORE the ASSETS fallback ───────────────────────
// S1 scaffold wires /health + /api/version. S5 (#97) adds POST /webhook/github.
// S6 (#98) adds /api/graph, /api/issues, /api/issues/*, /admin/sync.
app.get("/api/version", versionRoute);
app.get("/api/release", releaseRoute);

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
    const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>();
    dbReachable = true;
    issueCount = row?.n ?? 0;
  } catch {
    // db unreachable → report status without failing the request
  }
  return c.json({
    status: "ok",
    db_reachable: dbReachable,
    issue_count: issueCount,
    release: c.env.APP_RELEASE ?? "unknown",
  });
});

// ── Auth routes (#145, S2) ───────────────────────────────────────────────────
app.get("/login", loginRoute);
app.get("/oauth/callback", callbackRoute);
app.get("/auth/reset", authResetRoute);
app.get("/auth/exchange", authExchangeRoute);
app.get("/auth/status", authStatusRoute);
app.get("/install/complete", installCompleteRoute);
app.use("/api/me", requireSession);
app.get("/api/me", meRoute);
app.post("/api/consent", requireSameOriginPost, requireLinkedTenant, consentRoute);
app.post("/api/install/refresh", requireSameOriginPost, requireSession, installRefreshRoute);
app.use("/api/sync/status", requireLinkedTenant);
app.get("/api/sync/status", syncStatusRoute);
app.post("/api/active-tenant", requireSameOriginPost, requireLinkedTenant, activeTenantRoute);
app.post("/api/zk-opt-in", requireSameOriginPost, requireLinkedTenant, zkOptInRoute);
app.use("/api/zk/payloads", requireLinkedTenant);
app.get("/api/zk/payloads", listZkPayloadsRoute);
app.put("/api/zk/payloads", putZkPayloadsRoute);
app.post(
  "/api/zk/consume-handoff",
  requireSameOriginPost,
  requireLinkedTenant,
  consumeZkHandoffRoute,
);
app.post(
  "/api/zk/consume-reauth",
  requireSameOriginPost,
  requireLinkedTenant,
  consumeZkReauthRoute,
);
app.use("/api/zk/key-backup", requireLinkedTenant);
app.get("/api/zk/key-backup", getZkKeyBackupRoute);
app.put("/api/zk/key-backup", putZkKeyBackupRoute);
app.use("/api/zk/reset", requireLinkedTenant);
app.post("/api/zk/reset", requireSameOriginPost, postZkResetRoute);
app.post(
  "/api/zk/github/graphql",
  requireSameOriginPost,
  requireLinkedTenant,
  zkGithubGraphqlRoute,
);
// /logout is ungated by session middleware (idempotent + null-safe). SameSite=Lax on session cookie
// blocks most cross-site POSTs; requireSameOriginPost adds defense-in-depth.
app.post("/logout", requireSameOriginPost, logoutRoute);

// GET /sign-in/, /sign-up/ — guest auth pages; signed-in users go to dashboard.
app.get("/sign-in", signInPageRoute);
app.get("/sign-in/", signInPageRoute);
app.get("/sign-up", signUpPageRoute);
app.get("/sign-up/", signUpPageRoute);

// GET /dashboard — session-gated app shell (HTML only; JS/CSS served from ASSETS root).
app.get("/dashboard", dashboardRoute);
app.get("/dashboard/", dashboardRoute);

// ── Static-assets fallback — last resort (frontend populated in S7, #99) ────
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export { app };
