import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { type ViewKey, useDashboardStore } from "@/store/dashboardStore";
import { type Icon, ListBullets, Table, TreeStructure } from "@phosphor-icons/react";

// Order mirrors the legacy header view-segs (Graph / List / Table). The store
// key `pivot` is the legacy "Table" (pivot-matrix) renderer → catalog key view.table.
const VIEWS: { key: ViewKey; tkey: string; Icon: Icon }[] = [
  { key: "graph", tkey: "graph", Icon: TreeStructure },
  { key: "list", tkey: "list", Icon: ListBullets },
  { key: "pivot", tkey: "table", Icon: Table },
];

/** Segmented view control (Graph / List / Table) — legacy `.view-segs`. */
export function ViewToggle() {
  const t = useT();
  const view = useDashboardStore((s) => s.view);
  const patch = useDashboardStore((s) => s.patch);

  return (
    <div
      role="group"
      aria-label={t("view.groupAriaLabel")}
      className="inline-flex h-9 overflow-hidden rounded-md border border-border bg-card"
    >
      {VIEWS.map(({ key, tkey, Icon }, i) => {
        const on = view === key;
        const label = t(`view.${tkey}`);
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
