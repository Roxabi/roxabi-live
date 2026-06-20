import { initHover } from "./hover.js";
// list.js — flat-table list renderer with group-by and sort
import { dimValue, filteredNodes, parseMilestone, prioritySortKey, state } from "./state.js";

const PRIORITY_COLOR = { P0: "p0", P1: "p1", P2: "p2", P3: "p3" };
const STATUS_DOT = { open: "dot-open", closed: "dot-closed" };

// ─── Edge helpers ─────────────────────────────────────────────────────────
function edgeFilter(edges, key, dir, kind) {
  // dir='src': edges where src===key; dir='dst': edges where dst===key
  return edges.filter((e) => e.kind === kind && e[dir] === key);
}

function shortKey(k) {
  // "Roxabi/lyra#42" -> "#42"
  const m = k.match(/#(\d+)$/);
  return m ? `#${m[1]}` : k;
}

// ─── Group title helper ───────────────────────────────────────────────────
function groupTitle(dim, gVal, nodes) {
  if (dim === "parent" && gVal && gVal !== "—") {
    // Find parent node to get its title
    const parent = nodes.find((n) => n.key === gVal);
    if (parent) {
      const title = parent.title || "";
      return title.length > 50 ? `${title.slice(0, 47)}…` : title;
    }
  }
  // For other dims, no extra title
  return null;
}

// ─── Sort state ───────────────────────────────────────────────────────────
let sortCol = null; // column id or null (default)
let sortDir = "asc"; // 'asc' | 'desc'

function defaultSort(a, b) {
  const msa = parseMilestone(a).sortKey - parseMilestone(b).sortKey;
  if (msa !== 0) return msa;
  const pa = prioritySortKey(a.priority) - prioritySortKey(b.priority);
  if (pa !== 0) return pa;
  return a.number - b.number;
}

function colSortKey(n, col) {
  switch (col) {
    case "ref":
      return `${n.repo}#${String(n.number).padStart(8, "0")}`;
    case "status":
      return n._status ?? "";
    case "title":
      return (n.title ?? "").toLowerCase();
    case "milestone":
      return String(parseMilestone(n).sortKey).padStart(8, "0");
    case "priority":
      return String(prioritySortKey(n.priority)).padStart(3, "0");
    case "lane":
      return n.lane ?? "~";
    case "size":
      return n.size ?? "~";
    case "blocks":
      return 0; // sorted by count — filled at render time
    case "blockedby":
      return 0;
    case "parentof":
      return 0;
    default:
      return "";
  }
}

function sortNodes(nodes, edges) {
  if (!sortCol) return [...nodes].sort(defaultSort);

  // For edge-count cols we need to compute per-node
  if (["blocks", "blockedby", "parentof"].includes(sortCol)) {
    const counted = nodes.map((n) => {
      let cnt;
      if (sortCol === "blocks") cnt = edgeFilter(edges, n.key, "src", "blocks").length;
      if (sortCol === "blockedby") cnt = edgeFilter(edges, n.key, "dst", "blocks").length;
      if (sortCol === "parentof") cnt = edgeFilter(edges, n.key, "src", "parent").length;
      return { n, cnt };
    });
    counted.sort((a, b) => (sortDir === "asc" ? a.cnt - b.cnt : b.cnt - a.cnt));
    return counted.map((x) => x.n);
  }

  return [...nodes].sort((a, b) => {
    const ka = colSortKey(a, sortCol);
    const kb = colSortKey(b, sortCol);
    const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
    return sortDir === "asc" ? cmp : -cmp;
  });
}

// ─── Group ordering ───────────────────────────────────────────────────────
function groupSortKey(dim, val, nodes) {
  if (dim === "milestone") {
    const n = nodes.find((x) => dimValue(x, "milestone") === val);
    return n ? parseMilestone(n).sortKey : 9999;
  }
  if (dim === "priority") {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3, None: 4, "—": 5 };
    return order[val] ?? 99;
  }
  if (dim === "status") {
    return { ready: 0, blocked: 1, done: 2 }[val] ?? 99;
  }
  return val === "—" ? "￿" : val;
}

// ─── Row builder ──────────────────────────────────────────────────────────
function buildRow(n, edges) {
  const tr = document.createElement("tr");
  tr.className = `issue-row state-${n.state}`;
  tr.dataset.iss = n.key;

  // Hover-chain attrs
  const blockers = edges.filter((e) => e.kind === "blocks" && e.dst === n.key).map((e) => e.src);
  const blocking = edges
    .filter((e) => (e.kind === "blocks" || !e.kind) && e.src === n.key)
    .map((e) => e.dst);
  if (blockers.length) tr.dataset.blockedby = blockers.join(",");
  if (blocking.length) tr.dataset.blocking = blocking.join(",");

  const repoShort = n.repo ? n.repo.split("/")[1] : n.repo;

  // # ref
  const tdRef = document.createElement("td");
  const a = document.createElement("a");
  a.href = n.url || "#";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = "issue-link";
  a.textContent = `${repoShort}#${n.number}`;
  tdRef.appendChild(a);

  // ● state dot + status tooltip
  const tdDot = document.createElement("td");
  tdDot.className = "col-dot";
  const dot = document.createElement("span");
  dot.className = `state-dot ${STATUS_DOT[n.state] || "dot-closed"}`;
  dot.setAttribute("title", `${n.state} · ${n._status ?? ""}`);
  dot.setAttribute("aria-label", `${n.state}, ${n._status ?? ""}`);
  if (n._status === "blocked") dot.classList.add("dot-blocked");
  tdDot.appendChild(dot);

  // Title
  const tdTitle = document.createElement("td");
  tdTitle.className = "col-title";
  const titleSpan = document.createElement("span");
  titleSpan.className = "list-title";
  titleSpan.textContent = n.title || `Issue #${n.number}`;
  titleSpan.setAttribute("title", n.title || "");
  tdTitle.appendChild(titleSpan);

  // Milestone (centered)
  const tdMs = document.createElement("td");
  tdMs.className = "col-center";
  const ms = parseMilestone(n);
  if (ms.code) {
    const badge = document.createElement("span");
    badge.className = "badge badge-ms";
    badge.textContent = ms.code;
    tdMs.appendChild(badge);
  }

  // Priority (centered)
  const tdPri = document.createElement("td");
  tdPri.className = "col-center";
  if (n.priority) {
    const badge = document.createElement("span");
    badge.className = `badge badge-${PRIORITY_COLOR[n.priority] || ""}`;
    badge.textContent = n.priority;
    tdPri.appendChild(badge);
  }

  // Lane (centered)
  const tdLane = document.createElement("td");
  tdLane.className = "col-center";
  tdLane.textContent = n.lane ?? "";

  // Size (centered)
  const tdSize = document.createElement("td");
  tdSize.className = "col-center";
  tdSize.textContent = n.size ?? "";

  // Edge counts helper
  function makeCountCell(edgeList) {
    const td = document.createElement("td");
    td.className = "col-count col-center"; // center edge counts
    if (!edgeList.length) {
      return td;
    } // blank for empty
    const sp = document.createElement("span");
    sp.className = "edge-count";
    sp.textContent = edgeList.length;
    sp.setAttribute(
      "title",
      edgeList.map((e) => shortKey(e.src === n.key ? e.dst : e.src)).join(", "),
    );
    td.appendChild(sp);
    return td;
  }

  const blocksEdges = edgeFilter(edges, n.key, "src", "blocks");
  const blockedByEdges = edgeFilter(edges, n.key, "dst", "blocks");
  const parentOfEdges = edgeFilter(edges, n.key, "src", "parent");

  tr.append(
    tdRef,
    tdDot,
    tdTitle,
    tdMs,
    tdPri,
    tdLane,
    tdSize,
    makeCountCell(blocksEdges),
    makeCountCell(blockedByEdges),
    makeCountCell(parentOfEdges),
  );

  return tr;
}

// ─── Table shell ──────────────────────────────────────────────────────────
const COLS = [
  { id: "ref", label: "#" },
  { id: "status", label: "●" },
  { id: "title", label: "Title" },
  { id: "milestone", label: "Milestone" },
  { id: "priority", label: "Priority" },
  { id: "lane", label: "Lane" },
  { id: "size", label: "Size" },
  { id: "blocks", label: "Blocks" },
  { id: "blockedby", label: "Blocked by" },
  { id: "parentof", label: "Parent of" },
];

function buildThead(onSort) {
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const col of COLS) {
    const th = document.createElement("th");
    th.textContent = col.label;
    th.dataset.col = col.id;
    // Center all columns except ref, status, title
    const centerCols = ["milestone", "priority", "lane", "size", "blocks", "blockedby", "parentof"];
    th.className = `sortable${centerCols.includes(col.id) ? " col-center" : ""}`;
    if (sortCol === col.id) th.classList.add(sortDir === "asc" ? "sort-asc" : "sort-desc");
    th.setAttribute(
      "aria-sort",
      sortCol === col.id ? (sortDir === "asc" ? "ascending" : "descending") : "none",
    );
    th.addEventListener("click", () => onSort(col.id));
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  return thead;
}

// ─── Collapse tracking ────────────────────────────────────────────────────
const collapsed = new Set(); // group values that are folded

// ─── Main renderer ────────────────────────────────────────────────────────
export function renderList(container) {
  const nodes = filteredNodes();
  const edges = state.edges;
  const group = state.listGroup;
  const group2 = state.listGroup2;

  container.innerHTML = "";

  if (!nodes.length) {
    container.textContent = "No issues match the current filter.";
    return;
  }

  const sorted = sortNodes(nodes, edges);

  const table = document.createElement("table");
  table.className = "list-table";

  function rebuild() {
    table.innerHTML = "";
    const onSort = (colId) => {
      if (sortCol === colId) sortDir = sortDir === "asc" ? "desc" : "asc";
      else {
        sortCol = colId;
        sortDir = "asc";
      }
      rebuild();
    };
    table.appendChild(buildThead(onSort));

    const tbody = document.createElement("tbody");
    const reSorted = sortNodes(nodes, edges);

    if ((!group || group === "none") && (!group2 || group2 === "none")) {
      // No grouping
      for (const n of reSorted) tbody.appendChild(buildRow(n, edges));
    } else if (!group2 || group2 === "none" || group2 === group) {
      // Single-level grouping
      renderGroups(tbody, reSorted, edges, group, 1);
    } else {
      // Two-level grouping
      const groups1 = new Map();
      for (const n of reSorted) {
        const gv = dimValue(n, group);
        if (!groups1.has(gv)) groups1.set(gv, []);
        groups1.get(gv).push(n);
      }

      const gKeys = [...groups1.keys()].sort((a, b) => {
        const ka = groupSortKey(group, a, nodes);
        const kb = groupSortKey(group, b, nodes);
        if (typeof ka === "number" && typeof kb === "number") return ka - kb;
        return String(ka).localeCompare(String(kb));
      });

      for (const gVal of gKeys) {
        const groupNodes = groups1.get(gVal);
        const collapseKey = `${group}:${gVal}`;
        const isCollapsed = collapsed.has(collapseKey);

        // Level-1 header
        const hdr = document.createElement("tr");
        hdr.className = "group-hdr level-1";
        const hdrTd = document.createElement("td");
        hdrTd.colSpan = COLS.length;
        const caret = document.createElement("span");
        caret.className = "group-caret";
        caret.textContent = isCollapsed ? "▸" : "▾";
        caret.setAttribute("aria-hidden", "true");
        const gTitle = groupTitle(group, gVal, nodes);
        const titleSpan = gTitle
          ? Object.assign(document.createElement("span"), {
              className: "group-title",
              textContent: gTitle,
            })
          : null;
        hdrTd.append(
          caret,
          ` ${gVal} `,
          titleSpan || "",
          "  ",
          Object.assign(document.createElement("span"), {
            className: "group-count",
            textContent: `${groupNodes.length}`,
          }),
        );
        hdr.appendChild(hdrTd);
        hdr.addEventListener("click", () => {
          if (collapsed.has(collapseKey)) collapsed.delete(collapseKey);
          else collapsed.add(collapseKey);
          rebuild();
        });
        tbody.appendChild(hdr);

        if (!isCollapsed) {
          // Level-2 groups within this level-1 group
          renderGroups(tbody, groupNodes, edges, group2, 2);
        }
      }
    }

    table.appendChild(tbody);
  }

  // Helper: render single-level groups at a given nesting level
  function renderGroups(tbody, nodeList, edges, dim, level) {
    if (!dim || dim === "none") {
      for (const n of nodeList) tbody.appendChild(buildRow(n, edges));
      return;
    }

    const groups = new Map();
    for (const n of nodeList) {
      const gv = dimValue(n, dim);
      if (!groups.has(gv)) groups.set(gv, []);
      groups.get(gv).push(n);
    }

    const gKeys = [...groups.keys()].sort((a, b) => {
      const ka = groupSortKey(dim, a, nodes);
      const kb = groupSortKey(dim, b, nodes);
      if (typeof ka === "number" && typeof kb === "number") return ka - kb;
      return String(ka).localeCompare(String(kb));
    });

    for (const gVal of gKeys) {
      const groupNodes = groups.get(gVal);
      const collapseKey = `${dim}:${gVal}`;
      const isCollapsed = collapsed.has(collapseKey);

      const hdr = document.createElement("tr");
      hdr.className = `group-hdr level-${level}`;
      const hdrTd = document.createElement("td");
      hdrTd.colSpan = COLS.length;
      const caret = document.createElement("span");
      caret.className = "group-caret";
      caret.textContent = isCollapsed ? "▸" : "▾";
      caret.setAttribute("aria-hidden", "true");
      const gTitle = groupTitle(dim, gVal, nodeList);
      const titleSpan = gTitle
        ? Object.assign(document.createElement("span"), {
            className: "group-title",
            textContent: gTitle,
          })
        : null;
      hdrTd.append(
        caret,
        ` ${gVal} `,
        titleSpan || "",
        "  ",
        Object.assign(document.createElement("span"), {
          className: "group-count",
          textContent: `${groupNodes.length}`,
        }),
      );
      hdr.appendChild(hdrTd);
      hdr.addEventListener("click", () => {
        if (collapsed.has(collapseKey)) collapsed.delete(collapseKey);
        else collapsed.add(collapseKey);
        rebuild();
      });
      tbody.appendChild(hdr);

      if (!isCollapsed) {
        for (const n of groupNodes) tbody.appendChild(buildRow(n, edges));
      }
    }
  }

  rebuild();
  container.appendChild(table);

  // Wire hover-chain highlighting
  initHover(container, "list");
}
