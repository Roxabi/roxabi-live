/**
 * brand.ts — TypeScript mirror of brand/tokens/colors.css.
 *
 * SSOT for token *values* is the CSS in `brand/`. This file mirrors the hexes
 * for runtime/build-time TS consumers that can't read CSS custom properties
 * (graph node rendering, email inline styles, OG image generation).
 *
 * Keep in sync with brand/tokens/colors.css — when the CSS tokens change in
 * Claude Design and are re-synced, update these constants too.
 */

/** Surfaces — deep → elevated. */
export const surface = {
  bg: "#0b0e14",
  elevated: "#11161f",
  card: "#151b25",
  cardHover: "#1a2230",
} as const;

/** Borders. */
export const border = {
  base: "#222b38",
  hi: "#313d4e",
} as const;

/** Ink — warm ivory ramp. */
export const ink = {
  text: "#f2efe9",
  muted: "#8b94a3",
  dim: "#5b6473",
} as const;

/** Brand accent — amber. The single brand color (CTAs, links, focus, logo). */
export const accent = {
  base: "#f0b429",
  hover: "#f5c542",
  press: "#d99c10",
} as const;

/** Status vocabulary — kept deliberately distinct from the brand amber. */
export const status = {
  ready: "#34d399",
  blocked: "#fb7185",
  running: "#38bdf8",
  done: "#5b6473",
} as const;

/** Dependency-graph node vocabulary. */
export const graph = {
  node: "#7c75e8",
  nodeHi: "#9a93f2",
  nodeDone: "#454d5e",
  edge: "rgba(139,148,163,.45)",
  edgeDim: "rgba(139,148,163,.18)",
} as const;

/** Type families (CSS font stacks). */
export const fonts = {
  display: '"Inter", system-ui, -apple-system, sans-serif',
  body: '"Inter", system-ui, -apple-system, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
} as const;

export type StatusKey = keyof typeof status;

/** Flat lookup used by the dependency graph: status → fill hex. */
export const statusColor: Record<StatusKey, string> = status;
