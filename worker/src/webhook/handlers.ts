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
import { verifyHmac } from "./hmac";
import {
  upsertIssueFromWebhook,
  replaceLabels,
  addEdge,
  removeEdge,
  upsertEdges,
  deleteIssue,
  setActiveBranch,
  upsertPrState,
  renameMilestone,
  bumpDataVersion,
  type WebhookIssue,
} from "./mutations";
import { isIssueZkSealed } from "../auth/zk";
import { BRANCH_ISSUE_RE, canonicalKey, extractFromLabels, syncBranches } from "../sync/sync";
import { fetchIssueDeps, GraphQLError } from "../sync/graphql";
import { resolveInstallToken } from "../auth/installToken";
import { getTenantByInstallationId, getTenantByOrgLogin, type TenantRow } from "./tenant";
import { handleInstallation, handleInstallationRepositories, handleRepository, handleMember, handleMembership } from "./handlers-app";

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
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Derive an issue key from a partial issue object plus an optional repo override.
 * Verbatim port of _issue_key() from handlers.py.
 */
function issueKey(
  issue: Record<string, unknown>,
  repoOverride?: Record<string, unknown> | null,
): string {
  const repo = repoOverride ?? (issue["repository"] as Record<string, unknown> | undefined) ?? {};
  const fullName = (repo["full_name"] as string | undefined) ?? "";
  return `${fullName}#${issue["number"]}`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Process a GitHub `issues` webhook event.
 *
 * Supported actions: opened, edited, reopened, labeled, unlabeled, closed,
 * deleted, transferred.
 * Issue upsert + label replacement are committed atomically via db.batch (SC9).
 */
export async function handleIssues(payload: Record<string, unknown>, db: D1Database): Promise<void> {
  const action = payload["action"] as string | undefined;
  const issue = payload["issue"] as Record<string, unknown>;
  const repo = ((payload["repository"] as Record<string, unknown> | undefined) ?? {})["full_name"] as string | undefined ?? "";
  const key = `${repo}#${issue["number"]}`;

  if (action === "deleted" || action === "transferred") {
    await deleteIssue(db, key).run();
    return;
  }

  const rawLabels: unknown[] = (issue["labels"] as unknown[] | undefined) ?? [];
  const names: string[] = rawLabels.map((lbl) => {
    if (lbl && typeof lbl === "object") {
      return String((lbl as Record<string, unknown>)["name"] ?? "");
    }
    return String(lbl);
  });

  const milestoneObj = issue["milestone"];
  let milestoneTitle: string | null = null;
  if (milestoneObj && typeof milestoneObj === "object") {
    const titleVal = (milestoneObj as Record<string, unknown>)["title"];
    milestoneTitle = titleVal != null ? String(titleVal) : null;
  }

  const derived = extractFromLabels(names);

  const sealed = await isIssueZkSealed(db, key);
  const title = sealed ? null : ((issue["title"] as string | undefined) ?? null);

  const issuePartial: WebhookIssue = {
    key,
    repo,
    number: issue["number"] as number,
    title,
    state: issue["state"] as string,
    url: (issue["html_url"] as string | undefined) ?? null,
    created_at: (issue["created_at"] as string | null | undefined) ?? null,
    updated_at: (issue["updated_at"] as string | null | undefined) ?? null,
    closed_at: (issue["closed_at"] as string | null | undefined) ?? null,
    milestone: milestoneTitle,
    lane: derived.lane,
    priority: derived.priority,
    size: derived.size,
  };

  // Atomic upsert + label replacement via db.batch (SC9).
  await db.batch([upsertIssueFromWebhook(db, issuePartial), ...replaceLabels(db, key, names)]);
}

/**
 * Point-fetch the current blockedBy/blocking state for a single issue and
 * upsert edges into D1.
 *
 * Used when GitHub omits `blocking_issue` from cross-repo dependency payloads.
 * Returns the number of rows changed (0 on error or no-change).
 */
async function pointFetchAndUpsertDeps(
  db: D1Database,
  token: string,
  blockedIssue: Record<string, unknown>,
  repo: Record<string, unknown>,
): Promise<number> {
  const number = blockedIssue["number"] as number | undefined;
  if (number == null) {
    console.warn(
      `[webhook] handle_deps: missing number in blocked_issue — keys=${Object.keys(blockedIssue).join(",")}`,
    );
    return 0;
  }
  const fullName = (repo["full_name"] as string | undefined) ?? "";
  const slashIdx = fullName.indexOf("/");
  if (slashIdx < 0 || slashIdx === fullName.length - 1) {
    console.warn(
      `[webhook] handle_deps: cannot point-fetch — malformed repository.full_name=${JSON.stringify(fullName)}`,
    );
    return 0;
  }
  const owner = fullName.slice(0, slashIdx);
  const name = fullName.slice(slashIdx + 1);
  const key = canonicalKey(number, fullName);

  try {
    const deps = await fetchIssueDeps(owner, name, number, token);
    const stmts = upsertEdges(db, key, deps.blocked_by, deps.blocking, "blocks");
    if (stmts.length > 0) {
      const results = await db.batch(stmts);
      return results.reduce((acc, r) => acc + (r.meta.changes ?? 0), 0);
    }
    return 0;
  } catch (err) {
    if (err instanceof GraphQLError) {
      console.warn(`[webhook] handle_deps: point-fetch failed for ${key} — ${err.message}`);
      return 0;
    }
    console.error(`[webhook] handle_deps: unexpected error for ${key}`, err);
    return 0;
  }
}

/**
 * Process a GitHub `issue_dependencies` webhook event.
 *
 * Acted upon: blocked_by_added, blocked_by_removed.
 * Ignored (duplicate-direction): blocking_added, blocking_removed.
 *
 * Cross-repo case: GitHub omits `blocking_issue` from payloads when the
 * blocker is in a different repo.  When that field is absent we fall back to a
 * point-fetch of the affected issue's current dependency lists and rewrite all
 * its `blocks` edges via upsertEdges.
 *
 * Returns the number of rows changed (0 for ignored events or no-ops).
 */
export async function handleDeps(
  payload: Record<string, unknown>,
  db: D1Database,
  env: Env,
): Promise<number> {
  const action = payload["action"] as string | undefined;

  if (action === "blocking_added" || action === "blocking_removed") {
    return 0;
  }

  if (action !== "blocked_by_added" && action !== "blocked_by_removed") {
    return 0;
  }

  const blockingIssue = (payload["blocking_issue"] as Record<string, unknown> | undefined) ?? null;
  const blockedIssue =
    ((payload["blocked_issue"] ?? payload["issue"]) as Record<string, unknown> | undefined) ?? null;
  const blockingRepo =
    (payload["blocking_issue_repo"] as Record<string, unknown> | undefined) ?? null;

  if (blockedIssue == null) {
    console.warn(
      `[webhook] handle_deps: unexpected payload shape for ${action} — keys=${Object.keys(payload).join(",")}`,
    );
    return 0;
  }

  // Cross-repo case: blocking_issue absent — point-fetch the downstream issue's
  // current dep graph and derive edges from the authoritative GitHub state.
  if (blockingIssue == null) {
    const repoObj = (payload["repository"] as Record<string, unknown> | undefined) ?? {};
    const fullName = (repoObj["full_name"] as string | undefined) ?? "";
    const slashIdx = fullName.indexOf("/");
    if (slashIdx < 0 || slashIdx === fullName.length - 1) {
      console.warn(
        `[webhook] handle_deps: cannot resolve token — malformed repository.full_name=${JSON.stringify(fullName)}`,
      );
      return 0;
    }
    const owner = fullName.slice(0, slashIdx);
    const name = fullName.slice(slashIdx + 1);
    let token: string;
    try {
      token = await resolveInstallToken(db, env, owner, name);
    } catch (err) {
      console.warn(`[webhook] handle_deps: resolveInstallToken failed for ${fullName}`, err);
      return 0;
    }
    return await pointFetchAndUpsertDeps(db, token, blockedIssue, repoObj);
  }

  // Same-repo fast path: both sides are in the payload — use them directly.
  const blockerKey = issueKey(
    blockingIssue,
    blockingRepo,
  );
  const blockedKey = issueKey(
    blockedIssue,
    (payload["repository"] as Record<string, unknown> | undefined) ?? null,
  );

  if (action === "blocked_by_added") {
    const result = await addEdge(db, blockerKey, blockedKey, "blocks").run();
    return result.meta.changes ?? 0;
  }

  if (action === "blocked_by_removed") {
    const result = await removeEdge(db, blockerKey, blockedKey, "blocks").run();
    return result.meta.changes ?? 0;
  }

  return 0;
}

/**
 * Process a GitHub `sub_issues` webhook event.
 *
 * Acted upon: sub_issue_added, sub_issue_removed.
 * Ignored (duplicate-direction): parent_issue_added, parent_issue_removed.
 *
 * Returns the number of rows changed (0 for ignored events or no-ops).
 */
export async function handleSubIssues(
  payload: Record<string, unknown>,
  db: D1Database,
): Promise<number> {
  const action = payload["action"] as string | undefined;

  if (action === "parent_issue_added" || action === "parent_issue_removed") {
    return 0;
  }

  if (action !== "sub_issue_added" && action !== "sub_issue_removed") {
    return 0;
  }

  const parentIssue = payload["parent_issue"] as Record<string, unknown> | undefined;
  const parentRepo =
    ((payload["parent_issue_repo"] ?? payload["repository"]) as
      | Record<string, unknown>
      | undefined) ?? null;
  const subIssue = payload["sub_issue"] as Record<string, unknown> | undefined;
  const subRepo =
    ((payload["sub_issue_repo"] ?? payload["repository"]) as
      | Record<string, unknown>
      | undefined) ?? null;

  if (!parentIssue || !parentRepo || !subIssue || !subRepo) {
    console.warn(
      `[webhook] handle_sub_issues: unexpected payload shape for ${action} — keys=${Object.keys(payload).sort().join(",")}`,
    );
    return 0;
  }

  let parentKey: string;
  let childKey: string;
  try {
    parentKey = `${(parentRepo as Record<string, unknown>)["full_name"]}#${parentIssue["number"]}`;
    childKey = `${(subRepo as Record<string, unknown>)["full_name"]}#${subIssue["number"]}`;
  } catch {
    console.warn(
      `[webhook] handle_sub_issues: malformed payload for ${action} — keys=${Object.keys(payload).sort().join(",")}`,
    );
    return 0;
  }

  if (action === "sub_issue_added") {
    const result = await addEdge(db, parentKey, childKey, "parent").run();
    return result.meta.changes ?? 0;
  } else {
    // sub_issue_removed
    const result = await removeEdge(db, parentKey, childKey, "parent").run();
    return result.meta.changes ?? 0;
  }
}

/**
 * Handle GitHub `create` event for branch refs.
 *
 * Applies BRANCH_ISSUE_RE to the ref name. If the branch name encodes an
 * issue number, sets has_active_branch=1 for that issue in D1.
 * Non-matching refs (dependabot, release-please, tags, etc.) are no-ops.
 */
export async function handleRefCreate(
  payload: Record<string, unknown>,
  db: D1Database,
): Promise<void> {
  if (payload["ref_type"] !== "branch") {
    return;
  }
  const ref = (payload["ref"] as string | undefined) ?? "";
  const repo =
    ((payload["repository"] as Record<string, unknown> | undefined) ?? {})["full_name"] as
      | string
      | undefined;
  const repoStr = repo ?? "";
  const m = BRANCH_ISSUE_RE.exec(ref);
  if (!m) {
    return;
  }
  const number = parseInt(m[1], 10);
  await setActiveBranch(db, repoStr, number, 1).run();
}

/**
 * Handle GitHub `delete` event for branch refs.
 *
 * On a matching branch deletion, re-queries GitHub via syncBranches (race
 * rule: do not trust the branch-removal event alone).
 * syncBranches uses env.DB directly (no fresh sqlite3 connection needed in
 * the Worker runtime).
 */
export async function handleRefDelete(
  payload: Record<string, unknown>,
  db: D1Database,
  env: Env,
): Promise<void> {
  if (payload["ref_type"] !== "branch") {
    return;
  }
  const ref = (payload["ref"] as string | undefined) ?? "";
  const repoFull =
    ((payload["repository"] as Record<string, unknown> | undefined) ?? {})["full_name"] as
      | string
      | undefined;
  const repo = repoFull ?? "";

  const m = BRANCH_ISSUE_RE.exec(ref);
  if (!m) {
    return;
  }

  const slashIdx = repo.indexOf("/");
  if (slashIdx < 0 || slashIdx === repo.length - 1) {
    console.warn(
      `[webhook] handle_ref_delete: malformed repo=${JSON.stringify(repo)} ref=${ref} — skipping syncBranches`,
    );
    return;
  }
  const owner = repo.slice(0, slashIdx);
  const name = repo.slice(slashIdx + 1);

  try {
    const token = await resolveInstallToken(db, env, owner, name);
    await syncBranches(db, token, owner, name);
  } catch (err) {
    console.error(
      `[webhook] handle_ref_delete: token resolution or branch sync failed for repo=${repo} ref=${ref}`,
      err,
    );
  }
}

/**
 * Handle GitHub `pull_request` events.
 *
 * Supported actions: opened, labeled, unlabeled, closed, reopened, edited,
 * synchronize.
 *
 * Upserts a pr_state row:
 * - state: 'open' or 'closed' (merged PRs count as closed)
 * - has_reviewed_label: 1 if any label name == 'reviewed', else 0
 * - closing_issue_keys: JSON array of 'owner/repo#N' for bare #N keyword
 *   refs in the PR body (same regex as auto-merge.yml)
 * - updated_at: current UTC ISO timestamp
 */
export async function handlePullRequest(
  payload: Record<string, unknown>,
  db: D1Database,
): Promise<void> {
  const pr = (payload["pull_request"] as Record<string, unknown> | undefined) ?? {};
  const repo =
    ((payload["repository"] as Record<string, unknown> | undefined) ?? {})["full_name"] as
      | string
      | undefined;
  const repoStr = repo ?? "";
  const number = parseInt(String(pr["number"] ?? "0"), 10);
  if (!number) {
    console.warn(
      `[webhook] pull_request webhook missing PR number; payload keys: ${Object.keys(pr).join(",")}`,
    );
    return;
  }

  const rawState = String(pr["state"] ?? "open");
  const merged = Boolean(pr["merged"]);
  const state = rawState === "closed" || merged ? "closed" : "open";

  const rawLabels: unknown[] = (pr["labels"] as unknown[] | undefined) ?? [];
  const labelNames: string[] = rawLabels.map((lbl) => {
    if (lbl && typeof lbl === "object") {
      return String((lbl as Record<string, unknown>)["name"] ?? "");
    }
    return String(lbl);
  });
  const hasReviewedLabel: 0 | 1 = labelNames.includes("reviewed") ? 1 : 0;

  const body = String(pr["body"] ?? "");
  const issueNumbers: string[] = [];
  for (const m of body.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) {
    issueNumbers.push(m[1]);
  }
  const closingIssueKeys: string[] = issueNumbers.map((n) => `${repoStr}#${n}`);
  const closingIssueKeysJson = JSON.stringify(closingIssueKeys);

  const updatedAt = new Date().toISOString();

  await upsertPrState(db, repoStr, number, state, hasReviewedLabel, closingIssueKeysJson, updatedAt).run();
}

/**
 * Process a GitHub `milestone` webhook event.
 *
 * Only `edited` + title change is handled — renames the milestone in-place
 * without re-fetching all issues from GitHub.
 */
export async function handleMilestone(
  payload: Record<string, unknown>,
  db: D1Database,
): Promise<void> {
  const action = payload["action"] as string | undefined;
  if (action !== "edited") {
    return;
  }
  const changes = (payload["changes"] as Record<string, unknown> | undefined) ?? {};
  const titleChange = changes["title"] as Record<string, unknown> | undefined;
  if (!titleChange) {
    return;
  }
  const oldTitle = String(titleChange["from"]);
  const newTitle = String(
    ((payload["milestone"] as Record<string, unknown> | undefined ?? {})["title"] as string | undefined) ?? "",
  );
  const repo = String(
    ((payload["repository"] as Record<string, unknown> | undefined ?? {})["full_name"] as string | undefined) ?? "",
  );
  await renameMilestone(db, repo, oldTitle, newTitle).run();
}

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
  const installation = payload["installation"] as Record<string, unknown> | undefined;
  const installationId =
    typeof installation?.["id"] === "number" ? (installation["id"] as number) : undefined;

  let tenant: TenantRow | null = null;
  let hasRoutingContext = false;
  if (installationId != null) {
    tenant = await getTenantByInstallationId(db, installationId);
    hasRoutingContext = true;
  } else if (event === "membership") {
    const org = payload["organization"] as Record<string, unknown> | undefined;
    const login = org?.["login"];
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
      await handleIssues(payload, db);
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
