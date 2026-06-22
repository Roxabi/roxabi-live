/**
 * Lightweight GraphQL probe — installation/repositories can list repos GitHub
 * GraphQL no longer resolves (deleted, renamed, transferred away).
 */

import { ghGraphql } from "./graphql";
import { isInaccessibleRepoError } from "./repo-access-prune";

const REPO_PROBE_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
  }
}`;

export function parseRepoSlug(repo: string): { owner: string; name: string } | null {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash >= repo.length - 1) return null;
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

/** True when the installation token can resolve the repo via GraphQL. */
export async function isRepoResolvable(token: string, repo: string): Promise<boolean> {
  const slug = parseRepoSlug(repo);
  if (!slug) return false;
  try {
    const body = await ghGraphql<{ repository: { id: string } | null }>(
      REPO_PROBE_QUERY,
      slug,
      token,
    );
    return body.data.repository != null;
  } catch (err) {
    if (isInaccessibleRepoError(err)) return false;
    throw err;
  }
}

export async function filterResolvableRepos<T extends { repo: string }>(
  token: string,
  repos: T[],
): Promise<{ kept: T[]; dropped: string[] }> {
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const entry of repos) {
    if (await isRepoResolvable(token, entry.repo)) {
      kept.push(entry);
    } else {
      dropped.push(entry.repo);
    }
  }
  if (dropped.length > 0) {
    console.log(`[sync] dropped ${dropped.length} unresolvable repo(s): ${dropped.join(", ")}`);
  }
  return { kept, dropped };
}
