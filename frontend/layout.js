// layout.js — Graph layout for v6 dep-graph
// v5 engine: percentage coords, depth-based bands, configurable row/col grouping

import { compareDimValues, dimDisplayLabel, dimValue } from "./state.js";

// ── v5 positioning constants (match Python layout_graph.py) ──────────────────
const LANE_X_START = 4.0;
const LANE_X_END = 96.0;
const Y_TOP = 1.5;
const Y_BOT = 88.0;
const MIN_NODE_X = 8.0;
const MIN_VIS_NODE_GAP = 4.0;
const MAX_BAND_GAP_PX = 80;
const MIN_CONTAINER_H = 320;

function rowKey(node, rowDim) {
  return dimValue(node, rowDim);
}

function colKey(node, colDim) {
  return dimValue(node, colDim);
}

function rowSublabel(rowVal, rowDim, nodes) {
  if (rowDim !== "milestone") return null;
  const node = nodes.find((n) => rowKey(n, rowDim) === rowVal);
  const name = node?.milestone_name ?? null;
  if (!name || name === rowVal) return null;
  return name;
}

export function edgePath(x1, y1, x2, y2) {
  if (Math.abs(x1 - x2) < 0.1) {
    return `M ${x1.toFixed(2)},${y1.toFixed(2)} L ${x2.toFixed(2)},${y2.toFixed(2)}`;
  }
  const ymid = (y1 + y2) / 2;
  return `M ${x1.toFixed(2)},${y1.toFixed(2)} C ${x1.toFixed(2)},${ymid.toFixed(2)} ${x2.toFixed(2)},${ymid.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`;
}

/** Full-lane column anchors (repo, lane, …). */
function xFromColIdx(idx, colCount) {
  const pageSpan = LANE_X_END - LANE_X_START;
  const pageCenter = (LANE_X_START + LANE_X_END) / 2;
  if (colCount <= 1) return pageCenter;
  const step = pageSpan / (colCount - 1);
  const span = step * (colCount - 1);
  const xStart = pageCenter - span / 2;
  return xStart + idx * step;
}

/** Spread a same-column group around its anchor; use the full lane only when necessary. */
function spreadGroupX(count, anchorX) {
  if (count <= 1) return [Math.max(anchorX, MIN_NODE_X)];
  const laneSpan = LANE_X_END - MIN_NODE_X;
  let gap = MIN_VIS_NODE_GAP;
  let span = (count - 1) * gap;
  if (span > laneSpan) {
    gap = laneSpan / (count - 1);
    span = laneSpan;
  }
  let start = anchorX - span / 2;
  if (start < MIN_NODE_X) start = MIN_NODE_X;
  if (start + span > LANE_X_END) start = Math.max(MIN_NODE_X, LANE_X_END - span);
  return [...Array(count).keys()].map((i) => start + i * gap);
}

/** Spread only nodes that share the same desired column — keep distinct columns apart. */
function resolveBandColCollisions(bandNodes, desired, colCount) {
  const final = [...desired];
  const xByKey = new Map();
  const groups = new Map();
  for (let i = 0; i < desired.length; i++) {
    const d = desired[i];
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(i);
  }
  for (const [d, indices] of groups) {
    if (indices.length <= 1) continue;
    const anchor = Math.max(xFromColIdx(d, colCount), MIN_NODE_X);
    const xs = spreadGroupX(indices.length, anchor);
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j];
      xByKey.set(bandNodes[i].key, xs[j]);
    }
  }
  return { final, xByKey };
}

function finalizeBandXs(bandNodes, xByKey, minGap = MIN_VIS_NODE_GAP) {
  if (bandNodes.length <= 1) return;
  const sorted = [...bandNodes].sort(
    (a, b) => (xByKey.get(a.key) ?? 0) - (xByKey.get(b.key) ?? 0) || a.key.localeCompare(b.key),
  );

  for (let i = 1; i < sorted.length; i++) {
    const prevX = xByKey.get(sorted[i - 1].key) ?? MIN_NODE_X;
    const curX = xByKey.get(sorted[i].key) ?? MIN_NODE_X;
    if (curX - prevX < minGap) {
      xByKey.set(sorted[i].key, prevX + minGap);
    }
  }

  const lastKey = sorted[sorted.length - 1].key;
  const firstKey = sorted[0].key;
  const lastX = xByKey.get(lastKey) ?? MIN_NODE_X;
  if (lastX <= LANE_X_END) return;

  const firstX = xByKey.get(firstKey) ?? MIN_NODE_X;
  const span = lastX - firstX;
  const targetSpan = LANE_X_END - MIN_NODE_X;
  if (span <= 0) return;

  const scale = targetSpan / span;
  for (const n of sorted) {
    const x = xByKey.get(n.key) ?? MIN_NODE_X;
    xByKey.set(n.key, MIN_NODE_X + (x - firstX) * scale);
  }
}

/** Gap-fix only within the same order-by column — never push nodes across columns. */
function finalizeBandXsByColumn(bandNodes, desired, xByKey, minGap = MIN_VIS_NODE_GAP) {
  const groups = new Map();
  for (let i = 0; i < bandNodes.length; i++) {
    const d = desired[i];
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(bandNodes[i]);
  }
  for (const group of groups.values()) {
    finalizeBandXs(group, xByKey, minGap);
  }
}

function colHeaderLabel(code, colDim) {
  const label = dimDisplayLabel(code, colDim);
  if (colDim === "repo" && code.includes("/")) {
    return code.split("/")[1] || label;
  }
  return label.length > 14 ? `${label.slice(0, 13)}…` : label;
}

export function layoutV5(nodes, edges, rowDim = "milestone", colDim = "lane") {
  const colSet = new Set();
  if (colDim !== "none") {
    for (const n of nodes) colSet.add(colKey(n, colDim));
  }
  const colOrder = [...colSet].sort((a, b) => compareDimValues(a, b, colDim, nodes));

  const rowSet = new Set(nodes.map((n) => rowKey(n, rowDim)));
  const rowValues = [...rowSet].sort((a, b) => compareDimValues(a, b, rowDim, nodes));

  const blockersByDst = new Map();
  for (const e of edges) {
    if (!blockersByDst.has(e.dst)) blockersByDst.set(e.dst, []);
    blockersByDst.get(e.dst).push(e);
  }
  for (const n of nodes) {
    n._blockers = blockersByDst.get(n.key) || [];
  }

  const nodesByKey = new Map(nodes.map((n) => [n.key, n]));
  const depthCache = new Map();
  function computeDepth(node, stack = new Set()) {
    const cached = depthCache.get(node.key);
    if (cached !== undefined) return cached;
    if (stack.has(node.key)) return 0;
    stack.add(node.key);
    let maxDepth = 0;
    for (const e of node._blockers || []) {
      const blocker = nodesByKey.get(e.src);
      if (blocker) {
        maxDepth = Math.max(maxDepth, computeDepth(blocker, stack) + 1);
      }
    }
    stack.delete(node.key);
    depthCache.set(node.key, maxDepth);
    return maxDepth;
  }
  for (const n of nodes) {
    n._depth = computeDepth(n);
  }

  const byRowDepth = new Map();
  for (const n of nodes) {
    const row = rowKey(n, rowDim);
    const depth = n._depth;
    if (!byRowDepth.has(row)) byRowDepth.set(row, new Map());
    if (!byRowDepth.get(row).has(depth)) byRowDepth.get(row).set(depth, []);
    byRowDepth.get(row).get(depth).push(n);
  }

  const columnCount = colDim === "none" ? 1 : Math.max(colOrder.length, 1);

  const cellOf = new Map();
  const xOf = new Map();

  function colIdx(val) {
    if (colDim === "none") return 0;
    const idx = colOrder.indexOf(val);
    return idx >= 0 ? idx : colOrder.length;
  }

  function desiredCellsForBand(_row, bandNodes, _gridSz) {
    if (colDim !== "none") {
      return bandNodes.map((n) => colIdx(colKey(n, colDim)));
    }
    // None: same as ordering by the row dimension — one column per band, spread on collision.
    return bandNodes.map(() => 0);
  }

  const bandKeys = [];
  for (const row of rowValues) {
    const depths = byRowDepth.get(row);
    if (!depths) continue;
    for (const depth of depths.keys()) {
      bandKeys.push([row, depth]);
    }
  }
  // Depth first so parent X is known before children in other milestone rows.
  bandKeys.sort((a, b) => a[1] - b[1] || compareDimValues(a[0], b[0], rowDim, nodes));

  for (const [row, depth] of bandKeys) {
    const bandNodes = byRowDepth.get(row).get(depth);
    bandNodes.sort(
      (a, b) => colIdx(colKey(a, colDim)) - colIdx(colKey(b, colDim)) || a.key.localeCompare(b.key),
    );

    const desired = desiredCellsForBand(row, bandNodes, columnCount);

    // Only spread when multiple nodes share the same column cell — never
    // push distinct columns apart (that blew past the lane and hid nodes left).
    const hasColCollisions = new Set(desired).size < desired.length;
    const resolved = hasColCollisions
      ? resolveBandColCollisions(bandNodes, desired, columnCount)
      : { final: desired, xByKey: new Map() };
    const bandX = new Map();
    for (let i = 0; i < bandNodes.length; i++) {
      const n = bandNodes[i];
      cellOf.set(n.key, resolved.final[i]);
      const x =
        resolved.xByKey.get(n.key) ??
        Math.max(xFromColIdx(resolved.final[i], columnCount), MIN_NODE_X);
      bandX.set(n.key, x);
    }
    finalizeBandXsByColumn(bandNodes, resolved.final, bandX, MIN_VIS_NODE_GAP);
    for (const n of bandNodes) {
      xOf.set(n.key, bandX.get(n.key));
    }
  }

  const sortedBandKeys = [...bandKeys].sort(
    (a, b) => compareDimValues(a[0], b[0], rowDim, nodes) || a[1] - b[1],
  );

  const yTop = Y_TOP;
  const nBands = sortedBandKeys.length;
  const stepY = nBands > 1 ? (Y_BOT - yTop) / (nBands - 1) : 0;
  const halfBand = stepY > 0 ? stepY / 2 : 4;

  const positions = new Map();
  const bandRecords = [];

  for (let i = 0; i < sortedBandKeys.length; i++) {
    const [row, depth] = sortedBandKeys[i];
    const bandY = yTop + i * stepY;
    const bandNodes = byRowDepth.get(row).get(depth) || [];
    bandNodes.sort((a, b) => (cellOf.get(a.key) || 0) - (cellOf.get(b.key) || 0));

    for (const n of bandNodes) {
      positions.set(n.key, { x: xOf.get(n.key) || 50, y: bandY });
    }

    bandRecords.push({ row, depth, y: bandY, count: bandNodes.length });
  }

  const ysByRow = new Map();
  for (const b of bandRecords) {
    if (!ysByRow.has(b.row)) ysByRow.set(b.row, []);
    ysByRow.get(b.row).push(b.y);
  }

  const rowInfo = [];
  for (const [row, ys] of ysByRow) {
    const top = Math.min(...ys) - halfBand;
    const bot = Math.max(...ys) + halfBand;
    rowInfo.push({
      code: row,
      label: dimDisplayLabel(row, rowDim),
      name: rowSublabel(row, rowDim, nodes),
      y: Math.max(top, 0.5),
      height: Math.max(Math.min(bot, 99.0) - Math.max(top, 0.5), halfBand * 2),
    });
  }
  rowInfo.sort((a, b) => compareDimValues(a.code, b.code, rowDim, nodes));

  const colInfo =
    colDim === "none"
      ? []
      : colOrder.map((code) => {
          const xs = [];
          for (const n of nodes) {
            if (colKey(n, colDim) === code && xOf.has(n.key)) {
              xs.push(xOf.get(n.key));
            }
          }
          const nominal = xFromColIdx(colIdx(code), columnCount);
          const x = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : nominal;
          return {
            code,
            label: colHeaderLabel(code, colDim),
            x,
          };
        });

  const bandSpanPct = (Y_BOT - yTop) / 100;
  const containerH =
    nBands > 1
      ? Math.max(MIN_CONTAINER_H, (MAX_BAND_GAP_PX * (nBands - 1)) / bandSpanPct + 80)
      : MIN_CONTAINER_H;

  return {
    positions,
    rowInfo,
    milestoneInfo: rowInfo,
    colInfo,
    lanes: colOrder,
    width: 100,
    height: containerH,
    usePercentage: true,
    rowDim,
    colDim,
  };
}

export function runLayout(nodes, edges, rowDim = "milestone", colDim = "lane") {
  return layoutV5(nodes, edges, rowDim, colDim);
}
