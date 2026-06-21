import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDb } from "../test-utils";
import {
  getIssueCount,
  getRepoSyncProgress,
  getSyncStatus,
  isBootstrapComplete,
  isGlobalSyncRunning,
  maybeScheduleBootstrapSync,
  runBootstrapSync,
} from "./bootstrap";

vi.mock("./sync", () => ({
  ensureGlobalSyncControlSeeded: vi.fn().mockResolvedValue(undefined),
  isHalted: vi.fn().mockResolvedValue(false),
  runSync: vi.fn().mockResolvedValue(undefined),
}));

import { isHalted, runSync } from "./sync";

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(isHalted).mockResolvedValue(false);
  vi.mocked(runSync).mockResolvedValue(undefined);
});

function progressSqlHandler(sql: string, reposTotal: number, reposSynced: number) {
  if (sql.includes("FROM repos") && sql.includes("COUNT")) return [{ n: reposTotal }];
  if (sql.includes("sync_state") && sql.includes("COUNT")) return [{ n: reposSynced }];
  if (sql.includes("FROM issues") && sql.includes("COUNT"))
    return [{ n: reposSynced > 0 ? 10 : 0 }];
  if (sql.includes("sync_running")) return [{ value: "0", updated_at: new Date().toISOString() }];
  if (sql.includes("halted")) return [{ value: "0" }];
  if (sql.includes("bootstrap_at")) return [];
  return [];
}

describe("maybeScheduleBootstrapSync", () => {
  it("queues bootstrap chain when no repos are synced yet", async () => {
    const { db } = captureDb((sql) => progressSqlHandler(sql, 0, 0));
    const waitUntil = vi.fn();
    const ctx = { waitUntil } as unknown as ExecutionContext;

    const scheduled = await maybeScheduleBootstrapSync(db, { DB: db } as never, ctx);

    expect(scheduled).toBe(true);
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("queues bootstrap chain when some repos remain unsynced", async () => {
    const { db } = captureDb((sql) => progressSqlHandler(sql, 39, 20));
    const waitUntil = vi.fn();

    const scheduled = await maybeScheduleBootstrapSync(
      db,
      { DB: db } as never,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(scheduled).toBe(true);
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("skips when every repo is synced", async () => {
    const { db } = captureDb((sql) => progressSqlHandler(sql, 39, 39));
    const waitUntil = vi.fn();

    const scheduled = await maybeScheduleBootstrapSync(
      db,
      { DB: db } as never,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(scheduled).toBe(false);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("auto-resumes when halted during incomplete bootstrap", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("key='halted'") && sql.includes("SELECT")) return [{ value: "1" }];
      if (sql.includes("auth_failures")) return [{ value: "2" }];
      return progressSqlHandler(sql, 39, 28);
    });
    const waitUntil = vi.fn();

    const scheduled = await maybeScheduleBootstrapSync(
      db,
      { DB: db } as never,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(scheduled).toBe(true);
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("skips when global sync is already running", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("sync_running")) {
        return [{ value: "1", updated_at: new Date().toISOString() }];
      }
      return progressSqlHandler(sql, 39, 10);
    });
    const waitUntil = vi.fn();

    const scheduled = await maybeScheduleBootstrapSync(
      db,
      { DB: db } as never,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(scheduled).toBe(false);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("skips when ZK_ACCOUNT_KEY is on and user is not enrolled", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_key_backups")) return [];
      return progressSqlHandler(sql, 0, 0);
    });
    const waitUntil = vi.fn();

    const scheduled = await maybeScheduleBootstrapSync(
      db,
      { DB: db } as never,
      { waitUntil } as unknown as ExecutionContext,
      { userId: 1, zkAccountKeyEnabled: true },
    );

    expect(scheduled).toBe(false);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("queues bootstrap chain when ZK enrolled and repos unsynced", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_key_backups")) return [{ ok: 1 }];
      return progressSqlHandler(sql, 39, 0);
    });
    const waitUntil = vi.fn();

    const scheduled = await maybeScheduleBootstrapSync(
      db,
      { DB: db } as never,
      { waitUntil } as unknown as ExecutionContext,
      { userId: 1, zkAccountKeyEnabled: true },
    );

    expect(scheduled).toBe(true);
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});

describe("getSyncStatus", () => {
  it("marks sync_in_progress when linked tenant and repos remain", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("sync_running")) {
        return [{ value: "1", updated_at: new Date().toISOString() }];
      }
      if (sql.includes("halted")) return [{ value: "0" }];
      return progressSqlHandler(sql, 39, 12);
    });

    await expect(getSyncStatus(db, true)).resolves.toEqual({
      issue_count: 10,
      sync_running: true,
      initial_sync: false,
      repos_total: 39,
      repos_synced: 12,
      sync_in_progress: true,
      sync_halted: false,
    });
  });

  it("clears sync_in_progress when bootstrap is complete", async () => {
    const { db } = captureDb((sql) => progressSqlHandler(sql, 39, 39));

    await expect(getSyncStatus(db, true)).resolves.toMatchObject({
      repos_total: 39,
      repos_synced: 39,
      sync_in_progress: false,
    });
  });

  it("clears sync_in_progress when ZK is required but user is not enrolled", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_key_backups")) return [];
      return progressSqlHandler(sql, 0, 0);
    });

    await expect(
      getSyncStatus(db, true, { userId: 1, zkAccountKeyEnabled: true }),
    ).resolves.toMatchObject({
      sync_in_progress: false,
      initial_sync: false,
    });
  });
});

describe("getRepoSyncProgress / isBootstrapComplete", () => {
  it("reads repo totals from D1", async () => {
    const { db } = captureDb((sql) => progressSqlHandler(sql, 39, 20));
    await expect(getRepoSyncProgress(db)).resolves.toEqual({
      repos_total: 39,
      repos_synced: 20,
    });
    await expect(isBootstrapComplete(db)).resolves.toBe(false);
  });

  it("detects bootstrap complete", async () => {
    const { db } = captureDb((sql) => progressSqlHandler(sql, 39, 39));
    await expect(isBootstrapComplete(db)).resolves.toBe(true);
  });
});

describe("getIssueCount / isGlobalSyncRunning", () => {
  it("reads issue count from D1", async () => {
    const { db } = captureDb(() => [{ n: 7 }]);
    await expect(getIssueCount(db)).resolves.toBe(7);
  });

  it("detects global sync_running flag", async () => {
    const { db } = captureDb(() => [{ value: "1", updated_at: new Date().toISOString() }]);
    await expect(isGlobalSyncRunning(db)).resolves.toBe(true);
  });

  it("clears stale sync_running lock older than 900s", async () => {
    const stale = new Date(Date.now() - 901_000).toISOString();
    const { db, stmts } = captureDb(() => [{ value: "1", updated_at: stale }]);
    await expect(isGlobalSyncRunning(db)).resolves.toBe(false);
    expect(stmts().some((s) => s.sql.includes("sync_running") && s.sql.includes("'0'"))).toBe(true);
  });
});

describe("runBootstrapSync", () => {
  it("runs a single prioritizeUnsynced pass per schedule", async () => {
    const { db } = captureDb((sql) => progressSqlHandler(sql, 39, 26));
    await runBootstrapSync({ DB: db } as never);
    expect(runSync).toHaveBeenCalledTimes(1);
    expect(runSync).toHaveBeenCalledWith({ DB: db }, { prioritizeUnsynced: true });
  });

  it("skips when bootstrap is already complete", async () => {
    vi.mocked(runSync).mockClear();
    const { db } = captureDb((sql) => progressSqlHandler(sql, 39, 39));
    await runBootstrapSync({ DB: db } as never);
    expect(runSync).not.toHaveBeenCalled();
  });
});
