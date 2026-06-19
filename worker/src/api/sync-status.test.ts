import { describe, expect, it, vi, afterEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import type { AuthEnv, SessionContext } from "../auth/types";
import { syncStatusRoute } from "./sync-status";
import { captureDb } from "../test-utils";

vi.mock("../sync/bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sync/bootstrap")>();
  return {
    ...actual,
    maybeScheduleBootstrapSync: vi.fn().mockResolvedValue(true),
    getSyncStatus: vi.fn().mockResolvedValue({
      issue_count: 0,
      sync_running: false,
      initial_sync: true,
    }),
    isGlobalSyncRunning: vi.fn().mockResolvedValue(true),
  };
});

import {
  getSyncStatus,
  isGlobalSyncRunning,
  maybeScheduleBootstrapSync,
} from "../sync/bootstrap";

afterEach(() => {
  vi.clearAllMocks();
});

const STUB_SESSION: SessionContext = {
  userId: 1,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

function makeApp(db: D1Database, session = STUB_SESSION) {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.get("/api/sync/status", syncStatusRoute);
  return app;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("ok") } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

describe("GET /api/sync/status", () => {
  it("returns sync status for linked tenant", async () => {
    const { db } = captureDb();
    const res = await makeApp(db).request(
      "/api/sync/status",
      {},
      makeEnv(db),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      issue_count: 0,
      sync_running: true,
      initial_sync: true,
    });
  });

  it("schedules bootstrap when initial sync is pending", async () => {
    vi.mocked(getSyncStatus).mockResolvedValueOnce({
      issue_count: 0,
      sync_running: false,
      initial_sync: true,
    });
    const { db } = captureDb();
    const waitUntil = vi.fn();
    await makeApp(db).request(
      "/api/sync/status",
      {},
      makeEnv(db),
      { waitUntil } as unknown as ExecutionContext,
    );
    expect(maybeScheduleBootstrapSync).toHaveBeenCalled();
    expect(isGlobalSyncRunning).toHaveBeenCalled();
  });

  it("returns 401 without session", async () => {
    const { db } = captureDb();
    const app = new Hono<AuthEnv>();
    app.get("/api/sync/status", syncStatusRoute);
    const res = await app.request("/api/sync/status", {}, makeEnv(db));
    expect(res.status).toBe(401);
  });
});