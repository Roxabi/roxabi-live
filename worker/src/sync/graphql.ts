/**
 * GitHub GraphQL transport — fetch()-based port of corpus/graphql.py (#95).
 *
 * Replaces the `gh api graphql` subprocess with a direct fetch() call so the
 * transport runs inside the Cloudflare Worker runtime. The token is an explicit
 * parameter (comes from env.GITHUB_TOKEN) rather than being ambient.
 */

import { SINGLE_ISSUE_DEPS_QUERY } from "./queries";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Raised on HTTP errors, auth failures, or GraphQL-level error responses. */
export class GraphQLError extends Error {
  /** True when the failure is an authentication/authorization error (401/403). */
  public isAuth: boolean;

  constructor(message: string, isAuth = false) {
    super(message);
    this.name = "GraphQLError";
    this.isAuth = isAuth;
  }
}

// ---------------------------------------------------------------------------
// Core transport
// ---------------------------------------------------------------------------

/**
 * Execute a GraphQL query against the GitHub API using fetch().
 *
 * Ports `gh_graphql` from corpus/graphql.py (#95), replacing the subprocess
 * with a direct HTTP call. The `User-Agent` header is required — GitHub rejects
 * requests that omit it (the Python path received it for free from the gh CLI).
 *
 * @param query     GraphQL query string (one of the constants from queries.ts).
 * @param variables Variable map matching the query's parameter declarations.
 * @param token     GitHub PAT (env.GITHUB_TOKEN in Worker context).
 * @returns         Parsed response body; always contains a `data` key on success.
 * @throws          GraphQLError on HTTP errors or GraphQL-level `errors` in body.
 */
export async function ghGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
): Promise<{ data: T } & Record<string, unknown>> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "roxabi-live-worker",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new GraphQLError(
      `GitHub GraphQL auth error: HTTP ${res.status}`,
      true,
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw new GraphQLError(
      `GitHub GraphQL request failed: HTTP ${res.status} — ${text}`,
    );
  }

  const body = (await res.json()) as Record<string, unknown>;

  if ("errors" in body) {
    throw new GraphQLError(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }

  return body as { data: T } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface DepNode {
  number: number;
  repository: { nameWithOwner: string };
}

interface IssueDepsData {
  repository: {
    issue: {
      number: number;
      blockedBy: { nodes: DepNode[] };
      blocking: { nodes: DepNode[] };
    } | null;
  };
}

/**
 * Fetch blockedBy + blocking lists for a single issue via GraphQL.
 *
 * Ports `fetch_issue_deps` from corpus/graphql.py (#95). Returns snake_case
 * keys (`blocked_by` / `blocking`) to match the Python/D1 sync contract.
 *
 * @param owner   Repository owner (org or user login).
 * @param name    Repository name.
 * @param number  Issue number.
 * @param token   GitHub PAT (env.GITHUB_TOKEN in Worker context).
 * @returns       `{ blocked_by, blocking }` — each a list of `"owner/repo#N"` keys.
 */
export async function fetchIssueDeps(
  owner: string,
  name: string,
  number: number,
  token: string,
): Promise<{ blocked_by: string[]; blocking: string[] }> {
  const body = await ghGraphql<IssueDepsData>(
    SINGLE_ISSUE_DEPS_QUERY,
    { owner, name, number },
    token,
  );

  const issue = body.data.repository.issue;
  if (issue === null) {
    return { blocked_by: [], blocking: [] };
  }

  const toKeys = (nodes: DepNode[]): string[] =>
    nodes.map((n) => `${n.repository.nameWithOwner}#${n.number}`);

  return {
    blocked_by: toKeys(issue.blockedBy.nodes),
    blocking: toKeys(issue.blocking.nodes),
  };
}
