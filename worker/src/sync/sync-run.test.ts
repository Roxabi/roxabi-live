import "./sync-test-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, makeFakeStmt } from "../test-utils";
import { runSync } from "./sync";
import { emptyBundleGraphqlData, makeFullSyncDb, makeRunSyncEnv } from "./sync-run-helpers";

describe("runSync", () => {
  it("returns early when isHalted=true", async () => {
    const db = makeFakeDb((sql, args) => {
      // All queries return halted=1
      return makeFakeStmt(sql, args, [{ value: "1" }], 0);
    });
    const env = makeRunSyncEnv({ DB: db });

    // Should not throw; acquireSyncLock must not be called (we return before it)
    await expect(runSync(env)).resolves.toBeUndefined();

    // releaseSyncLock is in finally; acquireSyncLock UPDATE → changes=0 → not acquired
    // The key signal: ghGraphql was never called (mocked, no calls expected)
    const { ghGraphql } = await import("./graphql");
    expect(vi.mocked(ghGraphql)).not.toHaveBeenCalled();
  });

  it("returns early when lock not acquired", async () => {
    let callIdx = 0;
    const db = makeFakeDb((sql, args) => {
      callIdx++;
      // First call: isHalted SELECT → halted=0
      if (callIdx === 1) return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      // Second call: acquireSyncLock UPDATE → changes=0 (lock not acquired)
      return makeFakeStmt(sql, args, [], 0);
    });
    const env = makeRunSyncEnv({ DB: db });

    await expect(runSync(env)).resolves.toBeUndefined();

    const { ghGraphql } = await import("./graphql");
    expect(vi.mocked(ghGraphql)).not.toHaveBeenCalled();
  });

  it("returns early (logs warn) when no tenants with installation_id exist", async () => {
    const { listInstallationRepos } = await import("../auth/installToken");
    const { getInstallationToken } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    vi.mocked(listInstallationRepos).mockResolvedValue([]);

    const db = makeFakeDb((sql, args) => {
      if (sql.includes("FROM tenants")) {
        // discoverTenants → empty (no tenants with installation_id)
        return makeFakeStmt(sql, args, []);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const env = makeRunSyncEnv({ DB: db });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runSync(env)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no repos discovered across all installations — nothing to sync"),
    );
    warnSpy.mockRestore();
  });

  it("prunes issues/edges/pr_state/sync_state for a deleted repo (Roxabi/lyra)", async () => {
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    // listInstallationRepos returns only roxabi-factory (lyra is gone)
    vi.mocked(listInstallationRepos).mockResolvedValue([
      { repo: "Roxabi/roxabi-factory", isPrivate: false },
    ]);

    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);
    // syncRepoBundle calls for roxabi-factory — empty result
    mockGhGraphql.mockResolvedValue({ data: emptyBundleGraphqlData(4998) });

    const db = makeFullSyncDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db });
    await expect(runSync(env)).resolves.toBeUndefined();

    // Verify DELETE FROM issues was issued for Roxabi/lyra
    const deletedIssueStmts = db._recorded.filter(
      (s) => s.sql.includes("DELETE FROM issues") && s.args.includes("Roxabi/lyra"),
    );
    expect(deletedIssueStmts.length).toBeGreaterThan(0);

    // Verify DELETE FROM edges was issued for Roxabi/lyra
    const deletedEdgeStmts = db._recorded.filter(
      (s) => s.sql.includes("DELETE FROM edges") && s.args.includes("Roxabi/lyra"),
    );
    expect(deletedEdgeStmts.length).toBeGreaterThan(0);
  });

  it("does NOT prune rows for a repo still accessible via installation (roxabi-vault stays)", async () => {
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    // listInstallationRepos returns both repos — roxabi-vault is still accessible
    vi.mocked(listInstallationRepos).mockResolvedValue([
      { repo: "Roxabi/roxabi-factory", isPrivate: false },
      { repo: "Roxabi/roxabi-vault", isPrivate: false },
    ]);

    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);
    // syncRepoBundle empty result for each repo
    mockGhGraphql.mockResolvedValue({ data: emptyBundleGraphqlData(4998) });

    // DB returns roxabi-vault as present in issues — but it's still in live set, so NOT stale
    const db = makeFullSyncDb({
      issueRepos: ["Roxabi/roxabi-vault", "Roxabi/roxabi-factory"],
      edgeSrcRepos: [],
      edgeDstRepos: [],
      prStateRepos: [],
      syncStateRepos: ["Roxabi/roxabi-vault", "Roxabi/roxabi-factory"],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db });
    await expect(runSync(env)).resolves.toBeUndefined();

    // No DELETE statements should target roxabi-vault
    const deletedVaultStmts = db._recorded.filter(
      (s) => s.sql.includes("DELETE") && s.args.includes("Roxabi/roxabi-vault"),
    );
    expect(deletedVaultStmts).toHaveLength(0);
  });

  it("skips all prune logic (warn) when listInstallationRepos returns 0 repos", async () => {
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    // listInstallationRepos returns empty — transient error
    vi.mocked(listInstallationRepos).mockResolvedValue([]);

    const db = makeFakeDb((sql, args) => {
      if (sql.includes("key='halted'")) return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      if (sql.includes("sync_running") && sql.includes("UPDATE"))
        return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 139542392 }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db });
    await expect(runSync(env)).resolves.toBeUndefined();

    // Safety guard must have warned — new flow emits the "nothing to sync" message
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no repos discovered across all installations — nothing to sync"),
    );

    // No DELETE statements should have been issued
    const deleteStmts = db._recorded.filter((s) => s.sql.includes("DELETE"));
    expect(deleteStmts).toHaveLength(0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
