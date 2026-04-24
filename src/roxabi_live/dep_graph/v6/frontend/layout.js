// layout.js — Graph layout for v6 dep-graph
// v5 engine: percentage coords, depth-based bands, parent-child alignment

// ── v5 positioning constants (match Python layout_graph.py) ──────────────────
const LANE_X_START = 4.0;
const LANE_X_END = 96.0;
const Y_TOP = 2.5;
const Y_BOT = 97.5;
const MIN_CELL_GAP = 2;
const MAX_CELL_WIDTH_PCT = 4.0;
const MAX_BAND_GAP_PX = 80;
const MIN_CONTAINER_H = 320;

function msIdx(ms, msCodes) {
  if (!ms || ms === '(None)') return -1;
  const idx = msCodes.indexOf(ms);
  return idx >= 0 ? idx : 99;
}

function laneIdx(lane, laneOrder) {
  const idx = laneOrder.indexOf(lane);
  return idx >= 0 ? idx : laneOrder.length;
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
  const natural = pageSpan / (gridSize - 1);
  if (natural <= MAX_CELL_WIDTH_PCT) {
    return { xStart: LANE_X_START, xEnd: LANE_X_END, step: natural };
  }
  const step = MAX_CELL_WIDTH_PCT;
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

function uniformCells(n, gridSize) {
  if (n <= 0) return [];
  if (n === 1) return [Math.floor(gridSize / 2)];
  const step = (gridSize - 1) / (n - 1);
  return [...Array(n).keys()].map(i => Math.round(i * step));
}

function getParentCells(task, allTasks, ms, cellOf, xOf, gridSize) {
  const cells = [];
  for (const parent of allTasks) {
    if (parent.key === task.key) continue;
    const edges = task._blockers || [];
    const isParent = edges.some(e => e.src === parent.key);
    if (!isParent) continue;

    const pNum = parent.key;
    if (parent.milestone_code === ms && cellOf.has(pNum)) {
      cells.push(cellOf.get(pNum));
    } else if (xOf.has(pNum)) {
      cells.push(cellFromX(xOf.get(pNum), gridSize));
    }
  }
  return cells;
}

export function layoutV5(nodes, edges) {
  const laneSet = new Set(nodes.map(n => n.lane).filter(Boolean));
  const laneOrder = [...laneSet].sort();

  const msMap = new Map();
  for (const n of nodes) {
    const code = n.milestone_code ?? '-';
    const sortKey = n.milestone_sort_key ?? 9999;
    if (!msMap.has(code)) msMap.set(code, sortKey);
  }
  const msCodes = [...msMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([code]) => code);

  const blockersByDst = new Map();
  for (const e of edges) {
    if (!blockersByDst.has(e.dst)) blockersByDst.set(e.dst, []);
    blockersByDst.get(e.dst).push(e);
  }
  for (const n of nodes) {
    n._blockers = blockersByDst.get(n.key) || [];
  }

  const byMsDepth = new Map();
  for (const n of nodes) {
    const ms = n.milestone_code ?? '-';
    const depth = n._depth ?? 0;
    if (!byMsDepth.has(ms)) byMsDepth.set(ms, new Map());
    if (!byMsDepth.get(ms).has(depth)) byMsDepth.get(ms).set(depth, []);
    byMsDepth.get(ms).get(depth).push(n);
  }

  function computeDepth(node, visited = new Set()) {
    if (visited.has(node.key)) return 0;
    visited.add(node.key);
    const blockers = node._blockers || [];
    if (blockers.length === 0) return 0;
    let maxDepth = 0;
    for (const e of blockers) {
      const blocker = nodes.find(n => n.key === e.src);
      if (blocker) {
        maxDepth = Math.max(maxDepth, computeDepth(blocker, visited) + 1);
      }
    }
    return maxDepth;
  }
  for (const n of nodes) {
    n._depth = computeDepth(n);
  }

  byMsDepth.clear();
  for (const n of nodes) {
    const ms = n.milestone_code ?? '(None)';
    const depth = n._depth;
    if (!byMsDepth.has(ms)) byMsDepth.set(ms, new Map());
    if (!byMsDepth.get(ms).has(depth)) byMsDepth.get(ms).set(depth, []);
    byMsDepth.get(ms).get(depth).push(n);
  }

  const gridSizePerMs = new Map();
  for (const [ms, depths] of byMsDepth) {
    let maxBand = 1;
    for (const [, bandNodes] of depths) {
      maxBand = Math.max(maxBand, bandNodes.length);
    }
    gridSizePerMs.set(ms, Math.max(MIN_CELL_GAP * maxBand - 1, 1));
  }

  const cellOf = new Map();
  const xOf = new Map();

  for (const ms of [...byMsDepth.keys()].sort((a, b) => msIdx(a, msCodes) - msIdx(b, msCodes))) {
    const depths = byMsDepth.get(ms);
    const gridSize = gridSizePerMs.get(ms);

    for (const depth of [...depths.keys()].sort((a, b) => a - b)) {
      const bandNodes = depths.get(depth);
      bandNodes.sort((a, b) => laneIdx(a.lane, laneOrder) - laneIdx(b.lane, laneOrder) || a.key.localeCompare(b.key));

      const desired = bandNodes.map(n => {
        const pc = getParentCells(n, nodes, ms, cellOf, xOf, gridSize);
        if (pc.length > 0) return Math.round(pc.reduce((a, b) => a + b, 0) / pc.length);
        const uniform = uniformCells(bandNodes.length, gridSize);
        return uniform[bandNodes.indexOf(n)];
      });

      const final = resolveCells(desired, gridSize);
      for (let i = 0; i < bandNodes.length; i++) {
        const n = bandNodes[i];
        cellOf.set(n.key, final[i]);
        xOf.set(n.key, xFromCell(final[i], gridSize));
      }
    }
  }

  const sortedBandKeys = [];
  for (const [ms, depths] of byMsDepth) {
    for (const depth of depths.keys()) {
      sortedBandKeys.push([ms, depth]);
    }
  }
  sortedBandKeys.sort((a, b) => msIdx(a[0], msCodes) - msIdx(b[0], msCodes) || a[1] - b[1]);

  const nBands = sortedBandKeys.length;
  const stepY = nBands > 1 ? (Y_BOT - Y_TOP) / (nBands - 1) : 0;

  const positions = new Map();
  const bandRecords = [];

  for (let i = 0; i < sortedBandKeys.length; i++) {
    const [ms, depth] = sortedBandKeys[i];
    const bandY = Y_TOP + i * stepY;
    const bandNodes = byMsDepth.get(ms).get(depth) || [];
    bandNodes.sort((a, b) => (cellOf.get(a.key) || 0) - (cellOf.get(b.key) || 0));

    for (const n of bandNodes) {
      positions.set(n.key, { x: xOf.get(n.key) || 50, y: bandY });
    }

    bandRecords.push({ ms, depth, y: bandY, count: bandNodes.length });
  }

  const ysByMs = new Map();
  for (const b of bandRecords) {
    if (!ysByMs.has(b.ms)) ysByMs.set(b.ms, []);
    ysByMs.get(b.ms).push(b.y);
  }

  const milestoneInfo = [];
  for (const [ms, ys] of ysByMs) {
    const top = Math.min(...ys) - stepY / 2;
    const bot = Math.max(...ys) + stepY / 2;
    const msNode = nodes.find(n => (n.milestone_code ?? '(None)') === ms);
    milestoneInfo.push({
      code: ms,
      name: msNode?.milestone_name || null,
      y: Math.max(top, 1.0),
      height: Math.min(bot, 99.0) - Math.max(top, 1.0)
    });
  }
  milestoneInfo.sort((a, b) => msIdx(a.code, msCodes) - msIdx(b.code, msCodes));

  const bandSpanPct = (Y_BOT - Y_TOP) / 100;
  const containerH = nBands > 1
    ? Math.max(MIN_CONTAINER_H, (MAX_BAND_GAP_PX * (nBands - 1)) / bandSpanPct + 80)
    : MIN_CONTAINER_H;

  return {
    positions,
    milestoneInfo,
    lanes: laneOrder,
    width: 100,
    height: containerH,
    usePercentage: true
  };
}

export function runLayout(nodes, edges) {
  return layoutV5(nodes, edges);
}
