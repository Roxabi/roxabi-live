import { describe, expect, it, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { consumeZkReauthRoute } from "./zk-reauth";
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

function makeApp(db: D1Database): Hono<AuthEnv> {
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
    const body = await res.json() as { reauth_proof: string };
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