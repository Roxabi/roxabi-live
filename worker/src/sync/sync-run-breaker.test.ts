import "./sync-test-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, makeFakeStmt } from "../test-utils";
import { runSync } from "./sync";
import { makeRunSyncEnv } from "./sync-run-helpers";

describe("runSync — breaker + discovery (#160)", () => {
  it("B1: discovery failure increments the tenant breaker", async () => {
    // Arrange
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockRejectedValue(new Error("token-error"));
    vi.mocked(listInstallationRepos).mockResolvedValue([]);

    const db = makeFakeDb((sql, args) => {
      // Global tick lock (tenant_id=0) → acquired (changes=1)
      if (sql.includes("sync_running") && sql.includes("UPDATE") && args[0] === 0) {
        return makeFakeStmt(sql, args, [], 1);
      }
      // Tenant lock (tenant_id=1) → acquired
      if (sql.includes("sync_running") && sql.includes("UPDATE")) {
        return makeFakeStmt(sql, args, [], 1);
      }
      // halted guard
      if (sql.includes("key='halted'") && sql.includes("SELECT")) {
        return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      }
      // auth_failures SELECT for tenant after increment → return count
      if (
        sql.includes("key='auth_failures'") &&
        sql.includes("SELECT") &&
        !sql.includes("UPDATE")
      ) {
        return makeFakeStmt(sql, args, [{ value: "1" }], 0);
      }
      // tenants discovery
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 10 }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db });

    // Act
    await runSync(env);

    // Assert — auth_failures UPDATE was issued bound to tenant_id=1
    const recorded = db._recorded;
    const authFailureUpdate = recorded.find(
      (s) => s.sql.includes("auth_failures") && s.sql.includes("UPDATE") && s.args.includes(1),
    );
    expect(authFailureUpdate).toBeDefined();
  });

  it("B3: discoverTenants upserts repos and deletes stale tenant_repo_access", async () => {
    // Arrange
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("tok");
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "o/keep", isPrivate: true }]);

    const { ghGraphql } = await import("./graphql");
    vi.mocked(ghGraphql).mockResolvedValue({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
      },
    });

    const db = makeFakeDb((sql, args) => {
      // Global tick lock → acquired
      if (sql.includes("sync_running") && sql.includes("UPDATE") && args[0] === 0) {
        return makeFakeStmt(sql, args, [], 1);
      }
      // Tenant lock → acquired
      if (sql.includes("sync_running") && sql.includes("UPDATE")) {
        return makeFakeStmt(sql, args, [], 1);
      }
      // halted guard
      if (sql.includes("key='halted'") && sql.includes("SELECT")) {
        return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      }
      // auth_failures SELECT → not halted
      if (
        sql.includes("key='auth_failures'") &&
        sql.includes("SELECT") &&
        !sql.includes("UPDATE")
      ) {
        return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      }
      // tenants discovery → 1 tenant
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 10 }]);
      }
      // existing tenant_repo_access rows → keep + stale
      if (sql.includes("SELECT repo FROM tenant_repo_access")) {
        return makeFakeStmt(sql, args, [{ repo: "o/keep" }, { repo: "o/stale" }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db });

    // Act
    await runSync(env);

    // Assert — INSERT for "o/keep"
    const recorded = db._recorded;
    const insertKeep = recorded.find(
      (s) => s.sql.includes("INSERT INTO tenant_repo_access") && s.args.includes("o/keep"),
    );
    expect(insertKeep).toBeDefined();
    // #148: is_private written (o/keep mocked private → bound 1; args = [tenantId, repo, is_private])
    expect(insertKeep?.args[2]).toBe(1);

    // Assert — DELETE for "o/stale" (not for "o/keep")
    const deleteStale = recorded.find(
      (s) => s.sql.includes("DELETE FROM tenant_repo_access") && s.args.includes("o/stale"),
    );
    expect(deleteStale).toBeDefined();

    const deleteKeep = recorded.find(
      (s) => s.sql.includes("DELETE FROM tenant_repo_access") && s.args.includes("o/keep"),
    );
    expect(deleteKeep).toBeUndefined();
  });

  it("B3b: discoverTenants writes is_private=0 for a public repo", async () => {
    // Arrange
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("tok");
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "o/pub", isPrivate: false }]);

    const { ghGraphql } = await import("./graphql");
    vi.mocked(ghGraphql).mockResolvedValue({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
      },
    });

    const db = makeFakeDb((sql, args) => {
      // Global tick lock → acquired
      if (sql.includes("sync_running") && sql.includes("UPDATE") && args[0] === 0) {
        return makeFakeStmt(sql, args, [], 1);
      }
      // Tenant lock → acquired
      if (sql.includes("sync_running") && sql.includes("UPDATE")) {
        return makeFakeStmt(sql, args, [], 1);
      }
      // halted guard
      if (sql.includes("key='halted'") && sql.includes("SELECT")) {
        return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      }
      // auth_failures SELECT → not halted
      if (
        sql.includes("key='auth_failures'") &&
        sql.includes("SELECT") &&
        !sql.includes("UPDATE")
      ) {
        return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      }
      // tenants discovery → 1 tenant
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 10 }]);
      }
      // existing tenant_repo_access rows → same as current (no stale)
      if (sql.includes("SELECT repo FROM tenant_repo_access")) {
        return makeFakeStmt(sql, args, [{ repo: "o/pub" }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db });

    // Act
    await runSync(env);

    // Assert — INSERT for "o/pub" with is_private=0
    const recorded = db._recorded;
    const insertPub = recorded.find(
      (s) => s.sql.includes("INSERT INTO tenant_repo_access") && s.args.includes("o/pub"),
    );
    expect(insertPub).toBeDefined();
    // #148: is_private=0 for public repo (args = [tenantId, repo, is_private])
    expect(insertPub?.args[2]).toBe(0);
  });

  it("B3c: repos table gets archived=1 for an installation-archived repo, 0 for a live one (#160 fallout)", async () => {
    // Arrange — installation reports one live + one archived repo.
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("tok");
    vi.mocked(listInstallationRepos).mockResolvedValue([
      { repo: "o/live", isPrivate: false, isArchived: false },
      { repo: "o/old", isPrivate: false, isArchived: true },
    ]);

    const { ghGraphql } = await import("./graphql");
    vi.mocked(ghGraphql).mockResolvedValue({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
      },
    });

    const db = makeFakeDb((sql, args) => {
      if (sql.includes("sync_running") && sql.includes("UPDATE") && args[0] === 0) {
        return makeFakeStmt(sql, args, [], 1);
      }
      if (sql.includes("sync_running") && sql.includes("UPDATE")) {
        return makeFakeStmt(sql, args, [], 1);
      }
      if (sql.includes("key='halted'") && sql.includes("SELECT")) {
        return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      }
      if (
        sql.includes("key='auth_failures'") &&
        sql.includes("SELECT") &&
        !sql.includes("UPDATE")
      ) {
        return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      }
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 10 }]);
      }
      if (sql.includes("SELECT repo FROM tenant_repo_access")) {
        return makeFakeStmt(sql, args, [{ repo: "o/live" }, { repo: "o/old" }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db });

    // Act
    await runSync(env);

    // Assert — repos upsert binds archived per repo (args = [repo, archived]).
    const recorded = db._recorded;
    const insertOld = recorded.find(
      (s) => s.sql.includes("INSERT INTO repos") && s.args[0] === "o/old",
    );
    const insertLive = recorded.find(
      (s) => s.sql.includes("INSERT INTO repos") && s.args[0] === "o/live",
    );
    expect(insertOld?.args[1]).toBe(1);
    expect(insertLive?.args[1]).toBe(0);
  });

  it("B4: token-exhausted repo is skipped, runSync resolves without throwing", async () => {
    // Arrange — getInstallationToken always rejects for Phase 2 lookups
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockRejectedValue(new Error("no-token"));
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "o/a", isPrivate: false }]);

    const { ghGraphql } = await import("./graphql");
    vi.mocked(ghGraphql).mockResolvedValue({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
      },
    });

    const db = makeFakeDb((sql, args) => {
      if (sql.includes("sync_running") && sql.includes("UPDATE") && args[0] === 0) {
        return makeFakeStmt(sql, args, [], 1);
      }
      if (sql.includes("sync_running") && sql.includes("UPDATE")) {
        return makeFakeStmt(sql, args, [], 1);
      }
      if (sql.includes("key='halted'") && sql.includes("SELECT")) {
        return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      }
      if (
        sql.includes("key='auth_failures'") &&
        sql.includes("SELECT") &&
        !sql.includes("UPDATE")
      ) {
        return makeFakeStmt(sql, args, [{ value: "1" }], 0);
      }
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 10 }]);
      }
      if (sql.includes("SELECT repo FROM tenant_repo_access")) {
        return makeFakeStmt(sql, args, [{ repo: "o/a" }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db });

    // Act + Assert — runSync resolves (does not throw)
    await expect(runSync(env)).resolves.toBeUndefined();

    // ghGraphql must NOT have been called with REPO_BUNDLE_QUERY for o/a
    const bundleCalls = vi.mocked(ghGraphql).mock.calls.filter((c) => c[0] === "REPO_BUNDLE_QUERY");
    expect(bundleCalls).toHaveLength(0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
