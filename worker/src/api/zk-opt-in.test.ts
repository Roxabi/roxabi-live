import { describe, expect, it, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { zkOptInRoute } from "./zk-opt-in";
import type { AuthEnv, SessionContext } from "../auth/types";
import { captureDb } from "../test-utils";

afterEach(() => {
  vi.restoreAllMocks();
});

const STUB_SESSION: SessionContext = {
  userId: 7,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

function makeApp(db: D1Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("session", STUB_SESSION);
    await next();
  });
  app.post("/api/zk-opt-in", zkOptInRoute);
  return app;
}

describe("zkOptInRoute", () => {
  it("returns 400 when enabled is missing", async () => {
    const { db } = captureDb();
    const app = makeApp(db);
    const res = await app.request(
      "/api/zk-opt-in",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
  });

  it("updates users.zk_opt_in and returns the flag", async () => {
    const { db, stmts } = captureDb();
    const app = makeApp(db);
    const res = await app.request(
      "/api/zk-opt-in",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { zk_opt_in: boolean };
    expect(body.zk_opt_in).toBe(true);

    const update = stmts().find((s) => s.sql.includes("UPDATE users SET zk_opt_in"));
    expect(update).toBeDefined();
    expect(update!.args).toEqual([1, 7]);
  });

  it("binds 0 when disabling", async () => {
    const { db, stmts } = captureDb();
    const app = makeApp(db);
    await app.request(
      "/api/zk-opt-in",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
      makeEnv(db),
    );
    const update = stmts().find((s) => s.sql.includes("UPDATE users SET zk_opt_in"));
    expect(update!.args[0]).toBe(0);
  });
});