// hover.js — hover-chain highlight for table and list views
// Lifted from v5 hover.js, adapted for v6 module system

import { state } from './state.js';

// ── Build adjacency maps from edges ───────────────────────────────────────────
function buildAdjacency() {
  const blockers = new Map(); // key → keys that block it
  const unblocks = new Map(); // key → keys it unblocks

  for (const e of state.edges) {
    if (e.kind === 'blocks' || !e.kind) {
      if (!blockers.has(e.dst)) blockers.set(e.dst, []);
      blockers.get(e.dst).push(e.src);
      if (!unblocks.has(e.src)) unblocks.set(e.src, []);
      unblocks.get(e.src).push(e.dst);
    }
  }
  return { blockers, unblocks };
}

// ── Traverse graph to find upstream/downstream ────────────────────────────────
function traverse(start, adj) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const k = stack.pop();
    for (const n of adj.get(k) || []) {
      if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
  }
  return seen;
}

// ── Highlight logic ────────────────────────────────────────────────────────────
let panelEl = null;
let targetsFn = null;
let edgesFn = null;
let pinnedKey = null;

function highlightKey(k, byKey, edges) {
  const { blockers, unblocks } = buildAdjacency();
  const up = traverse(k, blockers);
  const down = traverse(k, unblocks);

  panelEl.classList.add('hl-active');
  (byKey.get(k) || []).forEach(n => n.classList.add('hl-self'));
  up.forEach(key => (byKey.get(key) || []).forEach(n => n.classList.add('hl-upstream')));
  down.forEach(key => (byKey.get(key) || []).forEach(n => n.classList.add('hl-downstream')));

  const chain = new Set([k, ...up, ...down]);
  edges.forEach(e => {
    if (chain.has(e.dataset.src) && chain.has(e.dataset.tgt)) {
      e.classList.add('hl-edge');
    }
  });
}

function clearHighlight() {
  if (!panelEl) return;
  panelEl.classList.remove('hl-active');
  panelEl.querySelectorAll('.hl-self, .hl-upstream, .hl-downstream')
    .forEach(el => el.classList.remove('hl-self', 'hl-upstream', 'hl-downstream'));
  (edgesFn ? edgesFn() : []).forEach(e => e.classList.remove('hl-edge'));
}

function restorePinned(byKey, edges) {
  clearHighlight();
  if (pinnedKey) highlightKey(pinnedKey, byKey, edges);
}

// ── Wire hover events on all targets ───────────────────────────────────────────
function wireTargets(targets, byKey, edges) {
  targets.forEach(el => {
    el.addEventListener('mouseenter', () => {
      clearHighlight();
      highlightKey(el.dataset.iss, byKey, edges);
    });
    el.addEventListener('mouseleave', () => restorePinned(byKey, edges));
  });
}

// ── Wire search input for pinned highlight ─────────────────────────────────────
function wireSearch(input, byKey, edges) {
  if (!input) return;

  // Build number → keys map
  const byNum = new Map();
  for (const k of byKey.keys()) {
    const m = /#(\d+)$/.exec(k);
    if (!m) continue;
    const num = m[1];
    if (!byNum.has(num)) byNum.set(num, []);
    byNum.get(num).push(k);
  }

  function applySearch() {
    const raw = input.value.trim().replace(/^#/, '');
    if (!raw) {
      pinnedKey = null;
      clearHighlight();
      return;
    }
    const keys = byNum.get(raw);
    if (!keys || keys.length === 0) {
      pinnedKey = null;
      clearHighlight();
      return;
    }
    pinnedKey = keys[0];
    clearHighlight();
    highlightKey(pinnedKey, byKey, edges);
  }

  input.addEventListener('input', applySearch);

  // Esc clears search
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!input.value && !pinnedKey) return;
    input.value = '';
    applySearch();
    if (document.activeElement === input) input.blur();
  });
}

// ── Public: initialize hover for a view container ──────────────────────────────
export function initHover(panel, viewName) {
  panelEl = panel;

  // Get all elements with data-iss (issue cards, list rows, etc.)
  const targets = Array.from(panel.querySelectorAll('[data-iss]'));
  if (targets.length === 0) return;

  // Bucket elements by issue key
  const byKey = new Map();
  targets.forEach(el => {
    const k = el.dataset.iss;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(el);
  });

  // Get edge elements if any (for graph view)
  const edges = viewName === 'graph'
    ? Array.from(panel.querySelectorAll('.gg-edge[data-src]'))
    : [];

  edgesFn = () => edges;

  wireTargets(targets, byKey, edges);

  // Wire search if this is the first view initialized
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    wireSearch(searchInput, byKey, edges);
  }
}

// ── Clear pinned key when filters change ───────────────────────────────────────
export function clearPinned() {
  pinnedKey = null;
}
