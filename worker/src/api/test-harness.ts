/**
 * E2E-only routes — registered when env.E2E_TEST_MODE === "1".
 * Never enable in production.
 */

import type { Context } from "hono";
import { sessionCookieHeaders } from "../auth/cookies";
import { mintSession } from "../auth/session";
import type { AuthEnv } from "../auth/types";
import { createZkReauthCode } from "../auth/zk-reauth";
import type { Env } from "../types";

export function e2eEnabled(env: Env): boolean {
  return env.E2E_TEST_MODE === "1";
}

interface SeedBody {
  github_id?: number;
  github_login?: string;
  tenant_id?: number;
  consent?: boolean;
  zk_backup?: boolean;
}

/** POST /__test__/seed — mint session + optional zk backup for Playwright. */
export async function e2eSeedRoute(c: Context<AuthEnv>): Promise<Response> {
  if (!e2eEnabled(c.env)) {
    return c.json({ error: "forbidden" }, 403);
  }

  let body: SeedBody = {};
  try {
    body = (await c.req.json()) as SeedBody;
  } catch {
    body = {};
  }

  const githubId = body.github_id ?? 99001;
  const githubLogin = body.github_login ?? "e2e-user";
  let tenantId = body.tenant_id ?? 1;

  const tenantRow = await c.env.DB.prepare(
    `INSERT INTO tenants (installation_id, account_login, account_type)
     VALUES (?, ?, 'Organization')
     ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login
     RETURNING id`,
  )
    .bind(99001, "roxabi")
    .first<{ id: number }>();
  if (tenantRow) tenantId = tenantRow.id;

  const userRow = await c.env.DB.prepare(
    `INSERT INTO users (github_id, github_login, zk_opt_in, consent_at, install_targets_json)
     VALUES (?, ?, 1, ?, NULL)
     ON CONFLICT(github_id) DO UPDATE SET
       github_login = excluded.github_login,
       consent_at = excluded.consent_at,
       install_targets_json = NULL,
       updated_at = datetime('now')
     RETURNING id`,
  )
    .bind(githubId, githubLogin, body.consent === false ? null : "2026-01-01 00:00:00")
    .first<{ id: number }>();

  if (!userRow) return c.json({ error: "db_error" }, 500);
  const userId = userRow.id;

  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO user_installations (user_id, tenant_id) VALUES (?, ?)",
  )
    .bind(userId, tenantId)
    .run();

  if (body.zk_backup) {
    await c.env.DB.prepare(
      `INSERT INTO zk_key_backups (user_id, key_fp, kdf_params, wrap_iv, wrapped_key, backup_version)
       VALUES (?, ?, '{}', 'iv', 'wrapped', 1)
       ON CONFLICT(user_id) DO UPDATE SET
         key_fp = excluded.key_fp,
         wrapped_key = excluded.wrapped_key`,
    )
      .bind(userId, "deadbeef1234567890abcdef12345678")
      .run();
  } else {
    await c.env.DB.prepare("DELETE FROM zk_key_backups WHERE user_id = ?").bind(userId).run();
  }

  const rawToken = await mintSession(c.env.DB, userId, tenantId);
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const cookie of sessionCookieHeaders(rawToken, { secure: false })) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      user_id: userId,
      github_login: githubLogin,
      session_token: rawToken,
    }),
    { status: 200, headers },
  );
}

/** GET /__test__/user-state?github_login= — inspect post-delete state. */
export async function e2eUserStateRoute(c: Context<AuthEnv>): Promise<Response> {
  if (!e2eEnabled(c.env)) {
    return c.json({ error: "forbidden" }, 403);
  }

  const login = c.req.query("github_login") ?? "e2e-user";
  const user = await c.env.DB.prepare("SELECT id, consent_at FROM users WHERE github_login = ?")
    .bind(login)
    .first<{ id: number; consent_at: string | null }>();

  if (!user) {
    return c.json({ exists: false });
  }

  const backup = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM zk_key_backups WHERE user_id = ? LIMIT 1",
  )
    .bind(user.id)
    .first<{ ok: number }>();

  const installs = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM user_installations WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ n: number }>();

  const sessions = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
    .bind(user.id)
    .first<{ n: number }>();

  return c.json({
    exists: true,
    consent_at: user.consent_at,
    zk_enrolled: backup != null,
    installations: installs?.n ?? 0,
    sessions: sessions?.n ?? 0,
  });
}

/** POST /__test__/reauth-proof — mint zk reauth code for delete E2E. */
export async function e2eReauthProofRoute(c: Context<AuthEnv>): Promise<Response> {
  if (!e2eEnabled(c.env)) {
    return c.json({ error: "forbidden" }, 403);
  }

  let body: { user_id?: number } = {};
  try {
    body = (await c.req.json()) as { user_id?: number };
  } catch {
    body = {};
  }
  const userId = body.user_id;
  if (userId == null) {
    return c.json({ error: "user_id required" }, 400);
  }

  const proof = await createZkReauthCode(c.env, userId);
  return c.json({ reauth_proof: proof });
}
