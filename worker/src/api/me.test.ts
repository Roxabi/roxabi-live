import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "../auth/session";
import type { AuthEnv, SessionContext } from "../auth/types";
import { captureDb, captureDbWithRows } from "../test-utils";
import type { Env } from "../types";
import { logoutRoute, meRoute } from "./me";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUB_SESSION: SessionContext = {
  userId: 7,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

/** Build a minimal Env with the given D1 instance. */
function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

/**
 * Build a test Hono app with a stub middleware that injects STUB_SESSION,
 * then mounts meRoute + logoutRoute.
 * This tests the route handlers in isolation — independent of requireSession.
 */
function makeApp(_db: D1Database, session: SessionContext = STUB_SESSION): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // Stub middleware: injects session without any cookie/DB check
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });

  app.get("/api/me", meRoute);
  app.post("/api/logout", logoutRoute);

  return app;
}

// ---------------------------------------------------------------------------
// meRoute
// ---------------------------------------------------------------------------

describe("meRoute", () => {
  it("includes zk_opt_in on user (defaults false when users row missing)", async () => {
    const { db } = captureDb();
    const app = makeApp(db);
    const res = await app.request("/api/me", {}, makeEnv(db));
    const body = (await res.json()) as { user: { zk_opt_in: boolean } };
    expect(body.user.zk_opt_in).toBe(false);
  });

  it("includes zk_account_key_enabled and zk_enrolled defaults", async () => {
    const { db } = captureDb();
    const app = makeApp(db);
    const res = await app.request("/api/me", {}, makeEnv(db));
    const body = (await res.json()) as {
      user: { zk_account_key_enabled: boolean; zk_enrolled: boolean };
    };
    expect(body.user.zk_account_key_enabled).toBe(false);
    expect(body.user.zk_enrolled).toBe(false);
  });

  it("returns zk_enrolled true when backup row exists", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_key_backups")) return [{ ok: 1 }];
      if (sql.includes("zk_opt_in")) return [{ zk_opt_in: 1 }];
      return [];
    });
    const res = await makeApp(db).request("/api/me", {}, makeEnv(db));
    const body = (await res.json()) as { user: { zk_enrolled: boolean } };
    expect(body.user.zk_enrolled).toBe(true);
  });

  it("returns zk_account_key_enabled when env flag set", async () => {
    const { db } = captureDb();
    const env = { ...makeEnv(db), ZK_ACCOUNT_KEY: "1" };
    const res = await makeApp(db).request("/api/me", {}, env);
    const body = (await res.json()) as { user: { zk_account_key_enabled: boolean } };
    expect(body.user.zk_account_key_enabled).toBe(true);
  });

  it("returns zk_opt_in true when users row has flag set", async () => {
    const { db } = captureDb((sql) => {
      if (sql.toLowerCase().includes("zk_opt_in")) {
        return [{ zk_opt_in: 1 }];
      }
      return [];
    });
    const app = makeApp(db);
    const res = await app.request("/api/me", {}, makeEnv(db));
    const body = (await res.json()) as { user: { zk_opt_in: boolean } };
    expect(body.user.zk_opt_in).toBe(true);
  });

  it("returns 200 with user fields from injected session", async () => {
    // Arrange
    const { db } = captureDb();
    const app = makeApp(db);

    // Act
    const res = await app.request("/api/me", {}, makeEnv(db));

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { github_id: number; github_login: string } };
    expect(body.user.github_id).toBe(42);
    expect(body.user.github_login).toBe("alice");
  });

  it("response body contains an installations array", async () => {
    // Arrange
    const { db } = captureDb();
    const app = makeApp(db);

    // Act
    const res = await app.request("/api/me", {}, makeEnv(db));

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installations: unknown[] };
    expect(Array.isArray(body.installations)).toBe(true);
  });

  it("installations SELECT references user_installations table", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const app = makeApp(db);

    // Act
    await app.request("/api/me", {}, makeEnv(db));

    // Assert — the SQL issued must mention user_installations
    const installStmt = stmts().find((s) => s.sql.includes("user_installations"));
    expect(installStmt).toBeDefined();
    expect(installStmt?.sql).toContain("user_installations");
  });

  it("installations SELECT JOINs the tenants table", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const app = makeApp(db);

    // Act
    await app.request("/api/me", {}, makeEnv(db));

    // Assert — the SQL must JOIN tenants
    const installStmt = stmts().find((s) => s.sql.includes("user_installations"));
    expect(installStmt).toBeDefined();
    expect(installStmt?.sql).toContain("JOIN tenants");
  });

  it("surfaces installation rows returned by D1 in the response body", async () => {
    // Arrange — FakeD1 returns one installation row
    const fakeRow = { tenant_id: 9, account_login: "Roxabi", account_type: "Organization" };
    const { db } = captureDbWithRows([fakeRow]);
    const app = makeApp(db);

    // Act
    const res = await app.request("/api/me", {}, makeEnv(db));

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installations: (typeof fakeRow)[] };
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]).toMatchObject({
      tenant_id: 9,
      account_login: "Roxabi",
      account_type: "Organization",
    });
  });

  it("installations SELECT does NOT project installation_id (#171 — unnecessary exposure removed)", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const app = makeApp(db);

    // Act
    await app.request("/api/me", {}, makeEnv(db));

    // Assert — installation_id is internal infra detail, not surfaced to clients
    const installStmt = stmts().find((s) => s.sql.includes("user_installations"));
    expect(installStmt).toBeDefined();
    expect(installStmt?.sql).not.toContain("installation_id");
  });

  it("response includes active_tenant_id from the session (#148 SC7)", async () => {
    // Arrange
    const { db } = captureDb();
    const app = makeApp(db);

    // Act
    const res = await app.request("/api/me", {}, makeEnv(db));

    // Assert — the active tenant is surfaced so the client can render the tenant switcher
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active_tenant_id: number };
    expect(body.active_tenant_id).toBe(STUB_SESSION.tenantId);
  });

  it("returns install_pending and install_targets when session has no tenant", async () => {
    const targetsJson = JSON.stringify([
      { id: 42, login: "alice", type: "User" },
      { id: 77, login: "Roxabi", type: "Organization" },
    ]);
    const { db } = captureDb((sql) => {
      if (sql.includes("install_targets_json")) {
        return [{ zk_opt_in: 1, install_targets_json: targetsJson, consent_at: null }];
      }
      if (sql.includes("user_installations")) return [];
      return [];
    });
    const pendingSession: SessionContext = {
      ...STUB_SESSION,
      tenantId: null,
    };
    const res = await makeApp(db, pendingSession).request("/api/me", {}, makeEnv(db));
    const body = (await res.json()) as {
      install_pending: boolean;
      install_targets: Array<{ login: string }>;
      active_tenant_id: number | null;
      installations: unknown[];
    };
    expect(body.install_pending).toBe(true);
    expect(body.active_tenant_id).toBeNull();
    expect(body.installations).toEqual([]);
    expect(body.install_targets.map((t) => t.login)).toEqual(["alice", "Roxabi"]);
  });

  it("suppresses install_targets once a tenant is linked", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("install_targets_json")) {
        return [{ zk_opt_in: 1, install_targets_json: "[]", consent_at: "2026-01-01T00:00:00Z" }];
      }
      if (sql.includes("user_installations")) {
        return [{ tenant_id: 9, account_login: "Roxabi", account_type: "Organization" }];
      }
      return [];
    });
    const res = await makeApp(db).request("/api/me", {}, makeEnv(db));
    const body = (await res.json()) as {
      install_pending: boolean;
      install_targets: unknown[];
    };
    expect(body.install_pending).toBe(false);
    expect(body.install_targets).toEqual([]);
  });

  it("installations SELECT filters soft-deleted tenants", async () => {
    const { db, stmts } = captureDb();
    await makeApp(db).request("/api/me", {}, makeEnv(db));
    const installStmt = stmts().find((s) => s.sql.includes("user_installations"));
    expect(installStmt?.sql).toContain("deleted_at IS NULL");
  });

  it("installations SELECT projects account_type (#148 SC7)", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const app = makeApp(db);

    // Act
    await app.request("/api/me", {}, makeEnv(db));

    // Assert — account_type must be selected so User vs Organization tenants are distinguishable
    const installStmt = stmts().find((s) => s.sql.includes("user_installations"));
    expect(installStmt).toBeDefined();
    expect(installStmt?.sql).toContain("account_type");
  });

  it("returns 401 when requireSession finds no session cookie (negative guard test)", async () => {
    // Arrange — separate throwaway app mounting real requireSession, no stub session
    // This verifies the guard is not tautological: deleting requireSession would let
    // the request reach the handler without a session, changing the response.
    const { db } = captureDb();
    const guardApp = new Hono<AuthEnv>();
    guardApp.use("/api/me", requireSession);
    guardApp.get("/api/me", meRoute);

    // Act — no Cookie header → requireSession should fail closed with 401
    const res = await guardApp.request("/api/me", {}, makeEnv(db));

    // Assert
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// logoutRoute
// ---------------------------------------------------------------------------

describe("logoutRoute", () => {
  it("returns 204 on successful logout", async () => {
    // Arrange
    const { db } = captureDb();
    const app = makeApp(db);

    // Act
    const res = await app.request(
      "/api/logout",
      { method: "POST", headers: { Cookie: "__Host-session=raw-test-token" } },
      makeEnv(db),
    );

    // Assert
    expect(res.status).toBe(204);
  });

  it("issues DELETE FROM sessions WHERE token_hash when cookie present", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const app = makeApp(db);

    // Act
    await app.request(
      "/api/logout",
      { method: "POST", headers: { Cookie: "__Host-session=raw-test-token" } },
      makeEnv(db),
    );

    // Assert — the SQL must be DELETE FROM sessions keyed on token_hash
    const deleteStmt = stmts().find((s) => s.sql.includes("DELETE FROM sessions"));
    expect(deleteStmt).toBeDefined();
    expect(deleteStmt?.sql).toContain("token_hash");
  });

  it("binds a 64-char hex hash (SHA-256 of raw token) — not the raw token itself", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const app = makeApp(db);

    // Act
    await app.request(
      "/api/logout",
      { method: "POST", headers: { Cookie: "__Host-session=raw-test-token" } },
      makeEnv(db),
    );

    // Assert — args[0] must be a 64-char lowercase hex string (SHA-256 digest)
    const deleteStmt = stmts().find((s) => s.sql.includes("DELETE FROM sessions"));
    expect(deleteStmt).toBeDefined();
    expect(deleteStmt?.args[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Set-Cookie response header clears the session cookie (Max-Age=0)", async () => {
    // Arrange
    const { db } = captureDb();
    const app = makeApp(db);

    // Act
    const res = await app.request(
      "/api/logout",
      { method: "POST", headers: { Cookie: "__Host-session=raw-test-token" } },
      makeEnv(db),
    );

    // Assert
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("roxabi_session");
  });

  it("does NOT issue DELETE when no session cookie is present", async () => {
    // Arrange — no Cookie header → logoutRoute guards if (raw) before calling deleteSession
    const { db, stmts } = captureDb();
    const app = makeApp(db);

    // Act
    const res = await app.request("/api/logout", { method: "POST" }, makeEnv(db));

    // Assert — no DELETE FROM sessions should have been issued
    const deleteStmt = stmts().find((s) => s.sql.includes("DELETE FROM sessions"));
    expect(deleteStmt).toBeUndefined();
    // Should still succeed (204) even with no cookie
    expect(res.status).toBe(204);
  });

  it("returns 204 + clears session cookie even when no Cookie header is present (ungated — null-safe)", async () => {
    // Arrange — bare app with no requireSession, no stub session middleware.
    // This is the negative guard test: if /logout were gated by requireSession,
    // this request (no cookie) would return 401 instead of 204, proving the guard was
    // present. Its 204 response proves the route is truly ungated and null-safe.
    const { db } = captureDb();
    const logoutApp = new Hono<AuthEnv>();
    logoutApp.post("/logout", logoutRoute);

    // Act — POST /logout with no Cookie header
    const res = await logoutApp.request("/logout", { method: "POST" }, makeEnv(db));

    // Assert
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("roxabi_session=");
    expect(setCookie).toContain("Max-Age=0");
  });
});
