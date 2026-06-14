import { describe, it, expect, vi } from "vitest";
import {
  handleInstallation,
  handleInstallationRepositories,
  handleRepository,
  handleMember,
  handleMembership,
} from "./handlers-app";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Fake-D1 harness
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeStmt {
  sql: string;
  args: unknown[];
  run: () => Promise<{ meta: { changes: number } }>;
  first: <T = Row>() => Promise<T | null>;
  all: <T = Row>() => Promise<{ results: T[] }>;
}

function makeStmt(sql: string, args: unknown[], rows: Row[]): FakeStmt {
  return {
    sql,
    args,
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
    all: vi.fn().mockResolvedValue({ results: rows }),
  };
}

/** Seeds .first() results by SQL match; records every bound stmt; captures db.batch arrays. */
function seededDb(seed: { tenant?: Row | null; user?: Row | null; repo?: Row | null } = {}) {
  const recorded: FakeStmt[] = [];
  const batched: FakeStmt[][] = [];
  const rowsFor = (sql: string): Row[] => {
    if (/FROM tenants/.test(sql)) return seed.tenant ? [seed.tenant] : [];
    if (/FROM users/.test(sql)) return seed.user ? [seed.user] : [];
    if (/FROM repos/.test(sql)) return seed.repo ? [seed.repo] : [];
    return [];
  };
  const db = {
    prepare(sql: string) {
      const direct = makeStmt(sql, [], rowsFor(sql));
      recorded.push(direct);
      return {
        bind: (...args: unknown[]) => {
          const s = makeStmt(sql, args, rowsFor(sql));
          recorded.push(s);
          return s;
        },
        first: <T = Row>() => direct.first<T>(),
        run: () => direct.run(),
        all: <T = Row>() => direct.all<T>(),
      };
    },
    batch: vi.fn(async (stmts: FakeStmt[]) => {
      batched.push(stmts);
      return stmts.map(() => ({ results: [], meta: { changes: 1 } }));
    }),
  } as unknown as D1Database;
  return {
    db,
    recorded: () => recorded,
    batched: () => batched,
    batchFn: () => (db as unknown as { batch: ReturnType<typeof vi.fn> }).batch,
  };
}

function fakeEnv(): Env {
  return { GITHUB_ORG: "Roxabi" } as unknown as Env;
}

const activeTenant: Row = {
  id: 1,
  installation_id: 555,
  account_login: "Roxabi",
  account_type: "Organization",
  suspended_at: null,
  deleted_at: null,
};

function batchedSql(batched: FakeStmt[][]): string[] {
  return batched.flat().map((s) => s.sql);
}

function allBatchedStmts(batched: FakeStmt[][]): FakeStmt[] {
  return batched.flat();
}

// ---------------------------------------------------------------------------
// handleInstallation
// ---------------------------------------------------------------------------

describe("handleInstallation", () => {
  describe("created", () => {
    it("upserts tenant and batches repo-access rows + bump for each repository", async () => {
      // Arrange
      const { db, recorded, batched, batchFn } = seededDb({ tenant: activeTenant });
      const payload = {
        action: "created",
        installation: { id: 555, account: { login: "Roxabi", type: "Organization" } },
        repositories: [
          { full_name: "Roxabi/a", private: false },
          { full_name: "Roxabi/b", private: true },
        ],
      };

      // Act
      await handleInstallation(payload, db, fakeEnv());

      // Assert — upsertTenant ran as a standalone .run()
      const allSql = recorded().map((s) => s.sql);
      expect(allSql.some((sql) => /INSERT INTO tenants/.test(sql))).toBe(true);

      // Assert — db.batch was called once with 3 statements:
      //   2× INSERT INTO tenant_repo_access + 1× sync_control bump
      expect(batchFn()).toHaveBeenCalledOnce();
      const stmts = allBatchedStmts(batched());
      const accessStmts = stmts.filter((s) => /INSERT INTO tenant_repo_access/.test(s.sql));
      expect(accessStmts).toHaveLength(2);

      // First repo is public (is_private = 0)
      const stmtA = accessStmts.find((s) => s.args.includes("Roxabi/a"));
      expect(stmtA).toBeDefined();
      expect(stmtA!.args).toContain(0);

      // Second repo is private (is_private = 1)
      const stmtB = accessStmts.find((s) => s.args.includes("Roxabi/b"));
      expect(stmtB).toBeDefined();
      expect(stmtB!.args).toContain(1);

      // Bump included
      expect(batchedSql(batched()).some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);
    });
  });

  describe("deleted", () => {
    it("batches soft-delete + repo-access purge + sessions + tokens + bump", async () => {
      // Arrange
      const { db, batched, batchFn } = seededDb({ tenant: activeTenant });
      const payload = { action: "deleted", installation: { id: 555 } };

      // Act
      await handleInstallation(payload, db, fakeEnv());

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const sqls = batchedSql(batched());

      expect(sqls.some((sql) => /UPDATE tenants SET deleted_at/.test(sql))).toBe(true);
      expect(sqls.some((sql) => /DELETE FROM tenant_repo_access WHERE tenant_id=\?/.test(sql))).toBe(true);
      expect(sqls.some((sql) => /DELETE FROM sessions WHERE tenant_id=\?/.test(sql))).toBe(true);
      expect(sqls.some((sql) => /DELETE FROM install_tokens WHERE tenant_id=\?/.test(sql))).toBe(true);
      expect(sqls.some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);
    });

    it("does NOT touch issues or edges (retention invariant)", async () => {
      // Arrange
      const { db, batched } = seededDb({ tenant: activeTenant });
      const payload = { action: "deleted", installation: { id: 555 } };

      // Act
      await handleInstallation(payload, db, fakeEnv());

      // Assert — no statement references issues or edges tables
      const sqls = batchedSql(batched());
      expect(sqls.some((sql) => /FROM issues/.test(sql) || /INTO issues/.test(sql) || /DELETE FROM issues/.test(sql))).toBe(false);
      expect(sqls.some((sql) => /FROM edges/.test(sql) || /INTO edges/.test(sql) || /DELETE FROM edges/.test(sql))).toBe(false);
    });

    it("is a no-op when tenant is unknown (idempotent)", async () => {
      // Arrange
      const { db, batchFn } = seededDb({ tenant: null });
      const payload = { action: "deleted", installation: { id: 555 } };

      // Act
      await handleInstallation(payload, db, fakeEnv());

      // Assert
      expect(batchFn()).not.toHaveBeenCalled();
    });
  });

  describe("suspend", () => {
    it("batches suspended_at update with a non-null timestamp + bump", async () => {
      // Arrange
      const { db, batched, batchFn } = seededDb({ tenant: activeTenant });
      const payload = { action: "suspend", installation: { id: 555 } };

      // Act
      await handleInstallation(payload, db, fakeEnv());

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const stmts = allBatchedStmts(batched());
      const suspendStmt = stmts.find((s) => /UPDATE tenants SET suspended_at/.test(s.sql));
      expect(suspendStmt).toBeDefined();
      // First arg is the suspended_at value — must be non-null (an ISO string)
      expect(suspendStmt!.args[0]).not.toBeNull();
      expect(typeof suspendStmt!.args[0]).toBe("string");

      // Bump included
      expect(batchedSql(batched()).some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);
    });
  });

  describe("unsuspend", () => {
    it("batches suspended_at update with null + bump", async () => {
      // Arrange
      const { db, batched, batchFn } = seededDb({ tenant: activeTenant });
      const payload = { action: "unsuspend", installation: { id: 555 } };

      // Act
      await handleInstallation(payload, db, fakeEnv());

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const stmts = allBatchedStmts(batched());
      const suspendStmt = stmts.find((s) => /UPDATE tenants SET suspended_at/.test(s.sql));
      expect(suspendStmt).toBeDefined();
      // First arg is suspended_at — must be null (clearing the suspension)
      expect(suspendStmt!.args[0]).toBeNull();

      // Bump included
      expect(batchedSql(batched()).some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// handleInstallationRepositories
// ---------------------------------------------------------------------------

describe("handleInstallationRepositories", () => {
  describe("added", () => {
    it("batches INSERT INTO tenant_repo_access + bump for each added repo", async () => {
      // Arrange
      const { db, batched, batchFn } = seededDb({ tenant: activeTenant });
      const payload = {
        action: "added",
        installation: { id: 555 },
        repositories_added: [{ full_name: "Roxabi/x", private: true }],
      };

      // Act
      await handleInstallationRepositories(payload, db, fakeEnv());

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const sqls = batchedSql(batched());
      expect(sqls.some((sql) => /INSERT INTO tenant_repo_access/.test(sql))).toBe(true);

      const accessStmt = allBatchedStmts(batched()).find(
        (s) => /INSERT INTO tenant_repo_access/.test(s.sql) && s.args.includes("Roxabi/x"),
      );
      expect(accessStmt).toBeDefined();
      expect(accessStmt!.args).toContain(1); // is_private = 1

      expect(sqls.some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);
    });

    it("does NOT call db.batch when repositories_added is empty", async () => {
      // Arrange
      const { db, batchFn } = seededDb({ tenant: activeTenant });
      const payload = {
        action: "added",
        installation: { id: 555 },
        repositories_added: [],
      };

      // Act
      await handleInstallationRepositories(payload, db, fakeEnv());

      // Assert
      expect(batchFn()).not.toHaveBeenCalled();
    });
  });

  describe("removed", () => {
    it("batches DELETE FROM tenant_repo_access for the removed repo + bump", async () => {
      // Arrange
      const { db, batched, batchFn } = seededDb({ tenant: activeTenant });
      const payload = {
        action: "removed",
        installation: { id: 555 },
        repositories_removed: [{ full_name: "Roxabi/x" }],
      };

      // Act
      await handleInstallationRepositories(payload, db, fakeEnv());

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const stmts = allBatchedStmts(batched());
      const deleteStmt = stmts.find(
        (s) => /DELETE FROM tenant_repo_access WHERE tenant_id=\? AND repo=\?/.test(s.sql),
      );
      expect(deleteStmt).toBeDefined();
      expect(deleteStmt!.args).toContain("Roxabi/x");
      expect(deleteStmt!.args).toContain(1); // tenantId

      expect(batchedSql(batched()).some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// handleRepository
// ---------------------------------------------------------------------------

describe("handleRepository", () => {
  describe("renamed — fallback path (no node_id DB hit)", () => {
    it("cascades rename across all repo-keyed tables + bump", async () => {
      // Arrange — seed no repo row so node_id lookup returns null; handler falls back to
      // changes.repository.name.from
      const { db, batched, batchFn } = seededDb({ repo: null });
      const payload = {
        action: "renamed",
        repository: { full_name: "Roxabi/new", node_id: "NID" },
        changes: { repository: { name: { from: "old" } } },
      };

      // Act
      await handleRepository(payload, db);

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const sqls = batchedSql(batched());

      // All 5 cascade tables + bump
      expect(sqls.some((sql) => /UPDATE repos SET repo=\?/.test(sql))).toBe(true);
      expect(sqls.some((sql) => /UPDATE tenant_repo_access SET repo=\?/.test(sql))).toBe(true);
      expect(sqls.some((sql) => /UPDATE issues SET repo=\?/.test(sql))).toBe(true);
      expect(sqls.some((sql) => /UPDATE edges SET src_key = \? \|\| substr/.test(sql))).toBe(true);
      expect(sqls.some((sql) => /UPDATE edges SET dst_key = \? \|\| substr/.test(sql))).toBe(true);
      expect(sqls.some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);

      // All cascade statements (all but the trailing bump) do not reference sync_control
      const stmts = allBatchedStmts(batched());
      const cascadeStmts = stmts.slice(0, stmts.length - 1);
      expect(cascadeStmts.every((s) => !/sync_control/.test(s.sql))).toBe(true);
    });
  });

  describe("transferred — node_id anchor path", () => {
    it("resolves oldFullName via repo_node_id lookup and cascades rename + bump", async () => {
      // Arrange — node_id lookup returns the stored old slug
      const { db, batched, batchFn } = seededDb({ repo: { repo: "OldOwner/repo" } });
      const payload = {
        action: "transferred",
        repository: { full_name: "NewOwner/repo", node_id: "NID" },
      };

      // Act
      await handleRepository(payload, db);

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const stmts = allBatchedStmts(batched());

      // repos UPDATE carries old → new names
      const reposStmt = stmts.find((s) => /UPDATE repos SET repo=\?/.test(s.sql));
      expect(reposStmt).toBeDefined();
      expect(reposStmt!.args).toContain("OldOwner/repo");
      expect(reposStmt!.args).toContain("NewOwner/repo");

      // All 5 cascade stmts + bump = 6
      expect(stmts).toHaveLength(6);

      // Bump is last
      expect(/INSERT INTO sync_control/.test(stmts[stmts.length - 1].sql)).toBe(true);
    });
  });

  describe("privatized", () => {
    it("batches is_private=1 + cache invalidation by repo + bump", async () => {
      // Arrange
      const { db, batched, batchFn } = seededDb();
      const payload = { action: "privatized", repository: { full_name: "Roxabi/r" } };

      // Act
      await handleRepository(payload, db);

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const stmts = allBatchedStmts(batched());

      const privacyStmt = stmts.find((s) => /UPDATE tenant_repo_access SET is_private=\?/.test(s.sql));
      expect(privacyStmt).toBeDefined();
      expect(privacyStmt!.args[0]).toBe(1);

      const cacheStmt = stmts.find((s) => /DELETE FROM user_repo_permission_cache WHERE repo=\?/.test(s.sql));
      expect(cacheStmt).toBeDefined();
      expect(cacheStmt!.args).toContain("Roxabi/r");

      expect(batchedSql(batched()).some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);
    });
  });

  describe("publicized", () => {
    it("batches is_private=0 + cache invalidation by repo + bump", async () => {
      // Arrange
      const { db, batched, batchFn } = seededDb();
      const payload = { action: "publicized", repository: { full_name: "Roxabi/r" } };

      // Act
      await handleRepository(payload, db);

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const stmts = allBatchedStmts(batched());

      const privacyStmt = stmts.find((s) => /UPDATE tenant_repo_access SET is_private=\?/.test(s.sql));
      expect(privacyStmt).toBeDefined();
      expect(privacyStmt!.args[0]).toBe(0);

      const cacheStmt = stmts.find((s) => /DELETE FROM user_repo_permission_cache WHERE repo=\?/.test(s.sql));
      expect(cacheStmt).toBeDefined();

      expect(batchedSql(batched()).some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);
    });
  });

  describe("unhandled action", () => {
    it("does NOT call db.batch for an unrecognized action", async () => {
      // Arrange
      const { db, batchFn } = seededDb();
      const payload = { action: "created", repository: { full_name: "Roxabi/r" } };

      // Act
      await handleRepository(payload, db);

      // Assert
      expect(batchFn()).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// handleMember
// ---------------------------------------------------------------------------

describe("handleMember", () => {
  describe("removed", () => {
    it("batches DELETE FROM user_repo_permission_cache for (user_id, repo) + bump", async () => {
      // Arrange — user seed: local user row for github_id=42
      const { db, batched, batchFn } = seededDb({ user: { id: 7 } });
      const payload = {
        action: "removed",
        member: { id: 42 },
        repository: { full_name: "Roxabi/r" },
      };

      // Act
      await handleMember(payload, db);

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const stmts = allBatchedStmts(batched());

      const cacheStmt = stmts.find(
        (s) => /DELETE FROM user_repo_permission_cache WHERE user_id=\? AND repo=\?/.test(s.sql),
      );
      expect(cacheStmt).toBeDefined();
      expect(cacheStmt!.args).toEqual([7, "Roxabi/r"]);

      expect(batchedSql(batched()).some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);
    });

    it("does NOT call db.batch when user is unknown (never logged in)", async () => {
      // Arrange
      const { db, batchFn } = seededDb({ user: null });
      const payload = {
        action: "removed",
        member: { id: 42 },
        repository: { full_name: "Roxabi/r" },
      };

      // Act
      await handleMember(payload, db);

      // Assert
      expect(batchFn()).not.toHaveBeenCalled();
    });
  });

  describe("added", () => {
    it("does NOT call db.batch (cache miss will re-verify on next request)", async () => {
      // Arrange
      const { db, batchFn } = seededDb({ user: { id: 7 } });
      const payload = {
        action: "added",
        member: { id: 42 },
        repository: { full_name: "Roxabi/r" },
      };

      // Act
      await handleMember(payload, db);

      // Assert
      expect(batchFn()).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// handleMembership
// ---------------------------------------------------------------------------

describe("handleMembership", () => {
  describe("removed", () => {
    it("batches full-user cache wipe (no repo filter) + bump", async () => {
      // Arrange
      const { db, batched, batchFn } = seededDb({ user: { id: 7 } });
      const payload = { action: "removed", member: { id: 42 } };

      // Act
      await handleMembership(payload, db);

      // Assert
      expect(batchFn()).toHaveBeenCalledOnce();
      const stmts = allBatchedStmts(batched());

      const cacheStmt = stmts.find(
        (s) => /DELETE FROM user_repo_permission_cache WHERE user_id=\?/.test(s.sql),
      );
      expect(cacheStmt).toBeDefined();
      // Must NOT have a repo filter
      expect(/repo=\?/.test(cacheStmt!.sql)).toBe(false);
      expect(cacheStmt!.args).toEqual([7]);

      expect(batchedSql(batched()).some((sql) => /INSERT INTO sync_control/.test(sql))).toBe(true);
    });

    it("does NOT call db.batch when user is unknown", async () => {
      // Arrange
      const { db, batchFn } = seededDb({ user: null });
      const payload = { action: "removed", member: { id: 42 } };

      // Act
      await handleMembership(payload, db);

      // Assert
      expect(batchFn()).not.toHaveBeenCalled();
    });
  });

  describe("added", () => {
    it("does NOT call db.batch (cache miss will re-verify on next check)", async () => {
      // Arrange
      const { db, batchFn } = seededDb({ user: { id: 7 } });
      const payload = { action: "added", member: { id: 42 } };

      // Act
      await handleMembership(payload, db);

      // Assert
      expect(batchFn()).not.toHaveBeenCalled();
    });
  });
});
