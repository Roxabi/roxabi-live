/**
 * hover.ts — dependency-chain traversal, ported from frontend/hover.js
 * (buildAdjacency / getHighlightChain). Pure: given a node key and an edge
 * list, returns the upstream (blockers, transitive) + downstream (blocked,
 * transitive) sets. The React graph dims everything outside `all` on hover.
 */

import type { GraphEdge } from "./types.ts";

export interface Adjacency {
  /** dst → [src...] : who blocks this node (upstream). */
  blockers: Map<string, string[]>;
  /** src → [dst...] : what this node blocks (downstream). */
  unblocks: Map<string, string[]>;
}

export function buildAdjacency(edges: GraphEdge[]): Adjacency {
  const blockers = new Map<string, string[]>();
  const unblocks = new Map<string, string[]>();
  for (const e of edges) {
    const b = blockers.get(e.dst);
    if (b) b.push(e.src);
    else blockers.set(e.dst, [e.src]);
    const u = unblocks.get(e.src);
    if (u) u.push(e.dst);
    else unblocks.set(e.src, [e.dst]);
  }
  return { blockers, unblocks };
}

function traverse(start: string, adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const k = stack.pop() as string;
    for (const n of adj.get(k) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

export interface HighlightChain {
  upstream: Set<string>;
  downstream: Set<string>;
  all: Set<string>;
}

/** Upstream + downstream chain from `key` over `edges`. */
export function getHighlightChain(key: string, edges: GraphEdge[]): HighlightChain {
  const { blockers, unblocks } = buildAdjacency(edges);
  const upstream = traverse(key, blockers);
  const downstream = traverse(key, unblocks);
  const all = new Set<string>([key, ...upstream, ...downstream]);
  return { upstream, downstream, all };
}
