// state.js — shared app state + sessionStorage persistence (per-tab)
export const SS = {
  get(key, def) {
    try {
      const v = sessionStorage.getItem(key);
      return v === null ? def : v;
    } catch {
      return def;
    }
  },
  getJSON(key, def) {
    try {
      const v = sessionStorage.getItem(key);
      return v === null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(key, val) {
    try {
      sessionStorage.setItem(key, val);
    } catch {}
  },
  setJSON(key, val) {
    try {
      sessionStorage.setItem(key, JSON.stringify(val));
    } catch {}
  },
};

// Migration: old repo was a string. Convert to array.
function migrateRepo() {
  const raw = sessionStorage.getItem("v6:repo");
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    // was a string (old format)
    return parsed === "all" ? [] : [parsed];
  } catch {
    // raw was plain string, not JSON
    return raw === "all" ? [] : [raw];
  }
}

export const state = {
  view: SS.get("v6:view", "graph"),
  // multi-select arrays (empty = all)
  repo: migrateRepo(),
  milestone: SS.getJSON("v6:milestone", []),
  priority: SS.getJSON("v6:priority", []),
  assignee: SS.getJSON("v6:assignee", []),
  status: SS.getJSON("v6:status", ["ready", "blocked"]),
  label: SS.getJSON("v6:label", []),
  search: SS.get("v6:search", ""),
  pivotRow: SS.get("v6:pivotRow", "milestone"),
  pivotCol: SS.get("v6:pivotCol", "priority"),
  graphRow: SS.get("v6:graphRow", "milestone"),
  graphCol: SS.get("v6:graphCol", "lane"),
  listGroup: SS.get("v7:listGroup", "none"),
  listGroup2: SS.get("v7:listGroup2", "none"),
  tableGroup: SS.get("v7:tableGroup", "none"),
  // graph options
  showParents: SS.get("v6:showParents", "false") === "true",
  showClosedUnderOpenEpic: SS.get("v6:showClosedUnderOpenEpic", "false") === "true",
  showAssignees: SS.get("v6:showAssignees", "false") === "true",
  nodes: [],
  edges: [],
  // built once after load
  edgesBySrc: new Map(),
  edgesByDst: new Map(),
  nodesByKey: new Map(),
};

const SS_KEYS = {
  view: { key: "v6:view", json: false },
  repo: { key: "v6:repo", json: true },
  milestone: { key: "v6:milestone", json: true },
  priority: { key: "v6:priority", json: true },
  assignee: { key: "v6:assignee", json: true },
  status: { key: "v6:status", json: true },
  label: { key: "v6:label", json: true },
  search: { key: "v6:search", json: false },
  pivotRow: { key: "v6:pivotRow", json: false },
  pivotCol: { key: "v6:pivotCol", json: false },
  graphRow: { key: "v6:graphRow", json: false },
  graphCol: { key: "v6:graphCol", json: false },
  listGroup: { key: "v7:listGroup", json: false },
  listGroup2: { key: "v7:listGroup2", json: false },
  tableGroup: { key: "v7:tableGroup", json: false },
  showParents: { key: "v6:showParents", json: false },
  showClosedUnderOpenEpic: { key: "v6:showClosedUnderOpenEpic", json: false },
  showAssignees: { key: "v6:showAssignees", json: false },
};

export function setState(patch) {
  Object.assign(state, patch);
  for (const [k, v] of Object.entries(patch)) {
    const meta = SS_KEYS[k];
    if (!meta) continue;
    meta.json ? SS.setJSON(meta.key, v) : SS.set(meta.key, v);
  }
}

// ─── Edge index ───────────────────────────────────────────────────────────
export function buildEdgeIndex(edges) {
  const bySrc = new Map();
  const byDst = new Map();
  for (const e of edges) {
    if (!bySrc.has(e.src)) bySrc.set(e.src, []);
    bySrc.get(e.src).push(e);
    if (!byDst.has(e.dst)) byDst.set(e.dst, []);
    byDst.get(e.dst).push(e);
  }
  return { bySrc, byDst };
}

// ─── Status computation ───────────────────────────────────────────────────
// Only 'blocks' edges affect status; 'parent' edges are for layout only
export function computeStatus(node, blockingEdgesByDst, nodesByKey) {
  if (node.state === "closed") return "done";
  const blockers = blockingEdgesByDst.get(node.key) ?? [];
  const openBlocker = blockers.some((e) => {
    const srcNode = nodesByKey.get(e.src);
    return srcNode?.state === "open";
  });
  return openBlocker ? "blocked" : "ready";
}

// Attach _status, _blockers, _parent to every node after payload load
// _blockers: all edges where this node is dst (for layout positioning)
// _status: computed from 'blocks' kind edges, then propagated through 'parent'
//          edges so any descendant of a blocked node is also rendered blocked
//          (unless the descendant itself is already closed → kept as 'done').
// _parent: parent issue key (from 'parent' edges where dst=this, src=parent)
export function annotateNodes(nodes, edges) {
  const blockingByDst = new Map(); // kind='blocks' only, for status
  const allByDst = new Map(); // all edges, for _blockers
  const parentByDst = new Map(); // kind='parent', dst=child → src=parent
  const childrenBySrc = new Map(); // kind='parent', src=parent → [child nodes]
  const byKey = new Map();

  for (const n of nodes) byKey.set(n.key, n);
  for (const e of edges) {
    if (!allByDst.has(e.dst)) allByDst.set(e.dst, []);
    allByDst.get(e.dst).push(e);

    if (e.kind === "blocks") {
      if (!blockingByDst.has(e.dst)) blockingByDst.set(e.dst, []);
      blockingByDst.get(e.dst).push(e);
    }

    if (e.kind === "parent") {
      if (!parentByDst.has(e.dst)) parentByDst.set(e.dst, []);
      parentByDst.get(e.dst).push(e.src); // src is the parent
      if (!childrenBySrc.has(e.src)) childrenBySrc.set(e.src, []);
      childrenBySrc.get(e.src).push(e.dst); // dst is the child
    }
  }

  // Pass 1: direct status from blocks-edges + closed-state
  for (const n of nodes) {
    n._blockers = allByDst.get(n.key) || [];
    n._status = computeStatus(n, blockingByDst, byKey);
    const parents = parentByDst.get(n.key);
    n._parent = parents?.length ? parents[0] : null;
  }

  // Stamp _isParent on nodes that have at least one child edge
  for (const n of nodes) {
    n._isParent = childrenBySrc.has(n.key);
  }

  // Pass 2: propagate 'blocked' through parent → child edges (BFS).
  // A descendant of a blocked parent is itself rendered blocked, unless it
  // is already 'done' (closed) — closed always wins.  Visited guard handles
  // any pathological parent cycles.
  const queue = nodes.filter((n) => n._status === "blocked").map((n) => n.key);
  const visited = new Set(queue);
  while (queue.length) {
    const parentKey = queue.shift();
    const childKeys = childrenBySrc.get(parentKey) || [];
    for (const childKey of childKeys) {
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      const child = byKey.get(childKey);
      if (!child || child._status === "done") continue;
      child._status = "blocked";
      queue.push(childKey);
    }
  }
}

// ─── Milestone parsing (client-side fallback) ──────────────────────────────
const MS_RE = /^(M\d+|Ph\d+|FIN|Phase\s*\d+)/i;

export function parseMilestone(node) {
  if (node.milestone_code !== undefined) {
    return {
      code: node.milestone_code ?? null,
      name: node.milestone_name ?? null,
      sortKey: node.milestone_sort_key ?? 9999,
    };
  }
  const raw = node.milestone ?? "";
  if (!raw) return { code: null, name: null, sortKey: 9999 };
  const m = raw.match(MS_RE);
  if (m) {
    const code = m[1].replace(/Phase\s*/i, "Ph");
    const name =
      raw
        .slice(m[0].length)
        .replace(/^\s*[—–-]\s*/, "")
        .trim() || null;
    return { code, name, sortKey: codeToSortKey(code) };
  }
  return { code: raw.slice(0, 8), name: null, sortKey: 9999 };
}

function codeToSortKey(code) {
  if (!code) return 9999;
  const u = code.toUpperCase();
  if (u === "FIN") return 8888;
  const mNum = u.match(/^M(\d+)$/);
  if (mNum) return Number.parseInt(mNum[1], 10);
  const phNum = u.match(/^PH(\d+)$/);
  if (phNum) return 1000 + Number.parseInt(phNum[1], 10);
  return 9999;
}

// ─── Priority sort order ───────────────────────────────────────────────────
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
export function prioritySortKey(p) {
  return p ? (PRIORITY_ORDER[p] ?? 99) : 99;
}

// ─── Dim-value extraction ──────────────────────────────────────────────────
export const EMPTY_DIM = "(None)";
export const EMPTY_ASSIGNEE = "(Unassigned)";

const EMPTY_DIM_ALIASES = new Set([EMPTY_DIM, "—", "None", "All", EMPTY_ASSIGNEE]);

/** True when a pivot/graph bucket has no underlying field value. */
export function isEmptyDimValue(val, dim) {
  if (dim === "assignee") return val === EMPTY_ASSIGNEE;
  if (dim === "none") return false;
  return EMPTY_DIM_ALIASES.has(val);
}

/** Human label for row/column headers and filter chips. */
export function dimDisplayLabel(val, dim) {
  if (!isEmptyDimValue(val, dim)) return val;
  const labels = {
    milestone: "No milestone",
    priority: "No priority",
    lane: "No lane",
    size: "No size",
    repo: "No repo",
    status: "No status",
    assignee: "Unassigned",
    parent: "No parent",
  };
  return labels[dim] ?? EMPTY_DIM;
}

export function dimValue(node, dim) {
  if (dim === "none") return "All";
  if (dim === "milestone") {
    const ms = parseMilestone(node);
    return ms.code ?? EMPTY_DIM;
  }
  if (dim === "priority") return node.priority ?? EMPTY_DIM;
  if (dim === "repo") return node.repo ?? EMPTY_DIM;
  if (dim === "lane") return node.lane ?? EMPTY_DIM;
  if (dim === "size") return node.size ?? EMPTY_DIM;
  if (dim === "status") return node._status ?? EMPTY_DIM;
  if (dim === "parent") return node._parent ?? EMPTY_DIM;
  if (dim === "assignee") {
    const assignees = node.assignees ?? [];
    return assignees.length ? assignees[0] : EMPTY_ASSIGNEE;
  }
  return EMPTY_DIM;
}

/** Sort key for pivot/graph axes — empty buckets always come first. */
export function dimSortKey(val, dim, nodes = []) {
  if (dim === "none") return 0;
  if (isEmptyDimValue(val, dim)) return -1;
  if (dim === "milestone") {
    const node = nodes.find((n) => dimValue(n, dim) === val);
    return node?.milestone_sort_key ?? 9999;
  }
  if (dim === "priority") {
    return prioritySortKey(val === EMPTY_DIM ? null : val);
  }
  if (dim === "status") {
    const order = { ready: 0, blocked: 1, done: 2 };
    return order[val] ?? 99;
  }
  return 0;
}

export function compareDimValues(a, b, dim, nodes = []) {
  const aEmpty = isEmptyDimValue(a, dim);
  const bEmpty = isEmptyDimValue(b, dim);
  if (aEmpty !== bEmpty) return aEmpty ? -1 : 1;
  const sa = dimSortKey(a, dim, nodes);
  const sb = dimSortKey(b, dim, nodes);
  if (typeof sa === "number" && typeof sb === "number" && sa !== sb) return sa - sb;
  return String(a).localeCompare(String(b));
}

// ─── Filter application ───────────────────────────────────────────────────
export function applyFilters(nodes, filters) {
  const q = (filters.search ?? "").trim().toLowerCase();
  const parentKeys = state.showParents
    ? null
    : new Set(state.edges.filter((e) => e.kind === "parent").map((e) => e.src));
  return nodes.filter((n) => {
    if (parentKeys?.has(n.key)) return false;
    if (filters.repo.length && !filters.repo.includes(n.repo)) return false;
    const msCode = n.milestone_code ?? "(None)";
    if (filters.milestone.length && !filters.milestone.includes(msCode)) return false;
    const pri = n.priority ?? "(None)";
    if (filters.priority.length && !filters.priority.includes(pri)) return false;
    if (filters.status.length && !filters.status.includes(n._status)) return false;
    if (filters.label?.length && !filters.label.some((l) => (n.labels ?? []).includes(l)))
      return false;
    if (filters.assignee?.length) {
      const nodeAssignees = n.assignees ?? [];
      if (nodeAssignees.length === 0) {
        if (!filters.assignee.includes("(Unassigned)")) return false;
      } else if (!nodeAssignees.some((a) => filters.assignee.includes(a))) {
        return false;
      }
    }
    if (q) {
      const hay = `${n.key} ${n.title ?? ""} ${(n.labels ?? []).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Convenience: apply current state filters to state.nodes
export function filteredNodes() {
  return applyFilters(state.nodes, {
    repo: state.repo,
    milestone: state.milestone,
    priority: state.priority,
    assignee: state.assignee,
    status: state.status,
    label: state.label,
    search: state.search,
  });
}

// For graph view: filter by all except search (search uses highlight).
// When `showClosedUnderOpenEpic` is enabled, a closed (`done`) issue whose
// parent epic is still open is kept visible even when the status filter
// excludes `done`. The node keeps its `_status='done'` so the rest of the
// rendering logic is unchanged.
export function filteredNodesForGraph() {
  const base = applyFilters(state.nodes, {
    repo: state.repo,
    milestone: state.milestone,
    priority: state.priority,
    assignee: state.assignee,
    status: [], // bypass status here, re-apply with override below
    label: state.label,
    search: "",
  });
  if (state.status.length === 0) return base;
  return base.filter((n) => {
    if (state.status.includes(n._status)) return true;
    if (state.showClosedUnderOpenEpic && n._status === "done" && n._parent) {
      const parent = state.nodesByKey.get(n._parent);
      if (parent && parent.state === "open") return true;
    }
    return false;
  });
}

// ─── Dev-state → animation class mapping (issue #82) ─────────────────────
export function mapDevStateToClass(devState) {
  if (devState === "pr_reviewed") return "pulse orbit-2";
  if (devState === "pr_open") return "pulse orbit-1";
  if (devState === "dev") return "pulse";
  return "";
}

// ─── Build edge lookup (legacy helper, kept for pivot.js) ─────────────────
export function buildEdgeLookup(edges) {
  const blocks = {};
  const parent = {};
  for (const e of edges) {
    if (e.kind === "blocks" || !e.kind) {
      blocks[e.dst] = blocks[e.dst] || [];
      blocks[e.dst].push(e.src);
    } else if (e.kind === "parent") {
      parent[e.dst] = parent[e.dst] || [];
      parent[e.dst].push(e.src);
    }
  }
  return { blocks, parent };
}
