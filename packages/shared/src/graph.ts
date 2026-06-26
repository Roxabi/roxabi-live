/**
 * graph.ts — pure status + annotation logic for the dependency graph.
 *
 * Ported from frontend/state.js (annotateNodes / computeStatus). Two changes
 * from the vanilla version, both deliberate:
 *
 *  1. Immutable: annotateNodes returns freshly-cloned AnnotatedNode objects
 *     instead of mutating the input nodes in place. The React app reads nodes
 *     out of the (frozen) TanStack Query cache, so in-place mutation would throw.
 *
 *  2. Clean field names: the vanilla `_status` / `_parent` / `_blockers` become
 *     `computedStatus` / `parentKey` / `blockers`, leaving the wire `status`
 *     field (the raw board-status string) untouched on GraphNode.
 *
 * The algorithm itself is identical — same blocks/parent edge handling, same
 * two-pass BFS, same "closed always wins" rule, same cycle guard.
 */

import type { StatusKey } from "./brand.ts";
import type { DevState, GraphEdge, GraphNode } from "./types.ts";

/** Logical status of an issue — derived purely from blocks-edges + closed state. */
export type NodeStatus = "ready" | "blocked" | "done";

export interface AnnotatedNode extends GraphNode {
  /** Computed logical status (ready/blocked/done). Distinct from wire `status`. */
  computedStatus: NodeStatus;
  /** Parent issue key (from a 'parent' edge where dst=this, src=parent), or null. */
  parentKey: string | null;
  /** True when this node has >=1 child ('parent' edge with src=this). */
  isParent: boolean;
  /** Every edge where this node is the dst (for layout + tooltips). */
  blockers: GraphEdge[];
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/**
 * Direct status of a single node. Only 'blocks' edges affect status; 'parent'
 * edges are layout-only. closed → done; any open blocker → blocked; else ready.
 */
export function computeStatus(
  node: Pick<GraphNode, "key" | "state">,
  blockingByDst: Map<string, GraphEdge[]>,
  byKey: Map<string, GraphNode>,
): NodeStatus {
  if (node.state === "closed") return "done";
  const blockers = blockingByDst.get(node.key) ?? [];
  const openBlocker = blockers.some((e) => byKey.get(e.src)?.state === "open");
  return openBlocker ? "blocked" : "ready";
}

/**
 * Clone + annotate every node with computedStatus / parentKey / isParent /
 * blockers. 'blocked' is propagated down parent→child edges (a descendant of a
 * blocked epic renders blocked too) unless the child is already 'done'.
 */
export function annotateNodes(nodes: GraphNode[], edges: GraphEdge[]): AnnotatedNode[] {
  const blockingByDst = new Map<string, GraphEdge[]>(); // kind='blocks', for status
  const allByDst = new Map<string, GraphEdge[]>(); // every edge, for blockers
  const parentByDst = new Map<string, string[]>(); // kind='parent', dst→[parent keys]
  const childrenBySrc = new Map<string, string[]>(); // kind='parent', src→[child keys]
  const byKey = new Map<string, GraphNode>();

  for (const n of nodes) byKey.set(n.key, n);
  for (const e of edges) {
    pushTo(allByDst, e.dst, e);
    if (e.kind === "blocks") pushTo(blockingByDst, e.dst, e);
    if (e.kind === "parent") {
      pushTo(parentByDst, e.dst, e.src); // src is the parent
      pushTo(childrenBySrc, e.src, e.dst); // dst is the child
    }
  }

  // Pass 1 — clone each node and compute its direct status.
  const annotated: AnnotatedNode[] = nodes.map((n) => {
    const parents = parentByDst.get(n.key);
    return {
      ...n,
      blockers: allByDst.get(n.key) ?? [],
      computedStatus: computeStatus(n, blockingByDst, byKey),
      parentKey: parents?.length ? parents[0] : null,
      isParent: childrenBySrc.has(n.key),
    };
  });

  // Pass 2 — BFS propagate 'blocked' through parent→child edges; 'done' wins.
  const annotatedByKey = new Map(annotated.map((n) => [n.key, n]));
  const queue = annotated.filter((n) => n.computedStatus === "blocked").map((n) => n.key);
  const visited = new Set(queue);
  while (queue.length) {
    const parentKey = queue.shift() as string;
    for (const childKey of childrenBySrc.get(parentKey) ?? []) {
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      const child = annotatedByKey.get(childKey);
      if (!child || child.computedStatus === "done") continue;
      child.computedStatus = "blocked";
      queue.push(childKey);
    }
  }

  return annotated;
}

/**
 * Display status for the four-state fleet badge (ready/blocked/running/done).
 * The logical status is ready/blocked/done; a 'ready' node that has active dev
 * work (a branch, an open PR, a reviewed PR) is surfaced as 'running'.
 */
export function displayStatus(node: {
  computedStatus: NodeStatus;
  dev_state: DevState;
}): StatusKey {
  if (node.computedStatus === "ready" && node.dev_state !== "idle") return "running";
  return node.computedStatus;
}

/** Sentinel bucket labels for nodes with no value on a given dimension. */
export const EMPTY_DIM = "(None)";
export const EMPTY_ASSIGNEE = "(Unassigned)";

/** Active filter state for the list/table views (ported from state.js applyFilters). */
export interface NodeFilters {
  repo: string[];
  /** milestone_code values, or EMPTY_DIM for "no milestone". */
  milestone: string[];
  /** priority values, or EMPTY_DIM. */
  priority: string[];
  /** assignee logins, or EMPTY_ASSIGNEE. */
  assignee: string[];
  /** displayStatus values (ready/running/blocked/done) — 'running' = a ready
   *  issue with active dev work (branch/open PR/reviewed PR). */
  status: StatusKey[];
  label: string[];
  search: string;
  /** When false, parent (epic) nodes are hidden — they group children, not rows. */
  showParents: boolean;
  /**
   * Graph-view override: keep a closed ('done') issue whose parent epic is still
   * open even when the status facet excludes 'done'. Mirrors the legacy
   * frontend/state.js::filteredNodesForGraph behaviour (graph view only).
   */
  closedUnderOpenEpic?: boolean;
  /** When repo facet is empty, hide issues from these archived repos unless explicitly selected. */
  archivedRepos?: ReadonlySet<string>;
}

/**
 * Apply the list/table filters to an annotated node set. Every facet is an
 * AND; empty facet arrays mean "no constraint". Search matches key + title +
 * labels (substring, case-insensitive). Ported verbatim from
 * frontend/state.js::applyFilters.
 */
export function filterNodes(
  nodes: AnnotatedNode[],
  edges: GraphEdge[],
  f: NodeFilters,
): AnnotatedNode[] {
  const q = f.search.trim().toLowerCase();
  const parentKeys = f.showParents
    ? null
    : new Set(edges.filter((e) => e.kind === "parent").map((e) => e.src));
  const byKey = f.closedUnderOpenEpic ? new Map(nodes.map((n) => [n.key, n])) : null;

  return nodes.filter((n) => {
    if (parentKeys?.has(n.key)) return false;
    if (f.repo.length && !f.repo.includes(n.repo)) return false;
    if (!f.repo.length && f.archivedRepos?.has(n.repo)) return false;
    const msCode = n.milestone_code ?? EMPTY_DIM;
    if (f.milestone.length && !f.milestone.includes(msCode)) return false;
    const pri = n.priority ?? EMPTY_DIM;
    if (f.priority.length && !f.priority.includes(pri)) return false;
    if (f.status.length && !f.status.includes(displayStatus(n))) {
      // Graph "Closed" toggle: a done issue under a still-open epic stays visible.
      if (!(byKey && n.computedStatus === "done" && n.parentKey)) return false;
      if (byKey.get(n.parentKey)?.state !== "open") return false;
    }
    if (f.label.length && !f.label.some((l) => n.labels.includes(l))) return false;
    if (f.assignee.length) {
      if (n.assignees.length === 0) {
        if (!f.assignee.includes(EMPTY_ASSIGNEE)) return false;
      } else if (!n.assignees.some((a) => f.assignee.includes(a))) {
        return false;
      }
    }
    if (q) {
      const hay = `${n.key} ${n.title ?? ""} ${n.labels.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
