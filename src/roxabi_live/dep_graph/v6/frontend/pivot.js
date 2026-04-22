// pivot.js — pivot-matrix (Table view) renderer
import { state, filteredNodes, dimValue, parseMilestone,
         prioritySortKey, buildEdgeLookup } from './state.js';

// ─── Card builder ─────────────────────────────────────────────────────────
function buildCard(node, edgeLookup, opts = {}) {
  const a = document.createElement('a');
  a.className = `issue-card state-${node.state}`;
  a.href = node.url || '#';
  if (node.url) a.target = '_blank';
  a.rel = 'noopener noreferrer';

  const head = document.createElement('div');
  head.className = 'card-head';

  const dot = document.createElement('span');
  dot.className = 'card-dot';
  dot.setAttribute('aria-hidden', 'true');

  const num = document.createElement('span');
  num.className = 'card-num';
  num.textContent = `#${node.number}`;

  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = node.title || `Issue #${node.number}`;

  head.append(dot, num, title);
  a.appendChild(head);

  const badges = document.createElement('div');
  badges.className = 'card-badges';
  if (opts.showRepo) {
    const rb = document.createElement('span');
    rb.className = 'badge badge-repo';
    rb.textContent = node.repo.split('/')[1] || node.repo;
    badges.appendChild(rb);
  }
  if (node.priority) {
    const pb = document.createElement('span');
    pb.className = `badge badge-${node.priority.toLowerCase()}`;
    pb.textContent = node.priority;
    badges.appendChild(pb);
  }
  if (node.size) {
    const sb = document.createElement('span');
    sb.className = 'badge';
    sb.textContent = node.size;
    badges.appendChild(sb);
  }
  if (opts.showMs) {
    const ms = parseMilestone(node);
    if (ms.code) {
      const mb = document.createElement('span');
      mb.className = 'badge badge-ms';
      mb.textContent = ms.code;
      badges.appendChild(mb);
    }
  }
  if (badges.children.length) a.appendChild(badges);

  if (edgeLookup) {
    const blockedBy = edgeLookup.blocks[node.key] || [];
    const parentOf  = edgeLookup.parent[node.key]  || [];
    if (blockedBy.length || parentOf.length) {
      const deps = document.createElement('div');
      deps.className = 'card-deps';
      if (blockedBy.length) {
        const sp = document.createElement('span');
        sp.className = 'dep-label';
        sp.textContent = `blocked by: ${blockedBy.map(k => '#' + k.split('#')[1]).join(', ')}`;
        deps.appendChild(sp);
      }
      if (parentOf.length) {
        const sp = document.createElement('span');
        sp.className = 'dep-label';
        sp.textContent = `parent: ${parentOf.map(k => '#' + k.split('#')[1]).join(', ')}`;
        deps.appendChild(sp);
      }
      a.appendChild(deps);
    }
  }
  return a;
}

// ─── Pivot sort helpers ───────────────────────────────────────────────────
function sortRowValues(values, dim) {
  if (dim === 'milestone') {
    return values.sort((a, b) => {
      const ka = state.nodes.find(n => dimValue(n, 'milestone') === a);
      const kb = state.nodes.find(n => dimValue(n, 'milestone') === b);
      const sa = ka ? parseMilestone(ka).sortKey : 9999;
      const sb = kb ? parseMilestone(kb).sortKey : 9999;
      if (a === '—') return 1; if (b === '—') return -1;
      return sa - sb;
    });
  }
  if (dim === 'priority') {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3, None: 4 };
    return values.sort((a, b) => (order[a] ?? 99) - (order[b] ?? 99));
  }
  return values.sort((a, b) => {
    if (a === '—' || a === 'All') return 1;
    if (b === '—' || b === 'All') return -1;
    return a.localeCompare(b);
  });
}

function msHeaderHTML(code) {
  const node = state.nodes.find(n => dimValue(n, 'milestone') === code);
  const ms = node ? parseMilestone(node) : { code, name: null };
  const div = document.createElement('div');
  div.className = 'ms-row-header';
  const codeEl = document.createElement('div');
  codeEl.className = 'ms-row-code';
  codeEl.textContent = ms.code || '—';
  div.appendChild(codeEl);
  if (ms.name) {
    const nameEl = document.createElement('div');
    nameEl.className = 'ms-row-name';
    nameEl.textContent = ms.name;
    div.appendChild(nameEl);
  }
  return div;
}

// ─── Table renderer ───────────────────────────────────────────────────────
export function renderTable(container) {
  const { pivotRow, pivotCol } = state;
  const nodes = filteredNodes();
  const edgeLookup = buildEdgeLookup(state.edges);

  const rowVals = [...new Set(nodes.map(n => dimValue(n, pivotRow)))];
  const colVals = [...new Set(nodes.map(n => dimValue(n, pivotCol)))];
  sortRowValues(rowVals, pivotRow);
  sortRowValues(colVals, pivotCol);

  const matrix = {};
  for (const n of nodes) {
    const r = dimValue(n, pivotRow);
    const c = dimValue(n, pivotCol);
    (matrix[r] = matrix[r] || {})[c] = matrix[r]?.[c] || [];
    matrix[r][c].push(n);
  }

  container.innerHTML = '';
  if (!nodes.length) {
    container.textContent = 'No issues match the current filter.';
    return;
  }

  const table = document.createElement('table');
  table.className = 'pivot-table';

  const thead = document.createElement('thead');
  const hrow  = document.createElement('tr');
  const cornerTh = document.createElement('th');
  cornerTh.className   = 'row-header-th';
  cornerTh.textContent = `${pivotRow} \\ ${pivotCol}`;
  hrow.appendChild(cornerTh);
  for (const cv of colVals) {
    const th = document.createElement('th');
    th.textContent = cv;
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const rv of rowVals) {
    const tr    = document.createElement('tr');
    const rowTh = document.createElement('th');
    rowTh.className = 'row-header-th';
    if (pivotRow === 'milestone') rowTh.appendChild(msHeaderHTML(rv));
    else rowTh.textContent = rv;
    tr.appendChild(rowTh);

    for (const cv of colVals) {
      const cellNodes = (matrix[rv] || {})[cv] || [];
      const td = document.createElement('td');
      if (!cellNodes.length) { td.className = 'empty-cell'; tr.appendChild(td); continue; }

      const cnt = document.createElement('div');
      cnt.className   = 'cell-count';
      cnt.textContent = `${cellNodes.length}`;
      td.appendChild(cnt);

      const issues = document.createElement('div');
      issues.className = 'cell-issues';
      for (const n of cellNodes) {
        issues.appendChild(buildCard(n, edgeLookup, {
          showRepo: pivotRow !== 'repo' && pivotCol !== 'repo',
        }));
      }
      td.appendChild(issues);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}
