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
import type { Env } from "../types";

const ISSUE_KEY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[0-9]+$/;

/** Parse 'owner/repo#N' → { repo, number }. Returns { repo: key, number: null } on failure. */
function parseKey(key: string): { repo: string; number: number | null } {
  const m = /^(.+)#(\d+)$/.exec(key);
  if (m) {
    return { repo: m[1], number: parseInt(m[2], 10) };
  }
  return { repo: key, number: null };
}

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
  number: number | null;
  repo: string | null;
}

export const listIssuesRoute = async (c: Context<{ Bindings: Env }>) => {
  const url = new URL(c.req.url);
  const repo = url.searchParams.get("repo");
  const state = url.searchParams.get("state");
  const label = url.searchParams.get("label");

  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const limit = rawLimit !== null && !isNaN(parseInt(rawLimit, 10)) ? parseInt(rawLimit, 10) : 100;
  const offset = rawOffset !== null && !isNaN(parseInt(rawOffset, 10)) ? parseInt(rawOffset, 10) : 0;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

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

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const countSql = `SELECT COUNT(*) AS n FROM issues ${where}`;
  const dataSql =
    `SELECT issues.key, issues.repo, issues.number, issues.title,` +
    ` issues.state, issues.url, issues.milestone, issues.is_stub,` +
    ` issues.created_at, issues.updated_at, issues.closed_at` +
    ` FROM issues ${where} ORDER BY issues.updated_at ASC LIMIT ? OFFSET ?`;

  // D1 batch for count + data in one round-trip
  const [countResult, dataResult] = await c.env.DB.batch<CountRow | IssueListRow>([
    c.env.DB.prepare(countSql).bind(...params),
    c.env.DB.prepare(dataSql).bind(...params, limit, offset),
  ]);

  const total = ((countResult.results[0] as CountRow | undefined)?.n) ?? 0;
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
    title: row.title,
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

export const getIssueRoute = async (c: Context<{ Bindings: Env }>) => {
  // Extract key from path: /api/issues/<owner>/<repo>#<number>
  // The key contains a slash so a single :key param won't match — use wildcard.
  const rawKey = decodeURIComponent(c.req.path.slice("/api/issues/".length));

  if (!ISSUE_KEY_RE.test(rawKey)) {
    return c.json(
      { detail: "invalid issue key; expected '<owner>/<repo>#<number>'" },
      400,
    );
  }

  const issueSql =
    "SELECT key, repo, number, title, state, url, milestone, is_stub," +
    " created_at, updated_at, closed_at FROM issues WHERE key = ?";
  const row = await c.env.DB.prepare(issueSql).bind(rawKey).first<IssueListRow>();

  if (!row) {
    return c.json({ detail: "Issue not found" }, 404);
  }

  const labelsResult = await c.env.DB.prepare(
    "SELECT name FROM labels WHERE issue_key = ? ORDER BY name",
  )
    .bind(rawKey)
    .all<{ name: string }>();
  const labels = labelsResult.results.map((r) => r.name);

  // blocking: edges where this issue is src (kind=blocks) → dst issues
  const blockingResult = await c.env.DB.prepare(
    "SELECT e.dst_key AS key, i.number, i.repo" +
      " FROM edges e LEFT JOIN issues i ON i.key = e.dst_key" +
      " WHERE e.src_key = ? AND e.kind = 'blocks'",
  )
    .bind(rawKey)
    .all<EdgeJoinRow>();

  // blocked_by: edges where this issue is dst (kind=blocks) → src issues
  const blockedByResult = await c.env.DB.prepare(
    "SELECT e.src_key AS key, i.number, i.repo" +
      " FROM edges e LEFT JOIN issues i ON i.key = e.src_key" +
      " WHERE e.dst_key = ? AND e.kind = 'blocks'",
  )
    .bind(rawKey)
    .all<EdgeJoinRow>();

  function edgeItem(edgeRow: EdgeJoinRow) {
    if (edgeRow.number === null || edgeRow.repo === null) {
      const parsed = parseKey(edgeRow.key);
      return { key: edgeRow.key, number: parsed.number, repo: parsed.repo };
    }
    return { key: edgeRow.key, number: edgeRow.number, repo: edgeRow.repo };
  }

  const blocking = blockingResult.results.map(edgeItem);
  const blocked_by = blockedByResult.results.map(edgeItem);

  return c.json({
    key: row.key,
    repo: row.repo,
    number: row.number,
    title: row.title,
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
