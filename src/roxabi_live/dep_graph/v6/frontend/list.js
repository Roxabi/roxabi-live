// list.js — flat-table list renderer with group-by and sort
import { state, filteredNodes, parseMilestone, prioritySortKey, dimValue } from './state.js';
import { initHover } from './hover.js';

const PRIORITY_COLOR = { P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3' };
const STATUS_DOT     = { open: 'dot-open', closed: 'dot-closed' };

// ─── Edge helpers ─────────────────────────────────────────────────────────
function edgeFilter(edges, key, dir, kind) {
  // dir='src': edges where src===key; dir='dst': edges where dst===key
  return edges.filter(e => e.kind === kind && e[dir] === key);
}

function shortKey(k) {
  // "Roxabi/lyra#42" -> "#42"
  const m = k.match(/#(\d+)$/);
  return m ? `#${m[1]}` : k;
}

// ─── Sort state ───────────────────────────────────────────────────────────
let sortCol = null;    // column id or null (default)
let sortDir = 'asc';  // 'asc' | 'desc'

function defaultSort(a, b) {
  const msa = parseMilestone(a).sortKey - parseMilestone(b).sortKey;
  if (msa !== 0) return msa;
  const pa = prioritySortKey(a.priority) - prioritySortKey(b.priority);
  if (pa !== 0) return pa;
  return a.number - b.number;
}

function colSortKey(n, col) {
  switch (col) {
    case 'ref':      return `${n.repo}#${String(n.number).padStart(8, '0')}`;
    case 'status':   return n._status ?? '';
    case 'title':    return (n.title ?? '').toLowerCase();
    case 'milestone':return String(parseMilestone(n).sortKey).padStart(8, '0');
    case 'priority': return String(prioritySortKey(n.priority)).padStart(3, '0');
    case 'lane':     return n.lane ?? '~';
    case 'size':     return n.size ?? '~';
    case 'blocks':   return 0;  // sorted by count — filled at render time
    case 'blockedby':return 0;
    case 'parentof': return 0;
    default:         return '';
  }
}

function sortNodes(nodes, edges) {
  if (!sortCol) return [...nodes].sort(defaultSort);

  // For edge-count cols we need to compute per-node
  if (['blocks', 'blockedby', 'parentof'].includes(sortCol)) {
    const counted = nodes.map(n => {
      let cnt;
      if (sortCol === 'blocks')    cnt = edgeFilter(edges, n.key, 'src', 'blocks').length;
      if (sortCol === 'blockedby') cnt = edgeFilter(edges, n.key, 'dst', 'blocks').length;
      if (sortCol === 'parentof')  cnt = edgeFilter(edges, n.key, 'src', 'parent').length;
      return { n, cnt };
    });
    counted.sort((a, b) => sortDir === 'asc' ? a.cnt - b.cnt : b.cnt - a.cnt);
    return counted.map(x => x.n);
  }

  return [...nodes].sort((a, b) => {
    const ka = colSortKey(a, sortCol);
    const kb = colSortKey(b, sortCol);
    const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });
}

// ─── Group ordering ───────────────────────────────────────────────────────
function groupSortKey(dim, val, nodes) {
  if (dim === 'milestone') {
    const n = nodes.find(x => dimValue(x, 'milestone') === val);
    return n ? parseMilestone(n).sortKey : 9999;
  }
  if (dim === 'priority') {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3, None: 4, '—': 5 };
    return order[val] ?? 99;
  }
  if (dim === 'status') {
    return { ready: 0, blocked: 1, done: 2 }[val] ?? 99;
  }
  return val === '—' ? '￿' : val;
}

// ─── Row builder ──────────────────────────────────────────────────────────
function buildRow(n, edges) {
  const tr  = document.createElement('tr');
  tr.className = `issue-row state-${n.state}`;
  tr.dataset.iss = n.key;

  // Hover-chain attrs
  const blockers = edges.filter(e => e.kind === 'blocks' && e.dst === n.key).map(e => e.src);
  const blocking = edges.filter(e => (e.kind === 'blocks' || !e.kind) && e.src === n.key).map(e => e.dst);
  if (blockers.length) tr.dataset.blockedby = blockers.join(',');
  if (blocking.length) tr.dataset.blocking = blocking.join(',');

  const repoShort = n.repo ? n.repo.split('/')[1] : n.repo;

  // # ref
  const tdRef = document.createElement('td');
  const a = document.createElement('a');
  a.href   = n.url || '#';
  a.target = '_blank';
  a.rel    = 'noopener noreferrer';
  a.className = 'issue-link';
  a.textContent = `${repoShort}#${n.number}`;
  tdRef.appendChild(a);

  // ● state dot + status tooltip
  const tdDot = document.createElement('td');
  tdDot.className = 'col-dot';
  const dot = document.createElement('span');
  dot.className = `state-dot ${STATUS_DOT[n.state] || 'dot-closed'}`;
  dot.setAttribute('title', `${n.state} · ${n._status ?? ''}`);
  dot.setAttribute('aria-label', `${n.state}, ${n._status ?? ''}`);
  if (n._status === 'blocked') dot.classList.add('dot-blocked');
  tdDot.appendChild(dot);

  // Title
  const tdTitle = document.createElement('td');
  tdTitle.className = 'col-title';
  const titleSpan = document.createElement('span');
  titleSpan.className  = 'list-title';
  titleSpan.textContent = n.title || `Issue #${n.number}`;
  titleSpan.setAttribute('title', n.title || '');
  tdTitle.appendChild(titleSpan);

  // Milestone
  const tdMs = document.createElement('td');
  const ms = parseMilestone(n);
  if (ms.code) {
    const badge = document.createElement('span');
    badge.className  = 'badge badge-ms';
    badge.textContent = ms.code;
    tdMs.appendChild(badge);
  } else {
    tdMs.textContent = '—';
    tdMs.className   = 'text-dim';
  }

  // Priority
  const tdPri = document.createElement('td');
  if (n.priority) {
    const badge = document.createElement('span');
    badge.className  = `badge badge-${PRIORITY_COLOR[n.priority] || ''}`;
    badge.textContent = n.priority;
    tdPri.appendChild(badge);
  } else {
    tdPri.textContent = '—';
    tdPri.className   = 'text-dim';
  }

  // Lane
  const tdLane = document.createElement('td');
  tdLane.textContent = n.lane ?? '—';
  if (!n.lane) tdLane.className = 'text-dim';

  // Size
  const tdSize = document.createElement('td');
  tdSize.textContent = n.size ?? '—';
  if (!n.size) tdSize.className = 'text-dim';

  // Edge counts helper
  function makeCountCell(edgeList) {
    const td   = document.createElement('td');
    td.className = 'col-count';
    if (!edgeList.length) { td.textContent = '—'; td.className += ' text-dim'; return td; }
    const sp = document.createElement('span');
    sp.className = 'edge-count';
    sp.textContent = edgeList.length;
    sp.setAttribute('title', edgeList.map(e => shortKey(e.src === n.key ? e.dst : e.src)).join(', '));
    td.appendChild(sp);
    return td;
  }

  const blocksEdges    = edgeFilter(edges, n.key, 'src', 'blocks');
  const blockedByEdges = edgeFilter(edges, n.key, 'dst', 'blocks');
  const parentOfEdges  = edgeFilter(edges, n.key, 'src', 'parent');

  tr.append(tdRef, tdDot, tdTitle, tdMs, tdPri, tdLane, tdSize,
    makeCountCell(blocksEdges),
    makeCountCell(blockedByEdges),
    makeCountCell(parentOfEdges));

  return tr;
}

// ─── Table shell ──────────────────────────────────────────────────────────
const COLS = [
  { id: 'ref',      label: '#'          },
  { id: 'status',   label: '●'          },
  { id: 'title',    label: 'Title'      },
  { id: 'milestone',label: 'Milestone'  },
  { id: 'priority', label: 'Priority'   },
  { id: 'lane',     label: 'Lane'       },
  { id: 'size',     label: 'Size'       },
  { id: 'blocks',   label: 'Blocks'     },
  { id: 'blockedby',label: 'Blocked by' },
  { id: 'parentof', label: 'Parent of'  },
];

function buildThead(onSort) {
  const thead = document.createElement('thead');
  const tr    = document.createElement('tr');
  for (const col of COLS) {
    const th = document.createElement('th');
    th.textContent = col.label;
    th.dataset.col = col.id;
    th.className   = 'sortable';
    if (sortCol === col.id) th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    th.setAttribute('aria-sort', sortCol === col.id ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    th.addEventListener('click', () => onSort(col.id));
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  return thead;
}

// ─── Collapse tracking ────────────────────────────────────────────────────
const collapsed = new Set();   // group values that are folded

// ─── Main renderer ────────────────────────────────────────────────────────
export function renderList(container) {
  const nodes = filteredNodes();
  const edges = state.edges;
  const group = state.listGroup;

  container.innerHTML = '';

  if (!nodes.length) {
    container.textContent = 'No issues match the current filter.';
    return;
  }

  const sorted = sortNodes(nodes, edges);

  const table = document.createElement('table');
  table.className = 'list-table';

  function rebuild() {
    table.innerHTML = '';
    const onSort = (colId) => {
      if (sortCol === colId) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = colId; sortDir = 'asc'; }
      rebuild();
    };
    table.appendChild(buildThead(onSort));

    const tbody = document.createElement('tbody');
    const reSorted = sortNodes(nodes, edges);

    if (!group || group === 'none') {
      for (const n of reSorted) tbody.appendChild(buildRow(n, edges));
    } else {
      // Group
      const groups = new Map();
      for (const n of reSorted) {
        const gv = dimValue(n, group);
        if (!groups.has(gv)) groups.set(gv, []);
        groups.get(gv).push(n);
      }
      // Sort group keys
      const gKeys = [...groups.keys()].sort((a, b) => {
        const ka = groupSortKey(group, a, nodes);
        const kb = groupSortKey(group, b, nodes);
        if (typeof ka === 'number' && typeof kb === 'number') return ka - kb;
        return String(ka).localeCompare(String(kb));
      });

      for (const gVal of gKeys) {
        const groupNodes = groups.get(gVal);
        const isCollapsed = collapsed.has(gVal);

        // Header row
        const hdr = document.createElement('tr');
        hdr.className = 'group-hdr';
        const hdrTd = document.createElement('td');
        hdrTd.colSpan = COLS.length;
        const caret = document.createElement('span');
        caret.className = 'group-caret';
        caret.textContent = isCollapsed ? '▸' : '▾';
        caret.setAttribute('aria-hidden', 'true');
        hdrTd.append(caret, ` ${gVal}  `, Object.assign(document.createElement('span'), {
          className: 'group-count', textContent: `${groupNodes.length}`,
        }));
        hdr.appendChild(hdrTd);
        hdr.addEventListener('click', () => {
          if (collapsed.has(gVal)) collapsed.delete(gVal);
          else collapsed.add(gVal);
          rebuild();
        });
        tbody.appendChild(hdr);

        if (!isCollapsed) {
          for (const n of groupNodes) tbody.appendChild(buildRow(n, edges));
        }
      }
    }

    table.appendChild(tbody);
  }

  rebuild();
  container.appendChild(table);

  // Wire hover-chain highlighting
  initHover(container, 'list');
}
