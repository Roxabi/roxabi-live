import { DimSelect } from "@/components/DimSelect";
import { FilterBar } from "@/components/FilterBar";
import { GraphPanel } from "@/components/GraphPanel";
import { IssueTable } from "@/components/IssueTable";
import { PivotMatrix } from "@/components/PivotMatrix";
import { useFilteredNodes } from "@/hooks/useFilteredNodes";
import { cn } from "@/lib/utils";
import { useDashboardStore } from "@/store/dashboardStore";
import type { AnnotatedNode, GraphEdge } from "@roxabi-live/shared";

function PivotControls() {
  const pivotRow = useDashboardStore((s) => s.pivotRow);
  const pivotCol = useDashboardStore((s) => s.pivotCol);
  const tableGroup = useDashboardStore((s) => s.tableGroup);
  const patch = useDashboardStore((s) => s.patch);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <DimSelect
        label="Rows"
        value={pivotRow}
        onChange={(v) => patch({ pivotRow: v })}
        allowNone={false}
      />
      <DimSelect
        label="Cols"
        value={pivotCol}
        onChange={(v) => patch({ pivotCol: v })}
        allowNone={false}
      />
      <DimSelect label="Group" value={tableGroup} onChange={(v) => patch({ tableGroup: v })} />
    </div>
  );
}

function ToggleSeg({
  label,
  pressed,
  title,
  testid,
  onClick,
}: {
  label: string;
  pressed: boolean;
  title: string;
  testid: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      aria-pressed={pressed}
      title={title}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors hover:border-primary/60",
        pressed ? "border-primary/50 text-foreground" : "border-border text-muted-foreground",
      )}
    >
      {label}
    </button>
  );
}

function GraphControls() {
  const graphRow = useDashboardStore((s) => s.graphRow);
  const graphCol = useDashboardStore((s) => s.graphCol);
  const showClosedUnderOpenEpic = useDashboardStore((s) => s.showClosedUnderOpenEpic);
  const showAssignees = useDashboardStore((s) => s.showAssignees);
  const patch = useDashboardStore((s) => s.patch);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <DimSelect
        label="Rows"
        value={graphRow}
        onChange={(v) => patch({ graphRow: v })}
        allowNone={false}
      />
      <DimSelect label="Order by" value={graphCol} onChange={(v) => patch({ graphCol: v })} />
      <ToggleSeg
        label="Closed"
        testid="graph-closed-toggle"
        title="Show closed issues whose parent epic is still open"
        pressed={showClosedUnderOpenEpic}
        onClick={() => patch({ showClosedUnderOpenEpic: !showClosedUnderOpenEpic })}
      />
      <ToggleSeg
        label="Assignees"
        testid="graph-assignees-toggle"
        title="Show assignee logins on issue nodes"
        pressed={showAssignees}
        onClick={() => patch({ showAssignees: !showAssignees })}
      />
    </div>
  );
}

function ListControls() {
  const listGroup = useDashboardStore((s) => s.listGroup);
  const listGroup2 = useDashboardStore((s) => s.listGroup2);
  const patch = useDashboardStore((s) => s.patch);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <DimSelect label="Group" value={listGroup} onChange={(v) => patch({ listGroup: v })} />
      <DimSelect label="Subgroup" value={listGroup2} onChange={(v) => patch({ listGroup2: v })} />
    </div>
  );
}

/**
 * BoardView — the cockpit body shared by the live page and the dev fixture page.
 * Owns the view toggle, pivot controls, filter bar, and the active view.
 */
export function BoardView({ nodes, edges }: { nodes: AnnotatedNode[]; edges: GraphEdge[] }) {
  const view = useDashboardStore((s) => s.view);
  const listGroup = useDashboardStore((s) => s.listGroup);
  const listGroup2 = useDashboardStore((s) => s.listGroup2);
  const filtered = useFilteredNodes(nodes, edges);

  return (
    <div className="space-y-3">
      {/* Filters row (legacy .toolbar-filters) */}
      <FilterBar nodes={nodes} />
      {/* Layout row (legacy .toolbar-layout): per-view controls + filtered count */}
      <div className="flex flex-wrap items-center gap-3">
        {view === "list" && <ListControls />}
        {view === "pivot" && <PivotControls />}
        {view === "graph" && <GraphControls />}
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {filtered.length} of {nodes.length}
        </span>
      </div>
      {view === "list" && (
        <IssueTable nodes={filtered} edges={edges} group={listGroup} group2={listGroup2} />
      )}
      {view === "pivot" && <PivotMatrix nodes={filtered} edges={edges} />}
      {view === "graph" && <GraphPanel nodes={filtered} edges={edges} />}
    </div>
  );
}
