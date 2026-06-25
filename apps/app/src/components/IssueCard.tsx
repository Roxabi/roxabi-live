import { cn } from "@/lib/utils";
import { type AnnotatedNode, type StatusKey, displayStatus } from "@roxabi-live/shared";

// Literal class maps — Tailwind v4 only extracts class strings it can see.
const STATUS_BORDER: Record<StatusKey, string> = {
  ready: "border-l-ready",
  running: "border-l-running",
  blocked: "border-l-blocked",
  done: "border-l-done",
};
const STATUS_DOT: Record<StatusKey, string> = {
  ready: "bg-ready",
  running: "bg-running",
  blocked: "bg-blocked",
  done: "bg-done",
};

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-sm border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

/** Compact issue card used inside pivot cells. */
export function IssueCard({ node, showRepo = true }: { node: AnnotatedNode; showRepo?: boolean }) {
  const status = displayStatus(node);
  return (
    <a
      href={node.url ?? "#"}
      target={node.url ? "_blank" : undefined}
      rel="noreferrer"
      className={cn(
        "block rounded-md border border-l-2 border-border bg-background/60 px-2 py-1.5 text-xs transition-colors hover:border-primary/50",
        STATUS_BORDER[status],
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} aria-hidden />
        <span className="font-mono text-[10px] text-muted-foreground">#{node.number}</span>
        <span className="truncate text-foreground">{node.title ?? `Issue #${node.number}`}</span>
      </div>
      {(showRepo || node.priority || node.size) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {showRepo && <Badge>{node.repo.split("/")[1] ?? node.repo}</Badge>}
          {node.priority && <Badge>{node.priority}</Badge>}
          {node.size && <Badge>{node.size}</Badge>}
        </div>
      )}
    </a>
  );
}
