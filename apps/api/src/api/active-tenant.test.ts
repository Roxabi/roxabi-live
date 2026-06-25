import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "../auth/types";
import { STUB_SESSION, captureDb, dispatchByTable, makeEnv } from "../test-utils";
import { activeTenantRoute } from "./active-tenant";

afterEach(() => {
  vi.restoreAllMocks();
});

// SESSION_COOKIE name — must match src/auth/session.ts SESSION_COOKIE constant.
const SESSION_COOKIE_NAME = "__Host-session";
const RAW_TOKEN = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const COOKIE_HEADER = `${SESSION_COOKIE_NAME}=${RAW_TOKEN}`;

// ---------------------------------------------------------------------------
// App builders
// ---------------------------------------------------------------------------

/** App with STUB_SESSION injected — simulates requireSession middleware passing. */
function makeApp(_db: ReturnType<typeof captureDb>["db"]): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.use("*", async (c, next) => {
    c.set("session", STUB_SESSION);
    await next();
  });

  app.post("/api/active-tenant", activeTenantRoute);

  return app;
}

/** App with NO session injected — simulates unauthenticated request. */
function makeAppNoSession(_db: ReturnType<typeof captureDb>["db"]): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.post("/api/active-tenant", activeTenantRoute);
  return app;
}

// ---------------------------------------------------------------------------
// Helper: POST /api/active-tenant
// ---------------------------------------------------------------------------

async function postActiveTenant(
  app: Hono<AuthEnv>,
  db: D1Database,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cookie) {
    headers.Cookie = cookie;
  }

  return app.request(
    "/api/active-tenant",
    {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    makeEnv(db),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("activeTenantRoute", () => {
  describe("POST /api/active-tenant — member switch (200)", () => {
    it("returns 200 with active_tenant_id and issues UPDATE sessions", async () => {
      // Arrange — membership row found AND target tenant not suspended → UPDATE runs.
      const { db, stmts } = captureDb((sql) =>
        dispatchByTable(sql, {
          user_installations: [{ 1: 1 }],
          tenants: [{ suspended_at: null }],
        }),
      );
      const app = makeApp(db);

      // Act
      const res = await postActiveTenant(app, db, { tenant_id: 2 }, COOKIE_HEADER);

      // Assert — status + body
      expect(res.status).toBe(200);
      const body = (await res.json()) as { active_tenant_id: number };
      expect(body.active_tenant_id).toBe(2);

      // Assert — an UPDATE sessions SET tenant_id statement was issued
      const updateStmt = stmts().find(
        (s) =>
          s.sql.toLowerCase().includes("update sessions") &&
          s.sql.toLowerCase().includes("tenant_id"),
      );
      expect(updateStmt).toBeDefined();
      expect(updateStmt?.sql).toMatch(/UPDATE sessions SET tenant_id/i);
    });
  });

  describe("POST /api/active-tenant — non-member (403)", () => {
    it("returns 403 when user has no membership row and issues NO UPDATE sessions", async () => {
      // Arrange — membership SELECT returns nothing.
      const { db, stmts } = captureDb(); // empty rows for every query
      const app = makeApp(db);

      // Act
      const res = await postActiveTenant(app, db, { tenant_id: 99 }, COOKIE_HEADER);

      // Assert — status + body
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("forbidden");

      // Assert — no UPDATE sessions was issued
      const updateStmt = stmts().find(
        (s) =>
          s.sql.toLowerCase().includes("update sessions") &&
          s.sql.toLowerCase().includes("tenant_id"),
      );
      expect(updateStmt).toBeUndefined();
    });
  });

  describe("POST /api/active-tenant — suspended tenant (403)", () => {
    it("returns 403 when the target tenant is suspended and issues NO UPDATE sessions", async () => {
      // Arrange — user IS a member, but the tenant carries a suspended_at timestamp.
      const { db, stmts } = captureDb((sql) =>
        dispatchByTable(sql, {
          user_installations: [{ 1: 1 }],
          tenants: [{ suspended_at: "2026-01-01T00:00:00.000Z" }],
        }),
      );
      const app = makeApp(db);

      // Act
      const res = await postActiveTenant(app, db, { tenant_id: 2 }, COOKIE_HEADER);

      // Assert — switch rejected before any session mutation
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("forbidden");

      const updateStmt = stmts().find(
        (s) =>
          s.sql.toLowerCase().includes("update sessions") &&
          s.sql.toLowerCase().includes("tenant_id"),
      );
      expect(updateStmt).toBeUndefined();
    });
  });

  describe("POST /api/active-tenant — missing / invalid tenant_id (400)", () => {
    it("returns 400 when body has no tenant_id field", async () => {
      // Arrange
      const { db } = captureDb();
      const app = makeApp(db);

      // Act
      const res = await postActiveTenant(app, db, {}, COOKIE_HEADER);

      // Assert
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("tenant_id required");
    });

    it("returns 400 when tenant_id is a string", async () => {
      // Arrange
      const { db } = captureDb();
      const app = makeApp(db);

      // Act
      const res = await postActiveTenant(app, db, { tenant_id: "two" }, COOKIE_HEADER);

      // Assert
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("tenant_id required");
    });

    it("returns 400 when tenant_id is a float", async () => {
      // Arrange
      const { db } = captureDb();
      const app = makeApp(db);

      // Act
      const res = await postActiveTenant(app, db, { tenant_id: 2.5 }, COOKIE_HEADER);

      // Assert
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("tenant_id required");
    });

    it("returns 400 when body is not valid JSON", async () => {
      // Arrange
      const { db } = captureDb();
      const app = makeApp(db);

      // Act — send a raw non-JSON body
      const res = await app.request(
        "/api/active-tenant",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: COOKIE_HEADER },
          body: "not-json",
        },
        makeEnv(db),
      );

      // Assert
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("tenant_id required");
    });
  });

  describe("POST /api/active-tenant — no session (401)", () => {
    it("returns 401 when no session is set on context", async () => {
      // Arrange — app without session-injecting middleware
      const { db } = captureDb();
      const app = makeAppNoSession(db);

      // Act
      const res = await postActiveTenant(app, db, { tenant_id: 2 }, COOKIE_HEADER);

      // Assert
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unauthorized");
    });
  });
});
