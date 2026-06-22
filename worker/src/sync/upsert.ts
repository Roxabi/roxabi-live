/**
 * Issue upsert SQL + statement preparation for the corpus sync engine.
 *
 * Owns the full-sync and structure-only (#216) UPSERT_ISSUE_SQL variants and
 * prepareIssueUpsert (the zk title-redaction branch). Split out of sync.ts
 * (file-length gate).
 */

import { d1PayloadTitle } from "../auth/zk";

/** Verbatim port of sync.py UPSERT_ISSUE_SQL — full sync path (sets status=null). */
export const UPSERT_ISSUE_SQL = `
  INSERT INTO issues
      (key, repo, number, payload, state, url, created_at, updated_at,
       closed_at, milestone, is_stub, lane, priority, size, status,
       has_active_branch, assignees)
  VALUES
      (?, ?, ?, json_object('title', ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
      repo              = excluded.repo,
      number            = excluded.number,
      payload           = excluded.payload,
      state             = excluded.state,
      url               = excluded.url,
      created_at        = excluded.created_at,
      updated_at        = excluded.updated_at,
      closed_at         = excluded.closed_at,
      milestone         = excluded.milestone,
      is_stub           = excluded.is_stub,
      lane              = excluded.lane,
      priority          = excluded.priority,
      size              = excluded.size,
      status            = excluded.status,
      has_active_branch = excluded.has_active_branch,
      assignees         = excluded.assignees
`;

/** Structure-only upsert — empty payload, one fewer bind arg (#216 PR 6). */
export const UPSERT_ISSUE_SQL_STRUCTURE = `
  INSERT INTO issues
      (key, repo, number, payload, state, url, created_at, updated_at,
       closed_at, milestone, is_stub, lane, priority, size, status,
       has_active_branch, assignees)
  VALUES
      (?, ?, ?, json_object(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
      repo              = excluded.repo,
      number            = excluded.number,
      payload           = excluded.payload,
      state             = excluded.state,
      url               = excluded.url,
      created_at        = excluded.created_at,
      updated_at        = excluded.updated_at,
      closed_at         = excluded.closed_at,
      milestone         = excluded.milestone,
      is_stub           = excluded.is_stub,
      lane              = excluded.lane,
      priority          = excluded.priority,
      size              = excluded.size,
      status            = excluded.status,
      has_active_branch = excluded.has_active_branch,
      assignees         = excluded.assignees
`;

function logStructureOnlyTitleSkipped(key: string, repo: string): void {
  console.log(
    JSON.stringify({
      prefix: "[zk]",
      event: "structure_only.title_skipped",
      key,
      repo,
    }),
  );
}

interface IssueUpsertFields {
  key: string;
  repo: string;
  number: number;
  title?: string | null;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  milestone: string | null;
  isStub: number;
  lane: string | null;
  priority: string | null;
  size: string | null;
  assignees?: string[];
}

export function prepareIssueUpsert(
  db: D1Database,
  structureOnly: boolean,
  sealedKeys: ReadonlySet<string>,
  fields: IssueUpsertFields,
): D1PreparedStatement {
  if (structureOnly) {
    logStructureOnlyTitleSkipped(fields.key, fields.repo);
    return db.prepare(UPSERT_ISSUE_SQL_STRUCTURE).bind(
      fields.key,
      fields.repo,
      fields.number,
      fields.state.toLowerCase(),
      fields.url,
      fields.createdAt,
      fields.updatedAt,
      fields.closedAt,
      fields.milestone,
      fields.isStub,
      fields.lane,
      fields.priority,
      fields.size,
      null, // status — managed by Project v2 board
      0, // has_active_branch — set by branch pass
      JSON.stringify(fields.assignees ?? []),
    );
  }

  return db.prepare(UPSERT_ISSUE_SQL).bind(
    fields.key,
    fields.repo,
    fields.number,
    d1PayloadTitle(fields.title, fields.key, sealedKeys),
    fields.state.toLowerCase(),
    fields.url,
    fields.createdAt,
    fields.updatedAt,
    fields.closedAt,
    fields.milestone,
    fields.isStub,
    fields.lane,
    fields.priority,
    fields.size,
    null, // status — managed by Project v2 board
    0, // has_active_branch — set by branch pass
    JSON.stringify(fields.assignees ?? []),
  );
}
