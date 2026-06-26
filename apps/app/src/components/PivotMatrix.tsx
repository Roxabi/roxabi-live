import { IssueCard } from "@/components/IssueCard";
import { useT } from "@/i18n";
import { localizedDimLabel } from "@/i18n/dimLabel";
import { useDashboardStore } from "@/store/dashboardStore";
import {
  type AnnotatedNode,
  type Dim,
  type GraphEdge,
  compareDimValues,
  dimValue,
} from "@roxabi-live/shared";
import { Fragment, useMemo, useState } from "react";

function groupKeyLabel(key: string, dim: Dim): string {
  if (key === "—") return "—";
  if (dim === "parent") return `#${key.split("#")[1] ?? key}`;
  return key;
}

/** Cards for one cell, optionally sub-grouped (lane/parent) with collapsible headers. */
function CellBody({
  nodes,
  tableGroup,
  parentOf,
  showRepo,
}: {
  nodes: AnnotatedNode[];
  tableGroup: Dim;
  parentOf: Map<string, string>;
  showRepo: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const groups = useMemo(() => {
    if (tableGroup === "none") return null;
    const g = new Map<string, AnnotatedNode[]>();
    for (const n of nodes) {
      const key = tableGroup === "lane" ? (n.lane ?? "—") : (parentOf.get(n.key) ?? "—");
      const arr = g.get(key);
      if (arr) arr.push(n);
      else g.set(key, [n]);
    }
    return [...g];
  }, [nodes, tableGroup, parentOf]);

  if (!groups) {
    return (
      <div className="space-y-1">
        {nodes.map((n) => (
          <IssueCard key={n.key} node={n} showRepo={showRepo} />
        ))}
      </div>
    );
  }

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-1.5">
      {groups.map(([key, groupNodes]) => {
        const isCollapsed = collapsed.has(key);
        return (
          <div key={key}>
            <button
              type="button"
              onClick={() => toggle(key)}
              className="flex w-full items-center gap-1 px-1 py-0.5 text-left text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <span aria-hidden>{isCollapsed ? "▸" : "▾"}</span>
              <span className="truncate">{groupKeyLabel(key, tableGroup)}</span>
              <span className="tabular-nums">({groupNodes.length})</span>
            </button>
            {!isCollapsed && (
              <div className="space-y-1">
                {groupNodes.map((n) => (
                  <IssueCard key={n.key} node={n} showRepo={showRepo} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Pivot (matrix) view — rows × cols of issue cards. Ported from frontend/pivot.js. */
export function PivotMatrix({ nodes, edges }: { nodes: AnnotatedNode[]; edges: GraphEdge[] }) {
  const t = useT();
  const pivotRow = useDashboardStore((s) => s.pivotRow);
  const pivotCol = useDashboardStore((s) => s.pivotCol);
  const tableGroup = useDashboardStore((s) => s.tableGroup);

  const { rowVals, colVals, matrix } = useMemo(() => {
    const rv = [...new Set(nodes.map((n) => dimValue(n, pivotRow)))].sort((a, b) =>
      compareDimValues(a, b, pivotRow, nodes),
    );
    const cv = [...new Set(nodes.map((n) => dimValue(n, pivotCol)))].sort((a, b) =>
      compareDimValues(a, b, pivotCol, nodes),
    );
    const m = new Map<string, Map<string, AnnotatedNode[]>>();
    for (const n of nodes) {
      const r = dimValue(n, pivotRow);
      const c = dimValue(n, pivotCol);
      let row = m.get(r);
      if (!row) {
        row = new Map();
        m.set(r, row);
      }
      let cell = row.get(c);
      if (!cell) {
        cell = [];
        row.set(c, cell);
      }
      cell.push(n);
    }
    return { rowVals: rv, colVals: cv, matrix: m };
  }, [nodes, pivotRow, pivotCol]);

  const parentOf = useMemo(() => {
    const p = new Map<string, string>();
    for (const e of edges) {
      if (e.kind === "parent" && !p.has(e.dst)) p.set(e.dst, e.src);
    }
    return p;
  }, [edges]);

  if (!nodes.length) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
        {t("pivot.empty")}
      </div>
    );
  }

  const showRepo = pivotRow !== "repo" && pivotCol !== "repo";
  const gridStyle = {
    gridTemplateColumns: `minmax(120px, 150px) repeat(${colVals.length}, minmax(180px, 1fr))`,
  };

  return (
    <div className="overflow-auto rounded-lg border border-border">
      <div className="grid min-w-max text-xs" style={gridStyle} data-testid="pivot-grid">
        {/* Header row */}
        <div className="sticky left-0 z-10 border-r border-b border-border bg-card/60 p-2" />
        {colVals.map((cv) => (
          <div
            key={cv}
            className="border-b border-border bg-card/40 p-2 font-medium uppercase tracking-wide text-muted-foreground"
          >
            {localizedDimLabel(t, cv, pivotCol)}
          </div>
        ))}

        {/* Data rows */}
        {rowVals.map((rv) => (
          <Fragment key={rv}>
            <div className="sticky left-0 z-10 border-r border-b border-border bg-card/60 p-2 font-medium text-foreground">
              {localizedDimLabel(t, rv, pivotRow)}
            </div>
            {colVals.map((cv) => {
              const cellNodes = matrix.get(rv)?.get(cv) ?? [];
              return (
                <div key={cv} className="border-b border-border p-1.5">
                  {cellNodes.length === 0 ? (
                    <div className="py-2 text-center text-muted-foreground/40">·</div>
                  ) : (
                    <>
                      <div className="mb-1 px-1 text-[10px] tabular-nums text-muted-foreground">
                        {cellNodes.length}
                      </div>
                      <CellBody
                        nodes={cellNodes}
                        tableGroup={tableGroup}
                        parentOf={parentOf}
                        showRepo={showRepo}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
