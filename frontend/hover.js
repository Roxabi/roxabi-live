// hover.js — centralized hover-chain highlight (table, list, graph)

import { state } from "./state.js";

/** @typedef {{ src: string, dst: string, kind?: string }} ChainEdge */

/** @typedef {{
 *   panel: HTMLElement,
 *   chainEdges: ChainEdge[],
 *   edgeElements: Element[],
 *   targetSelector: string,
 * }} HoverSession */

let activeSession = null;
let pinnedKey = null;
let searchPinWired = false;

// ── Graph traversal ───────────────────────────────────────────────────────────

/**
 * Build upstream/downstream adjacency from the supplied edge list.
 * Callers choose which kinds to include (table/list: blocks only; graph: blocks + parent).
 * @param {ChainEdge[]} edges
 */
export function buildAdjacency(edges) {
  const blockers = new Map();
  const unblocks = new Map();
  for (const e of edges) {
    if (!blockers.has(e.dst)) blockers.set(e.dst, []);
    blockers.get(e.dst).push(e.src);
    if (!unblocks.has(e.src)) unblocks.set(e.src, []);
    unblocks.get(e.src).push(e.dst);
  }
  return { blockers, unblocks };
}

/** @param {string} start @param {Map<string, string[]>} adj */
function traverse(start, adj) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const k = stack.pop();
    for (const n of adj.get(k) || []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

/** @param {string} key @param {ChainEdge[]} edges */
export function getHighlightChain(key, edges) {
  const { blockers, unblocks } = buildAdjacency(edges);
  const upstream = traverse(key, blockers);
  const downstream = traverse(key, unblocks);
  const all = new Set([key, ...upstream, ...downstream]);
  return { upstream, downstream, all };
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

/** @param {ParentNode} panel @param {string} [selector] */
export function bucketTargets(panel, selector = "[data-iss]") {
  const byKey = new Map();
  for (const el of panel.querySelectorAll(selector)) {
    const k = el.dataset.iss;
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(el);
  }
  return byKey;
}

// ── Apply / clear ─────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} panel
 * @param {string} key
 * @param {{ byKey: Map<string, Element[]>, chainEdges: ChainEdge[], edgeElements?: Element[] }} opts
 */
export function applyHighlight(panel, key, { byKey, chainEdges, edgeElements = [] }) {
  const { upstream, downstream, all } = getHighlightChain(key, chainEdges);

  panel.classList.add("hl-active");
  (byKey.get(key) || []).forEach((n) => n.classList.add("hl-self"));
  for (const k of upstream) {
    (byKey.get(k) || []).forEach((n) => n.classList.add("hl-upstream"));
  }
  for (const k of downstream) {
    (byKey.get(k) || []).forEach((n) => n.classList.add("hl-downstream"));
  }

  for (const e of edgeElements) {
    const src = e.dataset.src;
    const dst = e.dataset.dst;
    if (src && dst && all.has(src) && all.has(dst)) {
      e.classList.add("hl-edge");
    }
  }
}

/** @param {HTMLElement} panel @param {Element[]} [edgeElements] */
export function clearHighlight(panel, edgeElements = []) {
  panel.classList.remove("hl-active");
  panel
    .querySelectorAll(".hl-self, .hl-upstream, .hl-downstream")
    .forEach((el) => el.classList.remove("hl-self", "hl-upstream", "hl-downstream"));
  edgeElements.forEach((e) => e.classList.remove("hl-edge"));
}

function restorePinned(session) {
  clearHighlight(session.panel, session.edgeElements);
  if (!pinnedKey) return;
  applyHighlight(session.panel, pinnedKey, {
    byKey: bucketTargets(session.panel, session.targetSelector),
    chainEdges: session.chainEdges,
    edgeElements: session.edgeElements,
  });
}

// ── Wiring ────────────────────────────────────────────────────────────────────

/** @param {HoverSession} session */
function wireHoverChain(session) {
  const { panel, targetSelector, edgeElements } = session;
  const targets = panel.querySelectorAll(targetSelector);
  for (const el of targets) {
    el.addEventListener("mouseenter", () => {
      clearHighlight(panel, edgeElements);
      applyHighlight(panel, el.dataset.iss, {
        byKey: bucketTargets(panel, targetSelector),
        chainEdges: session.chainEdges,
        edgeElements,
      });
    });
    el.addEventListener("mouseleave", () => restorePinned(session));
  }
}

/** Issue-number pin for table/list search (highlights chain without re-render). */
function wireSearchPin(input) {
  if (!input || searchPinWired) return;
  searchPinWired = true;

  input.addEventListener("input", () => {
    if (state.view === "graph") return;
    const raw = input.value.trim().replace(/^#/, "");
    if (!raw) {
      pinnedKey = null;
      if (activeSession) clearHighlight(activeSession.panel, activeSession.edgeElements);
      return;
    }
    const panel = activeSession?.panel || document.querySelector(".view-active");
    if (!panel) return;

    const byNum = new Map();
    const byKey = new Map();
    for (const el of panel.querySelectorAll("[data-iss]")) {
      const k = el.dataset.iss;
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(el);
      const m = /#(\d+)$/.exec(k);
      if (!m) continue;
      const num = m[1];
      if (!byNum.has(num)) byNum.set(num, []);
      byNum.get(num).push(k);
    }

    const keys = byNum.get(raw);
    if (!keys?.length) {
      pinnedKey = null;
      clearHighlight(panel, activeSession?.edgeElements ?? []);
      return;
    }

    pinnedKey = keys[0];
    const session = activeSession ?? {
      panel,
      chainEdges: state.edges.filter((e) => e.kind === "blocks" || !e.kind),
      edgeElements: [],
      targetSelector: "[data-iss]",
    };
    clearHighlight(panel, session.edgeElements);
    applyHighlight(panel, pinnedKey, {
      byKey,
      chainEdges: session.chainEdges,
      edgeElements: session.edgeElements,
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Table and list views — blocks edges only, no SVG edges. */
export function initHover(panel) {
  const session = {
    panel,
    chainEdges: state.edges.filter((e) => e.kind === "blocks" || !e.kind),
    edgeElements: [],
    targetSelector: "[data-iss]",
  };
  activeSession = session;
  wireHoverChain(session);

  const searchInput = document.getElementById("search-input");
  if (searchInput) wireSearchPin(searchInput);
}

/**
 * Graph view — uses filtered chain edges (blocks + optional parent) and SVG edge elements.
 * @param {HTMLElement} panel
 * @param {{ chainEdges: ChainEdge[], edgeElements: Element[], nodes: Array<{ key: string, title?: string|null, labels?: string[] }> }} opts
 */
export function initGraphHover(panel, { chainEdges, edgeElements, nodes }) {
  const session = {
    panel,
    chainEdges,
    edgeElements,
    targetSelector: ".gg-node[data-iss], .gg-ilabel[data-iss]",
  };
  activeSession = session;
  wireHoverChain(session);
  applyGraphSearchHighlight(panel, nodes, session);
}

/**
 * Graph search: highlight first text match + dependency chain (does not filter nodes).
 * @param {HTMLElement} panel
 * @param {Array<{ key: string, title?: string|null, labels?: string[] }>} nodes
 * @param {HoverSession} session
 */
export function applyGraphSearchHighlight(panel, nodes, session = activeSession) {
  if (!session) return;
  const search = (state.search ?? "").trim().toLowerCase();
  if (!search) {
    pinnedKey = null;
    return;
  }

  const match = nodes.find((n) => {
    const hay = `${n.key} ${n.title ?? ""} ${(n.labels ?? []).join(" ")}`.toLowerCase();
    return hay.includes(search);
  });
  if (!match) {
    pinnedKey = null;
    return;
  }

  pinnedKey = match.key;
  clearHighlight(panel, session.edgeElements);
  applyHighlight(panel, pinnedKey, {
    byKey: bucketTargets(panel, session.targetSelector),
    chainEdges: session.chainEdges,
    edgeElements: session.edgeElements,
  });
}

/** Clear pinned search highlight (ESC, filter changes, search clear). */
export function clearPinned() {
  pinnedKey = null;
  if (activeSession) clearHighlight(activeSession.panel, activeSession.edgeElements);
}
