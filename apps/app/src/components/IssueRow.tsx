import { StatusBadge } from "@/components/StatusBadge";
import { type AnnotatedNode, displayStatus } from "@roxabi-live/shared";

/** One issue row in the flat Launch Board table. */
export function IssueRow({ node }: { node: AnnotatedNode }) {
  const status = displayStatus(node);
  const ref = `${node.repo}#${node.number}`;

  return (
    <tr className="border-b border-border/60 last:border-b-0 hover:bg-card/50">
      <td className="px-3 py-2 align-middle">
        <StatusBadge status={status} />
      </td>
      <td className="whitespace-nowrap px-3 py-2 align-middle">
        {node.url ? (
          <a
            href={node.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-muted-foreground transition-colors hover:text-primary"
          >
            {ref}
          </a>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">{ref}</span>
        )}
      </td>
      <td className="px-3 py-2 align-middle text-sm text-foreground">
        {node.title ? node.title : <span className="italic text-muted-foreground">untitled</span>}
        {node.is_stub && (
          <span className="ml-2 rounded-sm border border-border px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            stub
          </span>
        )}
        {node.isParent && (
          <span className="ml-2 rounded-sm border border-border px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            epic
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 align-middle text-sm text-muted-foreground">
        {node.milestone_code ?? "—"}
      </td>
      <td className="whitespace-nowrap px-3 py-2 align-middle text-sm text-muted-foreground">
        {node.priority ?? "—"}
      </td>
    </tr>
  );
}
