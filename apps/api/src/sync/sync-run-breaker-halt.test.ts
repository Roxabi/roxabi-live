import "./sync-test-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, makeFakeStmt } from "../test-utils";
import { runSync } from "./sync";
import { makeRunSyncEnv } from "./sync-run-helpers";

describe("runSync — breaker halt + recovery (#160)", () => {
  it("B2: systemic failure halts and POSTs NOTIFY at threshold (≥2)", async () => {
    // Arrange — discovery succeeds (listInstallationRepos returns repos), Phase 2
    // token fetch always fails → every windowed repo skipped → systemic failure.
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    // Discovery Phase 1 calls: getInstallationToken (once, for the tenant) then listInstallationRepos.
    // We need Phase 1 to succeed so repos enter the window, then Phase 2 token fetch to fail.
    // Use mockResolvedValueOnce for the Phase 1 call, then reject for all subsequent.
    vi.mocked(getInstallationToken)
      .mockResolvedValueOnce("tok-discovery") // Phase 1 success
      .mockRejectedValue(new Error("systemic-error")); // Phase 2 failures
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "o/r", isPrivate: false }]);

    const { ghGraphql } = await import("./graphql");
    vi.mocked(ghGraphql).mockResolvedValue({
      data: { repository: { id: "1" } },
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
      // auth_failures SELECT — return ≥2 for global (tenant_id=0) to trigger halt
      if (
        sql.includes("key='auth_failures'") &&
        sql.includes("SELECT") &&
        !sql.includes("UPDATE")
      ) {
        const val = args[0] === 0 ? "2" : "1";
        return makeFakeStmt(sql, args, [{ value: val }], 0);
      }
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 10 }]);
      }
      if (sql.includes("SELECT repo FROM tenant_repo_access")) {
        return makeFakeStmt(sql, args, [{ repo: "o/r" }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db, NOTIFY_URL: "https://notify.example.com/hook" });

    // Act
    await runSync(env);

    // Assert — a halted-related UPDATE was fired (haltSync writes to sync_control)
    // The SQL sets halted='1' or value='1' where key='halted'
    const recorded = db._recorded;
    const haltUpdate = recorded.find((s) => s.sql.includes("halted") && s.sql.includes("UPDATE"));
    expect(haltUpdate).toBeDefined();

    // Assert — fetch was called with NOTIFY_URL and body containing 'sync_halted'
    const notifyCalls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("notify.example.com"),
    );
    expect(notifyCalls.length).toBeGreaterThan(0);
    const bodyArg = notifyCalls[0][1] as { body?: string };
    expect(bodyArg?.body).toMatch(/sync_halted/);
  });

  it("B2: systemic failure below threshold does NOT halt (auth_failures=1)", async () => {
    // Arrange — same as B2 threshold but auth_failures stays at 1 (below halt trigger)
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken)
      .mockResolvedValueOnce("tok-discovery") // Phase 1 success
      .mockRejectedValue(new Error("systemic-error")); // Phase 2 failures
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "o/r", isPrivate: false }]);

    const { ghGraphql } = await import("./graphql");
    vi.mocked(ghGraphql).mockResolvedValue({
      data: { repository: { id: "1" } },
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
      // auth_failures SELECT always returns 1 (below threshold — no halt)
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
        return makeFakeStmt(sql, args, [{ repo: "o/r" }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db, NOTIFY_URL: "https://notify.example.com/hook" });

    // Act
    await runSync(env);

    // Assert — NO halted UPDATE issued
    const recorded = db._recorded;
    const haltUpdate = recorded.find((s) => s.sql.includes("halted") && s.sql.includes("UPDATE"));
    expect(haltUpdate).toBeUndefined();

    // Assert — fetch was NOT called with NOTIFY_URL
    const notifyCalls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("notify.example.com"),
    );
    expect(notifyCalls).toHaveLength(0);
  });

  it("B1b: successful run resets auth_failures for both global (tenant_id=0) and participating tenant", async () => {
    // Arrange — 1 tenant id=7, 1 repo synced OK
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("tok-7");
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "o/ok", isPrivate: false }]);

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
        return makeFakeStmt(sql, args, [{ id: 7, installation_id: 70 }]);
      }
      if (sql.includes("SELECT repo FROM tenant_repo_access")) {
        return makeFakeStmt(sql, args, [{ repo: "o/ok" }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const env = makeRunSyncEnv({ DB: db });

    // Act
    await runSync(env);

    // Assert — auth_failures reset UPDATE (value='0') for tenant_id=0
    const recorded = db._recorded;
    const resetGlobal = recorded.find(
      (s) =>
        s.sql.includes("auth_failures") &&
        s.sql.includes("UPDATE") &&
        s.sql.includes("value='0'") &&
        s.args.includes(0),
    );
    expect(resetGlobal).toBeDefined();

    // Assert — auth_failures reset UPDATE (value='0') for tenant_id=7
    const resetTenant = recorded.find(
      (s) =>
        s.sql.includes("auth_failures") &&
        s.sql.includes("UPDATE") &&
        s.sql.includes("value='0'") &&
        s.args.includes(7),
    );
    expect(resetTenant).toBeDefined();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
