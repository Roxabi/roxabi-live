import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AuthEnv } from "./types";
import { authExchangeRoute } from "./oauthExchange";
import { makeFakeDb, makeFakeStmt } from "../test-utils";

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

describe("authExchangeRoute", () => {
  it("serves dashboard HTML with session cookie for dashboard destinations", async () => {
    const row = {
      session_token: "a".repeat(64),
      redirect_after: "/dashboard?install=1",
    };
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [row], 1);
      (stmt as { first: <T>() => Promise<T | null> }).first = vi
        .fn()
        .mockResolvedValue(row);
      return stmt;
    });
    const { app, env } = makeApp(db);

    const res = await app.request(
      "/auth/exchange?code=abc123",
      { method: "GET" },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dashboard");
    expect(res.headers.get("Location")).toBeNull();
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("roxabi_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("redirects non-dashboard destinations with Set-Cookie", async () => {
    const row = {
      session_token: "a".repeat(64),
      redirect_after: "/settings",
    };
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [row], 1);
      (stmt as { first: <T>() => Promise<T | null> }).first = vi
        .fn()
        .mockResolvedValue(row);
      return stmt;
    });
    const { app, env } = makeApp(db);

    const res = await app.request(
      "/auth/exchange?code=abc123",
      { method: "GET" },
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings");
    expect(res.headers.get("Set-Cookie")).toContain("roxabi_session=");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("returns 400 when code is missing", async () => {
    const db = makeFakeDb(() => makeFakeStmt("SELECT 1", [], [], 0));
    const { app, env } = makeApp(db);
    const res = await app.request("/auth/exchange", { method: "GET" }, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 when code is expired or unknown", async () => {
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 0);
      (stmt as { first: <T>() => Promise<T | null> }).first = vi
        .fn()
        .mockResolvedValue(null);
      return stmt;
    });
    const { app, env } = makeApp(db);
    const res = await app.request(
      "/auth/exchange?code=deadbeef",
      { method: "GET" },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "expired" });
  });
});