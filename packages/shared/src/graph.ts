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
