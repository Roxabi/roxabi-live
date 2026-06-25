import { Hono } from "hono";
import type { AuthEnv } from "../auth/types";
import {
  type FakeResult,
  STUB_SESSION,
  captureDb,
  dispatchByTable,
  makeEnv,
  makeFakeDb,
  makeFakeStmt,
} from "../test-utils";
import type { Env } from "../types";
import { graphRoute } from "./graph";

export const GRAPH_REPO = "Roxabi/roxabi-live";

export type GraphIssueRow = {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  state: string;
  url: string | null;
  milestone: null;
  lane: string | null;
  priority: string | null;
  size: string | null;
  status: string | null;
  is_stub: number;
  has_active_branch: number;
  assignees?: string;
  updated_at?: string | null;
};

/** Minimal issues-row fixture for graph route tests. */
export function graphIssue(
  number: number,
  overrides: Partial<GraphIssueRow> = {},
  repo = GRAPH_REPO,
): GraphIssueRow {
  return {
    key: `${repo}#${number}`,
    repo,
    number,
    title: null,
    state: "open",
    url: null,
    milestone: null,
    lane: null,
    priority: null,
    size: null,
    status: null,
    is_stub: 0,
    has_active_branch: 0,
    ...overrides,
  };
}

export function aggregateRepoActivity(
  issues: Array<{ repo: string; updated_at?: string | null }>,
): FakeResult[] {
  const byRepo = new Map<string, { issue_count: number; last_updated_at: string | null }>();
  for (const issue of issues) {
    const prev = byRepo.get(issue.repo);
    const updatedAt = issue.updated_at ?? null;
    if (!prev) {
      byRepo.set(issue.repo, { issue_count: 1, last_updated_at: updatedAt });
      continue;
    }
    prev.issue_count += 1;
    if (updatedAt && (!prev.last_updated_at || updatedAt > prev.last_updated_at)) {
      prev.last_updated_at = updatedAt;
    }
  }
  return [...byRepo.entries()].map(([repo, stats]) => ({ repo, ...stats }));
}

export function makeGraphTestApp() {
  const a = new Hono<AuthEnv>();
  a.use("*", async (c, next) => {
    c.set("session", STUB_SESSION);
    await next();
  });
  a.get("/api/graph", graphRoute);
  return a;
}

type RepoAccessRow = { repo: string; is_private: number };

function graphDbRows(
  sql: string,
  labels: unknown[],
  prState: unknown[],
  issues: unknown[],
  edges: unknown[],
  repos: unknown[],
  _visibleRepos: string[],
  repoAccess: RepoAccessRow[],
  zkOptIn: boolean,
  sealedIssueKeys: string[],
): FakeResult[] {
  const lower = sql.toLowerCase();
  const issueRows = issues as Array<{ repo: string; updated_at?: string | null }>;
  if (lower.includes("group by repo")) {
    return aggregateRepoActivity(issueRows);
  }
  const privacyByRepo = new Map(repoAccess.map((row) => [row.repo, row.is_private]));
  const repoRows = (repos as Array<{ repo: string; archived: number }>).map((row) => ({
    repo: row.repo,
    archived: row.archived,
    is_private: privacyByRepo.get(row.repo) ?? 1,
  }));
  if (lower.includes("from repos")) {
    return repoRows;
  }
  return dispatchByTable(sql, {
    zk_opt_in: [{ zk_opt_in: zkOptIn ? 1 : 0 }],
    "from zk_payloads": sealedIssueKeys.map((issue_key) => ({ issue_key })),
    tenant_repo_access: repoAccess,
    "from labels": labels as FakeResult[],
    "from pr_state": prState as FakeResult[],
    "from edges": edges as FakeResult[],
    "from repos": repoRows as FakeResult[],
    "from issues": issues as FakeResult[],
  });
}

export function makeGraphEnv(
  labels: unknown[],
  prState: unknown[],
  issues: unknown[],
  edges: unknown[],
  repos: unknown[] = [],
  overrideVisible?: string[],
  zkOptIn = false,
  sealedIssueKeys: string[] = [],
  repoAccess?: RepoAccessRow[],
): Env {
  const visibleRepos = overrideVisible ?? [
    ...new Set((issues as Array<{ repo: string }>).map((i) => i.repo)),
  ];
  const accessRows =
    repoAccess ??
    visibleRepos.map((repo) => ({
      repo,
      is_private: 0,
    }));
  const db = makeFakeDb((sql, args) =>
    makeFakeStmt(
      sql,
      args,
      graphDbRows(
        sql,
        labels,
        prState,
        issues,
        edges,
        repos,
        visibleRepos,
        accessRows,
        zkOptIn,
        sealedIssueKeys,
      ),
      0,
    ),
  );
  return makeEnv(db);
}

export function makeGraphEnvWithCapture(
  labels: unknown[],
  prState: unknown[],
  issues: unknown[],
  edges: unknown[],
  repos: unknown[] = [],
): { env: Env; capturedSqls: string[] } {
  const capturedSqls: string[] = [];
  const visibleRepos = [...new Set((issues as Array<{ repo: string }>).map((i) => i.repo))];
  const accessRows = visibleRepos.map((repo) => ({ repo, is_private: 0 }));
  const { db } = captureDb((sql, _args) => {
    capturedSqls.push(sql);
    return graphDbRows(
      sql,
      labels,
      prState,
      issues,
      edges,
      repos,
      visibleRepos,
      accessRows,
      false,
      [],
    );
  });
  return { env: makeEnv(db), capturedSqls };
}
