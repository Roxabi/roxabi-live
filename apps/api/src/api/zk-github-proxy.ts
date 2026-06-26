/**
 * POST /api/zk/github/graphql — session-gated GitHub GraphQL relay (#142 S3).
 *
 * Browser holds the user token; Worker forwards the request without persisting
 * token or response body (plaintext in memory during the request only).
 *
 * Header: X-GitHub-User-Token: <user-to-server token>
 * Body: standard GitHub GraphQL JSON { query, variables? }
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import { userZkOptIn } from "../auth/zk";

const MAX_BODY_BYTES = 32 * 1024;

/**
 * Reject GraphQL documents containing a top-level `mutation`/`subscription`
 * operation. The relay is read-only (issue content fetch); writes must flow
 * through the user's own GitHub session, never the Worker token path. Scans at
 * brace-depth 0 only, after stripping comments and string literals, so field
 * names like `mutation` nested in a selection set do not false-positive.
 */
export function isReadOnlyGraphql(query: string): boolean {
  const cleaned = query.replace(/#[^\n\r]*/g, " ").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  let depth = 0;
  const re = /[{}]|\b(?:query|mutation|subscription)\b/g;
  let m = re.exec(cleaned);
  while (m !== null) {
    const tok = m[0];
    if (tok === "{") depth++;
    else if (tok === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && tok !== "query") return false;
    m = re.exec(cleaned);
  }
  return true;
}

export async function zkGithubGraphqlRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) return c.json({ error: "unauthorized" }, 401);

  if (!(await userZkOptIn(c.env.DB, s.userId))) {
    return c.json({ error: "zk_not_enabled" }, 403);
  }

  const ghToken = c.req.header("X-GitHub-User-Token");
  if (!ghToken || ghToken.length < 10 || ghToken.length > 512) {
    return c.json({ error: "github_user_token required" }, 400);
  }

  const raw = await c.req.text();
  if (!raw || raw.length > MAX_BODY_BYTES) {
    return c.json({ error: "invalid body" }, 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("query" in parsed) ||
    typeof (parsed as { query: unknown }).query !== "string"
  ) {
    return c.json({ error: "query required" }, 400);
  }

  if (!isReadOnlyGraphql((parsed as { query: string }).query)) {
    return c.json({ error: "read_only" }, 400);
  }

  const upstream = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghToken}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "User-Agent": "roxabi-live-zk",
    },
    body: raw,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
    },
  });
}
