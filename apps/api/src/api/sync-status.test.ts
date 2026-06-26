import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv, SessionContext } from "../auth/types";
import { captureDb } from "../test-utils";
import type { Env } from "../types";
import { syncStatusRoute } from "./sync-status";

vi.mock("../sync/bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sync/bootstrap")>();
  return {
    ...actual,
    maybeScheduleBootstrapSync: vi.fn().mockResolvedValue(true),
    getSyncStatus: vi.fn().mockResolvedValue({
      issue_count: 0,
      sync_running: false,
      initial_sync: true,
      repos_total: 39,
      repos_synced: 0,
      sync_in_progress: true,
      sync_halted: false,
    }),
    isGlobalSyncRunning: vi.fn().mockResolvedValue(true),
  };
});

import { getSyncStatus, isGlobalSyncRunning, maybeScheduleBootstrapSync } from "../sync/bootstrap";

afterEach(() => {
  vi.clearAllMocks();
});

const STUB_SESSION: SessionContext = {
  userId: 1,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

function makeApp(_db: D1Database, session = STUB_SESSION) {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.get("/api/sync/status", syncStatusRoute);
  return app;
}

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("ok") } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
    ZK_ACCOUNT_KEY: "1",
    ...overrides,
  } as unknown as Env;
}

describe("GET /api/sync/status", () => {
  it("returns sync status for linked tenant", async () => {
    const { db } = captureDb();
    const res = await makeApp(db).request("/api/sync/status", {}, makeEnv(db), {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      issue_count: 0,
      sync_running: true,
      initial_sync: true,
      repos_total: 39,
      repos_synced: 0,
      sync_in_progress: true,
      sync_halted: false,
    });
  });

  it("schedules bootstrap when sync is in progress", async () => {
    vi.mocked(getSyncStatus).mockResolvedValueOnce({
      issue_count: 80,
      sync_running: false,
      initial_sync: false,
      repos_total: 39,
      repos_synced: 20,
      sync_in_progress: true,
      sync_halted: false,
    });
    const { db } = captureDb();
    const waitUntil = vi.fn();
    await makeApp(db).request("/api/sync/status", {}, makeEnv(db), {
      waitUntil,
    } as unknown as ExecutionContext);
    expect(maybeScheduleBootstrapSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { userId: STUB_SESSION.userId, zkAccountKeyEnabled: true },
    );
    expect(isGlobalSyncRunning).toHaveBeenCalled();
  });

  it("does not schedule bootstrap when sync_in_progress is false (ZK not enrolled)", async () => {
    vi.mocked(getSyncStatus).mockResolvedValueOnce({
      issue_count: 0,
      sync_running: false,
      initial_sync: false,
      repos_total: 0,
      repos_synced: 0,
      sync_in_progress: false,
      sync_halted: false,
    });
    const { db } = captureDb();
    await makeApp(db).request("/api/sync/status", {}, makeEnv(db), {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext);
    expect(maybeScheduleBootstrapSync).not.toHaveBeenCalled();
  });

  it("returns 401 without session", async () => {
    const { db } = captureDb();
    const app = new Hono<AuthEnv>();
    app.get("/api/sync/status", syncStatusRoute);
    const res = await app.request("/api/sync/status", {}, makeEnv(db));
    expect(res.status).toBe(401);
  });
});
