// tone.js — stable repo → color mapping
// Consumed as data-tone="<name>" on graph nodes, cards, and filter pills.
// CSS defines --repo-<name> in graph.css; selectors live in graph.css + app.css.

const REPO_TONE_MAP = {
  "Roxabi/lyra": "teal",
  "Roxabi/voiceCLI": "blue",
  "Roxabi/imageCLI": "pink",
  "Roxabi/llmCLI": "plum",
  "Roxabi/roxabi-forge": "orange",
  "Roxabi/roxabi-live": "red",
  "Roxabi/roxabi-plugins": "lime",
  "Roxabi/roxabi-vault": "amber",
  "Roxabi/roxabi-production": "green",
  "Roxabi/roxabi-boilerplate": "gray",
  "Roxabi/projects-meta": "cyan",
};

// Full palette — must match --repo-<name> vars in graph.css and selectors in
// graph.css (.gg-node, .gg-ilabel) + app.css (.ms-pill).
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
];

// Fallback excludes tones already claimed by REPO_TONE_MAP so unlisted repos
// never collide with explicit assignments.  Without this filter, the hash
// can land on a slot already used (e.g. roxabi-cortex → teal == lyra).
const _EXPLICIT_TONES = new Set(Object.values(REPO_TONE_MAP));
const FALLBACK_PALETTE = FULL_PALETTE.filter((t) => !_EXPLICIT_TONES.has(t));

export function repoTone(repo) {
  if (!repo) return "";
  if (REPO_TONE_MAP[repo]) return REPO_TONE_MAP[repo];
  if (FALLBACK_PALETTE.length === 0) return "accent";
  let h = 0;
  for (let i = 0; i < repo.length; i++) h = (h * 31 + repo.charCodeAt(i)) | 0;
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
}
