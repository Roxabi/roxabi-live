import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// NOTE: session.ts does not exist yet — these tests are intentionally RED.
// They define the contract that session.ts must satisfy (T6 task).
// ---------------------------------------------------------------------------

import {
  mintSession,
  validateSession,
  deleteSession,
  requireSession,
} from "./session";
import { sessionCookie, clearSessionCookie, sessionRedirectHtml } from "./cookies";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./types";
import type { AuthEnv, SessionContext } from "./types";
import type { Env } from "../types";

import type { FakeResult, FakeStmt } from "../test-utils";
import { makeFakeStmt, makeFakeDb, captureDb, fixedFirstDb } from "../test-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// mintSession
// ---------------------------------------------------------------------------

describe("mintSession", () => {
  it("INSERT SQL contains datetime('now', '+8 hours') for expires_at", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    await mintSession(db, 7, 9);
    // Assert
    expect(stmts()[0].sql).toContain("datetime('now', '+8 hours')");
  });

  it("binds exactly 3 args: [userId, tenantId, token_hash]", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    await mintSession(db, 7, 9);
    // Assert
    expect(stmts()[0].args).toHaveLength(3);
    expect(stmts()[0].args[0]).toBe(7);
    expect(stmts()[0].args[1]).toBe(9);
  });

  it("arg[2] (token_hash) is a 64-char lowercase hex string", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    await mintSession(db, 7, 9);
    // Assert
    const hash = stmts()[0].args[2];
    expect(typeof hash).toBe("string");
    expect(hash).toMatch(HEX64_RE);
  });

  it("returned raw token is a 64-char lowercase hex string", async () => {
    // Arrange
    const { db } = captureDb();
    // Act
    const raw = await mintSession(db, 7, 9);
    // Assert
    expect(raw).toMatch(HEX64_RE);
  });

  it("returned raw token is NOT the stored token_hash (raw ≠ sha256(raw))", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    const raw = await mintSession(db, 7, 9);
    // Assert — the raw token must differ from its own hash stored in arg[2]
    const storedHash = stmts()[0].args[2];
    expect(raw).not.toBe(storedHash);
  });

  it("two consecutive calls produce different raw tokens (randomness)", async () => {
    // Arrange
    const { db: db1 } = captureDb();
    const { db: db2 } = captureDb();
    // Act
    const raw1 = await mintSession(db1, 1, 1);
    const raw2 = await mintSession(db2, 1, 1);
    // Assert
    expect(raw1).not.toBe(raw2);
  });
});

// ---------------------------------------------------------------------------
// validateSession — SQL guard clauses
// ---------------------------------------------------------------------------

describe("validateSession — SQL guard clauses", () => {
  it("SQL contains token_hash = ? clause", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    await validateSession(db, "a".repeat(64));
    // Assert
    expect(stmts()[0].sql).toContain("token_hash = ?");
  });

  it("SQL contains expires_at > datetime('now') guard", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    await validateSession(db, "b".repeat(64));
    // Assert
    expect(stmts()[0].sql).toContain("expires_at > datetime('now')");
  });

  it("SQL contains revoked_at IS NULL guard", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    await validateSession(db, "c".repeat(64));
    // Assert
    expect(stmts()[0].sql).toContain("revoked_at IS NULL");
  });

  it("SQL contains NOT EXISTS subquery for tenant suspension", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    await validateSession(db, "d".repeat(64));
    // Assert
    expect(stmts()[0].sql).toContain("NOT EXISTS");
  });

  it("SQL contains suspended_at IS NOT NULL guard inside NOT EXISTS", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    await validateSession(db, "e".repeat(64));
    // Assert
    expect(stmts()[0].sql).toContain("suspended_at IS NOT NULL");
  });

  it("SQL contains EXISTS guard on user_installations membership (#185)", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    await validateSession(db, "g".repeat(64));
    // Assert
    expect(stmts()[0].sql).toContain("user_installations");
    expect(stmts()[0].sql).toContain("ui.user_id = s.user_id");
    expect(stmts()[0].sql).toContain("ui.tenant_id = s.tenant_id");
  });

  it("SQL allows install-pending sessions when tenant_id IS NULL", async () => {
    const { db, stmts } = captureDb();
    await validateSession(db, "h".repeat(64));
    expect(stmts()[0].sql).toContain("s.tenant_id IS NULL");
  });

  it("passes the hash of rawToken as the bound arg (¬raw token itself)", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const raw = "f".repeat(64);
    // Act
    await validateSession(db, raw);
    // Assert — bound arg must be a different value (the hash), not the raw token
    expect(stmts()[0].args[0]).not.toBe(raw);
    // The hash should itself be a 64-char hex string
    expect(stmts()[0].args[0]).toMatch(HEX64_RE);
  });
});

// ---------------------------------------------------------------------------
// validateSession — behaviour with FakeD1 rows
// ---------------------------------------------------------------------------

describe("validateSession — return value", () => {
  const SESSION_ROW: FakeResult = {
    userId: 7,
    tenantId: 9,
    githubId: 42,
    githubLogin: "alice",
  };

  it("returns the SessionContext when first() resolves with a row", async () => {
    // Arrange
    const db = fixedFirstDb(SESSION_ROW);
    // Act
    const result = await validateSession(db, "rawtoken");
    // Assert
    expect(result).toEqual({
      userId: 7,
      tenantId: 9,
      githubId: 42,
      githubLogin: "alice",
    });
  });

  it("returns null when first() resolves with null (expired/revoked/unknown)", async () => {
    // Arrange
    const db = fixedFirstDb(null);
    // Act
    const result = await validateSession(db, "rawtoken");
    // Assert
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateSession — suspended-tenant behavioral guard (mutation-catching)
// ---------------------------------------------------------------------------

describe("validateSession — suspended-tenant behavioral guard", () => {
  /**
   * SQL-discriminating FakeD1: if the executed SQL contains the
   * suspended_at IS NOT NULL guard (i.e. the guard is present in source),
   * first() returns null — correctly filtering out the suspended tenant.
   * If the guard is ABSENT from the SQL, first() returns a valid row —
   * which would make validateSession return non-null and break toBeNull().
   *
   * This test FAILS if the suspended-tenant guard is removed from
   * validateSession's SQL, because the fake would then return a row
   * and validateSession would return non-null instead of null.
   */
  it("returns null for a suspended tenant (guard is mutation-catching)", async () => {
    // Arrange — a valid session row that would be returned if the guard is absent
    const validRow: FakeResult = {
      userId: 7,
      tenantId: 9,
      githubId: 42,
      githubLogin: "alice",
    };

    const db = makeFakeDb((sql, args) => {
      // If the suspended-tenant guard is present in the SQL, simulate the DB
      // filtering out the row (suspended tenant → no result).
      // If the guard is absent, the DB returns a valid row — causing toBeNull() to fail.
      const guardPresent = sql.includes("suspended_at IS NOT NULL");
      return makeFakeStmt(sql, args, guardPresent ? [] : [validRow], 0);
    });

    // Act
    const result = await validateSession(db, "a".repeat(64));

    // Assert — suspended tenant session must be filtered out → null
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateSession — revoked membership behavioral guard (#185)
// ---------------------------------------------------------------------------

describe("validateSession — user_installations membership guard", () => {
  it("returns null when user_installations link is absent (guard is mutation-catching)", async () => {
    const validRow: FakeResult = {
      userId: 7,
      tenantId: 9,
      githubId: 42,
      githubLogin: "alice",
    };

    const db = makeFakeDb((sql, args) => {
      const membershipGuardPresent =
        sql.includes("user_installations") &&
        sql.includes("ui.user_id = s.user_id") &&
        sql.includes("ui.tenant_id = s.tenant_id");
      return makeFakeStmt(sql, args, membershipGuardPresent ? [] : [validRow], 0);
    });

    const result = await validateSession(db, "a".repeat(64));

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe("deleteSession", () => {
  it("issues DELETE FROM sessions WHERE token_hash = ?", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    await deleteSession(db, "rawtoken");
    // Assert
    expect(stmts()[0].sql).toContain("DELETE FROM sessions");
    expect(stmts()[0].sql).toContain("token_hash = ?");
  });

  it("binds the SHA-256 hash of the raw token, not the raw token itself", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const raw = "myrawtoken";
    // Act
    await deleteSession(db, raw);
    // Assert
    const bound = stmts()[0].args[0];
    expect(bound).not.toBe(raw);
    expect(bound).toMatch(HEX64_RE);
  });

  it("consistent hashing: same raw token → same hash in both deleteSession and mintSession", async () => {
    // Arrange — capture hash from mintSession, then verify deleteSession uses same hash
    const { db: mintDb, stmts: mintStmts } = captureDb();
    const raw = await mintSession(mintDb, 1, 1);
    const mintedHash = mintStmts()[0].args[2] as string;

    const { db: delDb, stmts: delStmts } = captureDb();
    // Act
    await deleteSession(delDb, raw);
    // Assert
    expect(delStmts()[0].args[0]).toBe(mintedHash);
  });
});

// ---------------------------------------------------------------------------
// requireSession middleware
// ---------------------------------------------------------------------------

describe("requireSession", () => {
  function buildApp(
    db: D1Database,
    probeHandler: (session: SessionContext) => Response = (s) =>
      new Response(JSON.stringify(s), { status: 200 }),
  ) {
    const app = new Hono<AuthEnv>();

    app.use("/protected", requireSession);
    app.get("/protected", (c) => {
      // requireSession guarantees session is set before next() is called;
      // the non-null assertion is safe here (the middleware returns 401 otherwise).
      const session = c.get("session")!;
      return probeHandler(session);
    });

    return app;
  }

  const VALID_SESSION: SessionContext = {
    userId: 7,
    tenantId: 9,
    githubId: 42,
    githubLogin: "alice",
  };

  it("returns 401 JSON {error:'unauthorized'} when no Cookie header is present", async () => {
    // Arrange
    const { db } = captureDb();
    const app = buildApp(db);
    const env = { DB: db } as unknown as Env;
    // Act
    const res = await app.request("/protected", { method: "GET" }, env);
    // Assert
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when Cookie is present but validateSession returns null (bad/expired token)", async () => {
    // Arrange — DB always returns null for first()
    const db = fixedFirstDb(null);
    const app = buildApp(db);
    const env = { DB: db } as unknown as Env;
    const cookieValue = `${SESSION_COOKIE}=badtoken`;
    // Act
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Cookie: cookieValue } },
      env,
    );
    // Assert
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("calls next and sets session context when token is valid", async () => {
    // Arrange — DB returns a valid session row
    const db = fixedFirstDb(VALID_SESSION as unknown as FakeResult);
    const app = buildApp(db);
    const env = { DB: db } as unknown as Env;
    // mintSession to get a valid raw token format (64-char hex)
    const { db: mintDb } = captureDb();
    const raw = await mintSession(mintDb, 7, 9);
    const cookieValue = `${SESSION_COOKIE}=${raw}`;
    // Act
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Cookie: cookieValue } },
      env,
    );
    // Assert — next handler ran, session was set
    expect(res.status).toBe(200);
    const body = await res.json<SessionContext>();
    expect(body.userId).toBe(7);
    expect(body.tenantId).toBe(9);
    expect(body.githubId).toBe(42);
    expect(body.githubLogin).toBe("alice");
  });

  it("returns 401 when Cookie header has wrong cookie name", async () => {
    // Arrange
    const db = fixedFirstDb(VALID_SESSION as unknown as FakeResult);
    const app = buildApp(db);
    const env = { DB: db } as unknown as Env;
    const cookieValue = `wrong-name=sometoken`;
    // Act
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Cookie: cookieValue } },
      env,
    );
    // Assert — no __Host-session cookie → 401
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// sessionRedirectHtml
// ---------------------------------------------------------------------------

describe("sessionRedirectHtml", () => {
  it("returns 200 HTML with Set-Cookie and destination in body", async () => {
    const res = sessionRedirectHtml("/dashboard?install=1", "a".repeat(64));
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("roxabi_session=");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Vary")).toBe("Cookie");
    const body = await res.text();
    expect(body).toContain("/auth/continue");
    expect(body).toContain("/api/me");
    expect(body).toContain("location.replace");
    expect(body).not.toContain("http-equiv");
  });

  it("rejects open-redirect destinations", async () => {
    const res = sessionRedirectHtml("//evil.test", "tok");
    const body = await res.text();
    expect(body).toContain("/auth/continue?to=%2Fdashboard");
    expect(body).not.toContain("//evil");
  });
});

// ---------------------------------------------------------------------------
// sessionCookie
// ---------------------------------------------------------------------------

describe("sessionCookie", () => {
  it("contains roxabi_session=<rawToken>", () => {
    // Arrange + Act
    const cookie = sessionCookie("abc123");
    // Assert
    expect(cookie).toContain("roxabi_session=abc123");
  });

  it("contains HttpOnly flag", () => {
    // Arrange + Act
    const cookie = sessionCookie("tok");
    // Assert
    expect(cookie).toContain("HttpOnly");
  });

  it("contains Secure flag", () => {
    // Arrange + Act
    const cookie = sessionCookie("tok");
    // Assert
    expect(cookie).toContain("Secure");
  });

  it("contains SameSite=Lax for OAuth return navigations", () => {
    // Arrange + Act
    const cookie = sessionCookie("tok");
    // Assert
    expect(cookie).toContain("SameSite=Lax");
  });

  it("contains Path=/", () => {
    // Arrange + Act
    const cookie = sessionCookie("tok");
    // Assert
    expect(cookie).toContain("Path=/");
  });

  it("contains Max-Age=28800 (8 hours)", () => {
    // Arrange + Act
    const cookie = sessionCookie("tok");
    // Assert
    expect(cookie).toContain("Max-Age=28800");
    // Verify SESSION_TTL_SECONDS export matches
    expect(SESSION_TTL_SECONDS).toBe(28800);
  });

  it("does NOT contain Domain attribute (__Host- prefix requires omission)", () => {
    // Arrange + Act
    const cookie = sessionCookie("tok");
    // Assert — __Host- prefix mandates no Domain attribute
    expect(cookie).not.toContain("Domain");
  });
});

// ---------------------------------------------------------------------------
// clearSessionCookie
// ---------------------------------------------------------------------------

describe("clearSessionCookie", () => {
  it("contains roxabi_session= (empty value)", () => {
    // Arrange + Act
    const cookie = clearSessionCookie();
    // Assert
    expect(cookie).toContain("roxabi_session=");
  });

  it("contains Max-Age=0 to expire the cookie immediately", () => {
    // Arrange + Act
    const cookie = clearSessionCookie();
    // Assert
    expect(cookie).toContain("Max-Age=0");
  });

  it("contains HttpOnly flag", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain("HttpOnly");
  });

  it("contains Secure flag", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain("Secure");
  });

  it("contains SameSite=Lax", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain("SameSite=Lax");
  });

  it("contains Path=/", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain("Path=/");
  });

  it("does NOT contain Domain attribute", () => {
    const cookie = clearSessionCookie();
    expect(cookie).not.toContain("Domain");
  });
});

// ---------------------------------------------------------------------------
// SESSION_COOKIE constant
// ---------------------------------------------------------------------------

describe("SESSION_COOKIE constant", () => {
  it("equals 'roxabi_session'", () => {
    expect(SESSION_COOKIE).toBe("roxabi_session");
  });
});
