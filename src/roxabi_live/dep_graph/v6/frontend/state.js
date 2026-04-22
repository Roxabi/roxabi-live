// state.js — shared app state + localStorage persistence
export const LS = {
  get(key, def) {
    try { const v = localStorage.getItem(key); return v === null ? def : v; } catch { return def; }
  },
  getJSON(key, def) {
    try { const v = localStorage.getItem(key); return v === null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(key, val); } catch {}
  },
  setJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  },
};

// Migration: old repo was a string. Convert to array.
function migrateRepo() {
  const raw = localStorage.getItem('v6:repo');
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    // was a string (old format)
    return parsed === 'all' ? [] : [parsed];
  } catch {
    // raw was plain string, not JSON
    return raw === 'all' ? [] : [raw];
  }
}

export const state = {
  view:      LS.get('v6:view', 'table'),
  // multi-select arrays (empty = all)
  repo:      migrateRepo(),
  milestone: LS.getJSON('v6:milestone', []),
  priority:  LS.getJSON('v6:priority', []),
  status:    LS.getJSON('v6:status', []),
  search:    LS.get('v6:search', ''),
  pivotRow:  LS.get('v6:pivotRow', 'milestone'),
  pivotCol:  LS.get('v6:pivotCol', 'lane'),
  listGroup: LS.get('v6:listGroup', 'milestone'),
  listGroup2: LS.get('v6:listGroup2', 'none'),
  tableGroup: LS.get('v6:tableGroup', 'lane'),
  // graph options
  showParents: LS.get('v6:showParents', 'true') === 'true',
  nodes:     [],
  edges:     [],
  // built once after load
  edgesBySrc: new Map(),
  edgesByDst: new Map(),
  nodesByKey: new Map(),
};

const LS_KEYS = {
  view:        { key: 'v6:view',        json: false },
  repo:        { key: 'v6:repo',        json: true  },
  milestone:   { key: 'v6:milestone',   json: true  },
  priority:    { key: 'v6:priority',    json: true  },
  status:      { key: 'v6:status',      json: true  },
  search:      { key: 'v6:search',      json: false },
  pivotRow:    { key: 'v6:pivotRow',    json: false },
  pivotCol:    { key: 'v6:pivotCol',    json: false },
  listGroup:   { key: 'v6:listGroup',   json: false },
  listGroup2:  { key: 'v6:listGroup2',  json: false },
  tableGroup:  { key: 'v6:tableGroup',  json: false },
  showParents: { key: 'v6:showParents', json: false },
};

export function setState(patch) {
  Object.assign(state, patch);
  for (const [k, v] of Object.entries(patch)) {
    const meta = LS_KEYS[k];
    if (!meta) continue;
    meta.json ? LS.setJSON(meta.key, v) : LS.set(meta.key, v);
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
  if (node.state === 'closed') return 'done';
  const blockers = blockingEdgesByDst.get(node.key) ?? [];
  const openBlocker = blockers.some(e => {
    const srcNode = nodesByKey.get(e.src);
    return srcNode?.state === 'open';
  });
  return openBlocker ? 'blocked' : 'ready';
}

// Attach _status, _blockers, _parent to every node after payload load
// _blockers: all edges where this node is dst (for layout positioning)
// _status: computed only from 'blocks' kind edges
// _parent: parent issue key (from 'parent' edges where dst=this, src=parent)
export function annotateNodes(nodes, edges) {
  const blockingByDst = new Map();  // kind='blocks' only, for status
  const allByDst = new Map();       // all edges, for _blockers
  const parentByDst = new Map();    // kind='parent', dst=child → src=parent
  const byKey = new Map();

  for (const n of nodes) byKey.set(n.key, n);
  for (const e of edges) {
    if (!allByDst.has(e.dst)) allByDst.set(e.dst, []);
    allByDst.get(e.dst).push(e);

    if (e.kind === 'blocks') {
      if (!blockingByDst.has(e.dst)) blockingByDst.set(e.dst, []);
      blockingByDst.get(e.dst).push(e);
    }

    if (e.kind === 'parent') {
      if (!parentByDst.has(e.dst)) parentByDst.set(e.dst, []);
      parentByDst.get(e.dst).push(e.src);  // src is the parent
    }
  }

  for (const n of nodes) {
    n._blockers = allByDst.get(n.key) || [];  // all edges for layout
    n._status = computeStatus(n, blockingByDst, byKey);  // blocks-only for status
    const parents = parentByDst.get(n.key);
    n._parent = parents?.length ? parents[0] : null;  // first parent for grouping
  }
}

// ─── Milestone parsing (client-side fallback) ──────────────────────────────
const MS_RE = /^(M\d+|Ph\d+|FIN|Phase\s*\d+)/i;

export function parseMilestone(node) {
  if (node.milestone_code !== undefined) {
    return {
      code:    node.milestone_code ?? null,
      name:    node.milestone_name ?? null,
      sortKey: node.milestone_sort_key ?? 9999,
    };
  }
  const raw = node.milestone ?? '';
  if (!raw) return { code: null, name: null, sortKey: 9999 };
  const m = raw.match(MS_RE);
  if (m) {
    const code = m[1].replace(/Phase\s*/i, 'Ph');
    const name = raw.slice(m[0].length).replace(/^\s*[—–-]\s*/, '').trim() || null;
    return { code, name, sortKey: codeToSortKey(code) };
  }
  return { code: raw.slice(0, 8), name: null, sortKey: 9999 };
}

function codeToSortKey(code) {
  if (!code) return 9999;
  const u = code.toUpperCase();
  if (u === 'FIN') return 8888;
  const mNum = u.match(/^M(\d+)$/);   if (mNum)  return parseInt(mNum[1], 10);
  const phNum = u.match(/^PH(\d+)$/); if (phNum) return 1000 + parseInt(phNum[1], 10);
  return 9999;
}

// ─── Priority sort order ───────────────────────────────────────────────────
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
export function prioritySortKey(p) {
  return p ? (PRIORITY_ORDER[p] ?? 99) : 99;
}

// ─── Dim-value extraction ──────────────────────────────────────────────────
export function dimValue(node, dim) {
  if (dim === 'none')      return 'All';
  if (dim === 'milestone') { const ms = parseMilestone(node); return ms.code ?? '—'; }
  if (dim === 'priority')  return node.priority ?? 'None';
  if (dim === 'repo')      return node.repo ?? '—';
  if (dim === 'lane')      return node.lane ?? '—';
  if (dim === 'size')      return node.size ?? '—';
  if (dim === 'status')    return node._status ?? '—';
  if (dim === 'parent')    return node._parent ?? '—';
  return '—';
}

// ─── Filter application ───────────────────────────────────────────────────
export function applyFilters(nodes, filters) {
  const q = (filters.search ?? '').trim().toLowerCase();
  return nodes.filter(n => {
    if (filters.repo.length && !filters.repo.includes(n.repo)) return false;
    const msCode = n.milestone_code ?? '(None)';
    if (filters.milestone.length && !filters.milestone.includes(msCode)) return false;
    const pri = n.priority ?? '(None)';
    if (filters.priority.length && !filters.priority.includes(pri)) return false;
    if (filters.status.length && !filters.status.includes(n._status)) return false;
    if (q) {
      const hay = `${n.key} ${n.title ?? ''} ${(n.labels ?? []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Convenience: apply current state filters to state.nodes
export function filteredNodes() {
  return applyFilters(state.nodes, {
    repo:      state.repo,
    milestone: state.milestone,
    priority:  state.priority,
    status:    state.status,
    search:    state.search,
  });
}

// For graph view: filter by all except search (search uses highlight)
export function filteredNodesForGraph() {
  return applyFilters(state.nodes, {
    repo:      state.repo,
    milestone: state.milestone,
    priority:  state.priority,
    status:    state.status,
    search:    '',  // exclude search from filtering
  });
}

// ─── Build edge lookup (legacy helper, kept for pivot.js) ─────────────────
export function buildEdgeLookup(edges) {
  const blocks = {};
  const parent = {};
  for (const e of edges) {
    if (e.kind === 'blocks' || !e.kind) {
      (blocks[e.dst] = blocks[e.dst] || []).push(e.src);
    } else if (e.kind === 'parent') {
      (parent[e.dst] = parent[e.dst] || []).push(e.src);
    }
  }
  return { blocks, parent };
}
