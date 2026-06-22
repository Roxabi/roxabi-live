import {
  AuthError,
  api,
  getSessionProfile,
  isZkAccountKeyEnabled,
  requireAuthGate,
  stripStaleOAuthCallbackUrl,
} from "./auth.js";
import { clearSearchHighlight, initGraph } from "./graph.js";
import { clearPinned } from "./hover.js";
import { ensureSyncStarted, startSyncProgressMonitor } from "./initial-sync.js";
import { renderList } from "./list.js";
import { MultiSelect } from "./multi_select.js";
import { renderTable } from "./pivot.js";
import { resumeSettingsFromUrl } from "./settings.js";
import { SingleSelect } from "./single_select.js";
// app.js — bootstrap, controls wiring, render orchestration
import { annotateNodes, parseMilestone, setState, state } from "./state.js";
import { applyThemePref, toggleThemeQuick, wireThemeMediaListener } from "./theme.js";
import { repoTone } from "./tone.js";
import { requireZkEnrollmentGate } from "./zk-enroll.js";
import {
  consumeZkHandoffFromUrl,
  consumeZkReauthFromUrl,
  getGithubUserToken,
  zkLoginUrl,
} from "./zk-github.js";
import {
  applyZkDecryption,
  clearZkMigrationIncomplete,
  ensureAccountKeySealing,
  ensurePrivateMode,
  isZkMigrationIncomplete,
  syncZkContentFromGitHub,
} from "./zk-sync.js";

const $ = (id) => document.getElementById(id);

const viewTable = $("view-table");
const viewList = $("view-list");
const graphPanel = $("graph-panel");
const searchInput = $("search-input");
const searchClear = $("search-clear");
const pivotControls = $("pivot-controls");
const listControls = $("list-controls");
const graphControls = $("graph-controls");
const subtitle = $("subtitle");
const errorMsg = $("error-msg");
const zkMigrationNotice = $("zk-migration-notice");
const zkGithubLinkNotice = $("zk-github-link-notice");

const PIVOT_DIMS = ["milestone", "priority", "repo", "lane", "size", "assignee", "none"];
const GRAPH_DIMS = ["milestone", "priority", "repo", "lane", "size", "assignee", "status", "none"];
const LIST_DIMS = [
  "milestone",
  "priority",
  "repo",
  "lane",
  "size",
  "status",
  "parent",
  "assignee",
  "none",
];
const TABLE_GROUP_DIMS = ["lane", "parent", "none"];
const btnGraph = $("btn-graph");
const btnList = $("btn-list");
const btnTable = $("btn-table");

const dimItems = (values) => values.map((v) => ({ value: v, label: v }));

// ─── ZK migration incomplete notice ─────────────────────────────────────────
function showZkGithubLinkNotice() {
  if (!zkGithubLinkNotice || getGithubUserToken()) return;
  zkGithubLinkNotice.textContent = "";
  const msg = document.createElement("span");
  msg.textContent =
    "Issue titles are encrypted — link GitHub once to import titles from your repos.";
  const link = document.createElement("a");
  link.href = zkLoginUrl("/dashboard");
  link.textContent = "Link GitHub";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "zk-migration-notice-dismiss";
  btn.title = "Dismiss";
  btn.textContent = "×";
  btn.addEventListener("click", () => {
    zkGithubLinkNotice.hidden = true;
  });
  zkGithubLinkNotice.append(msg, " ", link, " ", btn);
  zkGithubLinkNotice.hidden = false;
}

function showZkMigrationNotice() {
  if (!isZkMigrationIncomplete()) return;
  zkMigrationNotice.textContent = "";
  const msg = document.createElement("span");
  msg.textContent =
    "Encryption upgrade incomplete — open Roxabi on your original device to finish, or some older items can't be decrypted.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "zk-migration-notice-dismiss";
  btn.title = "Dismiss";
  btn.textContent = "×";
  btn.addEventListener("click", () => {
    clearZkMigrationIncomplete();
    zkMigrationNotice.hidden = true;
  });
  zkMigrationNotice.append(msg, btn);
  zkMigrationNotice.hidden = false;
}

// ─── Single-select instances ──────────────────────────────────────────────
const ssPivotRow = new SingleSelect($("pivot-row-btn"), $("pivot-row-panel"));
const ssPivotCol = new SingleSelect($("pivot-col-btn"), $("pivot-col-panel"));
const ssGraphRow = new SingleSelect($("graph-row-btn"), $("graph-row-panel"));
const ssGraphCol = new SingleSelect($("graph-col-btn"), $("graph-col-panel"));
const ssTableGroup = new SingleSelect($("table-group-btn"), $("table-group-panel"));
const ssListGroup = new SingleSelect($("list-group-btn"), $("list-group-panel"));
const ssListGroup2 = new SingleSelect($("list-group2-btn"), $("list-group2-panel"));

// ─── Multi-select instances ───────────────────────────────────────────────
const msRepo = new MultiSelect($("ms-repo-btn"), $("ms-repo-panel"), {
  placeholder: "All repos",
  clearBtn: $("ms-repo-clear"),
  maxVisiblePills: 2,
});
const msMilestone = new MultiSelect($("ms-milestone-btn"), $("ms-milestone-panel"), {
  placeholder: "All milestones",
  clearBtn: $("ms-milestone-clear"),
});
const msPriority = new MultiSelect($("ms-priority-btn"), $("ms-priority-panel"), {
  placeholder: "All priorities",
  clearBtn: $("ms-priority-clear"),
});
const msAssignee = new MultiSelect($("ms-assignee-btn"), $("ms-assignee-panel"), {
  placeholder: "All assignees",
  clearBtn: $("ms-assignee-clear"),
});
const msStatus = new MultiSelect($("ms-status-btn"), $("ms-status-panel"), {
  placeholder: "All statuses",
  clearBtn: $("ms-status-clear"),
});
const msLabel = new MultiSelect($("ms-label-btn"), $("ms-label-panel"), {
  placeholder: "All labels",
  clearBtn: $("ms-label-clear"),
  maxVisiblePills: 2,
});

// ─── Render ───────────────────────────────────────────────────────────────
function render() {
  const isTable = state.view === "table";
  const isList = state.view === "list";
  const isGraph = state.view === "graph";

  viewTable.classList.toggle("view-active", isTable);
  viewList.classList.toggle("view-active", isList);
  if (isGraph) {
    graphPanel.removeAttribute("hidden");
    graphPanel.classList.add("view-active");
  } else {
    graphPanel.setAttribute("hidden", "");
    graphPanel.classList.remove("view-active");
  }

  for (const [btn, match] of [
    [btnGraph, "graph"],
    [btnList, "list"],
    [btnTable, "table"],
  ]) {
    if (!btn) continue;
    btn.classList.toggle("on", state.view === match);
    btn.setAttribute("aria-pressed", String(state.view === match));
  }

  pivotControls.style.display = isTable ? "" : "none";
  if (listControls) listControls.style.display = isList ? "" : "none";
  if (graphControls) graphControls.style.display = isGraph ? "" : "none";

  searchClear.hidden = !state.search;
  updateSubtitle();

  if (isTable) renderTable(viewTable);
  else if (isList) renderList(viewList);
  else if (isGraph) initGraph();
}

function updateSubtitle() {
  const total = state.nodes.length;
  const open = state.nodes.filter((n) => n.state === "open").length;
  subtitle.textContent = `${total} issues · ${open} open · ${total - open} closed`;
}

// ─── View toggle (segs) + dimension dropdowns ─────────────────────────────
for (const [btn, view] of [
  [btnGraph, "graph"],
  [btnList, "list"],
  [btnTable, "table"],
]) {
  btn?.addEventListener("click", () => {
    setState({ view });
    render();
  });
}
ssPivotRow.onChange = (v) => {
  setState({ pivotRow: v });
  render();
};
ssPivotCol.onChange = (v) => {
  setState({ pivotCol: v });
  render();
};
ssTableGroup.onChange = (v) => {
  setState({ tableGroup: v });
  render();
};
ssListGroup.onChange = (v) => {
  setState({ listGroup: v });
  render();
};
ssListGroup2.onChange = (v) => {
  setState({ listGroup2: v });
  render();
};
ssGraphRow.onChange = (v) => {
  setState({ graphRow: v });
  render();
};
ssGraphCol.onChange = (v) => {
  setState({ graphCol: v });
  render();
};

// ─── Search ───────────────────────────────────────────────────────────────
searchInput.addEventListener("input", () => {
  setState({ search: searchInput.value });
  render();
});
searchClear.addEventListener("click", () => {
  searchInput.value = "";
  setState({ search: "" });
  searchInput.focus();
  clearSearchHighlight();
  render();
});

// ESC key clears search + graph highlight
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    searchInput.value = "";
    setState({ search: "" });
    clearSearchHighlight();
    render();
  }
});

// ─── Graph edge toggle (Parents/Closed stay as segs) ───────────────────────
function buildGraphSegs() {
  const container = $("graph-edge-segs");
  if (!container) return;
  container.innerHTML = "";

  const parentsSeg = document.createElement("button");
  parentsSeg.type = "button";
  parentsSeg.className = `seg${state.showParents ? " on" : ""}`;
  parentsSeg.textContent = "Parents";
  parentsSeg.title = "Show parent (epic) issues";
  parentsSeg.addEventListener("click", () => {
    setState({ showParents: !state.showParents });
    buildGraphSegs();
    render();
  });
  container.appendChild(parentsSeg);

  const closedSeg = document.createElement("button");
  closedSeg.type = "button";
  closedSeg.className = `seg${state.showClosedUnderOpenEpic ? " on" : ""}`;
  closedSeg.textContent = "Closed";
  closedSeg.title = "Show closed issues whose parent epic is still open";
  closedSeg.addEventListener("click", () => {
    setState({ showClosedUnderOpenEpic: !state.showClosedUnderOpenEpic });
    buildGraphSegs();
    loadAndRender(sessionZkOptIn, sessionGithubLogin, sessionZkAccountKeyEnabled).catch((e) => {
      errorMsg.hidden = false;
      errorMsg.textContent = `Failed to load graph: ${e.message}`;
    });
  });
  container.appendChild(closedSeg);

  const assigneeSeg = document.createElement("button");
  assigneeSeg.type = "button";
  assigneeSeg.className = `seg${state.showAssignees ? " on" : ""}`;
  assigneeSeg.textContent = "Assignees";
  assigneeSeg.title = "Show assignee logins on issue labels";
  assigneeSeg.addEventListener("click", () => {
    setState({ showAssignees: !state.showAssignees });
    buildGraphSegs();
    render();
  });
  container.appendChild(assigneeSeg);
}

// ─── Multi-select onChange ────────────────────────────────────────────────
msRepo.onChange = (vals) => {
  clearPinned();
  setState({ repo: vals });
  render();
};
msMilestone.onChange = (vals) => {
  clearPinned();
  setState({ milestone: vals });
  render();
};
msPriority.onChange = (vals) => {
  clearPinned();
  setState({ priority: vals });
  render();
};
msAssignee.onChange = (vals) => {
  clearPinned();
  setState({ assignee: vals });
  render();
};
msStatus.onChange = (vals) => {
  clearPinned();
  setState({ status: vals });
  loadAndRender(sessionZkOptIn, sessionGithubLogin).catch((e) => {
    errorMsg.hidden = false;
    errorMsg.textContent = `Failed to load graph: ${e.message}`;
  });
};
msLabel.onChange = (vals) => {
  clearPinned();
  setState({ label: vals });
  render();
};

// ─── Populate filter options after data load ──────────────────────────────
const PRIORITY_NAMES = { P0: "Critical", P1: "High", P2: "Medium", P3: "Low" };

const LABEL_EXCLUDES = new Set([
  "graph:lane/",
  "size:",
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "P0",
  "priority:P0",
  "P1-high",
  "priority:high",
  "priority:P1",
  "P2-medium",
  "priority:medium",
  "priority:P2",
  "P3-low",
  "priority:low",
  "priority: low",
  "priority:P3",
]);

function isStructuredLabel(lbl) {
  if (LABEL_EXCLUDES.has(lbl)) return true;
  if (lbl.startsWith("graph:lane/") || lbl.startsWith("size:")) return true;
  return false;
}

// repoData: Array<{ repo, archived, issue_count?, last_updated_at? }>
function repoActivityRank(repo, nodes) {
  if (repo.issue_count != null) {
    return { count: repo.issue_count, updatedAt: repo.last_updated_at ?? "" };
  }
  let count = 0;
  for (const n of nodes) {
    if (n.repo === repo.repo) count++;
  }
  return { count, updatedAt: "" };
}

function compareReposByActivity(a, b, nodes) {
  const actA = repoActivityRank(a, nodes);
  const actB = repoActivityRank(b, nodes);
  if (actB.count !== actA.count) return actB.count - actA.count;
  if (actB.updatedAt !== actA.updatedAt) return actB.updatedAt.localeCompare(actA.updatedAt);
  return a.repo.localeCompare(b.repo);
}

function sortReposByActivity(repos, nodes) {
  return [...repos].sort((a, b) => compareReposByActivity(a, b, nodes));
}

function populateFilters(repoData) {
  const nodes = state.nodes;

  const live = sortReposByActivity(
    repoData.filter((r) => !r.archived),
    nodes,
  );
  const archived = sortReposByActivity(
    repoData.filter((r) => r.archived),
    nodes,
  );
  const liveItems = live.map((r) => ({
    value: r.repo,
    label: r.repo.split("/")[1] || r.repo,
    tone: repoTone(r.repo),
  }));
  const archItems = archived.map((r) => ({
    value: r.repo,
    label: r.repo.split("/")[1] || r.repo,
    tone: repoTone(r.repo),
    archived: true,
  }));
  const repoItems = archItems.length
    ? [...liveItems, { separator: true, label: "Archived" }, ...archItems]
    : liveItems;
  msRepo.setItems(repoItems, state.repo);

  const msMap = new Map();
  for (const n of nodes) {
    const ms = parseMilestone(n);
    const key = ms.code ?? "(None)";
    if (!msMap.has(key)) msMap.set(key, ms.sortKey ?? 9999);
  }
  const msItems = [...msMap.entries()]
    .sort((a, b) => {
      if (a[0] === "(None)") return -1;
      if (b[0] === "(None)") return 1;
      return a[1] - b[1];
    })
    .map(([v]) => {
      const node = nodes.find((n) => (n.milestone_code ?? "(None)") === v);
      const name = node?.milestone_name ?? null;
      return { value: v, label: v, sublabel: name && name !== v ? name : undefined };
    });
  msMilestone.setItems(msItems, state.milestone);

  msPriority.setItems(
    ["(None)", "P0", "P1", "P2", "P3"].map((v) => ({
      value: v,
      label: v,
      sublabel: PRIORITY_NAMES[v],
    })),
    state.priority,
  );

  const assigneeSet = new Set();
  let hasUnassigned = false;
  for (const n of nodes) {
    const assignees = n.assignees ?? [];
    if (assignees.length === 0) hasUnassigned = true;
    for (const login of assignees) assigneeSet.add(login);
  }
  const assigneeItems = [...assigneeSet].sort().map((v) => ({ value: v, label: v }));
  if (hasUnassigned) assigneeItems.unshift({ value: "(Unassigned)", label: "(Unassigned)" });
  msAssignee.setItems(assigneeItems, state.assignee);

  msStatus.setItems(
    ["ready", "blocked", "done"].map((v) => ({ value: v, label: v })),
    state.status,
  );

  const allLabels = [...new Set(nodes.flatMap((n) => n.labels ?? []))]
    .filter((l) => !isStructuredLabel(l))
    .sort();
  msLabel.setItems(
    allLabels.map((l) => ({ value: l, label: l })),
    state.label,
  );
}

function restoreControls() {
  searchInput.value = state.search;
  searchClear.hidden = !state.search;
  ssPivotRow.setItems(dimItems(PIVOT_DIMS), state.pivotRow);
  ssPivotCol.setItems(dimItems(PIVOT_DIMS), state.pivotCol);
  ssGraphRow.setItems(dimItems(GRAPH_DIMS), state.graphRow);
  ssGraphCol.setItems(dimItems(GRAPH_DIMS), state.graphCol);
  ssTableGroup.setItems(dimItems(TABLE_GROUP_DIMS), state.tableGroup);
  ssListGroup.setItems(dimItems(LIST_DIMS), state.listGroup);
  ssListGroup2.setItems(dimItems(LIST_DIMS), state.listGroup2);
  buildGraphSegs();
}

function graphStatusQuery() {
  const params = new URLSearchParams();
  const statuses = state.status;
  if (statuses?.length && statuses.length < 3) {
    params.set("status", statuses.join(","));
  }
  if (state.showClosedUnderOpenEpic) {
    params.set("closed_under_open_epic", "1");
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function loadGraphData() {
  const resp = await api(`/api/graph${graphStatusQuery()}`);
  return resp.json();
}

// Re-fetch graph data and re-render, preserving view/filters (held in state).
// Uses data.repos (Array<{repo,archived}>) from /api/graph; falls back to nodes-derived if absent.
let sessionZkOptIn = false;
let sessionZkAccountKeyEnabled = false;
let sessionGithubLogin = "";

async function loadAndRender(zkOptIn, githubLogin, zkAccountKeyEnabled = false) {
  const data = await loadGraphData();
  const nodes = data.nodes || [];
  const edges = data.edges || [];
  if (zkOptIn) {
    await applyZkDecryption(nodes, githubLogin, { accountKeyMode: zkAccountKeyEnabled });
  }
  annotateNodes(nodes, edges);
  setState({ nodes, edges });
  state.nodesByKey = new Map(nodes.map((n) => [n.key, n]));
  let repoData;
  if (data.repos?.length) {
    // All tenant repos — not only those with issues in the current status filter.
    repoData = data.repos;
  } else {
    const derived = [...new Set(nodes.map((n) => n.repo))].sort();
    repoData = derived.map((repo) => ({ repo, archived: false }));
  }
  populateFilters(repoData);
  render();
}

// ─── Live refresh: poll /api/version, reload when corpus.db changes ─────────
const POLL_MS = 15000;
let lastVersion = null;

async function fetchVersion() {
  const resp = await api("/api/version");
  return (await resp.json()).version;
}

function startPolling() {
  setInterval(async () => {
    if (document.hidden) return; // skip while tab is backgrounded
    try {
      const v = await fetchVersion();
      if (lastVersion !== null && v !== lastVersion) {
        await loadAndRender(sessionZkOptIn, sessionGithubLogin, sessionZkAccountKeyEnabled);
      }
      lastVersion = v;
    } catch {
      /* transient — retry next tick */
    }
  }, POLL_MS);
}

async function init() {
  stripStaleOAuthCallbackUrl();
  try {
    await consumeZkHandoffFromUrl();
    await consumeZkReauthFromUrl();
    try {
      const meEarly = await getSessionProfile();
      if (await resumeSettingsFromUrl(meEarly)) return;
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
    }

    // SC1: requireAuthGate() gates data fetches until onboarding_step === 'ready'.
    const view = await requireAuthGate();
    if (view !== "ready") return;
  } catch (e) {
    if (e instanceof AuthError) return;
    throw e;
  }
  restoreControls();
  try {
    const { reconcileZkResetPendingAfterReauth } = await import("./zk-reset.js");
    reconcileZkResetPendingAfterReauth();
    const me = await getSessionProfile();
    sessionGithubLogin = me.user?.github_login ?? "";
    if (await resumeSettingsFromUrl(me)) return;
    const zkAccountKeyEnabled = isZkAccountKeyEnabled(me);
    sessionZkAccountKeyEnabled = zkAccountKeyEnabled;

    if (zkAccountKeyEnabled) {
      const zkReady = await requireZkEnrollmentGate(me, sessionGithubLogin);
      if (!zkReady) return;
      sessionZkOptIn = true;
    } else {
      await ensurePrivateMode(sessionGithubLogin);
      sessionZkOptIn = true;
    }

    await ensureSyncStarted();
    const refreshDuringSync = () => {
      loadAndRender(sessionZkOptIn, sessionGithubLogin, sessionZkAccountKeyEnabled).catch((e) => {
        errorMsg.hidden = false;
        errorMsg.textContent = `Failed to refresh graph: ${e.message}`;
      });
    };
    startSyncProgressMonitor({
      onReposAdvanced: refreshDuringSync,
      onPassComplete: refreshDuringSync,
      onSyncComplete: refreshDuringSync,
    });
    await loadAndRender(sessionZkOptIn, sessionGithubLogin, zkAccountKeyEnabled);

    if (zkAccountKeyEnabled) {
      const sealResult = await ensureAccountKeySealing(sessionGithubLogin, state.nodes);
      await applyZkDecryption(state.nodes, sessionGithubLogin, { accountKeyMode: true });
      state.nodesByKey = new Map(state.nodes.map((n) => [n.key, n]));
      render();
      showZkMigrationNotice();
      if (sealResult?.needsGithubLink) showZkGithubLinkNotice();
    }
    if (getGithubUserToken()) {
      try {
        const { synced } = await syncZkContentFromGitHub(state.nodes, sessionGithubLogin);
        if (synced > 0) {
          await applyZkDecryption(state.nodes, sessionGithubLogin);
          state.nodesByKey = new Map(state.nodes.map((n) => [n.key, n]));
          render();
        }
      } catch {
        /* GitHub sync is best-effort */
      }
    }
    try {
      lastVersion = await fetchVersion();
    } catch {
      /* poller will retry */
    }
    startPolling();
  } catch (e) {
    errorMsg.hidden = false;
    errorMsg.textContent = `Failed to load graph: ${e.message}`;
    subtitle.textContent = "Error";
  }
}

// ─── Theme ────────────────────────────────────────────────────────────────
wireThemeMediaListener();
$("theme-btn")?.addEventListener("click", () => toggleThemeQuick());
applyThemePref();

init();
