/**
 * GET /api/graph — v6 graph payload (nodes + edges).
 *
 * Ported from src/roxabi_live/dep_graph/v6/api.py::build_graph_json.
 * Response shape MUST stay { nodes: Node[], edges: Edge[] } — byte-compatible
 * with the Python source consumed by the v6 frontend (state.js).
 *
 * Four D1 reads (same logical queries as Python):
 *   (a) labels — grouped into Map<issueKey, string[]>
 *   (b) open pr_state — build Map<issueKey, {has_reviewed_label:number}[]>
 *   (c) issues — one row per issue
 *   (d) edges — all src_key/dst_key/kind rows
 */

import type { Context } from "hono";
import type { Env } from "../types";
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
}

export interface Edge {
  src: string;
  dst: string;
  kind: string;
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
function computeDevState(
  issueState: string,
  hasActiveBranch: number,
  openPrs: PrInfo[],
): DevState {
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
}

interface EdgeRow {
  src_key: string;
  dst_key: string;
  kind: string;
}

export const graphRoute = async (c: Context<{ Bindings: Env }>) => {
  // (a) labels → Map<issueKey, string[]>
  const labelRows = await c.env.DB.prepare(
    "SELECT issue_key, name FROM labels",
  ).all<LabelRow>();
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
  const prRows = await c.env.DB.prepare(
    "SELECT closing_issue_keys, has_reviewed_label FROM pr_state WHERE state = 'open'",
  ).all<PrStateRow>();
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

  // (c) issues
  const issueRows = await c.env.DB.prepare(
    "SELECT key, repo, number, title, state, url, milestone," +
      " lane, priority, size, status, is_stub, has_active_branch FROM issues",
  ).all<IssueRow>();

  const nodes: Node[] = issueRows.results.map((row) => {
    const issueLabels = labelsByIssue.get(row.key) ?? [];
    const { code, name, sortKey } = parseMilestone(row.milestone);
    const openPrs = openPrsByIssue.get(row.key) ?? [];
    const devState = computeDevState(
      row.state,
      Number(row.has_active_branch ?? 0),
      openPrs,
    );
    return {
      key: row.key,
      repo: row.repo,
      number: row.number,
      title: row.title,
      state: row.state,
      dev_state: devState,
      url: row.url,
      milestone: row.milestone,
      milestone_code: code,
      milestone_name: name,
      milestone_sort_key: sortKey,
      labels: issueLabels,
      priority: row.priority,
      lane: row.lane ?? laneFromLabels(issueLabels),
      size: row.size,
      status: row.status,
      is_stub: Boolean(row.is_stub),
    };
  });

  // (d) edges
  const edgeRows = await c.env.DB.prepare(
    "SELECT src_key, dst_key, kind FROM edges",
  ).all<EdgeRow>();

  const edges: Edge[] = edgeRows.results.map((row) => ({
    src: row.src_key,
    dst: row.dst_key,
    kind: row.kind,
  }));

  return c.json({ nodes, edges });
};
