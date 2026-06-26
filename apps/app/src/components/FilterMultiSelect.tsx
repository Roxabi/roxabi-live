import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { FilterOption } from "@/hooks/useFilterOptions";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { CaretDown } from "@phosphor-icons/react";

interface FilterMultiSelectProps {
  label: string;
  options: FilterOption[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}

/** A Popover-backed multi-select pill: trigger shows the active count, the
 * panel lists options with checkmarks + per-option node counts. */
export function FilterMultiSelect({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: FilterMultiSelectProps) {
  const t = useT();
  const count = selected.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`facet-trigger-${label}`}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors hover:border-primary/60",
            count > 0 ? "border-primary/50 text-foreground" : "border-border text-muted-foreground",
          )}
        >
          {label}
          {count > 0 && (
            <span className="rounded-sm bg-primary/20 px-1 text-[10px] font-medium text-primary">
              {count}
            </span>
          )}
          <CaretDown size={10} weight="bold" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1">
        <div className="rl-scroll max-h-72 overflow-y-auto overflow-x-hidden">
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("filter.multiselect.noOptions")}</div>
          ) : (
            options.map((o) => {
              if (o.kind === "separator") {
                return (
                  <div
                    key={o.value}
                    role="separator"
                    className="pointer-events-none mt-1.5 px-2 py-1 select-none"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                      {o.label}
                    </span>
                  </div>
                );
              }

              const on = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  data-testid={`facet-option-${o.value}`}
                  onClick={() => onToggle(o.value)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-elevated)] focus:outline-none focus-visible:bg-[var(--accent-dim)] focus-visible:text-foreground",
                    on ? "text-foreground" : "text-muted-foreground",
                    o.archived && "opacity-70",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[9px] leading-none",
                        on ? "border-primary bg-primary text-background" : "border-border",
                      )}
                      aria-hidden
                    >
                      {on ? "✓" : ""}
                    </span>
                    <span className="truncate">{o.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 tabular-nums text-muted-foreground">
                    {o.archived && (
                      <span className="font-mono text-[10px] normal-case">
                        {t("filter.repo.archivedSublabel")}
                      </span>
                    )}
                    {o.count}
                  </span>
                </button>
              );
            })
          )}
        </div>
        {count > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="mt-1 w-full rounded-sm px-2 py-1 text-left text-xs text-muted-foreground hover:bg-background hover:text-foreground"
          >
            {t("filter.multiselect.clear", { label: label.toLowerCase() })}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
