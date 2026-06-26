/**
 * fake-d1.ts — shared FakeD1 harness for Worker vitest suites (#159).
 *
 * Lives outside src/ (not shipped). Import via test-utils.ts or directly in tests.
 */

import { vi } from "vitest";

export type FakeResult = { [k: string]: unknown };

export interface FakeStmt {
  sql: string;
  args: unknown[];
  run: () => Promise<{ meta: { changes: number } }>;
  first: <T = FakeResult>() => Promise<T | null>;
  all: <T = FakeResult>() => Promise<{ results: T[] }>;
}

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

export function fixedFirstDb(row: FakeResult | null): D1Database {
  return makeFakeDb((sql, args) =>
    makeFakeStmt(sql, args, row !== null ? [row] : [], 0),
  );
}