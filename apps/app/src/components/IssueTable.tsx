import { IssueRow, type RowEdgeRefs } from "@/components/IssueRow";
import {
  type AnnotatedNode,
  type Dim,
  type GraphEdge,
  type StatusKey,
  compareDimValues,
  dimDisplayLabel,
  dimValue,
  displayStatus,
  isEmptyDimValue,
} from "@roxabi-live/shared";
import { useMemo, useState } from "react";

type SortCol =
  | "status"
  | "issue"
  | "title"
  | "milestone"
  | "priority"
  | "lane"
  | "size"
  | "blocks"
  | "blockedby"
  | "parentof";

/** Launch-board sort: ready first (act on these), then running, blocked, done. */
const STATUS_RANK: Record<StatusKey, number> = { ready: 0, running: 1, blocked: 2, done: 3 };
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

const COLUMNS: { col: SortCol; label: string; center?: boolean }[] = [
  { col: "status", label: "Status" },
  { col: "issue", label: "Issue" },
  { col: "title", label: "Title" },
  { col: "milestone", label: "Milestone" },
  { col: "priority", label: "Priority" },
  { col: "lane", label: "Lane", center: true },
  { col: "size", label: "Size", center: true },
  { col: "blocks", label: "Blocks", center: true },
  { col: "blockedby", label: "Blocked by", center: true },
  { col: "parentof", label: "Parent of", center: true },
];

function issueCompare(a: AnnotatedNode, b: AnnotatedNode): number {
  return a.repo.localeCompare(b.repo) || a.number - b.number;
}

/** Build the per-issue linked-key lists for the blocks/blockedby/parentof columns. */
function buildRefs(edges: GraphEdge[]): Map<string, RowEdgeRefs> {
  const map = new Map<string, RowEdgeRefs>();
  const short = (k: string) => {
    const i = k.lastIndexOf("#");
    return i >= 0 ? k.slice(i) : k;
  };
  const get = (k: string): RowEdgeRefs => {
    let r = map.get(k);
    if (!r) {
      r = { blocks: [], blockedby: [], parentof: [] };
      map.set(k, r);
    }
    return r;
  };
  for (const e of edges) {
    if (e.kind === "blocks") {
      get(e.src).blocks.push(short(e.dst));
      get(e.dst).blockedby.push(short(e.src));
    } else if (e.kind === "parent") {
      get(e.src).parentof.push(short(e.dst));
    }
  }
  return map;
}

function comparator(
  col: SortCol,
  refs: Map<string, RowEdgeRefs>,
): (a: AnnotatedNode, b: AnnotatedNode) => number {
  const count = (key: string, kind: keyof RowEdgeRefs) => refs.get(key)?.[kind].length ?? 0;
  switch (col) {
    case "issue":
      return issueCompare;
    case "title":
      return (a, b) => (a.title ?? "").localeCompare(b.title ?? "") || issueCompare(a, b);
    case "milestone":
      return (a, b) => a.milestone_sort_key - b.milestone_sort_key || issueCompare(a, b);
    case "priority":
      return (a, b) =>
        (PRIORITY_RANK[a.priority ?? ""] ?? 99) - (PRIORITY_RANK[b.priority ?? ""] ?? 99) ||
        issueCompare(a, b);
    case "lane":
      return (a, b) => (a.lane ?? "~").localeCompare(b.lane ?? "~") || issueCompare(a, b);
    case "size":
      return (a, b) => (a.size ?? "~").localeCompare(b.size ?? "~") || issueCompare(a, b);
    case "blocks":
      return (a, b) => count(a.key, "blocks") - count(b.key, "blocks") || issueCompare(a, b);
    case "blockedby":
      return (a, b) => count(a.key, "blockedby") - count(b.key, "blockedby") || issueCompare(a, b);
    case "parentof":
      return (a, b) => count(a.key, "parentof") - count(b.key, "parentof") || issueCompare(a, b);
    default:
      return (a, b) =>
        STATUS_RANK[displayStatus(a)] - STATUS_RANK[displayStatus(b)] || issueCompare(a, b);
  }
}

// ─── Group-by (two-level, collapsible) ──────────────────────────────────────

type ListItem =
  | {
      kind: "header";
      level: 1 | 2;
      collapseKey: string;
      value: string;
      dim: Dim;
      title: string | null;
      count: number;
    }
  | { kind: "row"; node: AnnotatedNode };

/** For a 'parent' group, surface the epic's (truncated) title next to its key. */
function groupTitle(dim: Dim, value: string, all: AnnotatedNode[]): string | null {
  if (dim !== "parent" || isEmptyDimValue(value, dim)) return null;
  const parent = all.find((n) => n.key === value);
  if (!parent?.title) return null;
  return parent.title.length > 50 ? `${parent.title.slice(0, 47)}…` : parent.title;
}

function bucket(nodeList: AnnotatedNode[], dim: Dim): Map<string, AnnotatedNode[]> {
  const groups = new Map<string, AnnotatedNode[]>();
  for (const n of nodeList) {
    const v = dimValue(n, dim);
    const arr = groups.get(v);
    if (arr) arr.push(n);
    else groups.set(v, [n]);
  }
  return groups;
}

function emitGroups(
  items: ListItem[],
  nodeList: AnnotatedNode[],
  dim: Dim,
  level: 1 | 2,
  collapsed: Set<string>,
  all: AnnotatedNode[],
): void {
  const groups = bucket(nodeList, dim);
  const keys = [...groups.keys()].sort((a, b) => compareDimValues(a, b, dim, all));
  for (const v of keys) {
    const gnodes = groups.get(v) as AnnotatedNode[];
    const collapseKey = `${dim}:${v}`;
    items.push({
      kind: "header",
      level,
      collapseKey,
      value: v,
      dim,
      title: groupTitle(dim, v, all),
      count: gnodes.length,
    });
    if (!collapsed.has(collapseKey)) for (const n of gnodes) items.push({ kind: "row", node: n });
  }
}

/** Flatten sorted nodes into header+row render items honouring group/group2 + collapse. */
function buildItems(
  sorted: AnnotatedNode[],
  group: Dim,
  group2: Dim,
  collapsed: Set<string>,
): ListItem[] {
  const items: ListItem[] = [];
  const hasG1 = group !== "none";
  const hasG2 = group2 !== "none" && group2 !== group;

  if (!hasG1 && !hasG2) {
    for (const n of sorted) items.push({ kind: "row", node: n });
    return items;
  }
  if (!hasG1 || !hasG2) {
    emitGroups(items, sorted, hasG1 ? group : group2, 1, collapsed, sorted);
    return items;
  }
  const groups1 = bucket(sorted, group);
  const keys = [...groups1.keys()].sort((a, b) => compareDimValues(a, b, group, sorted));
  for (const v of keys) {
    const gnodes = groups1.get(v) as AnnotatedNode[];
    const collapseKey = `${group}:${v}`;
    items.push({
      kind: "header",
      level: 1,
      collapseKey,
      value: v,
      dim: group,
      title: groupTitle(group, v, sorted),
      count: gnodes.length,
    });
    if (!collapsed.has(collapseKey)) emitGroups(items, gnodes, group2, 2, collapsed, sorted);
  }
  return items;
}

/** Pure, sortable, optionally grouped table of annotated issue nodes. */
export function IssueTable({
  nodes,
  edges = [],
  group = "none",
  group2 = "none",
}: {
  nodes: AnnotatedNode[];
  edges?: GraphEdge[];
  group?: Dim;
  group2?: Dim;
}) {
  const [sortCol, setSortCol] = useState<SortCol>("status");
  const [dir, setDir] = useState<1 | -1>(1);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const refs = useMemo(() => buildRefs(edges), [edges]);

  const sorted = useMemo(() => {
    const cmp = comparator(sortCol, refs);
    return [...nodes].sort((a, b) => cmp(a, b) * dir);
  }, [nodes, sortCol, dir, refs]);

  const items = useMemo(
    () => buildItems(sorted, group, group2, collapsed),
    [sorted, group, group2, collapsed],
  );

  function toggle(col: SortCol) {
    if (col === sortCol) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortCol(col);
      setDir(1);
    }
  }

  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (nodes.length === 0) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
        No issues to show.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border bg-card/40">
            {COLUMNS.map(({ col, label, center }) => (
              <th
                key={col}
                className={`px-3 py-2 text-xs font-medium text-muted-foreground ${center ? "text-center" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => toggle(col)}
                  className="inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground"
                >
                  {label}
                  {sortCol === col && <span aria-hidden>{dir === 1 ? "↑" : "↓"}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) =>
            it.kind === "header" ? (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: same collapseKey can repeat across level-1 parents; index disambiguates
                key={`h${i}`}
                className="border-b border-border bg-card/60"
              >
                <td colSpan={COLUMNS.length} className="p-0">
                  <button
                    type="button"
                    onClick={() => toggleCollapse(it.collapseKey)}
                    aria-expanded={!collapsed.has(it.collapseKey)}
                    className={`flex w-full items-center px-3 py-1.5 text-left text-xs font-medium text-foreground hover:bg-card ${it.level === 2 ? "pl-8" : ""}`}
                  >
                    <span aria-hidden className="mr-1 text-muted-foreground">
                      {collapsed.has(it.collapseKey) ? "▸" : "▾"}
                    </span>
                    {dimDisplayLabel(it.value, it.dim)}
                    {it.title && <span className="ml-2 text-muted-foreground">{it.title}</span>}
                    <span className="ml-2 text-muted-foreground tabular-nums">{it.count}</span>
                  </button>
                </td>
              </tr>
            ) : (
              <IssueRow key={it.node.key} node={it.node} refs={refs.get(it.node.key)} />
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
