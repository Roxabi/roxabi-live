/**
 * GitHub App OAuth routes.
 *
 * loginRoute    — initiates the OAuth flow (stores state, redirects to GitHub).
 * callbackRoute — handles the GitHub callback (exchanges code, upserts user +
 *                 tenants, mints session).
 *
 * Never logs tokens, client_secret, or raw session tokens.
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { authRedirect, readSessionToken, sanitizeAuthRedirect, stripInstallParam } from "./cookies";
import { serveLoginPrompt } from "./login-prompt";
import { completeOAuthSession } from "./post-oauth";
import { mintSession, revokeOtherSessions } from "./session";
import { validateSession } from "./session";
import { createUserTokenHandoff } from "./userTokenHandoff";
import { createZkReauthCode } from "./zk-reauth";

export type LoginIntent = "signin" | "install" | "reauth" | "zk" | "prompt";

/** Unified /login intent — legacy ?go=1 / ?install=1 aliases kept one release. */
export function resolveLoginIntent(c: Context<{ Bindings: Env }>): LoginIntent {
  const intent = c.req.query("intent");
  if (
    intent === "signin" ||
    intent === "install" ||
    intent === "reauth" ||
    intent === "zk" ||
    intent === "prompt"
  ) {
    return intent;
  }
  if (c.req.query("install") === "1") return "install";
  if (c.req.query("reauth") === "1") return "reauth";
  if (c.req.query("zk") === "1") return "zk";
  if (c.req.query("go") === "1") return "signin";
  return "prompt";
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Encode a Uint8Array of random bytes as a lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// loginRoute
// ---------------------------------------------------------------------------

/**
 * GET /login
 *
 * Generates a random state token, persists it in D1 oauth_state with a
 * 10-minute expiry, then redirects the browser to GitHub's OAuth authorize
 * endpoint.  The redirect_uri is derived from the request origin — never from
 * a query parameter — to prevent redirect-uri injection (D-6).
 */
/**
 * OAuth must run again (install refresh, ZK flows, explicit reauth).
 * install=1 must be a top-level /login query flag — NOT embedded in redirect=,
 * otherwise every post-OAuth hop back to /login?redirect=/dashboard?install=1
 * re-triggers GitHub while the session cookie is already valid (redirect loop).
 */
async function mustReOAuth(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const intent = resolveLoginIntent(c);
  if (intent === "reauth" || intent === "zk") return true;
  if (intent !== "install") return false;

  const token = readSessionToken(c);
  if (!token) return true;
  const session = await validateSession(c.env.DB, token);
  if (!session) return true;

  const linked = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user_installations ui
     JOIN tenants t ON t.id = ui.tenant_id AND t.deleted_at IS NULL AND t.suspended_at IS NULL
     WHERE ui.user_id = ?`,
  )
    .bind(session.userId)
    .first<{ n: number }>();

  if ((linked?.n ?? 0) > 0) return false;
  if (session.tenantId !== null) return false;
  return true;
}

export async function loginRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const redirectAfter = sanitizeAuthRedirect(c.req.query("redirect") ?? undefined);
  const intent = resolveLoginIntent(c);
  const zkTokenHandoff = intent === "zk" ? 1 : 0;
  const reauth = intent === "reauth" ? 1 : 0;

  const cleanRedirect = stripInstallParam(redirectAfter);

  if (!(await mustReOAuth(c))) {
    const token = readSessionToken(c);
    if (token) {
      const session = await validateSession(c.env.DB, token);
      if (session) {
        return authRedirect(cleanRedirect);
      }
    }
  }

  if (intent === "prompt") {
    return serveLoginPrompt(c, cleanRedirect);
  }

  // 16 random bytes → 32 hex chars
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = bytesToHex(stateBytes);

  // Store state in D1 — single-use, expires in 10 minutes
  await c.env.DB.prepare(
    `INSERT INTO oauth_state (state, redirect_after, expires_at, zk_token_handoff, reauth)
     VALUES (?, ?, datetime('now', '+10 minutes'), ?, ?)`,
  )
    .bind(state, cleanRedirect, zkTokenHandoff, reauth)
    .run();

  // Build GitHub authorize URL — redirect_uri derived from origin only (D-6)
  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/oauth/callback`;

  const dest = new URL("https://github.com/login/oauth/authorize");
  dest.searchParams.set("client_id", c.env.GITHUB_APP_CLIENT_ID);
  dest.searchParams.set("redirect_uri", redirectUri);
  dest.searchParams.set("state", state);

  return authRedirect(dest.toString());
}

// ---------------------------------------------------------------------------
// callbackRoute
// ---------------------------------------------------------------------------

/**
 * GET /oauth/callback
 *
 * GitHub redirects here after the user authorises (or denies) the app.
 * Flow:
 *   1. Validate code + state params.
 *   2. Consume state — atomic single-use DELETE ... RETURNING (closes TOCTOU).
 *   3. Exchange code for access_token.
 *   4. Fetch /user and /user/installations.
 *   5. If no installations → upsert user, cache install targets, mint install-pending session.
 *   6. Upsert user → tenants → user_installations.
 *   7. Mint session tied to first installation, set __Host-session cookie.
 */
export async function callbackRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "bad_request" }, 400);
  }

  // Consume state — single-use + expiry guard in one atomic statement (closes TOCTOU)
  const stateRow = await c.env.DB.prepare(
    `DELETE FROM oauth_state WHERE state = ? AND expires_at > datetime('now')
     RETURNING redirect_after, zk_token_handoff, reauth`,
  )
    .bind(state)
    .first<{
      redirect_after: string | null;
      zk_token_handoff: number;
      reauth: number;
    }>();

  if (!stateRow) {
    return c.json({ error: "bad_request" }, 400);
  }

  let redirectAfter = stateRow.redirect_after ?? "/dashboard";
  const wantsZkHandoff = stateRow.zk_token_handoff === 1;
  const wantsReauth = stateRow.reauth === 1;

  // Build redirect_uri from origin (D-6)
  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/oauth/callback`;

  // Exchange code for access_token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "roxabi-live",
    },
    body: JSON.stringify({
      client_id: c.env.GITHUB_APP_CLIENT_ID,
      client_secret: c.env.GITHUB_APP_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    return c.json({ error: "oauth_failed" }, 502);
  }
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (tokenBody.error || !tokenBody.access_token) {
    return c.json({ error: "oauth_failed" }, 400);
  }
  const access_token = tokenBody.access_token;

  const ghHeaders = {
    Authorization: `Bearer ${access_token}`,
    "User-Agent": "roxabi-live",
    Accept: "application/vnd.github+json",
  };

  // Fetch authenticated user
  const userRes = await fetch("https://api.github.com/user", {
    headers: ghHeaders,
  });
  if (!userRes.ok) {
    return c.json({ error: "github_unavailable" }, 502);
  }
  const ghUser = (await userRes.json()) as { id: number; login: string };

  // Fetch user installations
  const installRes = await fetch("https://api.github.com/user/installations", {
    headers: ghHeaders,
  });
  if (!installRes.ok) {
    return c.json({ error: "github_unavailable" }, 502);
  }
  const { installations } = (await installRes.json()) as {
    installations: Array<{
      id: number;
      account: { login: string; type: string };
    }>;
  };

  // No installations — mint install-pending session and show our install guide
  if (installations.length === 0) {
    const orgsRes = await fetch("https://api.github.com/user/orgs?per_page=100", {
      headers: ghHeaders,
    });
    const orgs = orgsRes.ok ? ((await orgsRes.json()) as Array<{ id: number; login: string }>) : [];

    const installTargets = [
      { id: ghUser.id, login: ghUser.login, type: "User" as const },
      ...orgs.map((o) => ({
        id: o.id,
        login: o.login,
        type: "Organization" as const,
      })),
    ];

    const userRow = await c.env.DB.prepare(
      `INSERT INTO users (github_id, github_login, zk_opt_in, install_targets_json)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(github_id) DO UPDATE SET
         github_login=excluded.github_login,
         zk_opt_in=1,
         install_targets_json=excluded.install_targets_json,
         updated_at=datetime('now')
       RETURNING id`,
    )
      .bind(ghUser.id, ghUser.login, JSON.stringify(installTargets))
      .first<{ id: number }>();

    if (!userRow) {
      return c.json({ error: "db_error" }, 500);
    }

    const rawToken = await mintSession(c.env.DB, userRow.id, null);
    await revokeOtherSessions(c.env.DB, userRow.id, rawToken);
    return completeOAuthSession(c, rawToken, redirectAfter);
  }

  // Upsert user — get internal id
  const userRow = await c.env.DB.prepare(
    `INSERT INTO users (github_id, github_login, zk_opt_in, install_targets_json)
     VALUES (?, ?, 1, NULL)
     ON CONFLICT(github_id) DO UPDATE SET
       github_login=excluded.github_login,
       zk_opt_in=1,
       install_targets_json=NULL,
       updated_at=datetime('now')
     RETURNING id`,
  )
    .bind(ghUser.id, ghUser.login)
    .first<{ id: number }>();

  if (!userRow) {
    return c.json({ error: "db_error" }, 500);
  }
  const userId = userRow.id;

  // Upsert all installations as tenants in one batched round-trip (RETURNING id),
  // then link them to the user in a second batch. Replaces the per-installation
  // sequential loop (2N round-trips → 2). #158
  // Each DB.batch() runs as a single implicit D1 transaction (all-or-nothing), which
  // also closes the partial-write race the old sequential loop had.
  // installations is guaranteed non-empty here (the length===0 case returned above),
  // so neither batch() is ever called with an empty array.
  const tenantResults = await c.env.DB.batch<{ id: number }>(
    installations.map((inst) =>
      c.env.DB.prepare(
        `INSERT INTO tenants (installation_id, account_login, account_type) VALUES (?, ?, ?)
         ON CONFLICT(installation_id) DO UPDATE SET account_login=excluded.account_login,
           account_type=excluded.account_type, updated_at=datetime('now')
         RETURNING id`,
      ).bind(inst.id, inst.account.login, inst.account.type),
    ),
  );

  const maybeTenantIds = tenantResults.map((r) => r.results[0]?.id);
  if (maybeTenantIds.some((id) => id == null)) {
    return c.json({ error: "db_error" }, 500);
  }
  // Guard above guarantees every entry is defined; narrow the whole array once
  // rather than casting each element (.some() does not narrow in TS).
  const tenantIds = maybeTenantIds as number[];
  const firstTenantId = tenantIds[0];

  // Link each tenant to the user (idempotent) in one batch.
  await c.env.DB.batch(
    tenantIds.map((tid) =>
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO user_installations (user_id, tenant_id) VALUES (?, ?)",
      ).bind(userId, tid),
    ),
  );

  // Mint session tied to the first installation's tenant
  const rawToken = await mintSession(c.env.DB, userId, firstTenantId);
  await revokeOtherSessions(c.env.DB, userId, rawToken);

  if (wantsReauth) {
    const reauthCode = await createZkReauthCode(c.env, userId);
    const dest = new URL(redirectAfter, origin);
    dest.searchParams.set("zk_reauth", reauthCode);
    redirectAfter = `${dest.pathname}${dest.search}`;
  } else if (wantsZkHandoff) {
    try {
      const handoffCode = await createUserTokenHandoff(c.env, userId, access_token);
      const dest = new URL(redirectAfter, origin);
      dest.searchParams.set("zk_handoff", handoffCode);
      redirectAfter = `${dest.pathname}${dest.search}`;
    } catch {
      // INSTALL_TOKEN_KEY unset — skip handoff, user can retry /login?zk=1
    }
  }

  return completeOAuthSession(c, rawToken, stripInstallParam(redirectAfter));
}
