import { StatusBadge } from "@/components/StatusBadge";
import { type AnnotatedNode, displayStatus } from "@roxabi-live/shared";

/** Short keys of the issues linked to this row, per edge kind (for count cells). */
export interface RowEdgeRefs {
  /** Issues this one blocks (kind='blocks', src=this). */
  blocks: string[];
  /** Issues blocking this one (kind='blocks', dst=this). */
  blockedby: string[];
  /** Child issues (kind='parent', src=this). */
  parentof: string[];
}

const EMPTY_REFS: RowEdgeRefs = { blocks: [], blockedby: [], parentof: [] };

/** Centered edge-count cell — blank when zero; count + linked-key tooltip otherwise. */
function CountCell({ refs }: { refs: string[] }) {
  return (
    <td className="whitespace-nowrap px-3 py-2 text-center align-middle text-sm text-muted-foreground">
      {refs.length > 0 ? (
        <span
          title={refs.join(", ")}
          className="inline-block min-w-5 rounded-sm border border-border px-1 text-xs tabular-nums"
        >
          {refs.length}
        </span>
      ) : null}
    </td>
  );
}

/** One issue row in the Launch Board table (10 columns, mirrors frontend/list.js). */
export function IssueRow({ node, refs = EMPTY_REFS }: { node: AnnotatedNode; refs?: RowEdgeRefs }) {
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
            className="font-mono text-[11px] font-bold text-primary hover:underline"
          >
            {ref}
          </a>
        ) : (
          <span className="font-mono text-[11px] font-bold text-primary">{ref}</span>
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
      <td className="whitespace-nowrap px-3 py-2 text-center align-middle text-sm text-muted-foreground">
        {node.lane ?? "—"}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-center align-middle text-sm text-muted-foreground">
        {node.size ?? "—"}
      </td>
      <CountCell refs={refs.blocks} />
      <CountCell refs={refs.blockedby} />
      <CountCell refs={refs.parentof} />
    </tr>
  );
}
