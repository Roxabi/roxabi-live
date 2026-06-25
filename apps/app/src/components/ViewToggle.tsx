import { cn } from "@/lib/utils";
import { type ViewKey, useDashboardStore } from "@/store/dashboardStore";

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: "list", label: "List" },
  { key: "pivot", label: "Pivot" },
  { key: "graph", label: "Graph" },
];

/** Segmented control: List / Pivot / Graph. */
export function ViewToggle() {
  const view = useDashboardStore((s) => s.view);
  const patch = useDashboardStore((s) => s.patch);

  return (
    <div className="inline-flex rounded-md border border-border p-0.5">
      {VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          data-testid={`view-${v.key}`}
          onClick={() => patch({ view: v.key })}
          className={cn(
            "rounded-[5px] px-3 py-1 text-xs transition-colors",
            view === v.key
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
