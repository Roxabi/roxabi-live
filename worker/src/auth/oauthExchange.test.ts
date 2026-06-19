import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { makeFakeDb, makeFakeStmt } from "../test-utils";
import { authExchangeRoute } from "./oauthExchange";
import type { AuthEnv } from "./types";

function makeApp(db: D1Database) {
  const app = new Hono<AuthEnv>();
  app.get("/auth/exchange", authExchangeRoute);
  return {
    app,
    env: {
      DB: db,
      ASSETS: {
        fetch: vi.fn(async () => new Response("<html>dashboard</html>", { status: 200 })),
      } as unknown as Fetcher,
    } as AuthEnv["Bindings"],
  };
}

describe("authExchangeRoute (legacy shim)", () => {
  it("serves dashboard when session cookie is valid", async () => {
    const validRow = {
      userId: 1,
      tenantId: null,
      githubId: 1001,
      githubLogin: "octocat",
    };
    const db = makeFakeDb((sql) => {
      const stmt = makeFakeStmt(sql, [], [validRow], 1);
      (stmt as { first: <T>() => Promise<T | null> }).first = vi.fn().mockResolvedValue(validRow);
      return stmt;
    });
    const { app, env } = makeApp(db);

    const res = await app.request(
      "/auth/exchange?code=already-used",
      {
        method: "GET",
        headers: { Cookie: `roxabi_session=${"a".repeat(64)}` },
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dashboard");
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("returns 400 when no valid session", async () => {
    const db = makeFakeDb(() => makeFakeStmt("SELECT 1", [], [], 0));
    const { app, env } = makeApp(db);
    const res = await app.request("/auth/exchange?code=deadbeef", { method: "GET" }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "expired" });
  });

  it("serves dashboard when code is consumed but session cookie is valid", async () => {
    const validRow = {
      userId: 1,
      tenantId: null,
      githubId: 1001,
      githubLogin: "octocat",
    };
    const db = makeFakeDb((sql) => {
      if (sql.toLowerCase().includes("oauth_exchange")) {
        const stmt = makeFakeStmt(sql, [], [], 0);
        (stmt as { first: <T>() => Promise<T | null> }).first = vi
          .fn()
          .mockResolvedValue(null);
        return stmt;
      }
      const stmt = makeFakeStmt(sql, [], [validRow], 1);
      (stmt as { first: <T>() => Promise<T | null> }).first = vi
        .fn()
        .mockResolvedValue(validRow);
      return stmt;
    });
    const { app, env } = makeApp(db);

    const res = await app.request(
      "/auth/exchange?code=already-used",
      {
        method: "GET",
        headers: { Cookie: `roxabi_session=${"a".repeat(64)}` },
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dashboard");
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });
});