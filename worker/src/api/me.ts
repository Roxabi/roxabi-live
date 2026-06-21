/**
 * /api/me — current user profile + onboarding state.
 * /logout  — revoke session cookie.
 */

import type { Context } from "hono";
import { AUTH_NO_CACHE, clearSessionCookieHeaders, readSessionToken } from "../auth/cookies";
import {
  buildInstallOptions,
  deriveOnboardingStep,
  installTargetsFromUserRow,
} from "../auth/onboarding";
import { deleteSession } from "../auth/session";
import type { AuthEnv, SessionContext } from "../auth/types";
import { zkAccountKeyEnabled } from "../auth/zk-flags";
import type { Env } from "../types";

export interface MePayload {
  user: {
    github_id: number;
    github_login: string;
    zk_opt_in: boolean;
    zk_enrolled: boolean;
    zk_account_key_enabled: boolean;
  };
  active_tenant_id: number | null;
  /** @deprecated use onboarding_step */
  install_pending: boolean;
  /** @deprecated use install_options */
  install_targets: Array<{ id: number; login: string; type: string }>;
  install_options: Array<{ kind: string; login?: string; url: string }>;
  installations: Array<{
    tenant_id: number;
    account_login: string;
    account_type: string;
  }>;
  onboarding_step: "install" | "consent" | "ready";
  consent_at: string | null;
}

/** Shared /api/me body builder — used by GET /api/me and POST /api/install/refresh. */
export async function buildMePayload(env: Env, session: SessionContext): Promise<MePayload> {
  const userRow = await env.DB.prepare(
    "SELECT zk_opt_in, install_targets_json, consent_at FROM users WHERE id = ?",
  )
    .bind(session.userId)
    .first<{
      zk_opt_in: number;
      install_targets_json: string | null;
      consent_at: string | null;
    }>();

  const enrolledRow = await env.DB.prepare(
    "SELECT 1 AS ok FROM zk_key_backups WHERE user_id = ? LIMIT 1",
  )
    .bind(session.userId)
    .first<{ ok: number }>();

  const rows = await env.DB.prepare(
    `SELECT ui.tenant_id AS tenant_id, t.account_login AS account_login, t.account_type AS account_type
       FROM user_installations ui
       JOIN tenants t ON t.id = ui.tenant_id
       WHERE ui.user_id = ? AND t.deleted_at IS NULL AND t.suspended_at IS NULL`,
  )
    .bind(session.userId)
    .all<{ tenant_id: number; account_login: string; account_type: string }>();

  const installations = rows.results;
  const installPending = session.tenantId == null || installations.length === 0;
  const installTargets = installTargetsFromUserRow(installPending, userRow?.install_targets_json);
  const onboardingStep = deriveOnboardingStep(session, installations, userRow?.consent_at ?? null);

  return {
    user: {
      github_id: session.githubId,
      github_login: session.githubLogin,
      zk_opt_in: userRow?.zk_opt_in === 1,
      zk_enrolled: enrolledRow != null,
      zk_account_key_enabled: zkAccountKeyEnabled(env),
    },
    active_tenant_id: session.tenantId,
    install_pending: installPending,
    install_targets: installTargets,
    install_options: buildInstallOptions(installTargets, env.GITHUB_APP_SLUG),
    installations,
    onboarding_step: onboardingStep,
    consent_at: userRow?.consent_at ?? null,
  };
}

export async function meRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json(await buildMePayload(c.env, s));
}

export async function logoutRoute(c: Context<AuthEnv>): Promise<Response> {
  const raw = readSessionToken(c);
  if (raw) {
    await deleteSession(c.env.DB, raw);
  }

  const headers = new Headers({
    "Clear-Site-Data": '"cache", "cookies", "storage"',
    ...AUTH_NO_CACHE,
  });
  for (const cookie of clearSessionCookieHeaders()) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 204, headers });
}
