import { makeFakeDb, makeFakeStmt } from "../test-utils";
import type { Env } from "../types";

export function makeRunSyncEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    ...overrides,
  } as unknown as Env;
}

export function emptyBundleGraphqlData(remaining = 4999) {
  return {
    repository: {
      issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    },
    rateLimit: { cost: 1, remaining, resetAt: "2026-01-01T00:00:00Z" },
  };
}

export function makeFullSyncDb(
  opts: {
    issueRepos?: string[];
    edgeSrcRepos?: string[];
    edgeDstRepos?: string[];
    prStateRepos?: string[];
    syncStateRepos?: string[];
  } = {},
) {
  const {
    issueRepos = ["Roxabi/lyra", "Roxabi/roxabi-factory"],
    edgeSrcRepos = ["Roxabi/lyra"],
    edgeDstRepos = [],
    prStateRepos = ["Roxabi/lyra"],
    syncStateRepos = ["Roxabi/lyra", "Roxabi/roxabi-factory"],
  } = opts;

  return makeFakeDb((sql, args) => {
    if (sql.includes("key='halted'")) return makeFakeStmt(sql, args, [{ value: "0" }], 0);
    if (sql.includes("sync_running") && sql.includes("UPDATE"))
      return makeFakeStmt(sql, args, [], 1);
    if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
    if (sql.includes("FROM tenants")) {
      return makeFakeStmt(sql, args, [{ id: 1, installation_id: 139542392 }]);
    }
    if (sql.includes("FROM tenant_repo_access")) {
      return makeFakeStmt(sql, args, [{ owner: "Roxabi", name: "roxabi-factory" }]);
    }
    if (sql.includes("SELECT DISTINCT repo FROM issues")) {
      return makeFakeStmt(
        sql,
        args,
        issueRepos.map((r) => ({ repo: r })),
      );
    }
    if (sql.includes("SELECT DISTINCT substr(src_key")) {
      return makeFakeStmt(
        sql,
        args,
        edgeSrcRepos.map((r) => ({ repo: r })),
      );
    }
    if (sql.includes("SELECT DISTINCT substr(dst_key")) {
      return makeFakeStmt(
        sql,
        args,
        edgeDstRepos.map((r) => ({ repo: r })),
      );
    }
    if (sql.includes("SELECT DISTINCT repo FROM pr_state")) {
      return makeFakeStmt(
        sql,
        args,
        prStateRepos.map((r) => ({ repo: r })),
      );
    }
    if (sql.includes("SELECT repo FROM sync_state")) {
      return makeFakeStmt(
        sql,
        args,
        syncStateRepos.map((r) => ({ repo: r })),
      );
    }
    return makeFakeStmt(sql, args, [], 1);
  });
}

export function makeAuditDb() {
  return makeFakeDb((sql, args) => {
    if (sql.includes("FROM issues")) return makeFakeStmt(sql, args, [{ c: 2650 }]);
    if (sql.includes("FROM edges")) return makeFakeStmt(sql, args, [{ c: 2432 }]);
    if (sql.includes("FROM pr_state")) return makeFakeStmt(sql, args, [{ c: 373 }]);
    if (sql.includes("MAX(last_synced_at)"))
      return makeFakeStmt(sql, args, [{ w: "2026-06-08T09:00:00Z" }]);
    if (sql.includes("sync_control"))
      return makeFakeStmt(sql, args, [
        { key: "halted", value: "0" },
        { key: "auth_failures", value: "0" },
      ]);
    return makeFakeStmt(sql, args, []);
  });
}
