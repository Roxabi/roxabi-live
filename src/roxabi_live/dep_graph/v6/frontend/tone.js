// tone.js — deterministic repo → tone mapping
// Same hash must be used everywhere a repo gets colored (cards, graph nodes,
// filter pills) so a repo has one stable color across the whole UI.

const REPO_TONE_PALETTE = ['a1', 'a2', 'b', 'c1', 'd', 'e', 'f', 'g', 'h', 'i'];

export function repoTone(repo) {
  if (!repo) return '';
  let h = 0;
  for (let i = 0; i < repo.length; i++) h = (h * 31 + repo.charCodeAt(i)) | 0;
  return REPO_TONE_PALETTE[Math.abs(h) % REPO_TONE_PALETTE.length];
}
