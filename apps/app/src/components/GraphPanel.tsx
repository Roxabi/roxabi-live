import "@/components/graph-anim.css";
import { useHighlightChain } from "@/hooks/useHighlightChain";
import { useT } from "@/i18n";
import { localizedDimLabel } from "@/i18n/dimLabel";
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
  const blocked = status === "blocked";
  // Epics (parent issues) render as a slightly larger rounded square to stand
  // out from leaf issues — matches the legacy `.gg-node.parent` (14px, r:3px).
  const t = useT();
  const isParent = node.isParent;
  const ariaLabel = t("graph.node.title", { number: node.number, title: node.title ?? "" });
  const hover = {
    onMouseEnter: () => onHover(node.key),
    onMouseLeave: () => onHover(null),
    onFocus: () => onHover(node.key),
    onBlur: () => onHover(null),
  };
  const dim = dimmed ? "opacity-20" : "opacity-100";
  const expanded = active;

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
        aria-label={ariaLabel}
        style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
        className={cn("absolute -translate-x-1/2 -translate-y-1/2 transition-opacity", dim, active && "z-30")}
      >
        <span
          className={cn(
            "block",
            isParent ? "size-3.5 rounded-[4px]" : "size-3 rounded-full",
            devStateClasses(node.dev_state, done),
          )}
          style={{
            color: tone,
            // Blocked = hollow + dashed border in the repo tone (legacy
            // `.gg-node.blocked`) — never red. Done = hollow solid; open = filled.
            backgroundColor: done || blocked ? "transparent" : tone,
            border: blocked ? `2px dashed ${tone}` : `1.5px solid ${tone}`,
            // Separator ring vs the panel + a soft tone bloom (legacy
            // `.gg-node` 0 0 8px currentColor) — the premium glow. Done = no glow.
            // Ring uses --bg-elevated so it matches the panel surface it sits on.
            boxShadow: done
              ? "0 0 0 2px var(--bg-elevated)"
              : `0 0 0 2px var(--bg-elevated), 0 0 10px ${tone}`,
            opacity: done ? 0.55 : undefined,
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
        aria-label={ariaLabel}
        style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: "translate(-50%, 10px)" }}
        className={cn(
          "absolute min-w-[46px] rounded-full border border-border bg-card/90 leading-tight transition-[max-width,transform,box-shadow,padding,font-size] duration-150",
          dim,
          expanded
            ? "z-30 max-w-[300px] scale-[1.04] rounded-lg border-primary/50 bg-card px-2.5 py-1.5 text-xs shadow-[0_6px_18px_rgba(0,0,0,0.45)]"
            : "z-10 max-w-[116px] px-1.5 py-0.5 text-[10px] hover:z-30",
        )}
      >
        {expanded ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 font-mono">
              <span className="shrink-0 font-bold text-foreground">#{node.number}</span>
              {node.size && (
                <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                  {node.size}
                </span>
              )}
            </span>
            {node.title && (
              <span className="line-clamp-2 text-[11px] font-medium leading-snug text-foreground">
                {node.title}
              </span>
            )}
            {showAssignees && node.assignees.length > 0 && (
              <span className="font-mono text-[9px] text-muted-foreground opacity-85">
                {node.assignees.join(", ")}
              </span>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-1 overflow-hidden whitespace-nowrap">
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
  const t = useT();

  if (!nodes.length) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
        {t("graph.empty")}
      </div>
    );
  }

  return (
    // pt/pb give a fixed-pixel headroom so the first band never crowds the top
    // edge on short/filtered graphs (the % Y_TOP alone is too small there). The
    // gutter + stage both sit inside this padding, so they shift together. The
    // panel surface is --bg-elevated (legacy `--bg-panel`), not the page bg.
    <div className="flex overflow-hidden rounded-lg border border-border bg-[var(--bg-elevated)] pt-6 pb-3">
      {/* Row-band gutter — each milestone band gets an amber left accent +
          hairline separator (legacy `.gg-msrow` border-left + `.gg-msrow-sep`). */}
      <div
        className="relative w-28 shrink-0 border-r border-border"
        style={{ height: layout.height }}
      >
        {layout.rowInfo
          .filter((r) => r.code)
          .map((r, i) => (
            <div
              key={r.code}
              className={cn(
                "absolute inset-x-0 flex flex-col justify-start border-l-[3px] border-l-primary/80 px-2 pt-1.5",
                i > 0 && "border-t border-t-border",
              )}
              style={{ top: `${r.y}%`, height: `${r.height}%` }}
            >
              <div className="font-mono text-xs font-bold tracking-wide text-primary">
                {localizedDimLabel(t, r.code, graphRow, r.label)}
              </div>
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
        {/* Milestone band separators (legacy `.gg-msrow-sep`) — a faint hairline
            at each band boundary so rows read as distinct lanes. */}
        {layout.rowInfo.map((r, i) =>
          i === 0 ? null : (
            <div
              key={`sep-${r.code}`}
              className="pointer-events-none absolute inset-x-0 h-px bg-border"
              style={{ top: `${r.y}%` }}
              aria-hidden
            />
          ),
        )}
        {/* Column headers */}
        {layout.colInfo.map((c) => (
          <div
            key={c.code}
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] uppercase tracking-wide text-muted-foreground"
            style={{ left: `${c.x}%` }}
          >
            {localizedDimLabel(t, c.code, graphCol, c.label)}
          </div>
        ))}

        {/* SVG edges */}
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <title>{t("graph.edgesTitle")}</title>
          {edges.map((e) => {
            const s = layout.positions.get(e.src);
            const d = layout.positions.get(e.dst);
            if (!s || !d) return null;
            const inChain = chain ? chain.all.has(e.src) && chain.all.has(e.dst) : true;
            const isParent = e.kind === "parent";
            const dstBlocked = byKey.get(e.dst)?.computedStatus === "blocked";
            // Edges follow the source repo tone — never red (legacy `.gg-edge`).
            // A live blocker (blocks → still-blocked node) is cued by opacity, not
            // colour; parent (sub-issue) edges are dashed + faint.
            const stroke = toneHex(byKey.get(e.src)?.repo ?? "");
            const dimmed = chain && !inChain;
            return (
              <path
                key={`${e.src}->${e.dst}:${e.kind}`}
                d={edgePath(s.x, s.y, d.x, d.y)}
                fill="none"
                stroke={stroke}
                strokeWidth={inChain ? 1.4 : 0.8}
                strokeOpacity={dimmed ? 0.07 : isParent ? 0.3 : dstBlocked ? 0.85 : 0.45}
                strokeDasharray={isParent ? "2 2" : undefined}
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
