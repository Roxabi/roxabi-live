/**
 * test-utils.ts — shared FakeD1 harness for Worker vitest suites.
 *
 * NOT a test file — no `describe`/`it`/`expect`. Imported by *.test.ts files.
 * Sources consolidated from: me.test.ts, session.test.ts, installToken.test.ts
 */

import { vi } from "vitest";
import type { Env } from "./types";
import type { SessionContext } from "./auth/session";

// ---------------------------------------------------------------------------
// Core FakeD1 types
// ---------------------------------------------------------------------------

export type FakeResult = { [k: string]: unknown };

export interface FakeStmt {
  sql: string;
  args: unknown[];
  run: () => Promise<{ meta: { changes: number } }>;
  first: <T = FakeResult>() => Promise<T | null>;
  all: <T = FakeResult>() => Promise<{ results: T[] }>;
}

// ---------------------------------------------------------------------------
// Low-level primitives
// ---------------------------------------------------------------------------

export function makeFakeStmt(
  sql: string,
  args: unknown[],
  rows: FakeResult[],
  changes = 0,
): FakeStmt {
  return {
    sql,
    args,
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
    all: vi.fn().mockResolvedValue({ results: rows }),
  };
}

export function makeFakeDb(
  stmtFactory: (sql: string, args: unknown[]) => FakeStmt,
): D1Database & { _recorded: FakeStmt[] } {
  const recorded: FakeStmt[] = [];

  const db = {
    prepare(sql: string) {
      let directStmt: FakeStmt | null = null;
      const getDirectStmt = (): FakeStmt => {
        if (!directStmt) {
          directStmt = stmtFactory(sql, []);
          recorded.push(directStmt);
        }
        return directStmt;
      };

      return {
        first<T = FakeResult>(): Promise<T | null> {
          return getDirectStmt().first<T>();
        },
        run(): Promise<{ meta: { changes: number } }> {
          return getDirectStmt().run();
        },
        all<T = FakeResult>(): Promise<{ results: T[] }> {
          return getDirectStmt().all<T>();
        },
        bind(...args: unknown[]) {
          const stmt = stmtFactory(sql, args);
          recorded.push(stmt);
          return stmt;
        },
      };
    },
    batch: vi.fn(async (stmts: FakeStmt[]) => {
      await Promise.all(stmts.map((s) => s.run()));
      return stmts.map(() => ({ results: [], meta: { changes: 0 } }));
    }),
    _recorded: recorded,
  } as unknown as D1Database & { _recorded: FakeStmt[] };

  return db;
}

// ---------------------------------------------------------------------------
// Higher-level capture helpers
// ---------------------------------------------------------------------------

/**
 * Returns a FakeD1 that records every prepared statement.
 *
 * Optional `handler` receives (sql, args) and returns rows for that query.
 * When omitted, every query returns empty rows (same as original captureDb()).
 */
export function captureDb(
  handler?: (sql: string, args: unknown[]) => FakeResult[],
): { db: D1Database & { _recorded: FakeStmt[] }; stmts: () => FakeStmt[] } {
  const captured: FakeStmt[] = [];
  const db = makeFakeDb((sql, args) => {
    const rows = handler ? handler(sql, args) : [];
    const stmt = makeFakeStmt(sql, args, rows, 0);
    captured.push(stmt);
    return stmt;
  });
  return { db, stmts: () => captured };
}

/** Every query returns the same fixed rows. */
export function captureDbWithRows(
  rows: FakeResult[],
): { db: D1Database & { _recorded: FakeStmt[] }; stmts: () => FakeStmt[] } {
  const captured: FakeStmt[] = [];
  const db = makeFakeDb((sql, args) => {
    const stmt = makeFakeStmt(sql, args, rows, 0);
    captured.push(stmt);
    return stmt;
  });
  return { db, stmts: () => captured };
}

/**
 * Every query returns the single provided row (or null).
 * Sourced from session.test.ts — useful for single-row lookups (SELECT … LIMIT 1).
 */
export function fixedFirstDb(row: FakeResult | null): D1Database {
  return makeFakeDb((sql, args) =>
    makeFakeStmt(sql, args, row !== null ? [row] : [], 0),
  );
}

// ---------------------------------------------------------------------------
// SQL-dispatch helper
// ---------------------------------------------------------------------------

/**
 * Route a SQL string to a row set by matching table-name keywords.
 *
 * Keys in `map` are matched against `sql.toLowerCase()` via `includes()`.
 * First match wins. Returns `[]` when no key matches.
 *
 * Typical use inside a `captureDb` handler:
 *
 *   const { db } = captureDb((sql) =>
 *     dispatchByTable(sql, {
 *       "tenant_repo_access":          [{ repo_id: 1, tenant_id: 1 }],
 *       "user_repo_permission_cache":  [{ permission: "read" }],
 *       "tenants":                     [{ id: 1, github_org: "Roxabi" }],
 *     }),
 *   );
 *
 * Keys for the two new #148 tables (`tenant_repo_access`, `user_repo_permission_cache`)
 * are deliberately called out in the example above.
 */
export function dispatchByTable(
  sql: string,
  map: Record<string, FakeResult[]>,
): FakeResult[] {
  const lower = sql.toLowerCase();
  for (const [key, rows] of Object.entries(map)) {
    if (lower.includes(key.toLowerCase())) {
      return rows;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Canonical stub session for #148 tests.
 * Values differ from per-file stubs in older tests (alice/7/9/42) — use these
 * for all new Wave-1 / Wave-2 tests unless a specific scenario requires custom values.
 */
export const STUB_SESSION: SessionContext = {
  userId: 1,
  tenantId: 1,
  githubId: 1001,
  githubLogin: "octocat",
};

/**
 * Minimal Env builder — only fields required by most route handlers.
 * Cast via `unknown as Env` so callers do not need to satisfy optional fields.
 */
export function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: {
      fetch: async () => new Response("asset", { status: 200 }),
    } as unknown as Fetcher,
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}
