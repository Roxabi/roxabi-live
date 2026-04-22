// state.js — shared app state + localStorage persistence
export const LS = {
  get(key, def) {
    try { const v = localStorage.getItem(key); return v === null ? def : v; } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(key, val); } catch {}
  },
};

export const state = {
  view:     LS.get('v6:view',     'table'),
  repo:     LS.get('v6:repo',     'all'),
  search:   LS.get('v6:search',   ''),
  pivotRow: LS.get('v6:pivotRow', 'milestone'),
  pivotCol: LS.get('v6:pivotCol', 'lane'),
  nodes:    [],
  edges:    [],
};

export function setState(patch) {
  Object.assign(state, patch);
  for (const [k, v] of Object.entries(patch)) {
    const lsKey = { view:'v6:view', repo:'v6:repo', search:'v6:search',
                    pivotRow:'v6:pivotRow', pivotCol:'v6:pivotCol' }[k];
    if (lsKey !== undefined) LS.set(lsKey, v);
  }
}

// ─── Milestone parsing (client-side fallback) ──────────────────────────────
const MS_RE = /^(M\d+|Ph\d+|FIN|Phase\s*\d+)/i;

export function parseMilestone(node) {
  if (node.milestone_code !== undefined) {
    return {
      code:     node.milestone_code ?? null,
      name:     node.milestone_name ?? null,
      sortKey:  node.milestone_sort_key ?? 9999,
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
  const mNum = u.match(/^M(\d+)$/);   if (mNum) return parseInt(mNum[1], 10);
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
  if (dim === 'none') return 'All';
  if (dim === 'milestone') {
    const ms = parseMilestone(node);
    return ms.code ?? '—';
  }
  if (dim === 'priority') return node.priority ?? 'None';
  if (dim === 'repo')     return node.repo ?? '—';
  if (dim === 'lane')     return node.lane ?? '—';
  if (dim === 'size')     return node.size ?? '—';
  return '—';
}

// ─── Filter nodes ─────────────────────────────────────────────────────────
export function filteredNodes() {
  const { nodes, repo, search } = state;
  const q = search.trim().toLowerCase();
  return nodes.filter(n => {
    if (repo !== 'all' && n.repo !== repo) return false;
    if (q) {
      const haystack = `#${n.number} ${n.title ?? ''} ${n.repo}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

// ─── Build edge lookup ─────────────────────────────────────────────────────
export function buildEdgeLookup(edges) {
  const blocks = {};   // dst -> [src] (blocked by)
  const parent = {};   // child -> [parent]
  for (const e of edges) {
    if (e.kind === 'blocks' || !e.kind) {
      (blocks[e.dst] = blocks[e.dst] || []).push(e.src);
    } else if (e.kind === 'parent') {
      (parent[e.dst] = parent[e.dst] || []).push(e.src);
    }
  }
  return { blocks, parent };
}
