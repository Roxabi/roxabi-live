/**
 * dims.ts — pivot/group dimension helpers, ported from frontend/state.js
 * (dimValue / dimDisplayLabel / compareDimValues / dimSortKey / isEmptyDimValue).
 *
 * Adapted to AnnotatedNode field names (computedStatus / parentKey) and to the
 * server-provided milestone fields (milestone_code / milestone_name /
 * milestone_sort_key), so the regex milestone fallback from the vanilla client
 * is unnecessary.
 */

import { EMPTY_ASSIGNEE, EMPTY_DIM } from "./graph.ts";
import type { AnnotatedNode } from "./graph.ts";

export type Dim =
  | "none"
  | "milestone"
  | "priority"
  | "repo"
  | "lane"
  | "size"
  | "status"
  | "parent"
  | "assignee";

const EMPTY_DIM_ALIASES = new Set([EMPTY_DIM, "—", "None", "All", EMPTY_ASSIGNEE]);
const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const STATUS_ORDER: Record<string, number> = { ready: 0, blocked: 1, done: 2 };

/** True when a pivot/group bucket has no underlying field value. */
export function isEmptyDimValue(val: string, dim: Dim): boolean {
  if (dim === "assignee") return val === EMPTY_ASSIGNEE;
  if (dim === "none") return false;
  return EMPTY_DIM_ALIASES.has(val);
}

/** Bucket key for a node on a given dimension. */
export function dimValue(node: AnnotatedNode, dim: Dim): string {
  switch (dim) {
    case "none":
      return "All";
    case "milestone":
      return node.milestone_code ?? EMPTY_DIM;
    case "priority":
      return node.priority ?? EMPTY_DIM;
    case "repo":
      return node.repo;
    case "lane":
      return node.lane ?? EMPTY_DIM;
    case "size":
      return node.size ?? EMPTY_DIM;
    case "status":
      return node.computedStatus;
    case "parent":
      return node.parentKey ?? EMPTY_DIM;
    case "assignee":
      return node.assignees.length ? node.assignees[0] : EMPTY_ASSIGNEE;
    default:
      return EMPTY_DIM;
  }
}

/** Human label for a row/column header or filter chip. */
export function dimDisplayLabel(val: string, dim: Dim): string {
  if (!isEmptyDimValue(val, dim)) return val;
  const labels: Record<string, string> = {
    milestone: "No milestone",
    priority: "No priority",
    lane: "No lane",
    size: "No size",
    repo: "No repo",
    status: "No status",
    assignee: "Unassigned",
    parent: "No parent",
  };
  return labels[dim] ?? EMPTY_DIM;
}

function dimSortKey(val: string, dim: Dim, nodes: AnnotatedNode[]): number {
  if (dim === "none") return 0;
  if (isEmptyDimValue(val, dim)) return -1; // empty buckets come first
  if (dim === "milestone") {
    const node = nodes.find((n) => dimValue(n, dim) === val);
    return node?.milestone_sort_key ?? 9999;
  }
  if (dim === "priority") return PRIORITY_ORDER[val] ?? 99;
  if (dim === "status") return STATUS_ORDER[val] ?? 99;
  return 0;
}

/** Order two bucket values for a dimension axis (empty buckets first). */
export function compareDimValues(a: string, b: string, dim: Dim, nodes: AnnotatedNode[]): number {
  const aEmpty = isEmptyDimValue(a, dim);
  const bEmpty = isEmptyDimValue(b, dim);
  if (aEmpty !== bEmpty) return aEmpty ? -1 : 1;
  const sa = dimSortKey(a, dim, nodes);
  const sb = dimSortKey(b, dim, nodes);
  if (sa !== sb) return sa - sb;
  return a.localeCompare(b);
}
