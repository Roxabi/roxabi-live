// pivot.js — pivot-matrix (Table view) renderer with hover-chain + epic grouping
import { state, filteredNodes, dimValue, parseMilestone,
         prioritySortKey, buildEdgeLookup } from './state.js';
import { initHover, clearPinned } from './hover.js';

// ─── Lane tone mapping (kept for lane column/group headers) ──────────────────
const LANE_TONES = {
  'a1': 'a1', 'a2': 'a2', 'a3': 'a3',
  'b': 'b',
  'c1': 'c1', 'c2': 'c2', 'c3': 'c3',
  'd': 'd', 'e': 'e', 'f': 'f', 'g': 'g', 'h': 'h', 'i': 'i'
};

// ─── Repo → tone (deterministic hash into palette) — drives card color ───────
const REPO_TONE_PALETTE = ['a1', 'a2', 'b', 'c1', 'd', 'e', 'f', 'g', 'h', 'i'];
function getTone(node) {
  const repo = node.repo;
  if (!repo) return '';
  let h = 0;
  for (let i = 0; i < repo.length; i++) h = (h * 31 + repo.charCodeAt(i)) | 0;
  return REPO_TONE_PALETTE[Math.abs(h) % REPO_TONE_PALETTE.length];
}

// ─── Collapse tracking for epic groups ───────────────────────────────────────
const epicCollapsed = new Set();

// ─── Card builder with hover attrs ───────────────────────────────────────────
function buildCard(node, edgeLookup, opts = {}) {
  const a = document.createElement('a');
  const tone = getTone(node);
  a.className = `issue-card state-${node.state}${tone ? ` tone-${tone}` : ''}`;
  if (tone) a.dataset.tone = tone;

  // Hover-chain attrs
  a.dataset.iss = node.key;
  const blockers = edgeLookup.blocks[node.key] || [];
  const blocking = (state.edges.filter(e => e.src === node.key && (e.kind === 'blocks' || !e.kind))
    .map(e => e.dst).join(',')) || '';
  if (blockers.length) a.dataset.blockedby = blockers.join(',');
  if (blocking) a.dataset.blocking = blocking;

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
    const blockedBy = blockers;
    const parentOf  = edgeLookup.parent[node.key]  || [];
    if (blockedBy.length || parentOf.length) {
      const deps = document.createElement('div');
      deps.className = 'card-deps';
      if (blockedBy.length) {
        const sp = document.createElement('span');
        sp.className = 'dep-label dep-blocked';
        sp.textContent = `blocked by: ${blockedBy.map(k => '#' + k.split('#')[1]).join(', ')}`;
        deps.appendChild(sp);
      }
      if (parentOf.length) {
        const sp = document.createElement('span');
        sp.className = 'dep-label dep-parent';
        sp.textContent = `parent: ${parentOf.map(k => '#' + k.split('#')[1]).join(', ')}`;
        deps.appendChild(sp);
      }
      a.appendChild(deps);
    }
  }
  return a;
}

// ─── Epic group header (for lane grouping within cells) ───────────────────────
function buildEpicHeader(lane, nodesWithLane, parentKey, onToggle) {
  const collapseKey = `${lane}:${parentKey || ''}`;
  const isCollapsed = epicCollapsed.has(collapseKey);

  const header = document.createElement('div');
  header.className = 'epic-header' + (isCollapsed ? ' collapsed' : '');
  const tone = lane ? (LANE_TONES[lane.toLowerCase()] || '') : '';
  if (tone) header.dataset.tone = tone;

  // Caret for collapse
  const caret = document.createElement('span');
  caret.className = 'epic-caret';
  caret.textContent = isCollapsed ? '▸' : '▾';
  caret.setAttribute('aria-hidden', 'true');
  header.appendChild(caret);

  // Code element - link if parent URL exists
  const codeEl = document.createElement('span');
  codeEl.className = 'epic-code';
  const parentNode = parentKey ? state.nodes.find(n => n.key === parentKey) : null;
  if (parentNode?.url) {
    const link = document.createElement('a');
    link.href = parentNode.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = lane || '—';
    link.addEventListener('click', e => e.stopPropagation());  // prevent collapse toggle
    codeEl.appendChild(link);
  } else {
    codeEl.textContent = lane || '—';
  }
  header.appendChild(codeEl);

  // Count
  if (nodesWithLane.length > 0) {
    const countEl = document.createElement('span');
    countEl.className = 'epic-count';
    countEl.textContent = `(${nodesWithLane.length})`;
    header.appendChild(countEl);
  }

  // Click to collapse/expand
  header.addEventListener('click', () => {
    if (epicCollapsed.has(collapseKey)) epicCollapsed.delete(collapseKey);
    else epicCollapsed.add(collapseKey);
    onToggle?.();
  });

  return { header, isCollapsed };
}

// ─── Cell renderer with epic grouping ────────────────────────────────────────
function buildCell(cellNodes, edgeLookup, opts) {
  if (!cellNodes.length) {
    const td = document.createElement('td');
    td.className = 'empty-cell';
    td.textContent = '·';
    return td;
  }

  const td = document.createElement('td');

  const cnt = document.createElement('div');
  cnt.className = 'cell-count';
  cnt.textContent = `${cellNodes.length}`;
  td.appendChild(cnt);

  // Group by lane if showing parent grouping
  if (opts.groupByParent || opts.groupByLane) {
    const byLane = new Map();
    for (const n of cellNodes) {
      const lane = n.lane || '—';
      if (!byLane.has(lane)) byLane.set(lane, []);
      byLane.get(lane).push(n);
    }

    const issues = document.createElement('div');
    issues.className = 'cell-issues';

    for (const [lane, laneNodes] of byLane) {
      const group = document.createElement('div');
      group.className = 'epic-group';

      const header = buildEpicHeader(lane, laneNodes, null);
      group.appendChild(header);

      const cards = document.createElement('div');
      cards.className = 'epic-cards';
      for (const n of laneNodes) {
        cards.appendChild(buildCard(n, edgeLookup, opts));
      }
      group.appendChild(cards);
      issues.appendChild(group);
    }
    td.appendChild(issues);
  } else {
    const issues = document.createElement('div');
    issues.className = 'cell-issues';
    for (const n of cellNodes) {
      issues.appendChild(buildCard(n, edgeLookup, opts));
    }
    td.appendChild(issues);
  }

  return td;
}

// ─── Pivot sort helpers ───────────────────────────────────────────────────────
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

// ─── Table renderer ───────────────────────────────────────────────────────────
export function renderTable(container) {
  const { pivotRow, pivotCol, tableGroup } = state;
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

  // Build parent lookup for parent grouping
  // Edge direction: src=parent, dst=child
  // We want: given child, find parent → child → [parents]
  const parentOf = {};
  for (const e of state.edges) {
    if (e.kind === 'parent') {
      parentOf[e.dst] = parentOf[e.dst] || [];
      parentOf[e.dst].push(e.src);
    }
  }

  // Helper: get grouping key for a node based on tableGroup
  function getGroupKey(n) {
    if (tableGroup === 'lane') return n.lane || '—';
    if (tableGroup === 'parent') {
      const parents = parentOf[n.key] || [];
      return parents.length ? parents[0] : '—';
    }
    return '—'; // none
  }

  // Rebuild function for collapse/expand
  function rebuild() {
    renderTable(container);
  }

  // Use grid layout for lane-swim matrix style
  const grid = document.createElement('div');
  grid.className = 'lane-swim-grid';
  grid.style.setProperty('--cols', colVals.length);
  grid.style.setProperty('--row-header-w', '140px');
  grid.style.setProperty('--col-min-w', '190px');

  // Header row
  const gridHead = document.createElement('div');
  gridHead.className = 'grid-head';

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  gridHead.appendChild(spacer);

  for (const cv of colVals) {
    const colHeader = document.createElement('div');
    colHeader.className = 'col-header';
    const tone = LANE_TONES[cv?.toLowerCase()] || '';
    if (tone) colHeader.dataset.tone = tone;

    const label = document.createElement('div');
    label.className = 'col-label';
    if (tone) label.dataset.tone = tone;
    label.textContent = cv;
    colHeader.appendChild(label);
    gridHead.appendChild(colHeader);
  }
  grid.appendChild(gridHead);

  // Data rows
  for (const rv of rowVals) {
    const gridRow = document.createElement('div');
    gridRow.className = 'grid-row';

    const rowHeader = document.createElement('div');
    rowHeader.className = 'row-header';
    if (pivotRow === 'milestone') {
      rowHeader.appendChild(msHeaderHTML(rv));
    } else {
      const codeEl = document.createElement('div');
      codeEl.className = 'ms-code';
      codeEl.textContent = rv;
      rowHeader.appendChild(codeEl);
    }
    gridRow.appendChild(rowHeader);

    for (const cv of colVals) {
      const cellNodes = (matrix[rv] || {})[cv] || [];
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.dataset.col = cv;
      cell.dataset.row = rv;

      if (!cellNodes.length) {
        const empty = document.createElement('div');
        empty.className = 'cell-empty';
        empty.textContent = '·';
        cell.appendChild(empty);
      } else {
        const cnt = document.createElement('div');
        cnt.className = 'cell-count';
        cnt.textContent = `${cellNodes.length}`;
        cell.appendChild(cnt);

        const issues = document.createElement('div');
        issues.className = 'cell-issues';

        if (tableGroup === 'none') {
          // No grouping: flat list
          for (const n of cellNodes) {
            issues.appendChild(buildCard(n, edgeLookup, {
              showRepo: pivotRow !== 'repo' && pivotCol !== 'repo',
            }));
          }
        } else {
          // Group by lane or parent
          const groups = new Map();
          for (const n of cellNodes) {
            const gk = getGroupKey(n);
            if (!groups.has(gk)) groups.set(gk, []);
            groups.get(gk).push(n);
          }

          for (const [gk, groupNodes] of groups) {
            const group = document.createElement('div');
            group.className = 'epic-group';

            const { header, isCollapsed } = buildEpicHeader(gk, groupNodes, tableGroup === 'parent' ? gk : null, rebuild);
            group.appendChild(header);

            const cards = document.createElement('div');
            cards.className = 'epic-cards';
            if (!isCollapsed) {
              for (const n of groupNodes) {
                cards.appendChild(buildCard(n, edgeLookup, {
                  showRepo: pivotRow !== 'repo' && pivotCol !== 'repo',
                }));
              }
            }
            group.appendChild(cards);
            issues.appendChild(group);
          }
        }
        cell.appendChild(issues);
      }
      gridRow.appendChild(cell);
    }
    grid.appendChild(gridRow);
  }

  container.appendChild(grid);

  // Wire hover-chain highlighting
  initHover(container, 'table');
}
