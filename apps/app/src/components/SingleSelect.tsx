import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CaretDown } from "@phosphor-icons/react";
import { useState } from "react";

export interface SingleOption {
  value: string;
  label: string;
}

/**
 * SingleSelect — a Popover-backed single-choice dropdown (legacy `.ss-trigger` /
 * `.ss-option`). Replaces the native <select>, whose OS-rendered option popup
 * ignores the dark theme once the trigger is custom-styled (Chromium renders it
 * light). Fully themed: card surface, amber-on-selected, thin scrollbar.
 */
export function SingleSelect({
  label,
  value,
  options,
  onChange,
  ariaLabel,
  triggerClassName,
  contentClassName,
}: {
  label?: string;
  value: string;
  options: SingleOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <span className="inline-flex items-center gap-1.5">
      {label && <span className="font-mono text-[11px] text-muted-foreground">{label}</span>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel ?? label}
            className={cn(
              "inline-flex h-8 min-w-[80px] items-center justify-between gap-1.5 rounded-md border border-border bg-card px-2 font-mono text-[11px] text-foreground transition-colors hover:border-[var(--border-hi)] data-[state=open]:border-primary",
              triggerClassName,
            )}
          >
            <span className="truncate">{current?.label ?? value}</span>
            <CaretDown size={10} weight="bold" className="shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className={cn("w-44 p-1", contentClassName)}>
          <div className="rl-scroll max-h-72 overflow-y-auto overflow-x-hidden">
            {options.map((o) => {
              const on = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  data-testid={`option-${o.value}`}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[11px] transition-colors focus:outline-none focus-visible:bg-[var(--accent-dim)] focus-visible:text-foreground",
                    on
                      ? "bg-[var(--accent-dim)] font-semibold text-primary"
                      : "text-muted-foreground hover:bg-[var(--bg-elevated)] hover:text-foreground",
                  )}
                >
                  <span className="truncate">{o.label}</span>
                  {on && (
                    <span aria-hidden className="shrink-0 text-primary">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
