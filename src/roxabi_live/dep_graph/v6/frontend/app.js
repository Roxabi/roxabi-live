// app.js — bootstrap, controls wiring, render orchestration
import { state, setState } from './state.js';
import { renderTable, renderList } from './pivot.js';

const $ = id => document.getElementById(id);

const viewTable    = $('view-table');
const viewList     = $('view-list');
const btnTable     = $('btn-table');
const btnList      = $('btn-list');
const repoFilter   = $('repo-filter');
const searchInput  = $('search-input');
const searchClear  = $('search-clear');
const pivotRow     = $('pivot-row');
const pivotCol     = $('pivot-col');
const pivotControls= $('pivot-controls');
const subtitle     = $('subtitle');
const errorMsg     = $('error-msg');

// ─── Render ───────────────────────────────────────────────────────────────
function render() {
  if (state.view === 'table') {
    viewTable.classList.add('view-active');
    viewList.classList.remove('view-active');
    btnTable.classList.add('active'); btnTable.setAttribute('aria-pressed', 'true');
    btnList.classList.remove('active'); btnList.setAttribute('aria-pressed', 'false');
    pivotControls.style.display = '';
    renderTable(viewTable);
  } else {
    viewList.classList.add('view-active');
    viewTable.classList.remove('view-active');
    btnList.classList.add('active'); btnList.setAttribute('aria-pressed', 'true');
    btnTable.classList.remove('active'); btnTable.setAttribute('aria-pressed', 'false');
    pivotControls.style.display = 'none';
    renderList(viewList);
  }
  searchClear.hidden = !state.search;
  updateSubtitle();
}

function updateSubtitle() {
  const total = state.nodes.length;
  const open  = state.nodes.filter(n => n.state === 'open').length;
  subtitle.textContent = `${total} issues · ${open} open · ${total - open} closed`;
}

// ─── Controls ─────────────────────────────────────────────────────────────
btnTable.addEventListener('click', () => { setState({ view: 'table' }); render(); });
btnList.addEventListener('click',  () => { setState({ view: 'list'  }); render(); });

repoFilter.addEventListener('change', () => {
  setState({ repo: repoFilter.value });
  render();
});

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

pivotRow.addEventListener('change', () => {
  setState({ pivotRow: pivotRow.value });
  render();
});

pivotCol.addEventListener('change', () => {
  setState({ pivotCol: pivotCol.value });
  render();
});

// ─── Restore controls from state ─────────────────────────────────────────
function restoreControls() {
  repoFilter.value  = state.repo;
  searchInput.value = state.search;
  pivotRow.value    = state.pivotRow;
  pivotCol.value    = state.pivotCol;
  searchClear.hidden = !state.search;
}

// ─── Populate repo filter ─────────────────────────────────────────────────
async function loadRepos() {
  try {
    const resp = await fetch('/api/repos');
    if (!resp.ok) throw new Error(`/api/repos ${resp.status}`);
    const repos = await resp.json();
    const all = document.createElement('option');
    all.value = 'all'; all.textContent = 'All repos';
    repoFilter.appendChild(all);
    for (const r of repos) {
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      repoFilter.appendChild(opt);
    }
    repoFilter.value = state.repo;
  } catch (e) {
    // fallback: derive repos from nodes
    const repos = [...new Set(state.nodes.map(n => n.repo))].sort();
    const all = document.createElement('option');
    all.value = 'all'; all.textContent = 'All repos';
    repoFilter.appendChild(all);
    for (const r of repos) {
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      repoFilter.appendChild(opt);
    }
    repoFilter.value = state.repo;
  }
}

// ─── Fetch graph data ─────────────────────────────────────────────────────
async function loadGraph() {
  const resp = await fetch('/api/graph');
  if (!resp.ok) throw new Error(`/api/graph ${resp.status}`);
  return resp.json();
}

// ─── Init ─────────────────────────────────────────────────────────────────
async function init() {
  restoreControls();
  try {
    const data = await loadGraph();
    setState({ nodes: data.nodes || [], edges: data.edges || [] });
    await loadRepos();
    render();
  } catch (e) {
    errorMsg.hidden = false;
    errorMsg.textContent = `Failed to load graph: ${e.message}`;
    subtitle.textContent = 'Error';
  }
}

init();
