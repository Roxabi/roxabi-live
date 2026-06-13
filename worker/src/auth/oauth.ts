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
import { mintSession, sessionCookie } from "./session";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate a `redirect` query parameter as a safe relative path.
 * Accepts paths starting with "/" but not "//" (open-redirect via protocol-
 * relative URLs), not starting with "/\" (backslash bypass), and rejects
 * CRLF / NUL injection.
 */
function sanitizeRedirect(raw: string | undefined): string {
  if (raw && /^\/(?![/\\])/.test(raw) && !/[\r\n\0]/.test(raw)) return raw;
  return "/";
}

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
export async function loginRoute(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const redirectAfter = sanitizeRedirect(c.req.query("redirect") ?? undefined);

  // 16 random bytes → 32 hex chars
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = bytesToHex(stateBytes);

  // Store state in D1 — single-use, expires in 10 minutes
  await c.env.DB.prepare(
    `INSERT INTO oauth_state (state, redirect_after, expires_at)
     VALUES (?, ?, datetime('now', '+10 minutes'))`,
  )
    .bind(state, redirectAfter)
    .run();

  // Build GitHub authorize URL — redirect_uri derived from origin only (D-6)
  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/oauth/callback`;

  const dest = new URL("https://github.com/login/oauth/authorize");
  dest.searchParams.set("client_id", c.env.GITHUB_APP_CLIENT_ID);
  dest.searchParams.set("redirect_uri", redirectUri);
  dest.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: { Location: dest.toString() },
  });
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
 *   5. If no installations → redirect to app install page (no DB write, no session).
 *   6. Upsert user → tenants → user_installations.
 *   7. Mint session tied to first installation, set __Host-session cookie.
 */
export async function callbackRoute(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "bad_request" }, 400);
  }

  // Consume state — single-use + expiry guard in one atomic statement (closes TOCTOU)
  const stateRow = await c.env.DB.prepare(
    `DELETE FROM oauth_state WHERE state = ? AND expires_at > datetime('now') RETURNING redirect_after`,
  )
    .bind(state)
    .first<{ redirect_after: string | null }>();

  if (!stateRow) {
    return c.json({ error: "bad_request" }, 400);
  }

  const redirectAfter = stateRow.redirect_after ?? "/";

  // Build redirect_uri from origin (D-6)
  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/oauth/callback`;

  // Exchange code for access_token
  const tokenRes = await fetch(
    "https://github.com/login/oauth/access_token",
    {
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
    },
  );

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
  const installRes = await fetch(
    "https://api.github.com/user/installations",
    { headers: ghHeaders },
  );
  if (!installRes.ok) {
    return c.json({ error: "github_unavailable" }, 502);
  }
  const { installations } = (await installRes.json()) as {
    installations: Array<{
      id: number;
      account: { login: string; type: string };
    }>;
  };

  // No installations — redirect to app install page, no session, no DB write
  if (installations.length === 0) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "https://github.com/apps/roxabi-live/installations/new",
      },
    });
  }

  // Upsert user — get internal id
  const userRow = await c.env.DB.prepare(
    `INSERT INTO users (github_id, github_login) VALUES (?, ?)
     ON CONFLICT(github_id) DO UPDATE SET github_login=excluded.github_login, updated_at=datetime('now')
     RETURNING id`,
  )
    .bind(ghUser.id, ghUser.login)
    .first<{ id: number }>();

  if (!userRow) {
    return c.json({ error: "db_error" }, 500);
  }
  const userId = userRow.id;

  // Upsert each installation as a tenant and link to user
  let firstTenantId: number | null = null;

  for (const inst of installations) {
    const tenantRow = await c.env.DB.prepare(
      `INSERT INTO tenants (installation_id, account_login, account_type) VALUES (?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET account_login=excluded.account_login,
         account_type=excluded.account_type, updated_at=datetime('now')
       RETURNING id`,
    )
      .bind(inst.id, inst.account.login, inst.account.type)
      .first<{ id: number }>();

    if (!tenantRow) {
      return c.json({ error: "db_error" }, 500);
    }
    const tenantId = tenantRow.id;

    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO user_installations (user_id, tenant_id) VALUES (?, ?)`,
    )
      .bind(userId, tenantId)
      .run();

    if (firstTenantId === null) {
      firstTenantId = tenantId;
    }
  }

  if (firstTenantId === null) {
    return c.json({ error: "db_error" }, 500);
  }

  // Mint session tied to the first installation's tenant
  const rawToken = await mintSession(c.env.DB, userId, firstTenantId);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectAfter,
      "Set-Cookie": sessionCookie(rawToken),
    },
  });
}
