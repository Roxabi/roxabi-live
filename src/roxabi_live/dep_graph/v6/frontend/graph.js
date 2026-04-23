// graph.js — v6 graph view with v5 layout
// Uses layout.js for positioning and render_graph.js for DOM rendering

import { state, filteredNodesForGraph } from './state.js';
import { runLayout } from './layout.js';
import { renderGraph, getEdgeElements, getLabelElements } from './render_graph.js';

let loaded = false;

// ── Shared highlight helpers ────────────────────────────────────────────────
function getReachableKeys(edges, startKey, dir) {
  const visited = new Set();
  const queue = [startKey];
  while (queue.length) {
    const k = queue.shift();
    if (visited.has(k)) continue;
    visited.add(k);
    for (const e of edges) {
      const next = dir === 'up' ? e.dataset.src : e.dataset.dst;
      const cur = dir === 'up' ? e.dataset.dst : e.dataset.src;
      if (cur === k && next) queue.push(next);
    }
  }
  visited.delete(startKey);
  return visited;
}

function applyHighlight(panel, edges, key) {
  const labels = getLabelElements(panel);
  const byKey = new Map();
  for (const el of labels) {
    const k = el.dataset.iss;
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(el);
  }

  panel.classList.add('hl-active');
  (byKey.get(key) || []).forEach(n => n.classList.add('hl-self'));

  for (const k of getReachableKeys(edges, key, 'up')) {
    (byKey.get(k) || []).forEach(n => n.classList.add('hl-upstream'));
  }
  for (const k of getReachableKeys(edges, key, 'down')) {
    (byKey.get(k) || []).forEach(n => n.classList.add('hl-downstream'));
  }

  for (const e of edges) {
    const src = e.dataset.src;
    const dst = e.dataset.dst;
    if (src && dst) {
      const srcIsHl = (byKey.get(src) || []).some(n =>
        n.classList.contains('hl-self') || n.classList.contains('hl-upstream') ||
        n.classList.contains('hl-downstream')
      );
      const dstIsHl = (byKey.get(dst) || []).some(n =>
        n.classList.contains('hl-self') || n.classList.contains('hl-upstream') ||
        n.classList.contains('hl-downstream')
      );
      if (srcIsHl && dstIsHl) e.classList.add('hl-edge');
    }
  }
}

function clearHighlight(panel, edges) {
  panel.classList.remove('hl-active');
  panel.querySelectorAll('.hl-self, .hl-upstream, .hl-downstream')
    .forEach(el => el.classList.remove('hl-self', 'hl-upstream', 'hl-downstream'));
  edges.forEach(e => e.classList.remove('hl-edge'));
}

// ── Hover-chain highlight ─────────────────────────────────────────────────
function wireHoverChain(panel, edges) {
  const labels = getLabelElements(panel);
  const allItems = labels;

  for (const el of allItems) {
    el.addEventListener('mouseenter', () => {
      clearHighlight(panel, edges);
      applyHighlight(panel, edges, el.dataset.iss);
    });
    el.addEventListener('mouseleave', () => clearHighlight(panel, edges));
  }
}

// ── Search highlight (tree-based, no filtering) ─────────────────────────────
function applySearchHighlight(panel, nodes, edges) {
  const search = (state.search ?? '').trim().toLowerCase();
  if (!search) return;

  // Find matching nodes
  const matches = nodes.filter(n => {
    const hay = `${n.key} ${n.title ?? ''} ${(n.labels ?? []).join(' ')}`.toLowerCase();
    return hay.includes(search);
  });

  if (matches.length === 0) return;

  // Apply highlight to first match and its tree
  const key = matches[0].key;
  applyHighlight(panel, edges, key);
}

// Store current edges for clearSearchHighlight
let currentEdges = [];

// ── Main graph initialization ────────────────────────────────────────────
export async function initGraph() {
  const panel = document.getElementById('graph-panel');
  if (!panel) return;

  // Graph filters by repo/milestone/priority/status, but search uses highlight.
  // Parent-node filtering (showParents=false) is applied inside applyFilters.
  const nodes = filteredNodesForGraph();

  const nodeKeys = new Set(nodes.map(n => n.key));

  // Filter edges: only blocks edges, optionally include parent
  const edges = state.edges.filter(e =>
    nodeKeys.has(e.src) && nodeKeys.has(e.dst) &&
    (e.kind === 'blocks' || state.showParents)
  );
  currentEdges = [];

  if (nodes.length === 0) {
    panel.innerHTML = '<div class="error-msg">No issues match the current filters.</div>';
    return;
  }

  panel.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Calculating layout…</div>';

  try {
    const layoutResult = await runLayout(nodes, edges);
    renderGraph(panel, nodes, edges, layoutResult);

    // Get DOM edge elements for highlight
    currentEdges = getEdgeElements(panel);

    wireHoverChain(panel, currentEdges);
    applySearchHighlight(panel, nodes, currentEdges);
    loaded = true;
  } catch (e) {
    panel.innerHTML = `<div class="error-msg">Graph layout failed: ${e.message}</div>`;
    console.error('Graph layout error:', e);
  }
}

// ── Clear search highlight (for ESC key) ───────────────────────────────────
export function clearSearchHighlight() {
  const panel = document.getElementById('graph-panel');
  if (panel && currentEdges.length) {
    clearHighlight(panel, currentEdges);
  }
}

// ── Force reload (for external use) ───────────────────────────────────────
export async function reloadGraph() {
  loaded = false;
  await initGraph();
}
