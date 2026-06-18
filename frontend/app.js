// app.js — bootstrap, controls wiring, render orchestration
import { state, setState, parseMilestone, annotateNodes } from './state.js';
import { renderTable } from './pivot.js';
import { renderList }  from './list.js';
import { initGraph, clearSearchHighlight }   from './graph.js';
import { MultiSelect } from './multi_select.js';
import { clearPinned } from './hover.js';
import { repoTone } from './tone.js';
import { api, AuthError, requireAuthGate, getSessionProfile } from './auth.js';
import { applyZkDecryption } from './zk-sync.js';

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
const msLabel     = new MultiSelect($('ms-label-btn'),     $('ms-label-panel'),     { placeholder: 'All labels',     clearBtn: $('ms-label-clear') });

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
  container.innerHTML = '';

  const parentsSeg = document.createElement('button');
  parentsSeg.type = 'button';
  parentsSeg.className = 'seg' + (state.showParents ? ' on' : '');
  parentsSeg.textContent = 'Parents';
  parentsSeg.title = 'Show parent (epic) issues';
  parentsSeg.addEventListener('click', () => {
    setState({ showParents: !state.showParents });
    buildGraphSegs();
    render();
  });
  container.appendChild(parentsSeg);

  const closedSeg = document.createElement('button');
  closedSeg.type = 'button';
  closedSeg.className = 'seg' + (state.showClosedUnderOpenEpic ? ' on' : '');
  closedSeg.textContent = 'Closed';
  closedSeg.title = 'Show closed issues whose parent epic is still open';
  closedSeg.addEventListener('click', () => {
    setState({ showClosedUnderOpenEpic: !state.showClosedUnderOpenEpic });
    buildGraphSegs();
    render();
  });
  container.appendChild(closedSeg);
}

// ─── Multi-select onChange ────────────────────────────────────────────────
msRepo.onChange      = vals => { clearPinned(); setState({ repo:      vals }); render(); };
msMilestone.onChange = vals => { clearPinned(); setState({ milestone: vals }); render(); };
msPriority.onChange  = vals => { clearPinned(); setState({ priority:  vals }); render(); };
msStatus.onChange    = vals => { clearPinned(); setState({ status:    vals }); render(); };
msLabel.onChange     = vals => { clearPinned(); setState({ label:     vals }); render(); };

// ─── Populate filter options after data load ──────────────────────────────
const PRIORITY_NAMES = { P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low' };

const LABEL_EXCLUDES = new Set([
  'graph:lane/', 'size:', 'XS', 'S', 'M', 'L', 'XL',
  'P0', 'priority:P0', 'P1-high', 'priority:high', 'priority:P1',
  'P2-medium', 'priority:medium', 'priority:P2',
  'P3-low', 'priority:low', 'priority: low', 'priority:P3',
]);

function isStructuredLabel(lbl) {
  if (LABEL_EXCLUDES.has(lbl)) return true;
  if (lbl.startsWith('graph:lane/') || lbl.startsWith('size:')) return true;
  return false;
}

// repoData: Array<{ repo: string, archived: boolean }>
function populateFilters(repoData) {
  const nodes = state.nodes;

  const live     = repoData.filter(r => !r.archived);
  const archived = repoData.filter(r => r.archived);
  const liveItems = live.map(r => ({ value: r.repo, label: r.repo.split('/')[1] || r.repo, tone: repoTone(r.repo) }));
  const archItems = archived.map(r => ({ value: r.repo, label: r.repo.split('/')[1] || r.repo, tone: repoTone(r.repo), archived: true }));
  const repoItems = archItems.length
    ? [...liveItems, { separator: true, label: 'Archived' }, ...archItems]
    : liveItems;
  msRepo.setItems(repoItems, state.repo);

  const msMap = new Map();
  for (const n of nodes) {
    const ms  = parseMilestone(n);
    const key = ms.code ?? '(None)';
    if (!msMap.has(key)) msMap.set(key, ms.sortKey ?? 9999);
  }
  const msItems = [...msMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([v]) => {
      const node = nodes.find(n => (n.milestone_code ?? '(None)') === v);
      const name = node?.milestone_name ?? null;
      return { value: v, label: v, sublabel: (name && name !== v) ? name : undefined };
    });
  msMilestone.setItems(msItems, state.milestone);

  msPriority.setItems(
    ['P0', 'P1', 'P2', 'P3', '(None)'].map(v => ({
      value: v, label: v, sublabel: PRIORITY_NAMES[v],
    })),
    state.priority
  );

  msStatus.setItems(
    ['ready', 'blocked', 'done'].map(v => ({ value: v, label: v })),
    state.status
  );

  const allLabels = [...new Set(nodes.flatMap(n => n.labels ?? []))]
    .filter(l => !isStructuredLabel(l))
    .sort();
  msLabel.setItems(allLabels.map(l => ({ value: l, label: l })), state.label);
}

function restoreControls() {
  searchInput.value  = state.search;
  searchClear.hidden = !state.search;
  buildPivotSegs();
  buildGraphSegs();
}

async function loadGraphData() {
  const resp = await api('/api/graph');
  return resp.json();
}

// Re-fetch graph data and re-render, preserving view/filters (held in state).
// Uses data.repos (Array<{repo,archived}>) from /api/graph; falls back to nodes-derived if absent.
let sessionZkOptIn = false;
let sessionGithubLogin = '';

async function loadAndRender(zkOptIn, githubLogin) {
  const data  = await loadGraphData();
  const nodes = data.nodes || [];
  const edges = data.edges || [];
  if (zkOptIn) {
    await applyZkDecryption(nodes, githubLogin);
  }
  annotateNodes(nodes, edges);
  setState({ nodes, edges });
  state.nodesByKey = new Map(nodes.map(n => [n.key, n]));
  const reposWithIssues = new Set(nodes.map(n => n.repo));
  let repoData;
  if (data.repos && data.repos.length) {
    repoData = data.repos.filter(r => reposWithIssues.has(r.repo)); // preserves server order (live→archived, alpha) + archived flag
  } else {
    const derived = [...reposWithIssues].sort();
    repoData = derived.map(repo => ({ repo, archived: false }));
  }
  populateFilters(repoData);
  render();
}

// ─── Live refresh: poll /api/version, reload when corpus.db changes ─────────
const POLL_MS = 15000;
let lastVersion = null;

async function fetchVersion() {
  const resp = await api('/api/version');
  return (await resp.json()).version;
}

function startPolling() {
  setInterval(async () => {
    if (document.hidden) return;  // skip while tab is backgrounded
    try {
      const v = await fetchVersion();
      if (lastVersion !== null && v !== lastVersion) {
        await loadAndRender(sessionZkOptIn, sessionGithubLogin);
      }
      lastVersion = v;
    } catch { /* transient — retry next tick */ }
  }, POLL_MS);
}

async function init() {
  // SC1: requireAuthGate() gates all data fetches behind resolveView === 'dashboard'.
  // This is a render-block (UX), not an authz boundary — /api/* is already
  // session+tenant-scoped on the server. The gate prevents confusing 401/empty-graph
  // errors for unauthenticated or unconsented users.
  try {
    const view = await requireAuthGate();
    if (view !== 'dashboard') return; // auth gate is showing; do not fetch data
  } catch (e) {
    if (e instanceof AuthError) return; // no session — landing view shown by requireAuthGate
    throw e;
  }
  restoreControls();
  try {
    const me = await getSessionProfile();
    sessionZkOptIn = Boolean(me.user?.zk_opt_in);
    sessionGithubLogin = me.user?.github_login ?? '';
    await loadAndRender(sessionZkOptIn, sessionGithubLogin);
    try { lastVersion = await fetchVersion(); } catch { /* poller will retry */ }
    startPolling();
  } catch (e) {
    errorMsg.hidden = false;
    errorMsg.textContent = `Failed to load graph: ${e.message}`;
    subtitle.textContent = 'Error';
  }
}

// ─── Theme ────────────────────────────────────────────────────────────────
const themeBtn = $('theme-btn');
const htmlEl   = document.documentElement;
let theme = localStorage.getItem('v6:theme')
  || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

function applyTheme(t) {
  htmlEl.setAttribute('data-theme', t);
  themeBtn.textContent = t === 'dark' ? '🌙' : '☀️';
  localStorage.setItem('v6:theme', t);
}
themeBtn.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
});
applyTheme(theme);

init();
