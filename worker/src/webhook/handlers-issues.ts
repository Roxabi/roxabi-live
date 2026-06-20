/**
 * GitHub webhook data handlers — issues, issue_dependencies, sub_issues.
 *
 * Split out of handlers.ts (file-length gate). Dispatched by webhookRoute
 * after HMAC verification + tenant routing; same db.batch atomicity contract.
 */

import { resolveInstallToken } from "../auth/installToken";
import { isIssueZkSealed } from "../auth/zk";
import { zkStructureOnlyEnabled } from "../auth/zk-flags";
import { GraphQLError, fetchIssueDeps } from "../sync/graphql";
import { canonicalKey, extractFromLabels } from "../sync/sync";
import type { Env } from "../types";
import {
  type WebhookIssue,
  addEdge,
  deleteIssue,
  removeEdge,
  replaceLabels,
  upsertEdges,
  upsertIssueFromWebhook,
} from "./mutations";

/**
 * Derive an issue key from a partial issue object plus an optional repo override.
 * Verbatim port of _issue_key() from handlers.py.
 */
function issueKey(
  issue: Record<string, unknown>,
  repoOverride?: Record<string, unknown> | null,
): string {
  const repo = repoOverride ?? (issue.repository as Record<string, unknown> | undefined) ?? {};
  const fullName = (repo.full_name as string | undefined) ?? "";
  return `${fullName}#${issue.number}`;
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
export async function handleIssues(
  payload: Record<string, unknown>,
  db: D1Database,
  env: Env,
): Promise<void> {
  const action = payload.action as string | undefined;
  const issue = payload.issue as Record<string, unknown>;
  const repo =
    ((payload.repository as Record<string, unknown> | undefined)?.full_name as
      | string
      | undefined) ?? "";
  const key = `${repo}#${issue.number}`;

  if (action === "deleted" || action === "transferred") {
    await deleteIssue(db, key).run();
    return;
  }

  const rawLabels: unknown[] = (issue.labels as unknown[] | undefined) ?? [];
  const names: string[] = rawLabels.map((lbl) => {
    if (lbl && typeof lbl === "object") {
      return String((lbl as Record<string, unknown>).name ?? "");
    }
    return String(lbl);
  });

  const milestoneObj = issue.milestone;
  let milestoneTitle: string | null = null;
  if (milestoneObj && typeof milestoneObj === "object") {
    const titleVal = (milestoneObj as Record<string, unknown>).title;
    milestoneTitle = titleVal != null ? String(titleVal) : null;
  }

  const derived = extractFromLabels(names);

  const structureOnly = zkStructureOnlyEnabled(env);
  const sealed = await isIssueZkSealed(db, key);
  const title = structureOnly || sealed ? null : ((issue.title as string | undefined) ?? null);

  const issuePartial: WebhookIssue = {
    key,
    repo,
    number: issue.number as number,
    title,
    state: issue.state as string,
    url: (issue.html_url as string | undefined) ?? null,
    created_at: (issue.created_at as string | null | undefined) ?? null,
    updated_at: (issue.updated_at as string | null | undefined) ?? null,
    closed_at: (issue.closed_at as string | null | undefined) ?? null,
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
  const number = blockedIssue.number as number | undefined;
  if (number == null) {
    console.warn(
      `[webhook] handle_deps: missing number in blocked_issue — keys=${Object.keys(blockedIssue).join(",")}`,
    );
    return 0;
  }
  const fullName = (repo.full_name as string | undefined) ?? "";
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
  const action = payload.action as string | undefined;

  if (action === "blocking_added" || action === "blocking_removed") {
    return 0;
  }

  if (action !== "blocked_by_added" && action !== "blocked_by_removed") {
    return 0;
  }

  const blockingIssue = (payload.blocking_issue as Record<string, unknown> | undefined) ?? null;
  const blockedIssue =
    ((payload.blocked_issue ?? payload.issue) as Record<string, unknown> | undefined) ?? null;
  const blockingRepo = (payload.blocking_issue_repo as Record<string, unknown> | undefined) ?? null;

  if (blockedIssue == null) {
    console.warn(
      `[webhook] handle_deps: unexpected payload shape for ${action} — keys=${Object.keys(payload).join(",")}`,
    );
    return 0;
  }

  // Cross-repo case: blocking_issue absent — point-fetch the downstream issue's
  // current dep graph and derive edges from the authoritative GitHub state.
  if (blockingIssue == null) {
    const repoObj = (payload.repository as Record<string, unknown> | undefined) ?? {};
    const fullName = (repoObj.full_name as string | undefined) ?? "";
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
  const blockerKey = issueKey(blockingIssue, blockingRepo);
  const blockedKey = issueKey(
    blockedIssue,
    (payload.repository as Record<string, unknown> | undefined) ?? null,
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
  const action = payload.action as string | undefined;

  if (action === "parent_issue_added" || action === "parent_issue_removed") {
    return 0;
  }

  if (action !== "sub_issue_added" && action !== "sub_issue_removed") {
    return 0;
  }

  const parentIssue = payload.parent_issue as Record<string, unknown> | undefined;
  const parentRepo =
    ((payload.parent_issue_repo ?? payload.repository) as Record<string, unknown> | undefined) ??
    null;
  const subIssue = payload.sub_issue as Record<string, unknown> | undefined;
  const subRepo =
    ((payload.sub_issue_repo ?? payload.repository) as Record<string, unknown> | undefined) ?? null;

  if (!parentIssue || !parentRepo || !subIssue || !subRepo) {
    console.warn(
      `[webhook] handle_sub_issues: unexpected payload shape for ${action} — keys=${Object.keys(payload).sort().join(",")}`,
    );
    return 0;
  }

  let parentKey: string;
  let childKey: string;
  try {
    parentKey = `${(parentRepo as Record<string, unknown>).full_name}#${parentIssue.number}`;
    childKey = `${(subRepo as Record<string, unknown>).full_name}#${subIssue.number}`;
  } catch {
    console.warn(
      `[webhook] handle_sub_issues: malformed payload for ${action} — keys=${Object.keys(payload).sort().join(",")}`,
    );
    return 0;
  }

  if (action === "sub_issue_added") {
    const result = await addEdge(db, parentKey, childKey, "parent").run();
    return result.meta.changes ?? 0;
  }
  // sub_issue_removed
  const result = await removeEdge(db, parentKey, childKey, "parent").run();
  return result.meta.changes ?? 0;
}
