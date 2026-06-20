/**
 * GitHub webhook ref/PR/milestone handlers — create, delete, pull_request,
 * milestone.
 *
 * Split out of handlers.ts (file-length gate). Dispatched by webhookRoute
 * after HMAC verification + tenant routing.
 */

import { resolveInstallToken } from "../auth/installToken";
import { BRANCH_ISSUE_RE, syncBranches } from "../sync/sync";
import type { Env } from "../types";
import { renameMilestone, setActiveBranch, upsertPrState } from "./mutations";

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
  if (payload.ref_type !== "branch") {
    return;
  }
  const ref = (payload.ref as string | undefined) ?? "";
  const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name as
    | string
    | undefined;
  const repoStr = repo ?? "";
  const m = BRANCH_ISSUE_RE.exec(ref);
  if (!m) {
    return;
  }
  const number = Number.parseInt(m[1], 10);
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
  if (payload.ref_type !== "branch") {
    return;
  }
  const ref = (payload.ref as string | undefined) ?? "";
  const repoFull = (payload.repository as Record<string, unknown> | undefined)?.full_name as
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
  const pr = (payload.pull_request as Record<string, unknown> | undefined) ?? {};
  const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name as
    | string
    | undefined;
  const repoStr = repo ?? "";
  const number = Number.parseInt(String(pr.number ?? "0"), 10);
  if (!number) {
    console.warn(
      `[webhook] pull_request webhook missing PR number; payload keys: ${Object.keys(pr).join(",")}`,
    );
    return;
  }

  const rawState = String(pr.state ?? "open");
  const merged = Boolean(pr.merged);
  const state = rawState === "closed" || merged ? "closed" : "open";

  const rawLabels: unknown[] = (pr.labels as unknown[] | undefined) ?? [];
  const labelNames: string[] = rawLabels.map((lbl) => {
    if (lbl && typeof lbl === "object") {
      return String((lbl as Record<string, unknown>).name ?? "");
    }
    return String(lbl);
  });
  const hasReviewedLabel: 0 | 1 = labelNames.includes("reviewed") ? 1 : 0;

  const body = String(pr.body ?? "");
  const issueNumbers: string[] = [];
  for (const m of body.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) {
    issueNumbers.push(m[1]);
  }
  const closingIssueKeys: string[] = issueNumbers.map((n) => `${repoStr}#${n}`);
  const closingIssueKeysJson = JSON.stringify(closingIssueKeys);

  const updatedAt = new Date().toISOString();

  await upsertPrState(
    db,
    repoStr,
    number,
    state,
    hasReviewedLabel,
    closingIssueKeysJson,
    updatedAt,
  ).run();
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
  const action = payload.action as string | undefined;
  if (action !== "edited") {
    return;
  }
  const changes = (payload.changes as Record<string, unknown> | undefined) ?? {};
  const titleChange = changes.title as Record<string, unknown> | undefined;
  if (!titleChange) {
    return;
  }
  const oldTitle = String(titleChange.from);
  const newTitle = String(
    ((payload.milestone as Record<string, unknown> | undefined)?.title as string | undefined) ?? "",
  );
  const repo = String(
    ((payload.repository as Record<string, unknown> | undefined)?.full_name as
      | string
      | undefined) ?? "",
  );
  await renameMilestone(db, repo, oldTitle, newTitle).run();
}
