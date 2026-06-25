import { IssueRow } from "@/components/IssueRow";
import { type AnnotatedNode, type StatusKey, displayStatus } from "@roxabi-live/shared";
import { useMemo, useState } from "react";

type SortCol = "status" | "issue" | "title" | "milestone" | "priority";

/** Launch-board sort: ready first (act on these), then running, blocked, done. */
const STATUS_RANK: Record<StatusKey, number> = { ready: 0, running: 1, blocked: 2, done: 3 };
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function issueCompare(a: AnnotatedNode, b: AnnotatedNode): number {
  return a.repo.localeCompare(b.repo) || a.number - b.number;
}

function comparator(col: SortCol): (a: AnnotatedNode, b: AnnotatedNode) => number {
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
    default:
      return (a, b) =>
        STATUS_RANK[displayStatus(a)] - STATUS_RANK[displayStatus(b)] || issueCompare(a, b);
  }
}

const COLUMNS: { col: SortCol; label: string }[] = [
  { col: "status", label: "Status" },
  { col: "issue", label: "Issue" },
  { col: "title", label: "Title" },
  { col: "milestone", label: "Milestone" },
  { col: "priority", label: "Priority" },
];

/** Pure, flat, sortable table of annotated issue nodes. */
export function IssueTable({ nodes }: { nodes: AnnotatedNode[] }) {
  const [sortCol, setSortCol] = useState<SortCol>("status");
  const [dir, setDir] = useState<1 | -1>(1);

  const sorted = useMemo(() => {
    const cmp = comparator(sortCol);
    return [...nodes].sort((a, b) => cmp(a, b) * dir);
  }, [nodes, sortCol, dir]);

  function toggle(col: SortCol) {
    if (col === sortCol) {
      setDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortCol(col);
      setDir(1);
    }
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
            {COLUMNS.map(({ col, label }) => (
              <th key={col} className="px-3 py-2 text-xs font-medium text-muted-foreground">
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
          {sorted.map((node) => (
            <IssueRow key={node.key} node={node} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
