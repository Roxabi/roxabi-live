// render_graph.js — DOM renderer for graph layouts
// Matches v5 HTML structure: percentage coords, SVG with viewBox="0 0 100 100"

import { edgePath } from "./layout.js";
import { mapDevStateToClass, state } from "./state.js";
import { repoTone } from "./tone.js";

function getTone(node) {
  return repoTone(node.repo) || "accent";
}

// ── Render nodes as .gg-node dots + .gg-ilabel labels (v4.8 style) ───────────
function renderNodes(container, nodes, positions, usePercentage) {
  const byKey = new Map();
  for (const n of nodes) byKey.set(n.key, n);

  for (const [key, pos] of positions) {
    const node = byKey.get(key);
    if (!node) continue;

    const tone = getTone(node);
    const isDone = node.state === "closed";
    const isBlocked = node._status === "blocked";
    const isParent = node._isParent === true;

    // Determine blockers/unblockers for data attrs
    const blockers = (node._blockers || []).map((e) => e.src).join(",");
    const unblocks = nodes
      .filter((n) => (n._blockers || []).some((e) => e.src === key))
      .map((n) => n.key)
      .join(",");

    const style = usePercentage
      ? `left:${pos.x.toFixed(2)}%; top:${pos.y.toFixed(2)}%;`
      : `left:${pos.x}px; top:${pos.y}px;`;

    // ── Dot (.gg-node) ──────────────────────────────────────────────────────
    const dot = document.createElement("a");
    dot.className = `gg-node${isParent ? " parent" : ""}${isDone ? " done" : ""}${isBlocked ? " blocked" : ""}`;
    dot.dataset.tone = tone;
    dot.dataset.iss = key;
    dot.dataset.blockedby = blockers;
    dot.dataset.blocking = unblocks;
    dot.href = node.url || "#";
    dot.target = "_blank";
    dot.rel = "noopener";
    dot.style.cssText = style;
    dot.title = `#${node.number} — ${node.title || ""}`;

    // Dev-state animation classes — skip for closed nodes (done wins)
    if (!isDone) {
      const devClass = mapDevStateToClass(node.dev_state);
      if (devClass) {
        dot.className += ` ${devClass}`;
        // Inject second orbit dot host element for pr_reviewed (orbit-2)
        if (devClass.includes("orbit-2")) {
          const orbitChild = document.createElement("span");
          orbitChild.className = "gg-orbit-2nd";
          orbitChild.setAttribute("aria-hidden", "true");
          dot.appendChild(orbitChild);
        }
      }
    }

    container.appendChild(dot);

    // ── Label (.gg-ilabel) ──────────────────────────────────────────────────
    const label = document.createElement("a");
    label.className = `gg-ilabel${isParent ? " parent" : ""}${isDone ? " done" : ""}${isBlocked ? " blocked" : ""}`;
    label.dataset.tone = tone;
    label.dataset.iss = key;
    label.dataset.blockedby = blockers;
    label.dataset.blocking = unblocks;
    label.href = node.url || "#";
    label.target = "_blank";
    label.rel = "noopener";
    label.style.cssText = style;
    label.title = `#${node.number} — ${node.title || ""}`;

    // Issue number
    const num = document.createElement("span");
    num.className = "gg-ilabel-num";
    num.textContent = `#${node.number}`;
    label.appendChild(num);

    // Size
    if (node.size) {
      const size = document.createElement("span");
      size.className = "gg-ilabel-size";
      size.textContent = node.size;
      label.appendChild(size);
    }

    // Title (truncated)
    const title = document.createElement("span");
    title.className = "gg-ilabel-title";
    const fullTitle = node.title || "";
    title.textContent = fullTitle.length > 28 ? `${fullTitle.slice(0, 27)}…` : fullTitle;
    label.appendChild(title);

    if (state.showAssignees) {
      const assignees = node.assignees ?? [];
      if (assignees.length > 0) {
        const assignee = document.createElement("span");
        assignee.className = "gg-ilabel-assignee";
        assignee.textContent = assignees.join(", ");
        assignee.title = `Assignees: ${assignees.join(", ")}`;
        label.appendChild(assignee);
      }
    }

    container.appendChild(label);
  }
}

// ── Render milestone row headers (v5 layout only) ─────────────────────────────
function msRowMetrics(ms, index, usePercentage, containerHeight, isLast) {
  const topPct = index === 0 ? 0 : ms.y;
  const heightPct = isLast ? 100 - topPct : index === 0 ? ms.y + ms.height : ms.height;
  if (usePercentage) {
    return {
      top: `${topPct.toFixed(2)}%`,
      height: `${heightPct.toFixed(2)}%`,
      bottomPct: topPct + heightPct,
    };
  }
  const topPx = Math.round((topPct / 100) * containerHeight);
  const heightPx = Math.round((heightPct / 100) * containerHeight);
  return {
    top: `${topPx}px`,
    height: `${heightPx}px`,
    bottomPct: topPct + heightPct,
  };
}

function renderMilestoneHeaders(container, milestoneInfo, usePercentage, containerHeight) {
  const rows = [];
  const visible = milestoneInfo.filter((ms) => ms.code);
  let visibleIndex = 0;
  for (const ms of visible) {
    const metrics = msRowMetrics(
      ms,
      visibleIndex,
      usePercentage,
      containerHeight,
      visibleIndex === visible.length - 1,
    );
    const row = document.createElement("div");
    row.className = `gg-msrow${visibleIndex === 0 ? " gg-msrow-first" : ""}${visibleIndex === visible.length - 1 ? " gg-msrow-last" : ""}`;
    row.style.top = metrics.top;
    row.style.height = metrics.height;

    const code = document.createElement("div");
    code.className = "gg-msrow-code";
    code.textContent = ms.label ?? ms.code;
    row.appendChild(code);

    if (ms.name && ms.name !== (ms.label ?? ms.code)) {
      const name = document.createElement("div");
      name.className = "gg-msrow-name";
      name.textContent = ms.name;
      row.appendChild(name);
    }

    container.appendChild(row);
    rows.push({ ...ms, bottomPct: metrics.bottomPct });
    visibleIndex++;
  }
  return rows;
}

function renderMilestoneSeparators(container, milestoneRows, usePercentage, containerHeight) {
  for (let i = 1; i < milestoneRows.length; i++) {
    const prev = milestoneRows[i - 1];
    const cur = milestoneRows[i];
    const sepY = (prev.bottomPct + cur.y) / 2;

    const sep = document.createElement("div");
    sep.className = "gg-msrow-sep";
    sep.style.top = usePercentage
      ? `${sepY.toFixed(2)}%`
      : `${Math.round((sepY / 100) * containerHeight)}px`;
    container.appendChild(sep);
  }
}

// ── Render SVG edges ─────────────────────────────────────────────────────────
function renderEdges(svgContainer, nodes, edges, positions, usePercentage) {
  const byKey = new Map();
  for (const n of nodes) byKey.set(n.key, n);

  for (const edge of edges) {
    const srcPos = positions.get(edge.src);
    const dstPos = positions.get(edge.dst);
    if (!srcPos || !dstPos) continue;

    const srcNode = byKey.get(edge.src);
    const dstNode = byKey.get(edge.dst);
    const tone = getTone(srcNode || {});
    const isBlocked = dstNode?._status === "blocked";
    const kind = edge.kind || "blocks";

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("gg-edge");
    if (isBlocked) path.classList.add("blocked");
    if (kind === "parent") path.classList.add("parent-edge");
    path.dataset.tone = tone;
    path.dataset.kind = kind;
    path.dataset.src = edge.src;
    path.dataset.dst = edge.dst;

    // Use percentage-based path for v5, pixel-based for others
    const d = usePercentage
      ? edgePath(srcPos.x, srcPos.y, dstPos.x, dstPos.y)
      : `M ${srcPos.x} ${srcPos.y} C ${srcPos.x} ${(srcPos.y + dstPos.y) / 2}, ${dstPos.x} ${(srcPos.y + dstPos.y) / 2}, ${dstPos.x} ${dstPos.y}`;

    path.setAttribute("d", d);
    if (usePercentage) {
      path.setAttribute("vector-effect", "non-scaling-stroke");
    }

    svgContainer.appendChild(path);
  }
}

function renderColHeaders(container, colInfo, usePercentage) {
  if (!colInfo?.length) return;
  const strip = document.createElement("div");
  strip.className = "gg-cscol-strip";
  for (const col of colInfo) {
    const el = document.createElement("div");
    el.className = "gg-cscol";
    el.textContent = col.label ?? col.code;
    el.style.left = usePercentage ? `${col.x.toFixed(2)}%` : `${col.x}px`;
    strip.appendChild(el);
  }
  container.appendChild(strip);
}

// ── Main render function ──────────────────────────────────────────────────────
export function renderGraph(container, nodes, edges, layoutResult) {
  const { positions, milestoneInfo, colInfo, width, height, usePercentage } = layoutResult;

  container.innerHTML = "";

  // Create graph wrapper
  const wrap = document.createElement("div");
  wrap.className = "graph-wrap";
  wrap.style.height = usePercentage ? `${height}px` : `${Math.max(height, 400)}px`;
  wrap.style.position = "relative";
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", "Dependency graph");

  // Render milestone headers OUTSIDE stage (left gutter, full-height bands)
  if (milestoneInfo && milestoneInfo.length > 0) {
    const milestoneRows = renderMilestoneHeaders(wrap, milestoneInfo, usePercentage, height);
    renderMilestoneSeparators(wrap, milestoneRows, usePercentage, height);
  }

  // Create stage container (holds both SVG and nodes, same coordinate system)
  const stage = document.createElement("div");
  stage.className = "graph-stage";
  renderColHeaders(stage, colInfo, usePercentage);

  // Create SVG layer for edges (inside stage so coords match nodes)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("graph-svg");

  if (usePercentage) {
    // v5 style: percentage-based positioning with viewBox
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
  } else {
    // Pixel-based: full size
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
  }
  svg.setAttribute("aria-hidden", "true");

  // Render edges first (behind nodes)
  renderEdges(svg, nodes, edges, positions, usePercentage);

  // Render nodes
  renderNodes(stage, nodes, positions, usePercentage);

  // SVG and nodes share the same stage (same coordinate space)
  stage.appendChild(svg);
  // Nodes already appended to stage in renderNodes

  wrap.appendChild(stage);
  container.appendChild(wrap);

  return wrap;
}

// ── Exports for hover-chain wiring ────────────────────────────────────────────
export function getEdgeElements(container) {
  return Array.from(container.querySelectorAll(".gg-edge[data-src]"));
}

export function getLabelElements(container) {
  // Include both .gg-node dots and .gg-ilabel labels for hover-chain
  return Array.from(container.querySelectorAll(".gg-node[data-iss], .gg-ilabel[data-iss]"));
}
