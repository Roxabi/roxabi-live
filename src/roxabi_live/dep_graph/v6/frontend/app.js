// app.js — bootstrap, controls wiring, render orchestration
import { state, setState, parseMilestone, annotateNodes } from './state.js';
import { renderTable } from './pivot.js';
import { renderList }  from './list.js';
import { initGraph, clearSearchHighlight }   from './graph.js';
import { MultiSelect } from './multi_select.js';
import { clearPinned } from './hover.js';

const $ = id => document.getElementById(id);

const viewTable     = $('view-table');
const viewList      = $('view-list');
const graphPanel    = $('graph-panel');
const btnTable      = $('btn-table');
const btnList       = $('btn-list');
const btnGraph      = $('btn-graph');
const searchInput   = $('search-input');
const searchClear   = $('search-clear');
const pivotControls = $('pivot-controls');
const listControls  = $('list-controls');
const graphControls = $('graph-controls');
const subtitle      = $('subtitle');
const errorMsg      = $('error-msg');

const PIVOT_DIMS = ['milestone', 'priority', 'repo', 'lane', 'size', 'none'];
const LIST_DIMS  = ['milestone', 'priority', 'repo', 'lane', 'size', 'status', 'parent', 'none'];
const TABLE_GROUP_DIMS = ['lane', 'parent', 'none'];

// ─── Seg group builder (click active to deactivate → 'none') ────────────────
function buildSegs(container, values, current, onPick, opts = {}) {
  const { allowDeactivate = true, noneValue = 'none' } = opts;
  container.innerHTML = '';
  for (const v of values) {
    const b = document.createElement('button');
    b.type      = 'button';
    b.className = 'seg' + (v === current ? ' on' : '');
    b.dataset.v = v;
    b.textContent = v;
    b.addEventListener('click', () => {
      // Click active → deactivate (set to noneValue)
      if (allowDeactivate && v === current) {
        container.querySelectorAll('.seg').forEach(s => s.classList.toggle('on', s.dataset.v === noneValue));
        onPick(noneValue);
      } else {
        container.querySelectorAll('.seg').forEach(s => s.classList.toggle('on', s.dataset.v === v));
        onPick(v);
      }
    });
    container.appendChild(b);
  }
}

// ─── Multi-select instances ───────────────────────────────────────────────
const msRepo      = new MultiSelect($('ms-repo-btn'),      $('ms-repo-panel'),      { placeholder: 'All repos',      clearBtn: $('ms-repo-clear') });
const msMilestone = new MultiSelect($('ms-milestone-btn'), $('ms-milestone-panel'), { placeholder: 'All milestones', clearBtn: $('ms-milestone-clear') });
const msPriority  = new MultiSelect($('ms-priority-btn'),  $('ms-priority-panel'),  { placeholder: 'All priorities', clearBtn: $('ms-priority-clear') });
const msStatus    = new MultiSelect($('ms-status-btn'),    $('ms-status-panel'),    { placeholder: 'All statuses',   clearBtn: $('ms-status-clear') });

// ─── Render ───────────────────────────────────────────────────────────────
function render() {
  const isTable = state.view === 'table';
  const isList  = state.view === 'list';
  const isGraph = state.view === 'graph';

  viewTable.classList.toggle('view-active', isTable);
  viewList.classList.toggle('view-active', isList);
  if (isGraph) {
    graphPanel.removeAttribute('hidden');
    graphPanel.classList.add('view-active');
  } else {
    graphPanel.setAttribute('hidden', '');
    graphPanel.classList.remove('view-active');
  }

  for (const [btn, match] of [[btnTable, 'table'], [btnList, 'list'], [btnGraph, 'graph']]) {
    if (!btn) continue;
    btn.classList.toggle('on', state.view === match);
    btn.setAttribute('aria-pressed', String(state.view === match));
  }

  pivotControls.style.display = isTable ? '' : 'none';
  if (listControls) listControls.style.display = isList ? '' : 'none';
  if (graphControls) graphControls.style.display = isGraph ? '' : 'none';

  searchClear.hidden = !state.search;
  updateSubtitle();

  if (isTable) renderTable(viewTable);
  else if (isList) renderList(viewList);
  else if (isGraph) initGraph();
}

function updateSubtitle() {
  const total = state.nodes.length;
  const open  = state.nodes.filter(n => n.state === 'open').length;
  subtitle.textContent = `${total} issues · ${open} open · ${total - open} closed`;
}

// ─── View toggle ──────────────────────────────────────────────────────────
btnTable.addEventListener('click', () => { setState({ view: 'table' }); render(); });
btnList.addEventListener('click',  () => { setState({ view: 'list'  }); render(); });
if (btnGraph) btnGraph.addEventListener('click', () => { setState({ view: 'graph' }); render(); });

// ─── Search ───────────────────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  setState({ search: searchInput.value });
  render();
});
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  setState({ search: '' });
  searchInput.focus();
  clearSearchHighlight();
  render();
});

// ESC key clears search + graph highlight
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    searchInput.value = '';
    setState({ search: '' });
    clearSearchHighlight();
    render();
  }
});

// ─── Pivot + List segs ────────────────────────────────────────────────────
function buildPivotSegs() {
  buildSegs($('pivot-row-segs'), PIVOT_DIMS, state.pivotRow, v => { setState({ pivotRow: v }); render(); });
  buildSegs($('pivot-col-segs'), PIVOT_DIMS, state.pivotCol, v => { setState({ pivotCol: v }); render(); });
  buildSegs($('table-group-segs'), TABLE_GROUP_DIMS, state.tableGroup, v => { setState({ tableGroup: v }); render(); }, { allowDeactivate: true });
  buildSegs($('list-group-segs'), LIST_DIMS, state.listGroup, v => { setState({ listGroup: v }); render(); }, { allowDeactivate: true });
  buildSegs($('list-group2-segs'), LIST_DIMS, state.listGroup2, v => { setState({ listGroup2: v }); render(); }, { allowDeactivate: true });
}

// ─── Graph edge toggle ─────────────────────────────────────────────────────
function buildGraphSegs() {
  const container = $('graph-edge-segs');
  if (!container) return;
  const parentsSeg = document.createElement('button');
  parentsSeg.type = 'button';
  parentsSeg.className = 'seg' + (state.showParents ? ' on' : '');
  parentsSeg.textContent = 'Parents';
  parentsSeg.addEventListener('click', () => {
    setState({ showParents: !state.showParents });
    buildGraphSegs();
    initGraph();
  });
  container.innerHTML = '';
  container.appendChild(parentsSeg);
}

// ─── Multi-select onChange ────────────────────────────────────────────────
msRepo.onChange      = vals => { clearPinned(); setState({ repo:      vals }); render(); };
msMilestone.onChange = vals => { clearPinned(); setState({ milestone: vals }); render(); };
msPriority.onChange  = vals => { clearPinned(); setState({ priority:  vals }); render(); };
msStatus.onChange    = vals => { clearPinned(); setState({ status:    vals }); render(); };

// ─── Populate filter options after data load ──────────────────────────────
function populateFilters(repos) {
  const nodes = state.nodes;

  const repoItems = repos.map(r => ({ value: r, label: r.split('/')[1] || r }));
  msRepo.setItems(repoItems, state.repo);

  const msMap = new Map();
  for (const n of nodes) {
    const ms  = parseMilestone(n);
    const key = ms.code ?? '(None)';
    if (!msMap.has(key)) msMap.set(key, ms.sortKey ?? 9999);
  }
  const msItems = [...msMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([v]) => ({ value: v, label: v }));
  msMilestone.setItems(msItems, state.milestone);

  msPriority.setItems(
    ['P0', 'P1', 'P2', 'P3', '(None)'].map(v => ({ value: v, label: v })),
    state.priority
  );

  msStatus.setItems(
    ['ready', 'blocked', 'done'].map(v => ({ value: v, label: v })),
    state.status
  );
}

function restoreControls() {
  searchInput.value  = state.search;
  searchClear.hidden = !state.search;
  buildPivotSegs();
  buildGraphSegs();
}

async function loadGraphData() {
  const resp = await fetch('/api/graph');
  if (!resp.ok) throw new Error(`/api/graph ${resp.status}`);
  return resp.json();
}

async function loadRepos() {
  try {
    const resp = await fetch('/api/repos');
    if (!resp.ok) throw new Error(`/api/repos ${resp.status}`);
    return resp.json();
  } catch {
    return [...new Set(state.nodes.map(n => n.repo))].sort();
  }
}

async function init() {
  restoreControls();
  try {
    const [data, repos] = await Promise.all([loadGraphData(), loadRepos()]);
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    annotateNodes(nodes, edges);
    setState({ nodes, edges });
    populateFilters(repos);
    render();
  } catch (e) {
    errorMsg.hidden = false;
    errorMsg.textContent = `Failed to load graph: ${e.message}`;
    subtitle.textContent = 'Error';
  }
}

init();
