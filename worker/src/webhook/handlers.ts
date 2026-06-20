/**
 * GitHub webhook handlers — verbatim port of src/roxabi_live/webhook/handlers.py
 * and src/roxabi_live/webhook/router.py for the Cloudflare Worker runtime.
 *
 * Runtime-forced deltas vs. the Python original:
 *   - D1 db.batch([...stmts]) replaces aiosqlite interactive transactions.
 *   - trigger_heal() calls are DROPPED (no in-process reconciler in CF Worker).
 *   - handleRefDelete uses env.DB directly (no fresh sqlite3.connect).
 *   - MAX_WEBHOOK_BODY_BYTES enforced via bodyBuffer.byteLength after arrayBuffer()
 *     (authoritative check; Content-Length is spoofable and saves nothing).
 */

import type { Context } from "hono";
import type { Env } from "../types";

import { handleMember, handleMembership, handleRepository } from "./handlers-access";
import { handleInstallation, handleInstallationRepositories } from "./handlers-app";
import { handleDeps, handleIssues, handleSubIssues } from "./handlers-issues";
import {
  handleMilestone,
  handlePullRequest,
  handleRefCreate,
  handleRefDelete,
} from "./handlers-ref";
import { verifyHmac } from "./hmac";
import { bumpDataVersion } from "./mutations";
import { type TenantRow, getTenantByInstallationId, getTenantByOrgLogin } from "./tenant";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024; // 25 MB

// Stable event allowlists — hoisted to module level to avoid re-allocation per request.
const DATA_EVENTS = new Set([
  "issues",
  "issue_dependencies",
  "sub_issues",
  "create",
  "delete",
  "pull_request",
  "milestone",
]);
const APP_EVENTS = new Set([
  "installation",
  "installation_repositories",
  "repository",
  "member",
  "membership",
]);

// ---------------------------------------------------------------------------
// Dispatcher — POST /webhook/github
// ---------------------------------------------------------------------------

/**
 * Hono route handler for POST /webhook/github.
 *
 * Verbatim port of router.py::github_webhook with runtime-forced deltas:
 * - HMAC verification via Web Crypto (verifyHmac)
 * - D1 via c.env.DB (no aiosqlite)
 * - trigger_heal() calls DROPPED
 */
export async function webhookRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return c.json({ error: "webhook not configured" }, 503);
  }

  const bodyBuffer = await c.req.arrayBuffer();
  if (bodyBuffer.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }

  const sigHeader = c.req.header("x-hub-signature-256") ?? null;
  const valid = await verifyHmac(bodyBuffer, sigHeader, secret);
  if (!valid) {
    return c.json({ error: "invalid signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBuffer));
  } catch {
    return c.json({ error: "invalid JSON payload" }, 400);
  }

  const event = c.req.header("x-github-event") ?? null;
  const db = c.env.DB;

  // Unknown events short-circuit here — no data_version bump.
  if (event !== null && !DATA_EVENTS.has(event) && !APP_EVENTS.has(event)) {
    return c.json({ ok: true, ignored: event });
  }
  if (event === null) {
    return c.json({ ok: true, ignored: event });
  }

  // ── Tenant routing gate (S4 #147) ──
  // Resolve installation → tenant for events carrying installation context.
  // membership payloads may omit `installation` → route via organization.login.
  const installation = payload.installation as Record<string, unknown> | undefined;
  const installationId =
    typeof installation?.id === "number" ? (installation.id as number) : undefined;

  let tenant: TenantRow | null = null;
  let hasRoutingContext = false;
  if (installationId != null) {
    tenant = await getTenantByInstallationId(db, installationId);
    hasRoutingContext = true;
  } else if (event === "membership") {
    const org = payload.organization as Record<string, unknown> | undefined;
    const login = org?.login;
    if (typeof login === "string") {
      tenant = await getTenantByOrgLogin(db, login);
      hasRoutingContext = true;
    }
  }

  // Control-plane `installation` events are EXEMPT from the unknown/suspended reject:
  //   - installation.created bootstraps the tenant (it won't exist yet)
  //   - suspend / unsuspend / deleted manage tenant lifecycle and must always run.
  // All other events: when routing context is present, an unknown / suspended /
  // (soft-)deleted tenant → 200 OK, NO write (GitHub does not retry; no orphan rows).
  // When no routing context (legacy delivery without installation), fall through to
  // preserve existing behavior.
  if (event !== "installation" && hasRoutingContext) {
    if (tenant === null || tenant.suspended_at !== null || tenant.deleted_at !== null) {
      return c.json({ ok: true, ignored: event });
    }
  }

  let mutated = false;

  try {
    if (event === "issues") {
      await handleIssues(payload, db, c.env);
      mutated = true;
    } else if (event === "issue_dependencies") {
      const changed = await handleDeps(payload, db, c.env);
      mutated = changed > 0;
    } else if (event === "sub_issues") {
      const changed = await handleSubIssues(payload, db);
      mutated = changed > 0;
    } else if (event === "create") {
      await handleRefCreate(payload, db);
      mutated = true;
    } else if (event === "delete") {
      await handleRefDelete(payload, db, c.env);
      mutated = true;
    } else if (event === "pull_request") {
      await handlePullRequest(payload, db);
      mutated = true;
    } else if (event === "milestone") {
      await handleMilestone(payload, db);
      mutated = true;
      // App lifecycle events self-bump data_version inside their atomic batch — do not set `mutated`.
    } else if (event === "installation") {
      await handleInstallation(payload, db, c.env);
    } else if (event === "installation_repositories") {
      await handleInstallationRepositories(payload, db, c.env);
    } else if (event === "repository") {
      await handleRepository(payload, db);
    } else if (event === "member") {
      await handleMember(payload, db);
    } else if (event === "membership") {
      await handleMembership(payload, db);
    }
  } catch (err) {
    console.error("[webhook] unhandled handler error", err);
    return c.json({ ok: true, error: "internal" });
  }

  if (mutated) {
    const iso = new Date().toISOString();
    await db.batch([bumpDataVersion(db, iso)]);
  }

  return c.json({ ok: true });
}
