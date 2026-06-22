/**
 * GET /api/graph — v6 graph payload (nodes + edges).
 *
 * Ported from src/roxabi_live/dep_graph/v6/api.py::build_graph_json.
 * Response shape MUST stay { nodes: Node[], edges: Edge[] } — byte-compatible
 * with the Python source consumed by the v6 frontend (state.js).
 *
 * Five D1 reads (a)-(e), tenant-scoped to resolveVisibleRepos(c):
 *   (a) labels — grouped into Map<issueKey, string[]>
 *   (b) open pr_state — build Map<issueKey, {has_reviewed_label:number}[]>
 *   (c) issues — one row per issue
 *   (d) edges — all src_key/dst_key/kind rows
 *   (e) repos — registry rows + is_private + per-repo issue_count / last_updated_at
 */

import type { Context } from "hono";
import { resolveVisibleRepos } from "../auth/repoAccess";
import type { AuthEnv } from "../auth/types";
import { loadZkSealedIssueKeysForUser, redactIssueTitle } from "../auth/zk";
import {
  filterNodesByStatus,
  parseClosedUnderOpenEpicQuery,
  parseStatusQuery,
} from "../graph/status";
import { parseMilestone } from "../sync/parse";

const LANE_LABEL_PREFIX = "graph:lane/";

export type DevState = "idle" | "dev" | "pr_open" | "pr_reviewed";

interface PrInfo {
  has_reviewed_label: number;
}

export interface Node {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  state: string;
  dev_state: DevState;
  url: string | null;
  milestone: string | null;
  milestone_code: string | null;
  milestone_name: string | null;
  milestone_sort_key: number;
  labels: string[];
  priority: string | null;
  lane: string | null;
  size: string | null;
  status: string | null;
  is_stub: boolean;
  assignees: string[];
}

export interface Edge {
  src: string;
  dst: string;
  kind: string;
}

function parseAssignees(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Fallback: derive lane from `graph:lane/X` label when board field unset. */
function laneFromLabels(labels: string[]): string | null {
  for (const lbl of labels) {
    if (lbl.startsWith(LANE_LABEL_PREFIX)) {
      return lbl.slice(LANE_LABEL_PREFIX.length);
    }
  }
  return null;
}

/**
 * Compute dev_state for a single issue node.
 *
 * Priority (highest wins):
 *   pr_reviewed — any open PR linked to this issue has has_reviewed_label=1
 *   pr_open     — any open PR linked to this issue (no reviewed label)
 *   dev         — has_active_branch=1, no open PR
 *   idle        — no branch, no open PR; also forced for closed issues
 */
function computeDevState(issueState: string, hasActiveBranch: number, openPrs: PrInfo[]): DevState {
  if (issueState === "closed") return "idle";
  if (openPrs.some((pr) => pr.has_reviewed_label)) return "pr_reviewed";
  if (openPrs.length > 0) return "pr_open";
  if (hasActiveBranch) return "dev";
  return "idle";
}

interface LabelRow {
  issue_key: string;
  name: string;
}

interface PrStateRow {
  closing_issue_keys: string | null;
  has_reviewed_label: number;
}

interface IssueRow {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  state: string;
  url: string | null;
  milestone: string | null;
  lane: string | null;
  priority: string | null;
  size: string | null;
  status: string | null;
  is_stub: number;
  has_active_branch: number;
  assignees: string | null;
}

interface EdgeRow {
  src_key: string;
  dst_key: string;
  kind: string;
}

export const graphRoute = async (c: Context<AuthEnv>) => {
  const session = c.get("session");
  const sealedKeys = session
    ? await loadZkSealedIssueKeysForUser(c.env.DB, session.userId)
    : new Set<string>();

  const visible = await resolveVisibleRepos(c);

  if (visible.length === 0) {
    return c.json({ nodes: [], edges: [], repos: [] });
  }

  const ph = visible.map(() => "?").join(",");

  // (a) labels → Map<issueKey, string[]> — scoped to visible issues only
  const labelRows = await c.env.DB.prepare(
    `SELECT issue_key, name FROM labels WHERE issue_key IN (SELECT key FROM issues WHERE repo IN (${ph}))`,
  )
    .bind(...visible)
    .all<LabelRow>();
  const labelsByIssue = new Map<string, string[]>();
  for (const row of labelRows.results) {
    const existing = labelsByIssue.get(row.issue_key);
    if (existing) {
      existing.push(row.name);
    } else {
      labelsByIssue.set(row.issue_key, [row.name]);
    }
  }

  // (b) open pr_state → Map<issueKey, PrInfo[]>
  // pr_state has a repo column; scope to visible repos so PR metadata for non-visible
  // repos is excluded. openPrsByIssue is read by key only for visible issues, but
  // scoping here prevents any row for non-visible repos from entering the map.
  const prRows = await c.env.DB.prepare(
    `SELECT closing_issue_keys, has_reviewed_label FROM pr_state WHERE state = 'open' AND repo IN (${ph})`,
  )
    .bind(...visible)
    .all<PrStateRow>();
  const openPrsByIssue = new Map<string, PrInfo[]>();
  for (const row of prRows.results) {
    if (!row.closing_issue_keys) continue;
    let keys: string[];
    try {
      keys = JSON.parse(row.closing_issue_keys) as string[];
    } catch {
      continue;
    }
    const prInfo: PrInfo = { has_reviewed_label: Number(row.has_reviewed_label) };
    for (const key of keys) {
      const existing = openPrsByIssue.get(key);
      if (existing) {
        existing.push(prInfo);
      } else {
        openPrsByIssue.set(key, [prInfo]);
      }
    }
  }

  // (c) issues — scoped to visible repos
  const issueRows = await c.env.DB.prepare(
    `SELECT key, repo, number, JSON_EXTRACT(payload,'$.title') AS title, state, url, milestone, lane, priority, size, status, is_stub, has_active_branch, assignees FROM issues WHERE repo IN (${ph})`,
  )
    .bind(...visible)
    .all<IssueRow>();

  const searchParams = new URL(c.req.url).searchParams;
  const statusFilter = parseStatusQuery(searchParams.get("status"));
  const closedUnderOpenEpic = parseClosedUnderOpenEpicQuery(
    searchParams.get("closed_under_open_epic"),
  );

  let nodes: Node[] = issueRows.results.map((row) => {
    const issueLabels = labelsByIssue.get(row.key) ?? [];
    const { code, name, sortKey } = parseMilestone(row.milestone);
    const openPrs = openPrsByIssue.get(row.key) ?? [];
    const devState = computeDevState(row.state, Number(row.has_active_branch ?? 0), openPrs);
    return {
      key: row.key,
      repo: row.repo,
      number: row.number,
      title: redactIssueTitle(row.title, row.key, sealedKeys),
      state: row.state,
      dev_state: devState,
      url: row.url,
      milestone: row.milestone,
      milestone_code: code,
      milestone_name: name,
      milestone_sort_key: sortKey,
      labels: issueLabels,
      priority: row.priority,
      lane: row.lane || laneFromLabels(issueLabels),
      size: row.size,
      status: row.status,
      is_stub: Boolean(row.is_stub),
      assignees: parseAssignees(row.assignees),
    };
  });

  // (d) edges — both endpoints must be in visible repos; dangling edges to invisible
  // nodes are dropped (graph only draws an edge when both nodes are present)
  const edgeRows = await c.env.DB.prepare(
    `SELECT src_key, dst_key, kind FROM edges WHERE src_key IN (SELECT key FROM issues WHERE repo IN (${ph})) AND dst_key IN (SELECT key FROM issues WHERE repo IN (${ph}))`,
  )
    .bind(...visible, ...visible)
    .all<EdgeRow>();

  let edges: Edge[] = edgeRows.results.map((row) => ({
    src: row.src_key,
    dst: row.dst_key,
    kind: row.kind,
  }));

  if (statusFilter !== null) {
    nodes = filterNodesByStatus(nodes, edges, statusFilter, { closedUnderOpenEpic });
    const keys = new Set(nodes.map((n) => n.key));
    edges = edges.filter((e) => keys.has(e.src) && keys.has(e.dst));
  }

  // (e) repos — registry + visibility + activity stats for filter dropdown ordering
  interface RepoRow {
    repo: string;
    archived: number;
    is_private: number;
  }
  interface RepoActivityRow {
    repo: string;
    issue_count: number;
    last_updated_at: string | null;
  }
  const tenantId = session?.tenantId ?? null;
  const [repoRows, activityRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.repo, r.archived, COALESCE(tra.is_private, 1) AS is_private
       FROM repos r
       LEFT JOIN tenant_repo_access tra
         ON tra.tenant_id = ? AND tra.repo = r.repo
       WHERE r.repo IN (${ph})`,
    )
      .bind(tenantId, ...visible)
      .all<RepoRow>(),
    c.env.DB.prepare(
      `SELECT repo, COUNT(*) AS issue_count, MAX(updated_at) AS last_updated_at
       FROM issues WHERE repo IN (${ph}) GROUP BY repo`,
    )
      .bind(...visible)
      .all<RepoActivityRow>(),
  ]);
  const activityByRepo = new Map((activityRows.results ?? []).map((row) => [row.repo, row]));
  const repos = (repoRows.results ?? []).map((r) => {
    const activity = activityByRepo.get(r.repo);
    return {
      repo: r.repo,
      archived: Boolean(r.archived),
      is_private: Number(r.is_private) !== 0,
      issue_count: activity?.issue_count ?? 0,
      last_updated_at: activity?.last_updated_at ?? null,
    };
  });

  return c.json({ nodes, edges, repos });
};
