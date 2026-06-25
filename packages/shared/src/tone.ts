/**
 * tone.ts — stable repo → colour mapping, ported from frontend/tone.js +
 * the --repo-* CSS vars in frontend/graph.css. `repoTone` returns the tone name
 * (for a CSS class / data attribute); `toneHex` returns the hex directly, which
 * the React graph uses for inline node/edge colours.
 */

const REPO_TONE_MAP: Record<string, string> = {
  "Roxabi/lyra": "teal",
  "Roxabi/voiceCLI": "blue",
  "Roxabi/imageCLI": "pink",
  "Roxabi/llmCLI": "plum",
  "Roxabi/roxabi-forge": "orange",
  "Roxabi/roxabi-live": "red",
  "Roxabi/roxabi-plugins": "lime",
  "Roxabi/roxabi-vault": "amber",
  "Roxabi/roxabi-production": "green",
  // Indigo (the brand graph-node hue) rather than flat slate — a grey node's
  // glow is invisible on the dark canvas, which read as "no premium change".
  "Roxabi/roxabi-boilerplate": "indigo",
  "Roxabi/projects-meta": "cyan",
};

const FULL_PALETTE = [
  "teal",
  "blue",
  "pink",
  "plum",
  "orange",
  "red",
  "lime",
  "amber",
  "green",
  "gray",
  "cyan",
  "indigo",
  "rose",
  "violet",
  "brown",
  "fuchsia",
  "yellow",
] as const;

/** Hexes mirror the --repo-<name> vars in graph.css; `accent` is the graph node brand violet. */
const TONE_HEX: Record<string, string> = {
  teal: "#06b6d4",
  blue: "#3b82f6",
  pink: "#ec4899",
  plum: "#a855f7",
  orange: "#d97706",
  red: "#ef4444",
  lime: "#84cc16",
  amber: "#f59e0b",
  green: "#22c55e",
  gray: "#94a3b8",
  cyan: "#22d3ee",
  indigo: "#6366f1",
  rose: "#f43f5e",
  violet: "#8b5cf6",
  brown: "#b45309",
  fuchsia: "#d946ef",
  yellow: "#eab308",
  accent: "#7c75e8",
};

const EXPLICIT_TONES = new Set(Object.values(REPO_TONE_MAP));
const FALLBACK_PALETTE = FULL_PALETTE.filter((t) => !EXPLICIT_TONES.has(t));

/** Stable tone name for a repo. Explicit map first, else a hash over the fallback palette. */
export function repoTone(repo: string): string {
  if (!repo) return "accent";
  const explicit = REPO_TONE_MAP[repo];
  if (explicit) return explicit;
  if (FALLBACK_PALETTE.length === 0) return "accent";
  let h = 0;
  for (let i = 0; i < repo.length; i++) h = (h * 31 + repo.charCodeAt(i)) | 0;
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
}

/** Resolved hex for a repo's tone (for inline SVG/node colours). */
export function toneHex(repo: string): string {
  return TONE_HEX[repoTone(repo)] ?? TONE_HEX.accent;
}
