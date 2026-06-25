import { cn } from "@/lib/utils";
import { type ViewKey, useDashboardStore } from "@/store/dashboardStore";
import { type Icon, ListBullets, Table, TreeStructure } from "@phosphor-icons/react";

// Order + labels mirror the legacy header view-segs (Graph / List / Table).
// The store key `pivot` is the legacy "Table" (pivot-matrix) renderer.
const VIEWS: { key: ViewKey; label: string; Icon: Icon }[] = [
  { key: "graph", label: "Graph", Icon: TreeStructure },
  { key: "list", label: "List", Icon: ListBullets },
  { key: "pivot", label: "Table", Icon: Table },
];

/** Segmented view control (Graph / List / Table) — legacy `.view-segs`. */
export function ViewToggle() {
  const view = useDashboardStore((s) => s.view);
  const patch = useDashboardStore((s) => s.patch);

  return (
    <div
      role="group"
      aria-label="View"
      className="inline-flex h-9 overflow-hidden rounded-md border border-border bg-card"
    >
      {VIEWS.map(({ key, label, Icon }, i) => {
        const on = view === key;
        return (
          <button
            key={key}
            type="button"
            data-testid={`view-${key}`}
            onClick={() => patch({ view: key })}
            aria-pressed={on}
            title={label}
            className={cn(
              "inline-flex h-full items-center gap-1.5 px-3 font-mono text-[11px] tracking-[0.02em] transition-colors",
              i > 0 && "border-l border-border",
              on
                ? "bg-[var(--accent-dim)] font-semibold text-primary"
                : "font-medium text-[var(--text-dim)] hover:bg-[var(--bg-elevated)] hover:text-foreground",
            )}
          >
            <Icon size={13} weight={on ? "fill" : "regular"} aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
