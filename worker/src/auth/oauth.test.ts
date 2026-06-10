import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { loginRoute, callbackRoute } from "./oauth";

// ---------------------------------------------------------------------------
// FakeD1 — cloned from src/webhook/mutations.test.ts
// ---------------------------------------------------------------------------

type FakeResult = { value?: string; changes?: number; [k: string]: unknown };

interface FakeStmt {
  sql: string;
  args: unknown[];
  run: () => Promise<{ meta: { changes: number } }>;
  first: <T = FakeResult>() => Promise<T | null>;
  all: <T = FakeResult>() => Promise<{ results: T[] }>;
}

function makeFakeStmt(
  sql: string,
  args: unknown[],
  rows: FakeResult[],
  changes = 0,
): FakeStmt {
  return {
    sql,
    args,
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
    all: vi.fn().mockResolvedValue({ results: rows }),
  };
}

function makeFakeDb(
  stmtFactory: (sql: string, args: unknown[]) => FakeStmt,
): D1Database {
  const recorded: FakeStmt[] = [];

  const db = {
    prepare(sql: string) {
      let directStmt: FakeStmt | null = null;
      const getDirectStmt = (): FakeStmt => {
        if (!directStmt) {
          directStmt = stmtFactory(sql, []);
          recorded.push(directStmt);
        }
        return directStmt;
      };

      return {
        first<T = FakeResult>(): Promise<T | null> {
          return getDirectStmt().first<T>();
        },
        run(): Promise<{ meta: { changes: number } }> {
          return getDirectStmt().run();
        },
        all<T = FakeResult>(): Promise<{ results: T[] }> {
          return getDirectStmt().all<T>();
        },
        bind(...args: unknown[]) {
          const stmt = stmtFactory(sql, args);
          recorded.push(stmt);
          return stmt;
        },
      };
    },
    batch: vi.fn(async (stmts: FakeStmt[]) => {
      await Promise.all(stmts.map((s) => s.run()));
      return stmts.map(() => ({ results: [], meta: { changes: 0 } }));
    }),
    _recorded: recorded,
  } as unknown as D1Database & { _recorded: FakeStmt[] };

  return db;
}

/** Capture all statements produced via bind() calls on the FakeDb. */
function captureDb(): { db: D1Database; stmts: () => FakeStmt[] } {
  const captured: FakeStmt[] = [];
  const db = makeFakeDb((sql, args) => {
    const stmt = makeFakeStmt(sql, args, [], 0);
    captured.push(stmt);
    return stmt;
  });
  return { db, stmts: () => captured };
}

/**
 * Build a FakeD1 whose prepare().bind().first() returns the given row the first
 * time it is called, then null thereafter. Used to model single-use state lookup.
 */
function captureDbWithFirstRow(
  firstRowBySql: Map<string, FakeResult | null>,
): { db: D1Database; stmts: () => FakeStmt[] } {
  const captured: FakeStmt[] = [];
  const callCounts = new Map<string, number>();
  const db = makeFakeDb((sql, args) => {
    const count = callCounts.get(sql) ?? 0;
    callCounts.set(sql, count + 1);
    const rowForSql = firstRowBySql.get(sql);
    // Return the configured row only on the first call with this SQL.
    const row = count === 0 ? (rowForSql ?? null) : null;
    const stmt = makeFakeStmt(sql, args, row !== null ? [row] : [], 0);
    // Override first() to return the per-call row.
    (stmt as { first: <T>() => Promise<T | null> }).first = vi
      .fn()
      .mockResolvedValue(row);
    captured.push(stmt);
    return stmt;
  });
  return { db, stmts: () => captured };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal Env stub — only the fields needed for OAuth routes. */
function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: {} as Fetcher,
    GITHUB_TOKEN: "gh-token",
    GITHUB_ORG: "Roxabi",
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
    it("returns 302 redirect", async () => {
      // Arrange
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        "http://localhost/login",
        { method: "GET" },
        env,
      );

      // Assert
      expect(res.status).toBe(302);
    });

    it("Location starts with https://github.com/login/oauth/authorize", async () => {
      // Arrange
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        "http://localhost/login",
        { method: "GET" },
        env,
      );

      // Assert
      const location = res.headers.get("Location") ?? "";
      expect(location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
    });

    it("Location query includes client_id matching env", async () => {
      // Arrange
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        "http://localhost/login",
        { method: "GET" },
        env,
      );

      // Assert
      const location = res.headers.get("Location") ?? "";
      const url = new URL(location);
      expect(url.searchParams.get("client_id")).toBe("Iv1.abc123");
    });

    it("Location query includes state as 32 hex chars", async () => {
      // Arrange
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        "http://localhost/login",
        { method: "GET" },
        env,
      );

      // Assert
      const location = res.headers.get("Location") ?? "";
      const url = new URL(location);
      const state = url.searchParams.get("state") ?? "";
      expect(state).toMatch(/^[0-9a-f]{32}$/);
    });

    it("Location redirect_uri ends with /oauth/callback derived from request origin", async () => {
      // Arrange
      const { db } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        "http://myapp.example.com/login",
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
      await app.request("http://localhost/login", { method: "GET" }, env);

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
      await app.request("http://localhost/login", { method: "GET" }, env);

      // Assert
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      // args[0] = state (32 hex), args[1] = redirectAfter
      expect(insertStmt!.args[0]).toMatch(/^[0-9a-f]{32}$/);
      expect(insertStmt!.args[1]).toBe("/"); // default when no ?redirect param
    });

    it("?redirect=/dash stores '/dash' as redirect_after", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      await app.request(
        "http://localhost/login?redirect=/dash",
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

    it("?redirect=//evil stores '/' (open-redirect guard)", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      await app.request(
        "http://localhost/login?redirect=//evil",
        { method: "GET" },
        env,
      );

      // Assert
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.args[1]).toBe("/");
    });

    it("?redirect=https://evil stores '/' (absolute URL guard)", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const { app, env } = makeApp(db);

      // Act
      await app.request(
        "http://localhost/login?redirect=https://evil",
        { method: "GET" },
        env,
      );

      // Assert
      const insertStmt = stmts().find((s) =>
        s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(insertStmt).toBeDefined();
      expect(insertStmt!.args[1]).toBe("/");
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
      // Arrange — FakeD1 first() returns null for oauth_state lookup
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

    it("issues DELETE FROM oauth_state to consume state single-use", async () => {
      // Arrange
      const stateValue = "a".repeat(32);
      const stateRowBySql = new Map<string, FakeResult | null>([
        [
          // The SELECT that looks up the state row — matched via substring
          "SELECT redirect_after FROM oauth_state WHERE state = ? AND expires_at > datetime('now')",
          { redirect_after: "/" } as FakeResult,
        ],
      ]);
      // Use a flexible factory so ANY sql with oauth_state SELECT returns the row
      const captured: FakeStmt[] = [];
      let oauthSelectCallCount = 0;
      const db = makeFakeDb((sql, args) => {
        const isOauthSelect =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("select");
        oauthSelectCallCount += isOauthSelect ? 1 : 0;
        const row =
          isOauthSelect && oauthSelectCallCount === 1
            ? ({ redirect_after: "/" } as FakeResult)
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

        // For sessions INSERT
        const isSessionInsert =
          sql.toLowerCase().includes("sessions") &&
          sql.toLowerCase().includes("insert");

        const rows = isOauthSelect
          ? (row ? [row] : [])
          : isUsersInsert
            ? (usersRow ? [usersRow] : [])
            : isTenantsInsert
              ? (tenantsRow ? [tenantsRow] : [])
              : [];

        const stmt = makeFakeStmt(sql, args, rows, 0);
        if (isOauthSelect) {
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

      // Assert — a DELETE FROM oauth_state statement was issued
      const deleteStmt = captured.find(
        (s) =>
          s.sql.toLowerCase().includes("delete") &&
          s.sql.toLowerCase().includes("oauth_state"),
      );
      expect(deleteStmt).toBeDefined();
    });

    it("issues users upsert with ON CONFLICT(github_id)", async () => {
      // Arrange
      const stateValue = "b".repeat(32);
      let oauthSelectCallCount = 0;
      const captured: FakeStmt[] = [];
      const db = makeFakeDb((sql, args) => {
        const isOauthSelect =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("select");
        oauthSelectCallCount += isOauthSelect ? 1 : 0;
        const row =
          isOauthSelect && oauthSelectCallCount === 1
            ? ({ redirect_after: "/" } as FakeResult)
            : null;
        const isUsersInsert =
          sql.toLowerCase().includes("users") &&
          sql.toLowerCase().includes("returning");
        const usersRow = isUsersInsert ? ({ id: 1 } as FakeResult) : null;
        const isTenantsInsert =
          sql.toLowerCase().includes("tenants") &&
          sql.toLowerCase().includes("returning");
        const tenantsRow = isTenantsInsert ? ({ id: 10 } as FakeResult) : null;

        const stmt = makeFakeStmt(sql, args, [], 0);
        if (isOauthSelect) {
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
      let oauthSelectCallCount = 0;
      const captured: FakeStmt[] = [];
      const db = makeFakeDb((sql, args) => {
        const isOauthSelect =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("select");
        oauthSelectCallCount += isOauthSelect ? 1 : 0;
        const row =
          isOauthSelect && oauthSelectCallCount === 1
            ? ({ redirect_after: "/" } as FakeResult)
            : null;
        const isUsersInsert =
          sql.toLowerCase().includes("users") &&
          sql.toLowerCase().includes("returning");
        const usersRow = isUsersInsert ? ({ id: 1 } as FakeResult) : null;
        const isTenantsInsert =
          sql.toLowerCase().includes("tenants") &&
          sql.toLowerCase().includes("returning");
        const tenantsRow = isTenantsInsert ? ({ id: 10 } as FakeResult) : null;

        const stmt = makeFakeStmt(sql, args, [], 0);
        if (isOauthSelect) {
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
      let oauthSelectCallCount = 0;
      const captured: FakeStmt[] = [];
      const db = makeFakeDb((sql, args) => {
        const isOauthSelect =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("select");
        oauthSelectCallCount += isOauthSelect ? 1 : 0;
        const row =
          isOauthSelect && oauthSelectCallCount === 1
            ? ({ redirect_after: "/" } as FakeResult)
            : null;
        const isUsersInsert =
          sql.toLowerCase().includes("users") &&
          sql.toLowerCase().includes("returning");
        const usersRow = isUsersInsert ? ({ id: 1 } as FakeResult) : null;
        const isTenantsInsert =
          sql.toLowerCase().includes("tenants") &&
          sql.toLowerCase().includes("returning");
        const tenantsRow = isTenantsInsert ? ({ id: 10 } as FakeResult) : null;

        const stmt = makeFakeStmt(sql, args, [], 0);
        if (isOauthSelect) {
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

    it("returns 302 with Set-Cookie __Host-session containing HttpOnly Secure SameSite=Strict Path=/ and NO Domain", async () => {
      // Arrange
      const stateValue = "e".repeat(32);
      let oauthSelectCallCount = 0;
      const db = makeFakeDb((sql, _args) => {
        const isOauthSelect =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("select");
        oauthSelectCallCount += isOauthSelect ? 1 : 0;
        const row =
          isOauthSelect && oauthSelectCallCount === 1
            ? ({ redirect_after: "/" } as FakeResult)
            : null;
        const isUsersInsert =
          sql.toLowerCase().includes("users") &&
          sql.toLowerCase().includes("returning");
        const usersRow = isUsersInsert ? ({ id: 1 } as FakeResult) : null;
        const isTenantsInsert =
          sql.toLowerCase().includes("tenants") &&
          sql.toLowerCase().includes("returning");
        const tenantsRow = isTenantsInsert ? ({ id: 10 } as FakeResult) : null;

        const stmt = makeFakeStmt(sql, _args, [], 0);
        if (isOauthSelect) {
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
        return stmt;
      });

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
      expect(res.status).toBe(302);
      const cookie = res.headers.get("Set-Cookie") ?? "";
      expect(cookie).toContain("__Host-session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).not.toContain("Domain");
    });
  });

  describe("replay attack — state already consumed (first()→null on 2nd call)", () => {
    it("returns 400 on replay (state gone after first use)", async () => {
      // Arrange — state row returns null (simulating already-consumed state)
      const { db } = captureDb();
      const { app, env } = makeApp(db);
      // captureDb returns null for first() by default — models "state not found"

      // Act
      const res = await app.request(
        "http://localhost/oauth/callback?code=replaycode&state=aaaa0000bbbb1111cccc2222dddd3333",
        { method: "GET" },
        env,
      );

      // Assert — state is unknown (null row) → 400
      expect(res.status).toBe(400);
    });
  });

  describe("zero installations", () => {
    it("returns 302 to GitHub app install page when installations is empty", async () => {
      // Arrange
      const stateValue = "f".repeat(32);
      let oauthSelectCallCount = 0;
      const db = makeFakeDb((sql, _args) => {
        const isOauthSelect =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("select");
        oauthSelectCallCount += isOauthSelect ? 1 : 0;
        const row =
          isOauthSelect && oauthSelectCallCount === 1
            ? ({ redirect_after: "/" } as FakeResult)
            : null;
        const isUsersInsert =
          sql.toLowerCase().includes("users") &&
          sql.toLowerCase().includes("returning");
        const usersRow = isUsersInsert ? ({ id: 1 } as FakeResult) : null;

        const stmt = makeFakeStmt(sql, _args, [], 0);
        if (isOauthSelect) {
          (stmt as { first: <T>() => Promise<T | null> }).first = vi
            .fn()
            .mockResolvedValue(row);
        } else if (isUsersInsert) {
          (stmt as { first: <T>() => Promise<T | null> }).first = vi
            .fn()
            .mockResolvedValue(usersRow);
        }
        return stmt;
      });

      // Stub fetch with empty installations
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
          } else {
            return new Response(
              JSON.stringify({ installations: [] }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }),
      );

      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert
      expect(res.status).toBe(302);
      const location = res.headers.get("Location") ?? "";
      expect(location).toContain("github.com/apps/");
      expect(location).toContain("installations/new");
    });

    it("does NOT set a session cookie when installations is empty", async () => {
      // Arrange
      const stateValue = "0".repeat(32);
      let oauthSelectCallCount = 0;
      const db = makeFakeDb((sql, _args) => {
        const isOauthSelect =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("select");
        oauthSelectCallCount += isOauthSelect ? 1 : 0;
        const row =
          isOauthSelect && oauthSelectCallCount === 1
            ? ({ redirect_after: "/" } as FakeResult)
            : null;
        const isUsersInsert =
          sql.toLowerCase().includes("users") &&
          sql.toLowerCase().includes("returning");
        const usersRow = isUsersInsert ? ({ id: 1 } as FakeResult) : null;

        const stmt = makeFakeStmt(sql, _args, [], 0);
        if (isOauthSelect) {
          (stmt as { first: <T>() => Promise<T | null> }).first = vi
            .fn()
            .mockResolvedValue(row);
        } else if (isUsersInsert) {
          (stmt as { first: <T>() => Promise<T | null> }).first = vi
            .fn()
            .mockResolvedValue(usersRow);
        }
        return stmt;
      });

      let fetchCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string) => {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return new Response(
              JSON.stringify({ access_token: "tok" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          } else if (fetchCallCount === 2) {
            return new Response(
              JSON.stringify({ id: 42, login: "alice" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          } else {
            return new Response(
              JSON.stringify({ installations: [] }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }),
      );

      const { app, env } = makeApp(db);

      // Act
      const res = await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert — no Set-Cookie header when no installations
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });

    it("does NOT insert a session row when installations is empty", async () => {
      // Arrange
      const stateValue = "1".repeat(32);
      let oauthSelectCallCount = 0;
      const captured: FakeStmt[] = [];
      const db = makeFakeDb((sql, args) => {
        const isOauthSelect =
          sql.toLowerCase().includes("oauth_state") &&
          sql.toLowerCase().includes("select");
        oauthSelectCallCount += isOauthSelect ? 1 : 0;
        const row =
          isOauthSelect && oauthSelectCallCount === 1
            ? ({ redirect_after: "/" } as FakeResult)
            : null;
        const isUsersInsert =
          sql.toLowerCase().includes("users") &&
          sql.toLowerCase().includes("returning");
        const usersRow = isUsersInsert ? ({ id: 1 } as FakeResult) : null;

        const stmt = makeFakeStmt(sql, args, [], 0);
        if (isOauthSelect) {
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

      let fetchCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string) => {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return new Response(
              JSON.stringify({ access_token: "tok" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          } else if (fetchCallCount === 2) {
            return new Response(
              JSON.stringify({ id: 42, login: "alice" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          } else {
            return new Response(
              JSON.stringify({ installations: [] }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }),
      );

      const { app, env } = makeApp(db);

      // Act
      await app.request(
        `http://localhost/oauth/callback?code=mycode&state=${stateValue}`,
        { method: "GET" },
        env,
      );

      // Assert — no INSERT INTO sessions statement
      const sessionsInsert = captured.find(
        (s) =>
          s.sql.toLowerCase().includes("sessions") &&
          s.sql.toLowerCase().includes("insert"),
      );
      expect(sessionsInsert).toBeUndefined();
    });
  });
});
