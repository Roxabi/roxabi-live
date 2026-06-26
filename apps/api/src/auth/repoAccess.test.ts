import type { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STUB_SESSION, captureDb, dispatchByTable, makeEnv } from "../test-utils";
import { checkPrivateAccess, resolveVisibleRepos } from "./repoAccess";
import type { AuthEnv } from "./types";

// ---------------------------------------------------------------------------
// Mock installToken module
// ---------------------------------------------------------------------------

vi.mock("./installToken", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("tok"),
  encryptToken: vi.fn(),
  decryptToken: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Hono Context stub carrying a session and DB env. */
function makeCtx(db: D1Database, session: AuthEnv["Variables"]["session"]): Context<AuthEnv> {
  const env = makeEnv(db);
  return {
    get: (key: string) => (key === "session" ? session : undefined),
    env,
  } as unknown as Context<AuthEnv>;
}

afterEach(() => {
  vi.clearAllMocks();
  // Reset global fetch after each test
  (globalThis as Record<string, unknown>).fetch = undefined;
});

// ---------------------------------------------------------------------------
// checkPrivateAccess — cache HIT
// ---------------------------------------------------------------------------

describe("checkPrivateAccess", () => {
  it("returns true from cache (has_access=1, fresh) without calling fetch", async () => {
    // Arrange
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        user_repo_permission_cache: [{ has_access: 1 }],
        tenants: [{ id: 1 }],
      }),
    );
    const env = makeEnv(db);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    // Act
    const result = await checkPrivateAccess(db, env, 1, 1, 42, "Roxabi/secret", "octocat");

    // Assert
    expect(result).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false from cache (has_access=0, fresh) without calling fetch", async () => {
    // Arrange
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        user_repo_permission_cache: [{ has_access: 0 }],
        tenants: [{ id: 1 }],
      }),
    );
    const env = makeEnv(db);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    // Act
    const result = await checkPrivateAccess(db, env, 1, 1, 42, "Roxabi/secret", "octocat");

    // Assert
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // cache MISS → fetch 204 → granted + UPSERT
  // -------------------------------------------------------------------------

  it("cache miss: fetch 204 → returns true and issues a cache UPSERT", async () => {
    // Arrange
    const { db, stmts } = captureDb((sql) =>
      dispatchByTable(sql, {
        user_repo_permission_cache: [], // miss
        tenants: [{ id: 1 }],
      }),
    );
    const env = makeEnv(db);
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 204 }) as typeof fetch;

    // Act
    const result = await checkPrivateAccess(db, env, 1, 1, 42, "Roxabi/secret", "octocat");

    // Assert — access granted
    expect(result).toBe(true);

    // Assert — a cache UPSERT statement was issued (INSERT INTO user_repo_permission_cache)
    const upsertStmt = stmts().find((s) =>
      s.sql.toLowerCase().includes("insert into user_repo_permission_cache"),
    );
    expect(upsertStmt).toBeDefined();
    expect(upsertStmt?.run).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // fetch 404 → denied
  // -------------------------------------------------------------------------

  it("cache miss: fetch 404 → returns false", async () => {
    // Arrange
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        user_repo_permission_cache: [],
        tenants: [{ id: 1 }],
      }),
    );
    const env = makeEnv(db);
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 404 }) as typeof fetch;

    // Act
    const result = await checkPrivateAccess(db, env, 1, 1, 42, "Roxabi/secret", "octocat");

    // Assert
    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // fetch 403 → denied
  // -------------------------------------------------------------------------

  it("cache miss: fetch 403 → returns false", async () => {
    // Arrange
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        user_repo_permission_cache: [],
        tenants: [{ id: 1 }],
      }),
    );
    const env = makeEnv(db);
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 403 }) as typeof fetch;

    // Act
    const result = await checkPrivateAccess(db, env, 1, 1, 42, "Roxabi/secret", "octocat");

    // Assert
    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // fetch throws (network) → denied AND no cache UPSERT
  // -------------------------------------------------------------------------

  it("cache miss: fetch throws → returns false and does NOT issue a cache UPSERT", async () => {
    // Arrange
    const { db, stmts } = captureDb((sql) =>
      dispatchByTable(sql, {
        user_repo_permission_cache: [],
        tenants: [{ id: 1 }],
      }),
    );
    const env = makeEnv(db);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error")) as typeof fetch;

    // Act
    const result = await checkPrivateAccess(db, env, 1, 1, 42, "Roxabi/secret", "octocat");

    // Assert — denied
    expect(result).toBe(false);

    // Assert — no UPSERT issued
    const upsertStmt = stmts().find((s) =>
      s.sql.toLowerCase().includes("insert into user_repo_permission_cache"),
    );
    expect(upsertStmt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveVisibleRepos
// ---------------------------------------------------------------------------

describe("resolveVisibleRepos", () => {
  // -------------------------------------------------------------------------
  // Public repo — always visible, no fetch
  // -------------------------------------------------------------------------

  it("public repo (is_private=0) → visible without getInstallationToken or fetch", async () => {
    // Arrange
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        tenant_repo_access: [{ repo: "Roxabi/public", is_private: 0 }],
      }),
    );
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const ctx = makeCtx(db, STUB_SESSION);

    // Act
    const visible = await resolveVisibleRepos(ctx);

    // Assert
    expect(visible).toEqual(["Roxabi/public"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Empty tenant_repo_access → []
  // -------------------------------------------------------------------------

  it("empty tenant_repo_access → resolveVisibleRepos returns []", async () => {
    // Arrange
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        tenant_repo_access: [],
      }),
    );
    const ctx = makeCtx(db, STUB_SESSION);

    // Act
    const visible = await resolveVisibleRepos(ctx);

    // Assert
    expect(visible).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // No session on context → []
  // -------------------------------------------------------------------------

  it("no session on context → resolveVisibleRepos returns []", async () => {
    // Arrange
    const { db } = captureDb(() => []);
    const ctx = makeCtx(db, undefined);

    // Act
    const visible = await resolveVisibleRepos(ctx);

    // Assert
    expect(visible).toEqual([]);
  });
});
