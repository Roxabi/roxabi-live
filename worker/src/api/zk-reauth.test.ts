import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv, SessionContext } from "../auth/types";
import { isConsumeReauthRateLimited, recordConsumeReauthSuccess } from "../auth/zk-reauth";
import { captureDb } from "../test-utils";
import type { Env } from "../types";
import { consumeZkReauthRoute } from "./zk-reauth";

afterEach(() => {
  vi.restoreAllMocks();
});

const STUB_SESSION: SessionContext = {
  userId: 7,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

const CODE = "0123456789abcdef0123456789abcdef";

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("ok") } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
    ZK_ACCOUNT_KEY: "1",
    ...overrides,
  } as unknown as Env;
}

function makeApp(_db: D1Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("session", STUB_SESSION);
    await next();
  });
  app.post("/api/zk/consume-reauth", consumeZkReauthRoute);
  return app;
}

describe("consumeZkReauthRoute", () => {
  it("returns reauth_proof when code valid", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_reauth_proofs")) return [{ ok: 1 }];
      return [];
    });
    const res = await makeApp(db).request(
      "/api/zk/consume-reauth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: CODE }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reauth_proof: string };
    expect(body.reauth_proof).toBe(CODE);
  });

  it("returns 403 when ZK_ACCOUNT_KEY flag is off", async () => {
    const { db } = captureDb(() => []);
    const res = await makeApp(db).request(
      "/api/zk/consume-reauth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: CODE }),
      },
      makeEnv(db, { ZK_ACCOUNT_KEY: "0" }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 410 when code expired", async () => {
    const { db } = captureDb(() => []);
    const res = await makeApp(db).request(
      "/api/zk/consume-reauth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: CODE }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(410);
  });
});

describe("recordConsumeReauthSuccess — atomic UPSERT", () => {
  it("emits a single SQL statement with no prior SELECT", async () => {
    const { db, stmts } = captureDb(() => []);
    await recordConsumeReauthSuccess(db, 7);
    const syncStmts = stmts().filter((s) => s.sql.includes("sync_control"));
    expect(syncStmts).toHaveLength(1);
    expect(syncStmts[0].sql).toMatch(/ON CONFLICT/i);
    expect(syncStmts[0].sql).not.toMatch(/^SELECT/i);
  });

  it("SQL contains json_extract increment pattern", async () => {
    const { db, stmts } = captureDb(() => []);
    await recordConsumeReauthSuccess(db, 7);
    const stmt = stmts().find((s) => s.sql.includes("sync_control"));
    expect(stmt?.sql).toMatch(/json_extract/i);
    expect(stmt?.sql).toMatch(/CAST/i);
    expect(stmt?.sql).toMatch(/\+ 1/);
  });

  it("binds current hour key", async () => {
    const { db, stmts } = captureDb(() => []);
    const before = new Date().toISOString().slice(0, 13);
    await recordConsumeReauthSuccess(db, 7);
    const after = new Date().toISOString().slice(0, 13);
    const stmt = stmts().find((s) => s.sql.includes("sync_control"));
    // hourKey appears multiple times in bind args (5 total); must include current hour
    expect(stmt?.args.some((a) => a === before || a === after)).toBe(true);
  });
});

describe("isConsumeReauthRateLimited", () => {
  it("returns true when count at threshold", async () => {
    const currentHour = new Date().toISOString().slice(0, 13);
    const { db } = captureDb((sql) => {
      if (sql.includes("sync_control") && sql.includes("SELECT")) {
        return [{ value: JSON.stringify({ hour: currentHour, count: 10 }) }];
      }
      return [];
    });
    expect(await isConsumeReauthRateLimited(db, 7)).toBe(true);
  });

  it("returns false when count below threshold", async () => {
    const currentHour = new Date().toISOString().slice(0, 13);
    const { db } = captureDb((sql) => {
      if (sql.includes("sync_control") && sql.includes("SELECT")) {
        return [{ value: JSON.stringify({ hour: currentHour, count: 9 }) }];
      }
      return [];
    });
    expect(await isConsumeReauthRateLimited(db, 7)).toBe(false);
  });

  it("returns false when stored hour differs (counter reset)", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("sync_control") && sql.includes("SELECT")) {
        return [{ value: JSON.stringify({ hour: "2020-01-01T00", count: 99 }) }];
      }
      return [];
    });
    expect(await isConsumeReauthRateLimited(db, 7)).toBe(false);
  });
});
