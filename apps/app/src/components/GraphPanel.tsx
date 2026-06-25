import "@/components/graph-anim.css";
import { useHighlightChain } from "@/hooks/useHighlightChain";
import { cn } from "@/lib/utils";
import { useDashboardStore } from "@/store/dashboardStore";
import {
  type AnnotatedNode,
  type DevState,
  type GraphEdge,
  type NodePos,
  displayStatus,
  edgePath,
  layoutV5,
  statusColor,
  toneHex,
} from "@roxabi-live/shared";
import { useMemo, useState } from "react";

/** Dev-state → animation classes (mirrors frontend/state.js mapDevStateToClass). */
function devStateClasses(dev: DevState, done: boolean): string {
  if (done) return "rl-gg-dot";
  if (dev === "pr_reviewed") return "rl-gg-dot pulse orbit-2";
  if (dev === "pr_open") return "rl-gg-dot pulse orbit-1";
  if (dev === "dev") return "rl-gg-dot pulse";
  return "rl-gg-dot";
}

function GraphNode({
  node,
  pos,
  dimmed,
  active,
  showAssignees,
  onHover,
}: {
  node: AnnotatedNode;
  pos: NodePos;
  dimmed: boolean;
  active: boolean;
  showAssignees: boolean;
  onHover: (key: string | null) => void;
}) {
  const tone = toneHex(node.repo);
  const status = displayStatus(node);
  const done = node.computedStatus === "done";
  const title = `#${node.number} — ${node.title ?? ""}`;
  const hover = {
    onMouseEnter: () => onHover(node.key),
    onMouseLeave: () => onHover(null),
    onFocus: () => onHover(node.key),
    onBlur: () => onHover(null),
  };
  const dim = dimmed ? "opacity-20" : "opacity-100";

  // Dot and label are SEPARATE absolutely-positioned elements (matches the
  // legacy gg-node + gg-ilabel): the dot sits ON the node point, the label hangs
  // BELOW it. Rendering them inline made each node ~100px wide → dense bands
  // overlapped into illegibility. The label truncates and expands on hover.
  return (
    <>
      <a
        href={node.url ?? "#"}
        target={node.url ? "_blank" : undefined}
        rel="noreferrer"
        data-iss={node.key}
        {...hover}
        title={title}
        style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
        className={cn("absolute -translate-x-1/2 -translate-y-1/2 transition-opacity", dim, active && "z-30")}
      >
        <span
          className={cn("block size-2.5 rounded-full", devStateClasses(node.dev_state, done))}
          style={{
            color: tone,
            backgroundColor: done ? "transparent" : tone,
            border: `1.5px solid ${tone}`,
            boxShadow:
              status === "blocked" ? `0 0 0 1.5px ${statusColor.blocked}` : "0 0 0 2px var(--bg)",
          }}
          aria-hidden
        >
          {node.dev_state === "pr_reviewed" && !done && (
            <span className="rl-gg-orbit2" aria-hidden />
          )}
        </span>
      </a>
      <a
        href={node.url ?? "#"}
        target={node.url ? "_blank" : undefined}
        rel="noreferrer"
        data-iss={node.key}
        {...hover}
        title={title}
        style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: "translate(-50%, 10px)" }}
        className={cn(
          "absolute flex items-center gap-1 overflow-hidden whitespace-nowrap rounded border border-border bg-card/90 px-1.5 py-0.5 text-[10px] leading-tight transition-[max-width,opacity]",
          dim,
          active ? "z-30 max-w-[280px]" : "z-10 max-w-[116px] hover:z-30 hover:max-w-[280px]",
        )}
      >
        <span className="shrink-0 font-mono text-muted-foreground">#{node.number}</span>
        {node.size && (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{node.size}</span>
        )}
        {node.title && <span className="min-w-0 truncate text-foreground">{node.title}</span>}
        {showAssignees && node.assignees.length > 0 && (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground opacity-85">
            {node.assignees.join(", ")}
          </span>
        )}
      </a>
    </>
  );
}

/** Dependency-graph view (SVG edges + positioned nodes). Ported from frontend/graph.js. */
export function GraphPanel({ nodes, edges }: { nodes: AnnotatedNode[]; edges: GraphEdge[] }) {
  const graphRow = useDashboardStore((s) => s.graphRow);
  const graphCol = useDashboardStore((s) => s.graphCol);
  const showAssignees = useDashboardStore((s) => s.showAssignees);
  const [hovered, setHovered] = useState<string | null>(null);

  const layout = useMemo(
    () => layoutV5(nodes, edges, graphRow, graphCol),
    [nodes, edges, graphRow, graphCol],
  );
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);
  const chain = useHighlightChain(hovered, edges);

  if (!nodes.length) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
        No issues match the current filter.
      </div>
    );
  }

  return (
    <div className="flex overflow-hidden rounded-lg border border-border bg-background/40">
      {/* Row-band gutter */}
      <div
        className="relative w-28 shrink-0 border-r border-border"
        style={{ height: layout.height }}
      >
        {layout.rowInfo
          .filter((r) => r.code)
          .map((r) => (
            <div
              key={r.code}
              className="absolute inset-x-0 flex flex-col justify-start px-2 pt-1"
              style={{ top: `${r.y}%`, height: `${r.height}%` }}
            >
              <div className="text-xs font-medium text-foreground">{r.label}</div>
              {r.name && <div className="truncate text-[10px] text-muted-foreground">{r.name}</div>}
            </div>
          ))}
      </div>

      {/* Node stage */}
      <div
        className="relative min-w-0 flex-1"
        style={{ height: layout.height }}
        data-testid="graph-stage"
      >
        {/* Column headers */}
        {layout.colInfo.map((c) => (
          <div
            key={c.code}
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] uppercase tracking-wide text-muted-foreground"
            style={{ left: `${c.x}%` }}
          >
            {c.label}
          </div>
        ))}

        {/* SVG edges */}
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <title>Dependency edges</title>
          {edges.map((e) => {
            const s = layout.positions.get(e.src);
            const d = layout.positions.get(e.dst);
            if (!s || !d) return null;
            const inChain = chain ? chain.all.has(e.src) && chain.all.has(e.dst) : true;
            const blocked = byKey.get(e.dst)?.computedStatus === "blocked";
            const stroke = blocked ? statusColor.blocked : toneHex(byKey.get(e.src)?.repo ?? "");
            return (
              <path
                key={`${e.src}->${e.dst}:${e.kind}`}
                d={edgePath(s.x, s.y, d.x, d.y)}
                fill="none"
                stroke={stroke}
                strokeWidth={inChain ? 1.4 : 0.8}
                strokeOpacity={chain && !inChain ? 0.07 : blocked ? 0.7 : 0.32}
                strokeDasharray={e.kind === "parent" ? "2 2" : undefined}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        {/* Nodes */}
        {[...layout.positions].map(([key, pos]) => {
          const node = byKey.get(key);
          if (!node) return null;
          return (
            <GraphNode
              key={key}
              node={node}
              pos={pos}
              dimmed={chain ? !chain.all.has(key) : false}
              active={hovered === key}
              showAssignees={showAssignees}
              onHover={setHovered}
            />
          );
        })}
      </div>
    </div>
  );
}
