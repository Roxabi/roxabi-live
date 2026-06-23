// graph.js — v6 graph view with v5 layout
// Uses layout.js for positioning and render_graph.js for DOM rendering

import { initGraphHover } from "./hover.js";
import { runLayout } from "./layout.js";
import { getEdgeElements, renderGraph } from "./render_graph.js";
import { filteredNodesForGraph, state } from "./state.js";

let loaded = false;

// ── Main graph initialization ────────────────────────────────────────────
export async function initGraph() {
  const panel = document.getElementById("graph-panel");
  if (!panel) return;

  // Graph filters by repo/milestone/priority/status, but search uses highlight.
  // Parent-node filtering (showParents=false) is applied inside applyFilters.
  const nodes = filteredNodesForGraph();

  const nodeKeys = new Set(nodes.map((n) => n.key));

  // Filter edges: only blocks edges, optionally include parent
  const edges = state.edges.filter(
    (e) =>
      nodeKeys.has(e.src) &&
      nodeKeys.has(e.dst) &&
      (e.kind === "blocks" || (state.showParents && e.kind === "parent")),
  );

  if (nodes.length === 0) {
    panel.innerHTML = '<div class="error-msg">No issues match the current filters.</div>';
    return;
  }

  panel.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Calculating layout…</div>';

  try {
    const layoutResult = await runLayout(nodes, edges, state.graphRow, state.graphCol);
    renderGraph(panel, nodes, edges, layoutResult);

    initGraphHover(panel, {
      chainEdges: edges,
      edgeElements: getEdgeElements(panel),
      nodes,
    });
    loaded = true;
  } catch (e) {
    panel.innerHTML = `<div class="error-msg">Graph layout failed: ${e.message}</div>`;
    console.error("Graph layout error:", e);
  }
}

// ── Force reload (for external use) ───────────────────────────────────────
export async function reloadGraph() {
  loaded = false;
  await initGraph();
}
