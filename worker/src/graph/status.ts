/**
 * Graph issue status (ready / blocked / done) — mirrors frontend/state.js annotateNodes.
 */

export type GraphStatus = "ready" | "blocked" | "done";

const VALID_STATUSES = new Set<string>(["ready", "blocked", "done"]);

export function parseStatusQuery(raw: string | null): Set<GraphStatus> | null {
  if (raw === null || raw.trim() === "") return null;
  const out = new Set<GraphStatus>();
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (VALID_STATUSES.has(s)) out.add(s as GraphStatus);
  }
  return out.size > 0 ? out : null;
}

interface StatusNode {
  key: string;
  state: string;
}

interface StatusEdge {
  src: string;
  dst: string;
  kind: string;
}

/** Direct status from blocks edges + closed state (no parent propagation). */
function directStatus(
  node: StatusNode,
  blockingByDst: Map<string, StatusEdge[]>,
  nodesByKey: Map<string, StatusNode>,
): GraphStatus {
  if (node.state === "closed") return "done";
  const blockers = blockingByDst.get(node.key) ?? [];
  const openBlocker = blockers.some((e) => nodesByKey.get(e.src)?.state === "open");
  return openBlocker ? "blocked" : "ready";
}

/**
 * Compute per-node graph status including blocked propagation through parent edges.
 */
export function computeGraphStatuses(
  nodes: StatusNode[],
  edges: StatusEdge[],
): Map<string, GraphStatus> {
  const nodesByKey = new Map(nodes.map((n) => [n.key, n]));
  const blockingByDst = new Map<string, StatusEdge[]>();
  const childrenBySrc = new Map<string, string[]>();

  for (const e of edges) {
    if (e.kind === "blocks") {
      const list = blockingByDst.get(e.dst);
      if (list) list.push(e);
      else blockingByDst.set(e.dst, [e]);
    }
    if (e.kind === "parent") {
      const list = childrenBySrc.get(e.src);
      if (list) list.push(e.dst);
      else childrenBySrc.set(e.src, [e.dst]);
    }
  }

  const statuses = new Map<string, GraphStatus>();
  for (const n of nodes) {
    statuses.set(n.key, directStatus(n, blockingByDst, nodesByKey));
  }

  const queue = nodes.filter((n) => statuses.get(n.key) === "blocked").map((n) => n.key);
  const visited = new Set(queue);
  while (queue.length > 0) {
    const parentKey = queue.shift()!;
    for (const childKey of childrenBySrc.get(parentKey) ?? []) {
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      if (statuses.get(childKey) === "done") continue;
      statuses.set(childKey, "blocked");
      queue.push(childKey);
    }
  }

  return statuses;
}

export function filterNodesByStatus<T extends { key: string; state: string }>(
  nodes: T[],
  edges: StatusEdge[],
  allowed: Set<GraphStatus> | null,
): T[] {
  if (allowed === null) return nodes;
  const statuses = computeGraphStatuses(nodes, edges);
  return nodes.filter((n) => allowed.has(statuses.get(n.key)!));
}