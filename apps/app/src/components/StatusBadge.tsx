import { cn } from "@/lib/utils";

export type Status = "ready" | "blocked" | "running" | "done";

interface StatusBadgeProps {
  status: Status;
  className?: string;
}

const statusConfig: Record<Status, { label: string; className: string }> = {
  ready: {
    label: "Ready",
    className: "bg-ready/15 text-ready border-ready/30",
  },
  blocked: {
    label: "Blocked",
    className: "bg-blocked/15 text-blocked border-blocked/30",
  },
  running: {
    label: "Running",
    className: "bg-running/15 text-running border-running/30",
  },
  done: {
    label: "Done",
    className: "bg-done/20 text-done border-done/30",
  },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        config.className,
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {config.label}
    </span>
  );
}
