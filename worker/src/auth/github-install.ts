/**
 * GitHub App installation URL helpers.
 *
 * Installation always completes on github.com — these helpers build deep links
 * that pre-select account/org when possible. Repository scope is chosen on
 * GitHub during install ("Only select repositories").
 */

export const DEFAULT_GITHUB_APP_SLUG = "roxabi-live";

export type InstallTargetType = "User" | "Organization";

export interface InstallTarget {
  id: number;
  login: string;
  type: InstallTargetType;
}

export function resolveGithubAppSlug(slug?: string): string {
  const trimmed = slug?.trim();
  return trimmed ? trimmed : DEFAULT_GITHUB_APP_SLUG;
}

/**
 * Build the GitHub App installation URL.
 * When target is omitted, GitHub shows the account/org picker.
 */
export function githubInstallUrl(target?: InstallTarget, appSlug?: string): string {
  const url = new URL(`https://github.com/apps/${resolveGithubAppSlug(appSlug)}/installations/new`);
  if (target) {
    url.searchParams.set("target_id", String(target.id));
    url.searchParams.set("target_type", target.type);
  }
  return url.toString();
}

/** Parse install_targets_json from users — invalid JSON yields []. */
export function parseInstallTargets(raw: string | null | undefined): InstallTarget[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is InstallTarget =>
        t != null &&
        typeof t === "object" &&
        typeof (t as InstallTarget).id === "number" &&
        typeof (t as InstallTarget).login === "string" &&
        ((t as InstallTarget).type === "User" || (t as InstallTarget).type === "Organization"),
    );
  } catch {
    return [];
  }
}
