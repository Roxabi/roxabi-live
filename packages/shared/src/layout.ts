/**
 * layout.ts — the v5 dependency-graph layout engine, ported verbatim from
 * frontend/layout.js. Percentage coordinates, depth-based bands, configurable
 * row/col grouping. The one change from the vanilla: the per-node `_blockers`
 * and `_depth` scratch fields become local maps (blockersByDst / depthByKey),
 * so the engine never mutates the (frozen) cached nodes.
 *
 * Pure + synchronous — call it inside useMemo, never useEffect+setState.
 */

import { type Dim, compareDimValues, dimDisplayLabel, dimValue } from "./dims.ts";
import type { AnnotatedNode } from "./graph.ts";
import type { GraphEdge } from "./types.ts";

// v5 positioning constants (match Python layout_graph.py).
const LANE_X_START = 4.0;
const LANE_X_END = 96.0;
const Y_TOP = 1.5;
const Y_BOT = 88.0;
const MIN_NODE_X = 8.0;
const MIN_VIS_NODE_GAP = 4.0;
const MAX_COL_CENTER_STEP = 24.0;
const MAX_BAND_GAP_PX = 80;
const MIN_CONTAINER_H = 320;

export interface NodePos {
  x: number;
  y: number;
}
export interface RowBand {
  code: string;
  label: string;
  name: string | null;
  y: number;
  height: number;
}
export interface ColAnchor {
  code: string;
  label: string;
  x: number;
}
export interface GraphLayout {
  positions: Map<string, NodePos>;
  rowInfo: RowBand[];
  colInfo: ColAnchor[];
  lanes: string[];
  width: number;
  height: number;
  rowDim: Dim;
  colDim: Dim;
}

/** Cubic-bezier (or straight, when nearly vertical) SVG path in percentage space. */
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(x1 - x2) < 0.1) {
    return `M ${x1.toFixed(2)},${y1.toFixed(2)} L ${x2.toFixed(2)},${y2.toFixed(2)}`;
  }
  const ymid = (y1 + y2) / 2;
  return `M ${x1.toFixed(2)},${y1.toFixed(2)} C ${x1.toFixed(2)},${ymid.toFixed(2)} ${x2.toFixed(2)},${ymid.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`;
}

function rowSublabel(rowVal: string, rowDim: Dim, nodes: AnnotatedNode[]): string | null {
  if (rowDim !== "milestone") return null;
  const node = nodes.find((n) => dimValue(n, rowDim) === rowVal);
  const name = node?.milestone_name ?? null;
  if (!name || name === rowVal) return null;
  return name;
}

/** Column anchors. Uses the full lane when crowded; caps the step when few columns. */
function xFromColIdx(idx: number, colCount: number): number {
  const pageSpan = LANE_X_END - LANE_X_START;
  const pageCenter = (LANE_X_START + LANE_X_END) / 2;
  if (colCount <= 1) return pageCenter;
  const naturalStep = pageSpan / (colCount - 1);
  const step = Math.min(naturalStep, MAX_COL_CENTER_STEP);
  const span = step * (colCount - 1);
  const xStart = pageCenter - span / 2;
  return xStart + idx * step;
}

/** Spread a same-column group around its anchor; use the full lane only when necessary. */
function spreadGroupX(count: number, anchorX: number): number[] {
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

interface ColResolution {
  final: number[];
  xByKey: Map<string, number>;
}

/** Spread only nodes that share the same desired column — keep distinct columns apart. */
function resolveBandColCollisions(
  bandNodes: AnnotatedNode[],
  desired: number[],
  colCount: number,
): ColResolution {
  const final = [...desired];
  const xByKey = new Map<string, number>();
  const groups = new Map<number, number[]>();
  for (let i = 0; i < desired.length; i++) {
    const d = desired[i];
    const g = groups.get(d);
    if (g) g.push(i);
    else groups.set(d, [i]);
  }
  for (const [d, indices] of groups) {
    if (indices.length <= 1) continue;
    const anchor = Math.max(xFromColIdx(d, colCount), MIN_NODE_X);
    const xs = spreadGroupX(indices.length, anchor);
    for (let j = 0; j < indices.length; j++) {
      xByKey.set(bandNodes[indices[j]].key, xs[j]);
    }
  }
  return { final, xByKey };
}

function finalizeBandXs(
  bandNodes: AnnotatedNode[],
  xByKey: Map<string, number>,
  minGap = MIN_VIS_NODE_GAP,
): void {
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
function finalizeBandXsByColumn(
  bandNodes: AnnotatedNode[],
  desired: number[],
  xByKey: Map<string, number>,
  minGap = MIN_VIS_NODE_GAP,
): void {
  const groups = new Map<number, AnnotatedNode[]>();
  for (let i = 0; i < bandNodes.length; i++) {
    const d = desired[i];
    const g = groups.get(d);
    if (g) g.push(bandNodes[i]);
    else groups.set(d, [bandNodes[i]]);
  }
  for (const group of groups.values()) {
    finalizeBandXs(group, xByKey, minGap);
  }
}

function colHeaderLabel(code: string, colDim: Dim): string {
  const label = dimDisplayLabel(code, colDim);
  if (colDim === "repo" && code.includes("/")) {
    return code.split("/")[1] || label;
  }
  return label.length > 14 ? `${label.slice(0, 13)}…` : label;
}

export function layoutV5(
  nodes: AnnotatedNode[],
  edges: GraphEdge[],
  rowDim: Dim = "milestone",
  colDim: Dim = "lane",
): GraphLayout {
  const colSet = new Set<string>();
  if (colDim !== "none") {
    for (const n of nodes) colSet.add(dimValue(n, colDim));
  }
  const colOrder = [...colSet].sort((a, b) => compareDimValues(a, b, colDim, nodes));

  const rowSet = new Set(nodes.map((n) => dimValue(n, rowDim)));
  const rowValues = [...rowSet].sort((a, b) => compareDimValues(a, b, rowDim, nodes));

  // Blockers = every edge where the node is dst (all kinds), used for depth.
  const blockersByDst = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const list = blockersByDst.get(e.dst);
    if (list) list.push(e);
    else blockersByDst.set(e.dst, [e]);
  }

  const nodesByKey = new Map(nodes.map((n) => [n.key, n]));
  const depthCache = new Map<string, number>();
  function computeDepth(node: AnnotatedNode, stack = new Set<string>()): number {
    const cached = depthCache.get(node.key);
    if (cached !== undefined) return cached;
    if (stack.has(node.key)) return 0;
    stack.add(node.key);
    let maxDepth = 0;
    for (const e of blockersByDst.get(node.key) ?? []) {
      const blocker = nodesByKey.get(e.src);
      if (blocker) {
        maxDepth = Math.max(maxDepth, computeDepth(blocker, stack) + 1);
      }
    }
    stack.delete(node.key);
    depthCache.set(node.key, maxDepth);
    return maxDepth;
  }
  const depthByKey = new Map<string, number>();
  for (const n of nodes) depthByKey.set(n.key, computeDepth(n));

  const byRowDepth = new Map<string, Map<number, AnnotatedNode[]>>();
  for (const n of nodes) {
    const row = dimValue(n, rowDim);
    const depth = depthByKey.get(n.key) ?? 0;
    let depths = byRowDepth.get(row);
    if (!depths) {
      depths = new Map();
      byRowDepth.set(row, depths);
    }
    const band = depths.get(depth);
    if (band) band.push(n);
    else depths.set(depth, [n]);
  }

  const columnCount = colDim === "none" ? 1 : Math.max(colOrder.length, 1);

  const cellOf = new Map<string, number>();
  const xOf = new Map<string, number>();

  function colIdx(val: string): number {
    if (colDim === "none") return 0;
    const idx = colOrder.indexOf(val);
    return idx >= 0 ? idx : colOrder.length;
  }

  function desiredCellsForBand(bandNodes: AnnotatedNode[]): number[] {
    if (colDim !== "none") {
      return bandNodes.map((n) => colIdx(dimValue(n, colDim)));
    }
    return bandNodes.map(() => 0);
  }

  const bandKeys: [string, number][] = [];
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
    const bandNodes = byRowDepth.get(row)?.get(depth) ?? [];
    bandNodes.sort(
      (a, b) =>
        colIdx(dimValue(a, colDim)) - colIdx(dimValue(b, colDim)) || a.key.localeCompare(b.key),
    );

    const desired = desiredCellsForBand(bandNodes);
    const hasColCollisions = new Set(desired).size < desired.length;
    const resolved = hasColCollisions
      ? resolveBandColCollisions(bandNodes, desired, columnCount)
      : { final: desired, xByKey: new Map<string, number>() };
    const bandX = new Map<string, number>();
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
      xOf.set(n.key, bandX.get(n.key) ?? MIN_NODE_X);
    }
  }

  const sortedBandKeys = [...bandKeys].sort(
    (a, b) => compareDimValues(a[0], b[0], rowDim, nodes) || a[1] - b[1],
  );

  const yTop = Y_TOP;
  const nBands = sortedBandKeys.length;
  const stepY = nBands > 1 ? (Y_BOT - yTop) / (nBands - 1) : 0;
  const halfBand = stepY > 0 ? stepY / 2 : 4;

  const positions = new Map<string, NodePos>();
  const bandRecords: { row: string; depth: number; y: number; count: number }[] = [];

  for (let i = 0; i < sortedBandKeys.length; i++) {
    const [row, depth] = sortedBandKeys[i];
    const bandY = yTop + i * stepY;
    const bandNodes = byRowDepth.get(row)?.get(depth) ?? [];
    bandNodes.sort((a, b) => (cellOf.get(a.key) ?? 0) - (cellOf.get(b.key) ?? 0));

    for (const n of bandNodes) {
      positions.set(n.key, { x: xOf.get(n.key) ?? 50, y: bandY });
    }
    bandRecords.push({ row, depth, y: bandY, count: bandNodes.length });
  }

  const ysByRow = new Map<string, number[]>();
  for (const b of bandRecords) {
    const ys = ysByRow.get(b.row);
    if (ys) ys.push(b.y);
    else ysByRow.set(b.row, [b.y]);
  }

  const rowInfo: RowBand[] = [];
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

  const colInfo: ColAnchor[] =
    colDim === "none"
      ? []
      : colOrder.map((code) => {
          const xs: number[] = [];
          for (const n of nodes) {
            if (dimValue(n, colDim) === code && xOf.has(n.key)) {
              xs.push(xOf.get(n.key) ?? 0);
            }
          }
          const nominal = xFromColIdx(colIdx(code), columnCount);
          const x = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : nominal;
          return { code, label: colHeaderLabel(code, colDim), x };
        });

  const bandSpanPct = (Y_BOT - yTop) / 100;
  const containerH =
    nBands > 1
      ? Math.max(MIN_CONTAINER_H, (MAX_BAND_GAP_PX * (nBands - 1)) / bandSpanPct + 80)
      : MIN_CONTAINER_H;

  return {
    positions,
    rowInfo,
    colInfo,
    lanes: colOrder,
    width: 100,
    height: containerH,
    rowDim,
    colDim,
  };
}
