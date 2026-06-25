// github.ts — browser-side GitHub user token + GraphQL relay.
// Port of frontend/zk-github.js (#142 S3). The legacy `api()` helper (Response →
// .json()) is replaced by `apiFetch<T>` (parsed JSON, throws ApiError on non-2xx);
// behaviour is preserved: both throw on 401/5xx, GraphQL errors come back 200.

import { ApiError, apiFetch } from "@/lib/api";

const TOKEN_KEY = "roxabi:gh-user-token";
const REAUTH_KEY = "roxabi:zk-reauth-proof";

export function getGithubUserToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setGithubUserToken(token: string | null | undefined): void {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export function getZkReauthProof(): string | null {
  return sessionStorage.getItem(REAUTH_KEY);
}

export function clearZkReauthProof(): void {
  sessionStorage.removeItem(REAUTH_KEY);
}

function stripQueryParam(name: string): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(name)) return;
  params.delete(name);
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", next);
}

/** Consume ?zk_reauth= from URL after OAuth step-up redirect. */
export async function consumeZkReauthFromUrl(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("zk_reauth");
  if (!code) return false;

  try {
    const { reauth_proof } = await apiFetch<{ reauth_proof?: string }>("/api/zk/consume-reauth", {
      method: "POST",
      body: { code },
    });
    if (!reauth_proof) return false;
    sessionStorage.setItem(REAUTH_KEY, reauth_proof);
    stripQueryParam("zk_reauth");
    return true;
  } catch {
    return false;
  }
}

// Default redirect is "/" (not legacy "/dashboard"): the React app's dashboard is
// the index route. The Worker's OAuth handler bounces back here after step-up.
export function zkReauthLoginUrl(redirect = "/"): string {
  const dest = encodeURIComponent(redirect);
  return `/login?reauth=1&redirect=${dest}`;
}

/** Consume ?zk_handoff= from URL after OAuth redirect. */
export async function consumeZkHandoffFromUrl(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("zk_handoff");
  if (!code) return false;

  try {
    const { github_token } = await apiFetch<{ github_token?: string }>("/api/zk/consume-handoff", {
      method: "POST",
      body: { code },
    });
    // The code is single-use server-side; strip it now that the server has
    // acknowledged it (consumed or expired).
    stripQueryParam("zk_handoff");
    setGithubUserToken(github_token);
    return Boolean(github_token);
  } catch (err) {
    // Definitive failure (4xx: bad/expired code) → strip so we don't loop.
    // Transient failure (5xx / network) → leave the code in the URL so the next
    // mount retries; silently dropping the token was the prior failure mode.
    const status = err instanceof ApiError ? err.status : 0;
    if (status >= 400 && status < 500) stripQueryParam("zk_handoff");
    return false;
  }
}

// Default "/" — see zkReauthLoginUrl. The legacy "/dashboard" path no longer exists.
export function zkLoginUrl(redirect = "/"): string {
  const dest = encodeURIComponent(redirect);
  return `/login?zk=1&redirect=${dest}`;
}

// biome-ignore lint/suspicious/noExplicitAny: GraphQL variables are caller-shaped
type GraphqlVariables = Record<string, any> | undefined;

/** Relay GraphQL to GitHub via Worker (CORS-safe). */
export async function githubGraphql(
  query: string,
  variables: GraphqlVariables,
  githubToken?: string,
  // biome-ignore lint/suspicious/noExplicitAny: GraphQL data is query-shaped
): Promise<any> {
  const token = githubToken ?? getGithubUserToken();
  if (!token) throw new Error("github_user_token missing");

  const body = await apiFetch<{
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response is query-shaped
    data?: any;
    errors?: Array<{ message?: string }>;
  }>("/api/zk/github/graphql", {
    method: "POST",
    headers: { "X-GitHub-User-Token": token },
    body: { query, variables },
  });
  if (body.errors) {
    throw new Error(body.errors[0]?.message ?? "graphql error");
  }
  return body.data;
}

interface ParsedIssueKey {
  owner: string;
  name: string;
  number: number;
}

function parseIssueKey(key: string): ParsedIssueKey | null {
  const hash = key.lastIndexOf("#");
  if (hash < 0) return null;
  const repo = key.slice(0, hash);
  const number = Number(key.slice(hash + 1));
  const slash = repo.indexOf("/");
  if (slash < 0 || !Number.isFinite(number)) return null;
  return {
    owner: repo.slice(0, slash),
    name: repo.slice(slash + 1),
    number,
  };
}

export interface IssueContentEntry {
  title: string | null;
  body: string | null;
}

/**
 * Fetch title+body for issue keys (batched aliases, 25 per request).
 */
export async function fetchIssueContentMap(
  issueKeys: string[],
  githubToken?: string,
): Promise<Map<string, IssueContentEntry>> {
  const parsed = issueKeys
    .map((key) => ({ key, ...parseIssueKey(key) }))
    .filter((p): p is { key: string } & ParsedIssueKey => Boolean(p.owner && p.name && p.number));

  const out = new Map<string, IssueContentEntry>();
  const BATCH = 25;

  for (let i = 0; i < parsed.length; i += BATCH) {
    const chunk = parsed.slice(i, i + BATCH);
    const fields = chunk
      .map(
        (p, idx) =>
          `i${idx}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.name)}) {
          issue(number: ${p.number}) { title body }
        }`,
      )
      .join("\n");
    const query = `query { ${fields} }`;
    const data = await githubGraphql(query, undefined, githubToken);
    chunk.forEach((p, idx) => {
      const issue = data?.[`i${idx}`]?.issue;
      if (issue) {
        out.set(p.key, {
          title: issue.title ?? null,
          body: issue.body ?? null,
        });
      }
    });
  }

  return out;
}
