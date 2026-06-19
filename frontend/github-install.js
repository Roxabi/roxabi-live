// github-install.js — GitHub App installation deep links (mirrors worker/src/auth/github-install.ts)

export const GITHUB_APP_SLUG = 'roxabi-live';

const INSTALL_BASE = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;

/**
 * @param {{ id: number, login: string, type: 'User'|'Organization' }|undefined} target
 */
export function githubInstallUrl(target) {
  const url = new URL(INSTALL_BASE);
  if (target) {
    url.searchParams.set('target_id', String(target.id));
    url.searchParams.set('target_type', target.type);
  }
  return url.toString();
}

/**
 * @param {Array<{ id: number, login: string, type: string }>} targets
 */
export function partitionInstallTargets(targets) {
  const personal = targets.find(t => t.type === 'User') ?? null;
  const orgs = targets.filter(t => t.type === 'Organization');
  return { personal, orgs };
}