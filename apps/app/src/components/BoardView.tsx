import { DimSelect } from "@/components/DimSelect";
import { FilterBar } from "@/components/FilterBar";
import { GraphPanel } from "@/components/GraphPanel";
import { IssueTable } from "@/components/IssueTable";
import { PivotMatrix } from "@/components/PivotMatrix";
import { ViewToggle } from "@/components/ViewToggle";
import { useFilteredNodes } from "@/hooks/useFilteredNodes";
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

function GraphControls() {
  const graphRow = useDashboardStore((s) => s.graphRow);
  const graphCol = useDashboardStore((s) => s.graphCol);
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
    </div>
  );
}

/**
 * BoardView — the cockpit body shared by the live page and the dev fixture page.
 * Owns the view toggle, pivot controls, filter bar, and the active view.
 */
export function BoardView({ nodes, edges }: { nodes: AnnotatedNode[]; edges: GraphEdge[] }) {
  const view = useDashboardStore((s) => s.view);
  const filtered = useFilteredNodes(nodes, edges);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ViewToggle />
        {view === "pivot" && <PivotControls />}
        {view === "graph" && <GraphControls />}
        <span className="ml-auto text-sm text-muted-foreground">
          {filtered.length} of {nodes.length}
        </span>
      </div>
      <FilterBar nodes={nodes} />
      {view === "list" && <IssueTable nodes={filtered} />}
      {view === "pivot" && <PivotMatrix nodes={filtered} edges={edges} />}
      {view === "graph" && <GraphPanel nodes={filtered} edges={edges} />}
    </div>
  );
}
