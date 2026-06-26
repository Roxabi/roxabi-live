import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

export type Status = "ready" | "blocked" | "running" | "done";

interface StatusBadgeProps {
  status: Status;
  className?: string;
}

const statusClass: Record<Status, string> = {
  ready: "bg-ready/15 text-ready border-ready/30",
  blocked: "bg-blocked/15 text-blocked border-blocked/30",
  running: "bg-running/15 text-running border-running/30",
  done: "bg-done/20 text-done border-done/30",
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        statusClass[status],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {t(`status.${status}`)}
    </span>
  );
}
