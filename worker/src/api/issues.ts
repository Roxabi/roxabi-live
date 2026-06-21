/**
 * GET /api/issues       — list issues with optional filtering + pagination.
 * GET /api/issues/*     — single issue by key (key contains owner/repo#N slash).
 *
 * Ported from src/roxabi_live/api/issues.py. Response shapes are byte-compatible
 * with the Python source. Key note: the issue key contains a slash (owner/repo#N),
 * so a single :key param can't capture it — the wildcard route extracts the key
 * from c.req.path after stripping the /api/issues/ prefix.
 */

import type { Context } from "hono";
import { resolveVisibleRepos } from "../auth/repoAccess";
import type { AuthEnv } from "../auth/types";
import { loadZkSealedIssueKeysForUser, redactIssueTitle } from "../auth/zk";

const ISSUE_KEY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[0-9]+$/;

interface IssueListRow {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  state: string;
  url: string | null;
  milestone: string | null;
  is_stub: number;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
}

interface LabelRow {
  issue_key: string;
  name: string;
}

interface CountRow {
  n: number;
}

interface EdgeJoinRow {
  key: string;
  number: number;
  repo: string;
}

async function sealedKeysForSession(c: Context<AuthEnv>): Promise<Set<string>> {
  const session = c.get("session");
  if (!session) return new Set();
  return loadZkSealedIssueKeysForUser(c.env.DB, session.userId);
}

export const listIssuesRoute = async (c: Context<AuthEnv>) => {
  const sealedKeys = await sealedKeysForSession(c);

  const visible = await resolveVisibleRepos(c);

  const url = new URL(c.req.url);
  const repo = url.searchParams.get("repo");
  const state = url.searchParams.get("state");
  const label = url.searchParams.get("label");

  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const rawLimitParsed =
    rawLimit !== null && !Number.isNaN(Number.parseInt(rawLimit, 10))
      ? Number.parseInt(rawLimit, 10)
      : 100;
  const rawOffsetParsed =
    rawOffset !== null && !Number.isNaN(Number.parseInt(rawOffset, 10))
      ? Number.parseInt(rawOffset, 10)
      : 0;
  // clamp: public endpoint — bound result-set size (Worker 128MB budget) and reject negative offset
  const limit = Math.max(1, Math.min(rawLimitParsed, 500));
  const offset = Math.max(0, rawOffsetParsed);

  if (visible.length === 0) {
    return c.json({ issues: [], total: 0, limit, offset });
  }

  const ph = visible.map(() => "?").join(",");

  const conditions: string[] = [`issues.repo IN (${ph})`];
  const params: (string | number)[] = [...visible];

  if (repo !== null) {
    conditions.push("issues.repo = ?");
    params.push(repo);
  }
  if (state !== null) {
    conditions.push("issues.state = ?");
    params.push(state);
  }
  if (label !== null) {
    conditions.push(
      "EXISTS (SELECT 1 FROM labels l WHERE l.issue_key = issues.key AND l.name = ?)",
    );
    params.push(label);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countSql = `SELECT COUNT(*) AS n FROM issues ${where}`;
  const dataSql = `SELECT issues.key, issues.repo, issues.number, JSON_EXTRACT(issues.payload,'$.title') AS title, issues.state, issues.url, issues.milestone, issues.is_stub, issues.created_at, issues.updated_at, issues.closed_at FROM issues ${where} ORDER BY issues.updated_at ASC LIMIT ? OFFSET ?`;

  // D1 batch for count + data in one round-trip
  const [countResult, dataResult] = await c.env.DB.batch<CountRow | IssueListRow>([
    c.env.DB.prepare(countSql).bind(...params),
    c.env.DB.prepare(dataSql).bind(...params, limit, offset),
  ]);

  const total = (countResult.results[0] as CountRow | undefined)?.n ?? 0;
  const rows = dataResult.results as IssueListRow[];

  // Fetch labels for returned keys in one IN(...) query
  const labelsByKey = new Map<string, string[]>();
  if (rows.length > 0) {
    const keys = rows.map((r) => r.key);
    const placeholders = keys.map(() => "?").join(",");
    const lblResult = await c.env.DB.prepare(
      `SELECT issue_key, name FROM labels WHERE issue_key IN (${placeholders}) ORDER BY name`,
    )
      .bind(...keys)
      .all<LabelRow>();
    for (const lr of lblResult.results) {
      const existing = labelsByKey.get(lr.issue_key);
      if (existing) {
        existing.push(lr.name);
      } else {
        labelsByKey.set(lr.issue_key, [lr.name]);
      }
    }
  }

  const issues = rows.map((row) => ({
    key: row.key,
    repo: row.repo,
    number: row.number,
    title: redactIssueTitle(row.title, row.key, sealedKeys),
    state: row.state,
    url: row.url,
    labels: labelsByKey.get(row.key) ?? [],
    milestone: row.milestone,
    is_stub: Boolean(row.is_stub),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
  }));

  return c.json({ issues, total, limit, offset });
};

export const getIssueRoute = async (c: Context<AuthEnv>) => {
  const sealedKeys = await sealedKeysForSession(c);

  const visible = await resolveVisibleRepos(c);

  // Extract key from path: /api/issues/<owner>/<repo>#<number>
  // The key contains a slash so a single :key param won't match — use wildcard.
  const rawKey = decodeURIComponent(c.req.path.slice("/api/issues/".length));

  if (!ISSUE_KEY_RE.test(rawKey)) {
    return c.json({ detail: "invalid issue key; expected '<owner>/<repo>#<number>'" }, 400);
  }

  if (visible.length === 0) {
    return c.json({ detail: "Issue not found" }, 404);
  }

  const ph = visible.map(() => "?").join(",");

  const issueSql = `SELECT key, repo, number, JSON_EXTRACT(payload,'$.title') AS title, state, url, milestone, is_stub, created_at, updated_at, closed_at FROM issues WHERE key = ? AND repo IN (${ph})`;
  const row = await c.env.DB.prepare(issueSql)
    .bind(rawKey, ...visible)
    .first<IssueListRow>();

  if (!row) {
    return c.json({ detail: "Issue not found" }, 404);
  }

  const labelsResult = await c.env.DB.prepare(
    "SELECT name FROM labels WHERE issue_key = ? ORDER BY name",
  )
    .bind(rawKey)
    .all<{ name: string }>();
  const labels = labelsResult.results.map((r) => r.name);

  // blocking: edges where this issue is src (kind=blocks) → dst issues.
  // blocked_by: edges where this issue is dst (kind=blocks) → src issues.
  // INNER JOIN + `i.repo IN (...)` keeps an edge only when its OTHER endpoint is also
  // visible (the anchor issue is already confirmed visible above). A blocker in a repo
  // the caller can't see is dropped entirely — no key/number disclosure — matching the
  // both-endpoints-visible rule graph.ts enforces.
  const blockingResult = await c.env.DB.prepare(
    `SELECT e.dst_key AS key, i.number, i.repo FROM edges e JOIN issues i ON i.key = e.dst_key AND i.repo IN (${ph}) WHERE e.src_key = ? AND e.kind = 'blocks'`,
  )
    .bind(...visible, rawKey)
    .all<EdgeJoinRow>();

  const blockedByResult = await c.env.DB.prepare(
    `SELECT e.src_key AS key, i.number, i.repo FROM edges e JOIN issues i ON i.key = e.src_key AND i.repo IN (${ph}) WHERE e.dst_key = ? AND e.kind = 'blocks'`,
  )
    .bind(...visible, rawKey)
    .all<EdgeJoinRow>();

  const blocking = blockingResult.results.map((e) => ({
    key: e.key,
    number: e.number,
    repo: e.repo,
  }));
  const blocked_by = blockedByResult.results.map((e) => ({
    key: e.key,
    number: e.number,
    repo: e.repo,
  }));

  return c.json({
    key: row.key,
    repo: row.repo,
    number: row.number,
    title: redactIssueTitle(row.title, row.key, sealedKeys),
    state: row.state,
    url: row.url,
    labels,
    milestone: row.milestone,
    is_stub: Boolean(row.is_stub),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
    blocking,
    blocked_by,
  });
};
