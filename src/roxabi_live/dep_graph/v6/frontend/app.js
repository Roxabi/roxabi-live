// app.js — bootstrap, controls wiring, render orchestration
import { state, setState, parseMilestone, annotateNodes } from './state.js';
import { renderTable } from './pivot.js';
import { renderList }  from './list.js';
import { initGraph }   from './graph.js';
import { MultiSelect } from './multi_select.js';

const $ = id => document.getElementById(id);

const viewTable     = $('view-table');
const viewList      = $('view-list');
const graphPanel    = $('graph-panel');
const btnTable      = $('btn-table');
const btnList       = $('btn-list');
const btnGraph      = $('btn-graph');
const searchInput   = $('search-input');
const searchClear   = $('search-clear');
const pivotRow      = $('pivot-row');
const pivotCol      = $('pivot-col');
const pivotControls = $('pivot-controls');
const listControls  = $('list-controls');
const listGroup     = $('list-group');
const subtitle      = $('subtitle');
const errorMsg      = $('error-msg');

// ─── Multi-select instances ───────────────────────────────────────────────
const msRepo      = new MultiSelect($('ms-repo-btn'),      $('ms-repo-panel'),      { placeholder: 'All repos'      });
const msMilestone = new MultiSelect($('ms-milestone-btn'), $('ms-milestone-panel'), { placeholder: 'All milestones' });
const msPriority  = new MultiSelect($('ms-priority-btn'),  $('ms-priority-panel'),  { placeholder: 'All priorities' });
const msStatus    = new MultiSelect($('ms-status-btn'),    $('ms-status-panel'),    { placeholder: 'All statuses'   });

// ─── Render ───────────────────────────────────────────────────────────────
function render() {
  const isTable = state.view === 'table';
  const isList  = state.view === 'list';
  const isGraph = state.view === 'graph';

  // Panel visibility
  viewTable.classList.toggle('view-active', isTable);
  viewList.classList.toggle('view-active', isList);
  if (isGraph) {
    graphPanel.removeAttribute('hidden');
    graphPanel.classList.add('view-active');
  } else {
    graphPanel.setAttribute('hidden', '');
    graphPanel.classList.remove('view-active');
  }

  // Button states
  btnTable.classList.toggle('active', isTable);
  btnTable.setAttribute('aria-pressed', String(isTable));
  btnList.classList.toggle('active', isList);
  btnList.setAttribute('aria-pressed', String(isList));
  if (btnGraph) {
    btnGraph.classList.toggle('active', isGraph);
    btnGraph.setAttribute('aria-pressed', String(isGraph));
  }

  // Context-sensitive toolbar
  pivotControls.style.display = isTable ? '' : 'none';
  if (listControls) listControls.style.display = isList ? '' : 'none';

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
if (btnGraph) {
  btnGraph.addEventListener('click', () => { setState({ view: 'graph' }); render(); });
}

// ─── Search ───────────────────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  setState({ search: searchInput.value });
  render();
});
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  setState({ search: '' });
  searchInput.focus();
  render();
});

// ─── Pivot controls ───────────────────────────────────────────────────────
pivotRow.addEventListener('change', () => { setState({ pivotRow: pivotRow.value }); render(); });
pivotCol.addEventListener('change', () => { setState({ pivotCol: pivotCol.value }); render(); });

// ─── List group-by ────────────────────────────────────────────────────────
if (listGroup) {
  listGroup.addEventListener('change', () => { setState({ listGroup: listGroup.value }); render(); });
}

// ─── Multi-select onChange ────────────────────────────────────────────────
msRepo.onChange      = vals => { setState({ repo:      vals }); render(); };
msMilestone.onChange = vals => { setState({ milestone: vals }); render(); };
msPriority.onChange  = vals => { setState({ priority:  vals }); render(); };
msStatus.onChange    = vals => { setState({ status:    vals }); render(); };

// ─── Populate filter options after data load ──────────────────────────────
function populateFilters(repos) {
  const nodes = state.nodes;

  // Repo
  const repoItems = repos.map(r => ({ value: r, label: r.split('/')[1] || r }));
  msRepo.setItems(repoItems, state.repo);

  // Milestone — distinct codes sorted by sort_key; synthetic (None)
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

  // Priority — always all 5
  msPriority.setItems(
    ['P0', 'P1', 'P2', 'P3', '(None)'].map(v => ({ value: v, label: v })),
    state.priority
  );

  // Status — always 3
  msStatus.setItems(
    ['ready', 'blocked', 'done'].map(v => ({ value: v, label: v })),
    state.status
  );
}

// ─── Restore static controls ──────────────────────────────────────────────
function restoreControls() {
  searchInput.value  = state.search;
  searchClear.hidden = !state.search;
  pivotRow.value     = state.pivotRow;
  pivotCol.value     = state.pivotCol;
  if (listGroup) listGroup.value = state.listGroup;
}

// ─── Data loading ─────────────────────────────────────────────────────────
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

// ─── Init ─────────────────────────────────────────────────────────────────
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
