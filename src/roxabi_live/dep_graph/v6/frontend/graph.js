// graph.js — v6 graph view with v5 layout
// Uses layout.js for positioning and render_graph.js for DOM rendering

import { state, filteredNodes } from './state.js';
import { runLayout } from './layout.js';
import { renderGraph, getEdgeElements, getLabelElements } from './render_graph.js';

let loaded = false;

// ── Hover-chain highlight ─────────────────────────────────────────────────
function wireHoverChain(panel) {
  const labels = getLabelElements(panel);
  const edges  = getEdgeElements(panel);
  const allItems = labels;

  const byKey = new Map();
  for (const el of allItems) {
    const k = el.dataset.iss;
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(el);
  }

  function edgesFor(key, dir) {
    return edges.filter(e =>
      dir === 'up'   ? e.dataset.dst === key :
      dir === 'down' ? e.dataset.src === key : false
    );
  }

  function reachable(startKey, dir) {
    const visited = new Set();
    const queue   = [startKey];
    while (queue.length) {
      const k = queue.shift();
      if (visited.has(k)) continue;
      visited.add(k);
      for (const e of edgesFor(k, dir)) {
        const next = dir === 'up' ? e.dataset.src : e.dataset.dst;
        if (next) queue.push(next);
      }
    }
    visited.delete(startKey);
    return visited;
  }

  function activateHl(key) {
    panel.classList.add('hl-active');
    (byKey.get(key) || []).forEach(n => n.classList.add('hl-self'));
    for (const k of reachable(key, 'up')) {
      (byKey.get(k) || []).forEach(n => n.classList.add('hl-upstream'));
    }
    for (const k of reachable(key, 'down')) {
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

  function clearHl() {
    panel.classList.remove('hl-active');
    panel.querySelectorAll('.hl-self, .hl-upstream, .hl-downstream')
      .forEach(el => el.classList.remove('hl-self', 'hl-upstream', 'hl-downstream'));
    edges.forEach(e => e.classList.remove('hl-edge'));
  }

  for (const el of allItems) {
    el.addEventListener('mouseenter', () => { clearHl(); activateHl(el.dataset.iss); });
    el.addEventListener('mouseleave', clearHl);
  }
}

// ── Main graph initialization ────────────────────────────────────────────
export async function initGraph() {
  const panel = document.getElementById('graph-panel');

  const nodes = filteredNodes();
  const nodeKeys = new Set(nodes.map(n => n.key));
  const edges = state.edges.filter(e => nodeKeys.has(e.src) && nodeKeys.has(e.dst));

  if (nodes.length === 0) {
    panel.innerHTML = '<div class="error-msg">No issues match the current filters.</div>';
    return;
  }

  if (!loaded) {
    panel.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Calculating layout…</div>';
  }

  try {
    const layoutResult = await runLayout(nodes, edges);
    panel.innerHTML = '';

    const toolbar = document.createElement('div');
    toolbar.className = 'graph-toolbar';

    const reloadBtn = document.createElement('button');
    reloadBtn.id = 'graph-reload-btn';
    reloadBtn.type = 'button';
    reloadBtn.textContent = 'Refresh graph';
    reloadBtn.setAttribute('aria-label', 'Refresh graph');
    reloadBtn.addEventListener('click', () => {
      loaded = false;
      initGraph();
    });
    toolbar.appendChild(reloadBtn);
    panel.appendChild(toolbar);

    renderGraph(panel, nodes, edges, layoutResult);
    wireHoverChain(panel);
    loaded = true;
  } catch (e) {
    panel.innerHTML = `<div class="error-msg">Graph layout failed: ${e.message}</div>`;
    console.error('Graph layout error:', e);
  }
}

// ── Force reload (for external use) ───────────────────────────────────────
export async function reloadGraph() {
  loaded = false;
  await initGraph();
}
