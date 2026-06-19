import { describe, expect, it, vi, afterEach } from "vitest";
import { captureDb } from "../test-utils";
import {
  getIssueCount,
  getSyncStatus,
  isGlobalSyncRunning,
  maybeScheduleBootstrapSync,
} from "./bootstrap";

vi.mock("./sync", () => ({
  isHalted: vi.fn().mockResolvedValue(false),
  runSync: vi.fn().mockResolvedValue(undefined),
}));

import { isHalted, runSync } from "./sync";

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(isHalted).mockResolvedValue(false);
  vi.mocked(runSync).mockResolvedValue(undefined);
});

describe("maybeScheduleBootstrapSync", () => {
  it("queues runSync when corpus is empty", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("COUNT(*)")) return [{ n: 0 }];
      if (sql.includes("sync_running")) return [{ value: "0" }];
      if (sql.includes("bootstrap_at")) return [];
      return [];
    });
    const waitUntil = vi.fn();
    const ctx = { waitUntil } as unknown as ExecutionContext;

    const scheduled = await maybeScheduleBootstrapSync(
      db,
      { DB: db } as never,
      ctx,
    );

    expect(scheduled).toBe(true);
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(vi.mocked(runSync)).toHaveBeenCalled();
  });

  it("skips when issues already exist", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("COUNT(*)")) return [{ n: 12 }];
      return [];
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

  it("skips when global sync is already running", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("COUNT(*)")) return [{ n: 0 }];
      if (sql.includes("sync_running")) return [{ value: "1" }];
      return [];
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
});

describe("getSyncStatus", () => {
  it("marks initial_sync when linked tenant and empty corpus", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("COUNT(*)")) return [{ n: 0 }];
      if (sql.includes("sync_running")) return [{ value: "1" }];
      if (sql.includes("halted")) return [{ value: "0" }];
      return [];
    });

    await expect(getSyncStatus(db, true)).resolves.toEqual({
      issue_count: 0,
      sync_running: true,
      initial_sync: true,
    });
  });

  it("clears initial_sync once issues exist", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("COUNT(*)")) return [{ n: 3 }];
      if (sql.includes("sync_running")) return [{ value: "0" }];
      if (sql.includes("halted")) return [{ value: "0" }];
      return [];
    });

    await expect(getSyncStatus(db, true)).resolves.toEqual({
      issue_count: 3,
      sync_running: false,
      initial_sync: false,
    });
  });
});

describe("getIssueCount / isGlobalSyncRunning", () => {
  it("reads issue count from D1", async () => {
    const { db } = captureDb(() => [{ n: 7 }]);
    await expect(getIssueCount(db)).resolves.toBe(7);
  });

  it("detects global sync_running flag", async () => {
    const { db } = captureDb(() => [{ value: "1" }]);
    await expect(isGlobalSyncRunning(db)).resolves.toBe(true);
  });
});