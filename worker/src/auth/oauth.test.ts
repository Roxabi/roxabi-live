import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { loginRoute, callbackRoute } from "./oauth";

import type { FakeResult, FakeStmt } from "../test-utils";
import { makeFakeStmt, makeFakeDb, captureDb } from "../test-utils";

/**
 * #158: the default makeFakeDb batch() mock returns empty results. This override
 * surfaces each batched statement's own RETURNING rows (via stmt.all()) so tenant
 * ids flow through batch results. Shared test-utils.ts is intentionally untouched.
 */
function applyBatchOverride(db: D1Database): void {
  (db as unknown as { batch: unknown }).batch = vi.fn(async (stmts: FakeStmt[]) =>
    Promise.all(
      stmts.map(async (s) => {
        const { results } = await s.all<FakeResult>();
        return { results, meta: { changes: results.length } };
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal Env stub — only the fields needed for OAuth routes. */
function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: {
      fetch: vi.fn(async () => new Response("<html>dashboard</html>", { status: 200 })),
    } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_CLIENT_ID: "Iv1.abc123",
    GITHUB_APP_CLIENT_SECRET: "secret-xyz",
    GITHUB_APP_PRIVATE_KEY: "base64privkey",
    GITHUB_APP_WEBHOOK_SECRET: "app-webhook-secret",
  } as unknown as Env;
}

/** Mount the login and callback routes on a throwaway Hono app. */
function makeApp(db: D1Database) {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/login", loginRoute);
  app.get("/oauth/callback", callbackRoute);
  const env = makeEnv(db);
  return { app, env };
}

// ---------------------------------------------------------------------------
// loginRoute
// ---------------------------------------------------------------------------

describe("loginRoute", () => {
  describe("GET /login", () => {
    it("returns 200 HTML login prompt without go=1", async () => {
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      const res = await app.request(
        "http://localhost/login",
        { method: "GET" },
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("Continuer avec GitHub");
      expect(body).toContain("Connexion GitHub");
      expect(body).toContain("/login?intent=signin");
      expect(body).not.toContain("%252F");
      expect(body).toContain('href="/login?intent=signin&redirect=%2Fdashboard"');
      expect(res.headers.get("Location")).toBeNull();
      expect(stmts()).toHaveLength(0);
    });

    it("returns 302 redirect when go=1", async () => {
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      const res = await app.request(
        "http://localhost/login?go=1",
        { method: "GET" },
        env,
      );

      expect(res.status).toBe(302);
    });

    it("Location starts with https://github.com/login/oauth/authorize when go=1", async () => {
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      const res = await app.request(
        "http://localhost/login?go=1",
        { method: "GET" },
        env,
      );

      const location = res.headers.get("Location") ?? "";
      expect(location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
    });

    it("Location query includes client_id matching env when go=1", async () => {
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      const res = await app.request(
        "http://localhost/login?go=1",
        { method: "GET" },
        env,
      );

      const location = res.headers.get("Location") ?? "";
      const url = new URL(location);
      expect(url.searchParams.get("client_id")).toBe("Iv1.abc123");
    });

    it("Location query includes state as 32 hex chars when go=1", async () => {
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      const res = await app.request(
        "http://localhost/login?go=1",
        { method: "GET" },
        env,
      );

      const location = res.headers.get("Location") ?? "";
      const url = new URL(location);
      const state = url.searchParams.get("state") ?? "";
      expect(state).toMatch(/^[0-9a-f]{32}$/);
    });

    it("Location redirect_uri ends with /oauth/callback derived from request origin when go=1", async () => {
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      const res = await app.request(
        "http://myapp.example.com/login?go=1",
        { method: "GET" },
        env,
      );

      // Assert
      const location = res.headers.get("Location") ?? "";
      const url = new URL(location);
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      expect(redirectUri).toMatch(/\/oauth\/callback$/);
      expect(redirectUri).toContain("myapp.example.com");
    });

    it("oauth_state INSERT SQL contains '+10 minutes' for expiry", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      await app.request("http://localhost/login?go=1", { method: "GET" }, env);

      // Assert — state row has datetime('now', '+10 minutes')
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.sql).toContain("+10 minutes");
    });

    it("oauth_state INSERT binds [state, redirectAfter] in that order", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      await app.request("http://localhost/login?go=1", { method: "GET" }, env);

      // Assert
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      // args[0] = state (32 hex), args[1] = redirectAfter
      expect(insertStmt!.args[0]).toMatch(/^[0-9a-f]{32}$/);
      expect(insertStmt!.args[1]).toBe("/dashboard"); // default when no ?redirect param
    });

    it("?redirect=/dash stores '/dash' as redirect_after", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      await app.request(
        "http://localhost/login?go=1&redirect=/dash",
        { method: "GET" },
        env,
      );

      // Assert
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.args[1]).toBe("/dash");
    });

    it("?redirect=//evil stores '/dashboard' (open-redirect guard)", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      await app.request(
        "http://localhost/login?go=1&redirect=//evil",
        { method: "GET" },
        env,
      );

      // Assert
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.args[1]).toBe("/dashboard");
    });

    it("?redirect=https://evil stores '/dashboard' (absolute URL guard)", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      await app.request(
        "http://localhost/login?go=1&redirect=https://evil",
        { method: "GET" },
        env,
      );

      // Assert
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.args[1]).toBe("/dashboard");
    });

    it("?redirect=/\\evil stores '/dashboard' (backslash bypass guard)", async () => {
      // Arrange — backslash-prefixed path; sanitizeRedirect regex (?![/\\]) rejects it
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      await app.request(
        "http://localhost/login?go=1&redirect=/\\evil",
        { method: "GET" },
        env,
      );

      // Assert — deleting the /[/\\]/ check in sanitizeRedirect would let "/\evil" pass
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.args[1]).toBe("/dashboard");
    });

    it("?redirect=/ok\\r\\nX-Injected:x stores '/dashboard' (CRLF injection guard)", async () => {
      // Arrange — CRLF chars smuggled in the redirect param; sanitizeRedirect rejects via /[\r\n\0]/
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act — encodeURIComponent so the URL parser doesn't strip the special chars
      await app.request(
        "http://localhost/login?go=1&redirect=" + encodeURIComponent("/ok\r\nX-Injected: x"),
        { method: "GET" },
        env,
      );

      // Assert — deleting the /[\r\n\0]/ check in sanitizeRedirect would let the injection through
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.args[1]).toBe("/dashboard");
    });

    it("?redirect=/ok\\0null stores '/dashboard' (NUL injection guard)", async () => {
      // Arrange — NUL byte smuggled in the redirect param; sanitizeRedirect rejects via /[\r\n\0]/
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act — encodeURIComponent so the URL parser doesn't strip the NUL byte
      await app.request(
        "http://localhost/login?go=1&redirect=" + encodeURIComponent("/ok\0null"),
        { method: "GET" },
        env,
      );

      // Assert — deleting the /[\r\n\0]/ check in sanitizeRedirect would let the NUL through
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.args[1]).toBe("/dashboard");
    });

    it("redirects to redirect_after when session is already valid", async () => {
      const validRow = {
        userId: 1,
        tenantId: 1,
        githubId: 42,
        githubLogin: "alice",
      };
      const bindStmt = {
        first: vi.fn().mockResolvedValue(validRow),
        run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        bind: vi.fn(function (this: unknown) {
          return this;
        }),
      };
      const stmt = {
        first: vi.fn().mockResolvedValue(validRow),
        run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        bind: vi.fn(() => bindStmt),
      };
      const db = {
        prepare: vi.fn(() => stmt),
        batch: vi.fn().mockResolvedValue([]),
        dump: vi.fn(),
        exec: vi.fn(),
      } as unknown as D1Database;

      const { app, env } = makeApp(db);
      const res = await app.request(
        "http://localhost/login?go=1&redirect=/dash",
        {
          method: "GET",
          headers: { Cookie: `__Host-session=${"a".repeat(64)}` },
        },
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dash");
      expect(res.headers.get("Location")).not.toMatch(/^https:\/\/github\.com/);
    });

    it("short-circuits to dashboard without install=1 when session has a linked tenant", async () => {
      const validRow = {
        userId: 1,
        tenantId: 10,
        githubId: 42,
        githubLogin: "alice",
      };
      const db = {
        prepare: vi.fn((sql: string) => {
          const stmt = {
            sql,
            first: vi.fn().mockImplementation(function (this: { sql: string }) {
              if (this.sql.toLowerCase().includes("count")) {
                return Promise.resolve({ n: 1 });
              }
              return Promise.resolve(validRow);
            }),
            run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
            all: vi.fn().mockResolvedValue({ results: [] }),
            bind: vi.fn(function (this: unknown) {
              return this;
            }),
          };
          return stmt;
        }),
        batch: vi.fn().mockResolvedValue([]),
        dump: vi.fn(),
        exec: vi.fn(),
      } as unknown as D1Database;

      const { app, env } = makeApp(db);
      const res = await app.request(
        "http://localhost/login?redirect=" +
          encodeURIComponent("/dashboard?install=1"),
        {
          method: "GET",
          headers: { Cookie: `roxabi_session=${"a".repeat(64)}` },
        },
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard");
      expect(res.headers.get("Location")).not.toMatch(/^https:\/\/github\.com/);
    });

    it("short-circuits install-pending session when install=1 is only in redirect=", async () => {
      const validRow = {
        userId: 1,
        tenantId: null,
        githubId: 42,
        githubLogin: "alice",
      };
      const db = {
        prepare: vi.fn((sql: string) => ({
          sql,
          first: vi.fn().mockResolvedValue(validRow),
          run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
          all: vi.fn().mockResolvedValue({ results: [] }),
          bind: vi.fn(function (this: unknown) {
            return this;
          }),
        })),
        batch: vi.fn().mockResolvedValue([]),
        dump: vi.fn(),
        exec: vi.fn(),
      } as unknown as D1Database;

      const { app, env } = makeApp(db);
      const res = await app.request(
        "http://localhost/login?redirect=" +
          encodeURIComponent("/dashboard?install=1"),
        {
          method: "GET",
          headers: { Cookie: `roxabi_session=${"a".repeat(64)}` },
        },
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard");
      expect(res.headers.get("Location")).not.toMatch(/^https:\/\/github\.com/);
    });

    it("starts OAuth when /login?install=1 and session is install-pending", async () => {
      const validRow = {
        userId: 1,
        tenantId: null,
        githubId: 42,
        githubLogin: "alice",
      };
      const db = {
        prepare: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(validRow),
          run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
          all: vi.fn().mockResolvedValue({ results: [] }),
          bind: vi.fn(function (this: unknown) {
            return this;
          }),
        })),
        batch: vi.fn().mockResolvedValue([]),
        dump: vi.fn(),
        exec: vi.fn(),
      } as unknown as D1Database;

      const { app, env } = makeApp(db);
      const res = await app.request(
        "http://localhost/login?install=1&redirect=%2Fdashboard",
        {
          method: "GET",
          headers: { Cookie: `roxabi_session=${"a".repeat(64)}` },
        },
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toMatch(
        /^https:\/\/github\.com\/login\/oauth\/authorize/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// callbackRoute
// ---------------------------------------------------------------------------

describe("callbackRoute", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("missing parameters", () => {
    it("returns 400 when code is missing", async () => {
      // Arrange
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        "http://localhost/oauth/callback?state=abc123",
        { method: "GET" },
        env,
      );

      // Assert
      expect(res.status).toBe(400);
    });

    it("returns 400 when state is missing", async () => {
      // Arrange
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        "http://localhost/oauth/callback?code=somecode",
        { method: "GET" },
        env,
      );

      // Assert
      expect(res.status).toBe(400);
    });

    it("returns 400 when both code and state are missing", async () => {
      // Arrange
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        "http://localhost/oauth/callback",
        { method: "GET" },
        env,
      );

      // Assert
      expect(res.status).toBe(400);
    });
  });

  describe("unknown or expired state", () => {
    it("returns 400 when state lookup returns null (unknown state)", async () => {
      // Arrange — FakeD1 first() returns null for oauth_state DELETE...RETURNING
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        "http://localhost/oauth/callback?code=code1&state=unknownstate000000000000000000",
        { method: "GET" },
        env,
      );

      // Assert
      expect(res.status).toBe(400);
    });
  });

  describe("happy path — user has installations", () => {
    function stubFetchSequence(
      accessToken: string,
      user: { id: number; login: string },
      installations: Array<{ id: number; account: { login: string; type: string } }>,
    ) {
      let callCount = 0;
      const mockFetch = vi.fn(async (url: string, _init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          // Token exchange
          return new Response(
            JSON.stringify({ access_token: accessToken }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        } else if (callCount === 2) {
          // /user
          return new Response(JSON.stringify(user), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } else {
          // /user/installations
          return new Response(JSON.stringify({ installations }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      });
      vi.stubGlobal("fetch", mockFetch);
      return mockFetch;
    }

    /**
     * Build a FakeD1 for happy-path callback tests.
     * State consumption is now a DELETE...RETURNING (detected via "delete" + "oauth_state").
     */
    function makeHappyPathDb(captured: FakeStmt[], redirectAfter = "/"): D1Database {
      let oauthDeleteCallCount = 0;
      const db = makeFakeDb((sql, args) => {
        const isOauthDelete =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("delete");
        oauthDeleteCallCount += isOauthDelete ? 1 : 0;
        const row =
          isOauthDelete && oauthDeleteCallCount === 1
            ? ({ redirect_after: redirectAfter } as FakeResult)
            : null;

        // For users RETURNING id, return a row with id
        const isUsersInsert =
          sql.toLowerCase().includes("users") &&
          sql.toLowerCase().includes("returning");
        const usersRow = isUsersInsert ? ({ id: 1 } as FakeResult) : null;

        // For tenants RETURNING id
        const isTenantsInsert =
          sql.toLowerCase().includes("tenants") &&
          sql.toLowerCase().includes("returning");
        const tenantsRow = isTenantsInsert ? ({ id: 10 } as FakeResult) : null;

        const rows = isOauthDelete
          ? (row ? [row] : [])
          : isUsersInsert
            ? (usersRow ? [usersRow] : [])
            : isTenantsInsert
              ? (tenantsRow ? [tenantsRow] : [])
              : [];

        const stmt = makeFakeStmt(sql, args, rows, 0);
        if (isOauthDelete) {
          (stmt as { first: <T>() => Promise<T | null> }).first = vi
            .fn()
            .mockResolvedValue(row);
        } else if (isUsersInsert) {
          (stmt as { first: <T>() => Promise<T | null> }).first = vi
            .fn()
            .mockResolvedValue(usersRow);
        } else if (isTenantsInsert) {
          (stmt as { first: <T>() => Promise<T | null> }).first = vi
            .fn()
            .mockResolvedValue(tenantsRow);
        }
        captured.push(stmt);
        return stmt;
      });
      // #158: surface each statement's RETURNING rows through batch results.
      applyBatchOverride(db);
      return db;
    }

    it("uses atomic DELETE...RETURNING to consume state (closes TOCTOU)", async () => {
      // Arrange
      const stateValue = "a".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeHappyPathDb(captured);

      stubFetchSequence(
        "t",
        { id: 42, login: "alice" },
        [{ id: 9, account: { login: "Roxabi", type: "Organization" } }],
      );

      const { app, env } = makeApp(db);

      // Act
      await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert — a DELETE FROM oauth_state statement was issued (the atomic consume)
      const deleteStmt = captured.find(
        (s) =>
          s.sql.toLowerCase().includes("delete") &&
          s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(deleteStmt).toBeDefined();
      // It must also have RETURNING (atomic, not a separate DELETE)
      expect(deleteStmt!.sql.toUpperCase()).toContain("RETURNING");
    });

    it("issues users upsert with ON CONFLICT(github_id)", async () => {
      // Arrange
      const stateValue = "b".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeHappyPathDb(captured);

      stubFetchSequence(
        "t",
        { id: 42, login: "alice" },
        [{ id: 9, account: { login: "Roxabi", type: "Organization" } }],
      );

      const { app, env } = makeApp(db);

      // Act
      await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert
      const usersStmt = captured.find(
        (s) =>
          s.sql.toLowerCase().includes("users") &&
          s.sql.toUpperCase().includes("ON CONFLICT(github_id)".toUpperCase()),
      );
      expect(usersStmt).toBeDefined();
      expect(usersStmt!.sql).toContain("ON CONFLICT(github_id)");
    });

    it("issues tenants upsert with ON CONFLICT(installation_id)", async () => {
      // Arrange
      const stateValue = "c".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeHappyPathDb(captured);

      stubFetchSequence(
        "t",
        { id: 42, login: "alice" },
        [{ id: 9, account: { login: "Roxabi", type: "Organization" } }],
      );

      const { app, env } = makeApp(db);

      // Act
      await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert
      const tenantsStmt = captured.find(
        (s) =>
          s.sql.toLowerCase().includes("tenants") &&
          s.sql.toUpperCase().includes("ON CONFLICT(installation_id)".toUpperCase()),
      );
      expect(tenantsStmt).toBeDefined();
      expect(tenantsStmt!.sql).toContain("ON CONFLICT(installation_id)");
    });

    it("issues user_installations INSERT", async () => {
      // Arrange
      const stateValue = "d".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeHappyPathDb(captured);

      stubFetchSequence(
        "t",
        { id: 42, login: "alice" },
        [{ id: 9, account: { login: "Roxabi", type: "Organization" } }],
      );

      const { app, env } = makeApp(db);

      // Act
      await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert
      const uiStmt = captured.find((s) =>
        s.sql.toLowerCase().includes("user_installations"),
      );
      expect(uiStmt).toBeDefined();
    });

    it("serves dashboard HTML with Set-Cookie on callback (no exchange hop)", async () => {
      // Arrange
      const stateValue = "e".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeHappyPathDb(captured, "/dashboard");

      stubFetchSequence(
        "t",
        { id: 42, login: "alice" },
        [{ id: 9, account: { login: "Roxabi", type: "Organization" } }],
      );

      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("dashboard");
      expect(res.headers.get("Location")).toBeNull();
      expect(res.headers.get("Set-Cookie") ?? "").toContain("roxabi_session=");
      const exchangeInsert = captured.find((s) =>
        s.sql.toLowerCase().includes("oauth_exchange"),
      );
      expect(exchangeInsert).toBeUndefined();
    });

    it("redirects to redirect_after from state row when it is '/dashboard'", async () => {
      // Arrange — state row returns redirect_after: "/dashboard"
      const stateValue = "f".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeHappyPathDb(captured, "/dashboard");

      stubFetchSequence(
        "t",
        { id: 42, login: "alice" },
        [{ id: 9, account: { login: "Roxabi", type: "Organization" } }],
      );

      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert — dashboard served inline with session cookie
      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie") ?? "").toContain("roxabi_session=");
    });

    it("uses two DB.batch round-trips (tenants + links) instead of a per-install loop", async () => {
      const stateValue = "h".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeHappyPathDb(captured, "/dashboard");
      stubFetchSequence(
        "t",
        { id: 42, login: "alice" },
        [{ id: 9, account: { login: "Roxabi", type: "Organization" } }],
      );
      const { app, env } = makeApp(db);
      const res = await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie") ?? "").toContain("roxabi_session=");
      expect((db as unknown as { batch: ReturnType<typeof vi.fn> }).batch).toHaveBeenCalledTimes(2);
    });

    it("handles multiple installations: distinct tenant ids route to the correct links + HTML redirect", async () => {
      const stateValue = "g".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeHappyPathDb(captured, "/dashboard");
      const idByInstall: Record<number, number> = { 9: 100, 11: 101 };
      (db as unknown as { batch: unknown }).batch = vi.fn(async (stmts: FakeStmt[]) =>
        stmts.map((s) => {
          const isTenantUpsert =
            s.sql.toLowerCase().includes("tenants") &&
            s.sql.toLowerCase().includes("returning");
          if (isTenantUpsert) {
            return {
              results: [{ id: idByInstall[s.args[0] as number] }],
              meta: { changes: 1 },
            };
          }
          return { results: [], meta: { changes: 0 } };
        }),
      );
      stubFetchSequence(
        "t",
        { id: 42, login: "alice" },
        [
          { id: 9, account: { login: "Roxabi", type: "Organization" } },
          { id: 11, account: { login: "OtherOrg", type: "Organization" } },
        ],
      );
      const { app, env } = makeApp(db);
      const res = await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie") ?? "").toContain("roxabi_session=");
      const tenantUpserts = captured.filter(
        (s) =>
          s.sql.toLowerCase().includes("tenants") &&
          s.sql.toLowerCase().includes("returning"),
      );
      expect(tenantUpserts).toHaveLength(2);
      const links = captured.filter((s) =>
        s.sql.toLowerCase().includes("user_installations"),
      );
      expect(links).toHaveLength(2);
      expect(links.map((s) => s.args[1])).toEqual([100, 101]);
    });

    it("returns 500 db_error when a tenant upsert batch returns no RETURNING row", async () => {
      const stateValue = "j".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeHappyPathDb(captured);
      // Simulate D1 returning empty .results for the tenant upsert (no RETURNING row)
      // → tenantIds contains undefined → the some(id == null) guard must 500.
      (db as unknown as { batch: unknown }).batch = vi.fn(async (stmts: FakeStmt[]) =>
        stmts.map(() => ({ results: [], meta: { changes: 0 } })),
      );
      stubFetchSequence(
        "t",
        { id: 42, login: "alice" },
        [{ id: 9, account: { login: "Roxabi", type: "Organization" } }],
      );
      const { app, env } = makeApp(db);
      const res = await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "db_error" });
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });
  });

  describe("replay attack — behavioral single-use enforcement", () => {
    it("first request mints session (302 exchange); second with same state returns 400", async () => {
      // Arrange — FakeD1 whose state-consume DELETE...RETURNING returns a row
      // on the first call and null on the second (simulating row deleted by first request).
      const stateValue = "aaaa0000bbbb1111cccc2222dddd3333";
      const atomicDeleteSql =
        `DELETE FROM oauth_state WHERE state = ? AND expires_at > datetime('now') RETURNING redirect_after`;

      let atomicDeleteCallCount = 0;

      const captured: FakeStmt[] = [];
      const db = makeFakeDb((sql, args) => {
        const isAtomicDelete = sql.trim() === atomicDeleteSql.trim() ||
          (sql.toLowerCase().includes("delete") &&
            sql.toLowerCase().includes("oauth_state") &&
            sql.toLowerCase().includes("returning"));

        const isUsersInsert =
          sql.toLowerCase().includes("users") &&
          sql.toLowerCase().includes("returning");
        const isTenantsInsert =
          sql.toLowerCase().includes("tenants") &&
          sql.toLowerCase().includes("returning");

        let row: FakeResult | null = null;
        if (isAtomicDelete) {
          atomicDeleteCallCount++;
          row = atomicDeleteCallCount === 1
            ? ({ redirect_after: "/" } as FakeResult)
            : null;
        } else if (isUsersInsert) {
          row = { id: 1 } as FakeResult;
        } else if (isTenantsInsert) {
          row = { id: 10 } as FakeResult;
        }

        const stmt = makeFakeStmt(sql, args, row !== null ? [row] : [], 0);
        (stmt as { first: <T>() => Promise<T | null> }).first = vi
          .fn()
          .mockResolvedValue(row);
        captured.push(stmt);
        return stmt;
      });
      // #158: surface tenant RETURNING ids through batch results.
      applyBatchOverride(db);

      // Stub fetch so both calls hit GitHub APIs successfully
      let fetchCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string) => {
          fetchCallCount++;
          // Cycle through token → user → installations for each OAuth callback
          const pos = ((fetchCallCount - 1) % 3) + 1;
          if (pos === 1) {
            return new Response(
              JSON.stringify({ access_token: "tok-abc" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          } else if (pos === 2) {
            return new Response(
              JSON.stringify({ id: 42, login: "alice" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          } else {
            return new Response(
              JSON.stringify({ installations: [{ id: 9, account: { login: "Roxabi", type: "Organization" } }] }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }),
      );

      const { app, env } = makeApp(db);

      // Act — first call
      const res1 = await app.request(
        `http://localhost/oauth/callback?code=code1&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Act — second call with the same state (simulates replay)
      const res2 = await app.request(
        `http://localhost/oauth/callback?code=code2&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert — first request succeeds with redirect + cookie
      expect(res1.status).toBe(302);
      expect(res1.headers.get("Location")).toBe("/");
      expect(res1.headers.get("Set-Cookie") ?? "").toContain("roxabi_session=");

      // Assert — second request fails (state row gone after first consume)
      expect(res2.status).toBe(400);
    });
  });

  describe("F1 — GitHub token / API error handling", () => {
    /**
     * Build a FakeD1 that successfully returns a state row (for state consume)
     * but returns null for all other first() calls (sessions, etc.).
     */
    function makeStateOnlyDb(): { db: D1Database; stmts: () => FakeStmt[] } {
      const captured: FakeStmt[] = [];
      let oauthDeleteCallCount = 0;
      const db = makeFakeDb((sql, args) => {
        const isOauthDelete =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("delete");
        oauthDeleteCallCount += isOauthDelete ? 1 : 0;
        const row =
          isOauthDelete && oauthDeleteCallCount === 1
            ? ({ redirect_after: "/" } as FakeResult)
            : null;

        const stmt = makeFakeStmt(sql, args, row !== null ? [row] : [], 0);
        (stmt as { first: <T>() => Promise<T | null> }).first = vi
          .fn()
          .mockResolvedValue(row);
        captured.push(stmt);
        return stmt;
      });
      return { db, stmts: () => captured };
    }

    it("returns 400 when token endpoint returns {error} with no access_token", async () => {
      // Arrange — GitHub returns HTTP 200 with error body (standard OAuth error shape)
      const { db, stmts } = makeStateOnlyDb();
      const stateValue = "e".repeat(32);

      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(
            JSON.stringify({ error: "bad_verification_code" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        `http://localhost/oauth/callback?code=badcode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert
      expect(res.status).toBe(400);

      // No INSERT INTO sessions should have been executed
      const sessionsInsert = stmts().find(
        (s) =>
          s.sql.toLowerCase().includes("sessions") &&
          s.sql.toLowerCase().includes("insert"),
      );
      expect(sessionsInsert).toBeUndefined();
    });

    it("returns 502 when /user fetch returns non-ok status", async () => {
      // Arrange — token exchange succeeds but /user returns 401
      const { db } = makeStateOnlyDb();
      const stateValue = "f".repeat(32);

      let fetchCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            // Token exchange succeeds
            return new Response(
              JSON.stringify({ access_token: "tok-xyz" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          // /user returns 401
          return new Response("Unauthorized", { status: 401 });
        }),
      );

      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        `http://localhost/oauth/callback?code=goodcode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert
      expect(res.status).toBe(502);
    });

    it("returns 502 when /user/installations fetch returns non-ok status", async () => {
      // Arrange — token exchange + /user succeed but /user/installations returns 500
      const { db } = makeStateOnlyDb();
      const stateValue = "a".repeat(32);

      let fetchCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            // Token exchange succeeds
            return new Response(
              JSON.stringify({ access_token: "tok-abc" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          } else if (fetchCallCount === 2) {
            // /user succeeds
            return new Response(
              JSON.stringify({ id: 1, login: "alice" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          // /user/installations returns 500
          return new Response("Internal Server Error", { status: 500 });
        }),
      );

      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        `http://localhost/oauth/callback?code=goodcode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert — deleting the if (!installRes.ok) guard would let the route parse a 500 body
      expect(res.status).toBe(502);
    });
  });

  describe("zero installations", () => {
    /**
     * Build a FakeD1 for zero-installation tests.
     * Tracks whether INSERT INTO users was ever called.
     */
    function makeZeroInstallDb(
      captured: FakeStmt[],
      redirectAfter = "/dashboard",
    ): D1Database {
      let oauthDeleteCallCount = 0;
      return makeFakeDb((sql, args) => {
        const isOauthDelete =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("delete");
        oauthDeleteCallCount += isOauthDelete ? 1 : 0;
        const row =
          isOauthDelete && oauthDeleteCallCount === 1
            ? ({ redirect_after: redirectAfter } as FakeResult)
            : null;
        const isUsersInsert =
          sql.toLowerCase().includes("users") &&
          sql.toLowerCase().includes("returning");
        const usersRow = isUsersInsert ? ({ id: 1 } as FakeResult) : null;

        const stmt = makeFakeStmt(sql, args, [], 0);
        if (isOauthDelete) {
          (stmt as { first: <T>() => Promise<T | null> }).first = vi
            .fn()
            .mockResolvedValue(row);
        } else if (isUsersInsert) {
          (stmt as { first: <T>() => Promise<T | null> }).first = vi
            .fn()
            .mockResolvedValue(usersRow);
        }
        captured.push(stmt);
        return stmt;
      });
    }

    function stubZeroInstallFetch() {
      let fetchCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string) => {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return new Response(
              JSON.stringify({ access_token: "tok" }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          } else if (fetchCallCount === 2) {
            return new Response(
              JSON.stringify({ id: 42, login: "alice" }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          } else if (fetchCallCount === 3) {
            return new Response(
              JSON.stringify({ installations: [] }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          } else {
            return new Response(
              JSON.stringify([{ id: 77, login: "Roxabi" }]),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }),
      );
    }

    it("serves dashboard with Set-Cookie when installations is empty (install-pending)", async () => {
      const stateValue = "f".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeZeroInstallDb(captured);
      stubZeroInstallFetch();
      const { app, env } = makeApp(db);

      const res = await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie") ?? "").toContain("roxabi_session=");
      const exchangeInsert = captured.find((s) =>
        s.sql.toLowerCase().includes("oauth_exchange"),
      );
      expect(exchangeInsert).toBeUndefined();
    });

    it("inserts install-pending session (tenant_id null) when installations is empty", async () => {
      // Arrange
      const stateValue = "1".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeZeroInstallDb(captured);
      stubZeroInstallFetch();
      const { app, env } = makeApp(db);

      // Act
      await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert
      const sessionsInsert = captured.find(
        (s) =>
          s.sql.toLowerCase().includes("sessions") &&
          s.sql.toLowerCase().includes("insert"),
      );
      expect(sessionsInsert).toBeDefined();
      expect(sessionsInsert!.args[1]).toBeNull();
    });

    it("still mints install-pending session when /user/orgs fails (User target only)", async () => {
      const stateValue = "3".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeZeroInstallDb(captured);
      let fetchCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return new Response(JSON.stringify({ access_token: "tok" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          } else if (fetchCallCount === 2) {
            return new Response(JSON.stringify({ id: 42, login: "alice" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          } else if (fetchCallCount === 3) {
            return new Response(JSON.stringify({ installations: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("error", { status: 500 });
        }),
      );
      const { app, env } = makeApp(db);
      const res = await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie") ?? "").toContain("roxabi_session=");
      const usersInsert = captured.find(
        (s) =>
          s.sql.toLowerCase().includes("insert") &&
          s.sql.toLowerCase().includes("users"),
      );
      const targets = JSON.parse(String(usersInsert!.args[2])) as Array<{
        type: string;
      }>;
      expect(targets).toHaveLength(1);
      expect(targets[0].type).toBe("User");
    });

    it("upserts user with install_targets_json when installations is empty", async () => {
      // Arrange
      const stateValue = "2".repeat(32);
      const captured: FakeStmt[] = [];
      const db = makeZeroInstallDb(captured);
      stubZeroInstallFetch();
      const { app, env } = makeApp(db);

      // Act
      await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert
      const usersInsert = captured.find(
        (s) =>
          s.sql.toLowerCase().includes("insert") &&
          s.sql.toLowerCase().includes("users"),
      );
      expect(usersInsert).toBeDefined();
      expect(usersInsert!.sql).toContain("install_targets_json");
      const targets = JSON.parse(String(usersInsert!.args[2])) as Array<{
        login: string;
        type: string;
      }>;
      expect(targets.some((t) => t.login === "alice" && t.type === "User")).toBe(
        true,
      );
      expect(targets.some((t) => t.login === "Roxabi" && t.type === "Organization")).toBe(
        true,
      );
    });
  });
});
