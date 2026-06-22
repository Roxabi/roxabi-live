/**
 * GraphQL probe — installation/repositories can list repos the bundle query
 * no longer resolves (deleted, renamed, transferred away).
 */

import { ghGraphql } from "./graphql";
import { pickRepoBundleQuery } from "./queries";
import { isInaccessibleRepoError } from "./repo-access-prune";

export function parseRepoSlug(repo: string): { owner: string; name: string } | null {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash >= repo.length - 1) return null;
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

export interface RepoResolvableOptions {
  /** Reserved for callers; bundle probe uses the installation token either way. */
  isPrivate?: boolean;
}

/** True when the installation token can run REPO_BUNDLE_QUERY for the repo. */
export async function isRepoResolvable(
  token: string,
  repo: string,
  _opts?: RepoResolvableOptions,
): Promise<boolean> {
  const slug = parseRepoSlug(repo);
  if (!slug) return false;
  try {
    const body = await ghGraphql<{ repository: { id: string } | null }>(
      pickRepoBundleQuery(true),
      {
        owner: slug.owner,
        name: slug.name,
        issuesCursor: null,
        refsCursor: null,
        prsCursor: null,
        since: null,
      },
      token,
    );
    return body.data.repository != null;
  } catch (err) {
    if (isInaccessibleRepoError(err)) return false;
    throw err;
  }
}

async function isPublicRepoGone(owner: string, name: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "roxabi-live-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(5_000),
  });
  return res.status === 404;
}

export async function filterResolvableRepos<T extends { repo: string; isPrivate?: boolean }>(
  token: string,
  repos: T[],
): Promise<{ kept: T[]; dropped: string[] }> {
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const entry of repos) {
    const slug = parseRepoSlug(entry.repo);
    if (slug && (await isPublicRepoGone(slug.owner, slug.name))) {
      dropped.push(entry.repo);
      continue;
    }
    if (await isRepoResolvable(token, entry.repo, { isPrivate: entry.isPrivate })) {
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
