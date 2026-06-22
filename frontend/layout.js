// layout.js — Graph layout for v6 dep-graph
// v5 engine: percentage coords, depth-based bands, configurable row/col grouping

import { compareDimValues, dimDisplayLabel, dimValue } from "./state.js";

// ── v5 positioning constants (match Python layout_graph.py) ──────────────────
const LANE_X_START = 4.0;
const LANE_X_END = 96.0;
const Y_TOP = 1.5;
const Y_BOT = 88.0;
const MIN_NODE_X = 8.0;
const MIN_CELL_GAP = 2;
const MAX_CELL_WIDTH_PCT = 4.0;
const MAX_BAND_GAP_PX = 80;
const MIN_CONTAINER_H = 320;

function rowKey(node, rowDim) {
  return dimValue(node, rowDim);
}

function colKey(node, colDim) {
  return dimValue(node, colDim);
}

function computeGridSize(byRowDepth, colDim, colOrder) {
  if (colDim === "none") return 1;
  let gridSize = Math.max(colOrder.length, 1);
  for (const depths of byRowDepth.values()) {
    for (const bandNodes of depths.values()) {
      const byCol = new Map();
      for (const n of bandNodes) {
        const c = colKey(n, colDim);
        byCol.set(c, (byCol.get(c) || 0) + 1);
      }
      for (const count of byCol.values()) {
        if (count > 1) {
          const needed = colOrder.length + (count - 1) * MIN_CELL_GAP;
          gridSize = Math.max(gridSize, needed);
        }
      }
    }
  }
  return gridSize;
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

function msBounds(gridSize) {
  const pageSpan = LANE_X_END - LANE_X_START;
  const pageCenter = (LANE_X_START + LANE_X_END) / 2;
  if (gridSize <= 1) return { xStart: pageCenter, xEnd: pageCenter, step: 0 };
  // Always fit the full grid inside the lane — shrink step when many columns.
  const fitStep = pageSpan / (gridSize - 1);
  const step = Math.min(MAX_CELL_WIDTH_PCT, fitStep);
  const span = step * (gridSize - 1);
  const xStart = pageCenter - span / 2;
  return { xStart, xEnd: xStart + span, step };
}

function xFromCell(cell, gridSize) {
  const { xStart, step } = msBounds(gridSize);
  return xStart + cell * step;
}

function cellFromX(x, gridSize) {
  const { xStart, step } = msBounds(gridSize);
  if (step === 0) return 0;
  const raw = Math.round((x - xStart) / step);
  return Math.max(0, Math.min(gridSize - 1, raw));
}

function resolveCells(desired, gridSize) {
  const n = desired.length;
  const order = [...Array(n).keys()].sort((a, b) => desired[a] - desired[b] || a - b);
  const final = new Array(n);

  for (let k = 0; k < n; k++) {
    const idx = order[k];
    let c = Math.max(desired[idx], 0);
    if (k > 0) {
      c = Math.max(c, final[order[k - 1]] + MIN_CELL_GAP);
    }
    final[idx] = c;
  }

  for (let k = n - 1; k >= 0; k--) {
    const idx = order[k];
    let c = Math.min(final[idx], gridSize - 1);
    if (k < n - 1) {
      c = Math.min(c, final[order[k + 1]] - MIN_CELL_GAP);
    }
    final[idx] = c;
  }

  return final;
}

/** Spread only nodes that share the same desired column — keep distinct columns apart. */
function resolveBandColCollisions(desired, gridSize) {
  const final = [...desired];
  const groups = new Map();
  for (let i = 0; i < desired.length; i++) {
    const d = desired[i];
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(i);
  }
  for (const indices of groups.values()) {
    if (indices.length <= 1) continue;
    const subDesired = indices.map((i) => desired[i]);
    const resolved = resolveCells(subDesired, gridSize);
    for (let j = 0; j < indices.length; j++) {
      final[indices[j]] = resolved[j];
    }
  }
  return final;
}

function separateBandXs(bandNodes, xByKey, minGap = 1) {
  if (bandNodes.length <= 1) return;
  const sorted = [...bandNodes].sort(
    (a, b) => (xByKey.get(a.key) ?? 0) - (xByKey.get(b.key) ?? 0) || a.key.localeCompare(b.key),
  );
  let needsSeparation = false;
  for (let i = 1; i < sorted.length; i++) {
    const prevX = xByKey.get(sorted[i - 1].key) ?? 0;
    const curX = xByKey.get(sorted[i].key) ?? 0;
    if (curX - prevX < minGap) {
      needsSeparation = true;
      break;
    }
  }
  if (!needsSeparation) return;

  for (let i = 1; i < sorted.length; i++) {
    const prevX = xByKey.get(sorted[i - 1].key) ?? MIN_NODE_X;
    const curX = xByKey.get(sorted[i].key) ?? MIN_NODE_X;
    if (curX - prevX < minGap) {
      xByKey.set(sorted[i].key, Math.min(prevX + minGap, LANE_X_END - 1));
    }
  }
}

function uniformCells(n, gridSize) {
  if (n <= 0) return [];
  if (n === 1) return [Math.floor(gridSize / 2)];
  const step = (gridSize - 1) / (n - 1);
  return [...Array(n).keys()].map((i) => Math.round(i * step));
}

function colHeaderLabel(code, colDim) {
  const label = dimDisplayLabel(code, colDim);
  if (colDim === "repo" && code.includes("/")) {
    return code.split("/")[1] || label;
  }
  return label.length > 14 ? `${label.slice(0, 13)}…` : label;
}

function getParentCells(task, allTasks, rowVal, rowDim, cellOf, xOf, gridSize) {
  const cells = [];
  for (const parent of allTasks) {
    if (parent.key === task.key) continue;
    const edges = task._blockers || [];
    const isParent = edges.some((e) => e.src === parent.key);
    if (!isParent) continue;

    const pNum = parent.key;
    if (rowKey(parent, rowDim) === rowVal && cellOf.has(pNum)) {
      cells.push(cellOf.get(pNum));
    } else if (xOf.has(pNum)) {
      cells.push(cellFromX(xOf.get(pNum), gridSize));
    }
  }
  return cells;
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

  const groupedGridSize = colDim === "none" ? 1 : computeGridSize(byRowDepth, colDim, colOrder);

  const cellOf = new Map();
  const xOf = new Map();

  function colIdx(val) {
    if (colDim === "none") return 0;
    const idx = colOrder.indexOf(val);
    return idx >= 0 ? idx : colOrder.length;
  }

  function bandGridSize(bandNodes) {
    if (colDim !== "none") return groupedGridSize;
    return Math.max(MIN_CELL_GAP * bandNodes.length - 1, 1);
  }

  function desiredCell(n, row, bandNodes, gridSz) {
    const pc = getParentCells(n, nodes, row, rowDim, cellOf, xOf, gridSz);
    if (pc.length > 0) return Math.round(pc.reduce((a, b) => a + b, 0) / pc.length);
    if (colDim === "none") {
      const uniform = uniformCells(bandNodes.length, gridSz);
      return uniform[bandNodes.indexOf(n)] ?? 0;
    }
    return colIdx(colKey(n, colDim));
  }

  for (const row of rowValues) {
    const depths = byRowDepth.get(row);
    if (!depths) continue;

    for (const depth of [...depths.keys()].sort((a, b) => a - b)) {
      const bandNodes = depths.get(depth);
      const gridSize = bandGridSize(bandNodes);
      bandNodes.sort(
        (a, b) =>
          colIdx(colKey(a, colDim)) - colIdx(colKey(b, colDim)) || a.key.localeCompare(b.key),
      );

      const desired = bandNodes.map((n) => desiredCell(n, row, bandNodes, gridSize));

      // Only spread when multiple nodes share the same column cell — never
      // push distinct columns apart (that blew past the lane and hid nodes left).
      const hasColCollisions = new Set(desired).size < desired.length;
      const final = hasColCollisions ? resolveBandColCollisions(desired, gridSize) : desired;
      const bandX = new Map();
      for (let i = 0; i < bandNodes.length; i++) {
        const n = bandNodes[i];
        cellOf.set(n.key, final[i]);
        const x = Math.max(xFromCell(final[i], gridSize), MIN_NODE_X);
        bandX.set(n.key, x);
      }
      separateBandXs(bandNodes, bandX);
      for (const n of bandNodes) {
        xOf.set(n.key, bandX.get(n.key));
      }
    }
  }

  const sortedBandKeys = [];
  for (const [row, depths] of byRowDepth) {
    for (const depth of depths.keys()) {
      sortedBandKeys.push([row, depth]);
    }
  }
  sortedBandKeys.sort((a, b) => compareDimValues(a[0], b[0], rowDim, nodes) || a[1] - b[1]);

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
          const nominal = xFromCell(colIdx(code), groupedGridSize);
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
