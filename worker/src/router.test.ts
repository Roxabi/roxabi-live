/**
 * router.test.ts — auth gate fires before DB work.
 *
 * Verifies that requireSession short-circuits the /api/issues, /api/issues/*,
 * and /api/graph routes before any D1 access when no session cookie is present.
 * Also provides a positive control confirming the gate admits a valid session.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Env } from "./types";
import type { SessionContext } from "./auth/types";
import { app } from "./router";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// DB stub helpers
// ---------------------------------------------------------------------------

/**
 * Returns a D1Database stub whose .prepare throws if called.
 * Use this to assert the DB is never touched on the 401 path.
 */
function makeDbThatMustNotBeCalled(): D1Database {
  const errorMsg = "DB must not be touched on 401 path";
  return {
    prepare: vi.fn(() => {
      throw new Error(errorMsg);
    }),
    batch: vi.fn(() => {
      throw new Error(errorMsg);
    }),
    dump: vi.fn(() => {
      throw new Error(errorMsg);
    }),
    exec: vi.fn(() => {
      throw new Error(errorMsg);
    }),
  } as unknown as D1Database;
}

/**
 * Returns a D1Database stub that answers validateSession's query with a
 * valid session row, so requireSession admits the request.
 *
 * validateSession calls:
 *   db.prepare(SELECT … FROM sessions s JOIN users …).bind(hash).first()
 *
 * We intercept via bind().first() returning the stub row.
 */
function makeSessionDb(session: SessionContext): D1Database {
  const validRow = {
    userId: session.userId,
    tenantId: session.tenantId,
    githubId: session.githubId,
    githubLogin: session.githubLogin,
  };

  const bindStmt = {
    first: vi.fn().mockResolvedValue(validRow),
    run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    bind: vi.fn(function (this: unknown) { return this; }),
  };

  const stmt = {
    first: vi.fn().mockResolvedValue(validRow),
    run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    bind: vi.fn(() => bindStmt),
  };

  return {
    prepare: vi.fn(() => stmt),
    batch: vi.fn().mockResolvedValue([]),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Env builder
// ---------------------------------------------------------------------------

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: {
      fetch: async () => new Response("asset", { status: 200 }),
    } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

// Canonical stub session for positive control
const STUB_SESSION: SessionContext = {
  userId: 1,
  tenantId: 1,
  githubId: 1001,
  githubLogin: "octocat",
};

// A plausible raw session token (64-char hex)
const VALID_RAW_TOKEN = "a".repeat(64);

// ---------------------------------------------------------------------------
// Negative tests — no Cookie header → 401, DB must not be touched
// ---------------------------------------------------------------------------

describe("requireSession auth gate", () => {
  describe("GET /api/issues — no cookie", () => {
    it("returns 401 with {error: unauthorized}", async () => {
      // Arrange
      const db = makeDbThatMustNotBeCalled();
      const env = makeEnv(db);

      // Act
      const res = await app.request("/api/issues", {}, env);

      // Assert
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("unauthorized");
    });

    it("never calls DB.prepare on 401 path", async () => {
      // Arrange
      const db = makeDbThatMustNotBeCalled();
      const env = makeEnv(db);

      // Act — must not throw (DB.prepare is guarded by requireSession returning early)
      const res = await app.request("/api/issues", {}, env);

      // Assert — 401 means requireSession returned before touching DB
      expect(res.status).toBe(401);
      expect(db.prepare).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/issues/:key — no cookie", () => {
    it("returns 401 with {error: unauthorized}", async () => {
      // Arrange
      const db = makeDbThatMustNotBeCalled();
      const env = makeEnv(db);

      // Act — encoded Roxabi/alpha#42
      const res = await app.request(
        "/api/issues/Roxabi%2Falpha%2342",
        {},
        env,
      );

      // Assert
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("unauthorized");
    });

    it("never calls DB.prepare on 401 path", async () => {
      // Arrange
      const db = makeDbThatMustNotBeCalled();
      const env = makeEnv(db);

      // Act
      const res = await app.request(
        "/api/issues/Roxabi%2Falpha%2342",
        {},
        env,
      );

      // Assert
      expect(res.status).toBe(401);
      expect(db.prepare).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/graph — no cookie", () => {
    it("returns 401 with {error: unauthorized}", async () => {
      // Arrange
      const db = makeDbThatMustNotBeCalled();
      const env = makeEnv(db);

      // Act
      const res = await app.request("/api/graph", {}, env);

      // Assert
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("unauthorized");
    });

    it("never calls DB.prepare on 401 path", async () => {
      // Arrange
      const db = makeDbThatMustNotBeCalled();
      const env = makeEnv(db);

      // Act
      const res = await app.request("/api/graph", {}, env);

      // Assert
      expect(res.status).toBe(401);
      expect(db.prepare).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Positive control — valid session cookie must NOT produce 401
  // -------------------------------------------------------------------------

  describe("GET /install/complete — post-install return", () => {
    it("returns 302 to /login?redirect=/dashboard without touching DB", async () => {
      const db = makeDbThatMustNotBeCalled();
      const env = makeEnv(db);
      const res = await app.request("/install/complete", {}, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "/login?install=1&redirect=/dashboard",
      );
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      expect(db.prepare).not.toHaveBeenCalled();
    });
  });

  describe("GET /auth/exchange — post-OAuth cookie hop", () => {
    it("returns 400 when code is missing", async () => {
      const db = makeDbThatMustNotBeCalled();
      const env = makeEnv(db);
      const res = await app.request("/auth/exchange", {}, env);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /auth/continue — post-OAuth hop", () => {
    it("redirects to login when no session cookie", async () => {
      const db = makeDbThatMustNotBeCalled();
      const env = makeEnv(db);
      const res = await app.request(
        "/auth/continue?to=%2Fdashboard%3Finstall%3D1",
        {},
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "/login?redirect=%2Fdashboard%3Finstall%3D1",
      );
      expect(res.headers.get("Cache-Control")).toContain("no-store");
    });
  });

  describe("GET /auth/reset — stuck-profile recovery", () => {
    it("redirects home with Clear-Site-Data and clears session cookie", async () => {
      const db = makeDbThatMustNotBeCalled();
      const env = makeEnv(db);
      const res = await app.request("/auth/reset", {}, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
      expect(res.headers.get("Clear-Site-Data")).toContain("cache");
      expect(res.headers.get("Set-Cookie") ?? "").toContain("roxabi_session=;");
      expect(res.headers.get("Cache-Control")).toContain("no-store");
    });
  });

  describe("install-pending session — linked tenant required", () => {
    it("GET /api/graph returns 401 when session has null tenantId", async () => {
      const db = makeSessionDb({
        ...STUB_SESSION,
        tenantId: null,
      });
      const env = makeEnv(db);
      const res = await app.request(
        "/api/graph",
        { headers: { Cookie: `__Host-session=${VALID_RAW_TOKEN}` } },
        env,
      );
      expect(res.status).toBe(401);
    });

    it("POST /api/zk-opt-in returns 401 when session has null tenantId", async () => {
      const db = makeSessionDb({
        ...STUB_SESSION,
        tenantId: null,
      });
      const env = makeEnv(db);
      const res = await app.request(
        "/api/zk-opt-in",
        {
          method: "POST",
          headers: {
            Cookie: `__Host-session=${VALID_RAW_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ opt_in: true }),
        },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  describe("positive control — valid session cookie", () => {
    it("GET /api/issues with valid session does not return 401", async () => {
      // Arrange — DB answers validateSession's query with a valid row
      const db = makeSessionDb(STUB_SESSION);
      const env = makeEnv(db);

      // Act — send a plausible raw token in the __Host-session cookie
      const res = await app.request(
        "/api/issues",
        { headers: { Cookie: `__Host-session=${VALID_RAW_TOKEN}` } },
        env,
      );

      // Assert — gate passed; handler ran (may be 200 or non-401 error from handler)
      expect(res.status).not.toBe(401);
    });

    it("GET /api/graph with valid session does not return 401", async () => {
      // Arrange
      const db = makeSessionDb(STUB_SESSION);
      const env = makeEnv(db);

      // Act
      const res = await app.request(
        "/api/graph",
        { headers: { Cookie: `__Host-session=${VALID_RAW_TOKEN}` } },
        env,
      );

      // Assert
      expect(res.status).not.toBe(401);
    });

    it("GET /api/issues/:key with valid session does not return 401", async () => {
      // Arrange
      const db = makeSessionDb(STUB_SESSION);
      const env = makeEnv(db);

      // Act
      const res = await app.request(
        "/api/issues/Roxabi%2Falpha%2342",
        { headers: { Cookie: `__Host-session=${VALID_RAW_TOKEN}` } },
        env,
      );

      // Assert
      expect(res.status).not.toBe(401);
    });
  });
});
