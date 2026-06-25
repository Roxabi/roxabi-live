/**
 * test-utils.ts — shared test helpers for Worker vitest suites.
 *
 * FakeD1 primitives live in worker/test/fake-d1.ts (#159) and are re-exported here
 * so existing tests keep importing from "../test-utils".
 */

import type { SessionContext } from "./auth/types";
import type { Env } from "./types";

export type { FakeResult, FakeStmt } from "../test/fake-d1";
export {
  makeFakeStmt,
  makeFakeDb,
  captureDb,
  captureDbWithRows,
  fixedFirstDb,
} from "../test/fake-d1";

import type { FakeResult } from "../test/fake-d1";

// ---------------------------------------------------------------------------
// SQL-dispatch helper
// ---------------------------------------------------------------------------

export function dispatchByTable(sql: string, map: Record<string, FakeResult[]>): FakeResult[] {
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

export const STUB_SESSION: SessionContext = {
  userId: 1,
  tenantId: 1,
  githubId: 1001,
  githubLogin: "octocat",
};

export function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: {
      fetch: async () => new Response("asset", { status: 200 }),
    } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}
