// graph.js — v5.1 graph view embed for v6
// Fetches /dep-graph/ HTML, extracts .graph-wrap, injects into #graph-panel.
// Hover-chain highlight is wired locally within the panel.

let loaded = false;

// ── Hover-chain highlight ─────────────────────────────────────────────────
function wireHoverChain(panel) {
  const nodes    = Array.from(panel.querySelectorAll('.gg-node[data-iss]'));
  const labels   = Array.from(panel.querySelectorAll('.gg-ilabel[data-iss]'));
  const edges    = Array.from(panel.querySelectorAll('.gg-edge[data-src]'));
  const allItems = [...nodes, ...labels];

  // Build adjacency by data-iss key
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

// ── Load & inject ─────────────────────────────────────────────────────────
export async function initGraph() {
  if (loaded) return;
  const panel = document.getElementById('graph-panel');
  panel.textContent = 'Loading graph…';
  try {
    const html = await fetch('/dep-graph/', { cache: 'no-store' }).then(r => {
      if (!r.ok) throw new Error(`/dep-graph/ ${r.status}`);
      return r.text();
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // v5.1 graph is a positioned-HTML layout inside .graph-wrap — not an SVG
    const graphWrap = doc.querySelector('.graph-wrap');
    if (!graphWrap) throw new Error('no .graph-wrap in /dep-graph/ response');

    // Build toolbar with refresh button
    const toolbar = document.createElement('div');
    toolbar.className = 'graph-toolbar';
    const reloadBtn = document.createElement('button');
    reloadBtn.id = 'graph-reload-btn';
    reloadBtn.type = 'button';
    reloadBtn.textContent = 'Refresh graph';
    reloadBtn.setAttribute('aria-label', 'Refresh graph from server');
    reloadBtn.addEventListener('click', reloadGraph);
    toolbar.appendChild(reloadBtn);

    panel.replaceChildren(toolbar, graphWrap);
    wireHoverChain(panel);
    loaded = true;
  } catch (e) {
    panel.textContent = `Graph load failed: ${e.message}`;
  }
}

export async function reloadGraph() {
  loaded = false;
  await initGraph();
}
