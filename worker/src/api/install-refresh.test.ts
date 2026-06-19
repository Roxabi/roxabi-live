import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { AuthEnv, SessionContext } from "../auth/types";
import {
  installRefreshRoute,
  OAUTH_FALLBACK,
} from "./install-refresh";
import {
  captureDb,
  dispatchByTable,
  makeEnv,
  makeFakeStmt,
  makeFakeDb,
  type FakeResult,
} from "../test-utils";

afterEach(() => {
  vi.restoreAllMocks();
});

const RAW_TOKEN = "a".repeat(64);
const COOKIE = `roxabi_session=${RAW_TOKEN}`;

const PENDING_SESSION: SessionContext = {
  userId: 7,
  tenantId: null,
  githubId: 42,
  githubLogin: "alice",
};

function makeApp(
  session: SessionContext | undefined,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  if (session) {
    app.use("*", async (c, next) => {
      c.set("session", session);
      await next();
    });
  }
  app.post("/api/install/refresh", installRefreshRoute);
  return app;
}

function meRows(): FakeResult[] {
  return [{ zk_opt_in: 0, install_targets_json: null, consent_at: null }];
}

async function postRefresh(
  app: Hono<AuthEnv>,
  db: D1Database,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  return await app.request(
    "/api/install/refresh",
    { method: "POST", headers },
    makeEnv(db),
  );
}

describe("installRefreshRoute", () => {
  it("returns 401 when session is missing", async () => {
    const { db } = captureDb();
    const res = await postRefresh(makeApp(undefined), db);
    expect(res.status).toBe(401);
  });

  it("returns 202 pending when user has no linked installations", async () => {
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        user_installations: [],
        users: meRows(),
      }),
    );
    const res = await postRefresh(makeApp(PENDING_SESSION), db, COOKIE);
    expect(res.status).toBe(202);
    const body = await res.json() as {
      status: string;
      retry_after_ms: number;
      oauth_fallback: string;
    };
    expect(body.status).toBe("pending");
    expect(body.retry_after_ms).toBe(2000);
    expect(body.oauth_fallback).toBe(OAUTH_FALLBACK);
  });

  it("installations query excludes suspended tenants", async () => {
    const { db, stmts } = captureDb((sql) =>
      dispatchByTable(sql, {
        user_installations: [],
        users: meRows(),
      }),
    );
    await postRefresh(makeApp(PENDING_SESSION), db, COOKIE);
    const installStmt = stmts().find((s) => s.sql.includes("user_installations"));
    expect(installStmt!.sql).toContain("suspended_at IS NULL");
  });

  it("returns 200 linked with me payload when installations exist", async () => {
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        user_installations: [
          { tenant_id: 9, account_login: "Roxabi", account_type: "Organization" },
        ],
        users: meRows(),
      }),
    );
    const linkedSession: SessionContext = { ...PENDING_SESSION, tenantId: 9 };
    const res = await postRefresh(makeApp(linkedSession), db, COOKIE);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      status: string;
      onboarding_step: string;
      installations: unknown[];
    };
    expect(body.status).toBe("linked");
    expect(body.onboarding_step).toBe("consent");
    expect(body.installations).toHaveLength(1);
  });

  it("auto-switches tenant only when exactly one installation", async () => {
    const captured: ReturnType<typeof makeFakeStmt>[] = [];
    const db = makeFakeDb((sql, args) => {
      const rows: FakeResult[] = [];
      if (sql.includes("user_installations") && sql.includes("SELECT")) {
        rows.push({
          tenant_id: 5,
          account_login: "solo",
          account_type: "User",
        });
      } else if (sql.includes("zk_opt_in") || sql.includes("install_targets_json")) {
        rows.push(...meRows());
      }
      const changes = sql.includes("UPDATE sessions SET tenant_id") ? 1 : 0;
      const stmt = makeFakeStmt(sql, args, rows, changes);
      captured.push(stmt);
      return stmt;
    });

    const res = await postRefresh(makeApp(PENDING_SESSION), db, COOKIE);
    expect(res.status).toBe(200);
    const updateStmt = captured.find((s) =>
      s.sql.includes("UPDATE sessions SET tenant_id"),
    );
    expect(updateStmt).toBeDefined();
    expect(updateStmt!.args[0]).toBe(5);
  });

  it("skips auto-switch when multiple installations exist", async () => {
    const captured: ReturnType<typeof makeFakeStmt>[] = [];
    const db = makeFakeDb((sql, args) => {
      const rows: FakeResult[] = [];
      if (sql.includes("user_installations") && sql.includes("SELECT")) {
        rows.push(
          { tenant_id: 5, account_login: "a", account_type: "User" },
          { tenant_id: 6, account_login: "b", account_type: "Organization" },
        );
      } else if (sql.includes("zk_opt_in") || sql.includes("install_targets_json")) {
        rows.push(...meRows());
      }
      const stmt = makeFakeStmt(sql, args, rows, 0);
      captured.push(stmt);
      return stmt;
    });

    const res = await postRefresh(makeApp(PENDING_SESSION), db, COOKIE);
    expect(res.status).toBe(200);
    const updateStmt = captured.find((s) =>
      s.sql.includes("UPDATE sessions SET tenant_id"),
    );
    expect(updateStmt).toBeUndefined();
  });

  it("returns 401 when setSessionTenant affects zero rows", async () => {
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        user_installations: [
          { tenant_id: 5, account_login: "solo", account_type: "User" },
        ],
        users: meRows(),
      }),
    );
    const res = await postRefresh(makeApp(PENDING_SESSION), db, COOKIE);
    expect(res.status).toBe(401);
  });
});