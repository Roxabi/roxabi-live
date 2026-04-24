// render_graph.js — DOM renderer for graph layouts
// Matches v5 HTML structure: percentage coords, SVG with viewBox="0 0 100 100"

import { edgePath } from './layout.js';
import { repoTone } from './tone.js';

function getTone(node) {
  return repoTone(node.repo) || 'accent';
}

// ── Render nodes as .gg-node dots + .gg-ilabel labels (v4.8 style) ───────────
function renderNodes(container, nodes, positions, usePercentage) {
  const byKey = new Map();
  for (const n of nodes) byKey.set(n.key, n);

  for (const [key, pos] of positions) {
    const node = byKey.get(key);
    if (!node) continue;

    const tone = getTone(node);
    const isDone = node.state === 'closed';
    const isBlocked = node._status === 'blocked';

    // Determine blockers/unblockers for data attrs
    const blockers = (node._blockers || []).map(e => e.src).join(',');
    const unblocks = nodes
      .filter(n => (n._blockers || []).some(e => e.src === key))
      .map(n => n.key)
      .join(',');

    const style = usePercentage
      ? `left:${pos.x.toFixed(2)}%; top:${pos.y.toFixed(2)}%;`
      : `left:${pos.x}px; top:${pos.y}px;`;

    // ── Dot (.gg-node) ──────────────────────────────────────────────────────
    const dot = document.createElement('a');
    dot.className = 'gg-node' + (isDone ? ' done' : '') + (isBlocked ? ' blocked' : '');
    dot.dataset.tone = tone;
    dot.dataset.iss = key;
    dot.dataset.blockedby = blockers;
    dot.dataset.blocking = unblocks;
    dot.href = node.url || '#';
    dot.target = '_blank';
    dot.rel = 'noopener';
    dot.style.cssText = style;
    dot.title = `#${node.number} — ${node.title || ''}`;
    container.appendChild(dot);

    // ── Label (.gg-ilabel) ──────────────────────────────────────────────────
    const label = document.createElement('a');
    label.className = 'gg-ilabel' + (isDone ? ' done' : '') + (isBlocked ? ' blocked' : '');
    label.dataset.tone = tone;
    label.dataset.iss = key;
    label.dataset.blockedby = blockers;
    label.dataset.blocking = unblocks;
    label.href = node.url || '#';
    label.target = '_blank';
    label.rel = 'noopener';
    label.style.cssText = style;
    label.title = `#${node.number} — ${node.title || ''}`;

    // Dot indicator inside label
    const ldot = document.createElement('span');
    ldot.className = 'gg-ldot';
    ldot.setAttribute('aria-hidden', 'true');
    label.appendChild(ldot);

    // Issue number
    const num = document.createElement('span');
    num.className = 'gg-ilabel-num';
    num.textContent = `#${node.number}`;
    label.appendChild(num);

    // Title (truncated)
    const title = document.createElement('span');
    title.className = 'gg-ilabel-title';
    const fullTitle = node.title || '';
    title.textContent = fullTitle.length > 28 ? fullTitle.slice(0, 27) + '…' : fullTitle;
    label.appendChild(title);

    container.appendChild(label);
  }
}

// ── Render milestone row headers (v5 layout only) ─────────────────────────────
function renderMilestoneHeaders(container, milestoneInfo, usePercentage) {
  for (const ms of milestoneInfo) {
    if (!ms.code) continue;

    const row = document.createElement('div');
    row.className = 'gg-msrow';
    row.style.top = usePercentage
      ? `${ms.y.toFixed(2)}%`
      : `${ms.y}px`;
    row.style.height = usePercentage
      ? `${(ms.height || 5).toFixed(2)}%`
      : `${ms.height || 40}px`;

    // Hide code for "no milestone" rows
    const isNoMs = ms.code === '-' || ms.code === '(None)';
    if (!isNoMs) {
      const code = document.createElement('div');
      code.className = 'gg-msrow-code';
      code.textContent = ms.code;
      row.appendChild(code);
    }

    // Show name, or "No milestone" for rows without milestone
    const displayName = ms.name || (isNoMs ? 'No milestone' : null);
    if (displayName) {
      const name = document.createElement('div');
      name.className = 'gg-msrow-name';
      name.textContent = displayName;
      row.appendChild(name);
    }

    container.appendChild(row);
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
    const isBlocked = dstNode?._status === 'blocked';
    const kind = edge.kind || 'blocks';

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('gg-edge');
    if (isBlocked) path.classList.add('blocked');
    if (kind === 'parent') path.classList.add('parent-edge');
    path.dataset.tone = tone;
    path.dataset.kind = kind;
    path.dataset.src = edge.src;
    path.dataset.dst = edge.dst;

    // Use percentage-based path for v5, pixel-based for others
    const d = usePercentage
      ? edgePath(srcPos.x, srcPos.y, dstPos.x, dstPos.y)
      : `M ${srcPos.x} ${srcPos.y} C ${srcPos.x} ${(srcPos.y + dstPos.y) / 2}, ${dstPos.x} ${(srcPos.y + dstPos.y) / 2}, ${dstPos.x} ${dstPos.y}`;

    path.setAttribute('d', d);
    if (usePercentage) {
      path.setAttribute('vector-effect', 'non-scaling-stroke');
    }

    svgContainer.appendChild(path);
  }
}

// ── Main render function ──────────────────────────────────────────────────────
export function renderGraph(container, nodes, edges, layoutResult) {
  const { positions, milestoneInfo, width, height, usePercentage } = layoutResult;

  container.innerHTML = '';

  // Create graph wrapper
  const wrap = document.createElement('div');
  wrap.className = 'graph-wrap';
  wrap.style.height = usePercentage ? `${height}px` : `${Math.max(height, 400)}px`;
  wrap.style.position = 'relative';
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', 'Dependency graph');

  // Render milestone headers OUTSIDE stage (they need left:12px from wrap edge)
  if (milestoneInfo && milestoneInfo.length > 0) {
    renderMilestoneHeaders(wrap, milestoneInfo, usePercentage);
  }

  // Create stage container (holds both SVG and nodes, same coordinate system)
  const stage = document.createElement('div');
  stage.className = 'graph-stage';

  // Create SVG layer for edges (inside stage so coords match nodes)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('graph-svg');

  if (usePercentage) {
    // v5 style: percentage-based positioning with viewBox
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
  } else {
    // Pixel-based: full size
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
  }
  svg.setAttribute('aria-hidden', 'true');

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
  return Array.from(container.querySelectorAll('.gg-edge[data-src]'));
}

export function getLabelElements(container) {
  // Include both .gg-node dots and .gg-ilabel labels for hover-chain
  return Array.from(container.querySelectorAll('.gg-node[data-iss], .gg-ilabel[data-iss]'));
}
