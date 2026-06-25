import "./sync-test-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, makeFakeStmt } from "../test-utils";
import { runSync } from "./sync";
import { makeRunSyncEnv } from "./sync-run-helpers";

// ---------------------------------------------------------------------------
// runSync — multi-tenant / per-installation tests
// ---------------------------------------------------------------------------
// DEFERRED to #160 (S3b — sync per-tenant cutover + PAT retirement). The runSync
// rewrite was split out of #146 (S3a shipped the install-token infra + webhook
// cutover). Skipped here because (a) these assert the not-yet-built per-tenant
// runSync, and (b) two bugs must be fixed when un-skipping in #160:
//   1. dedup assertion uses c[2]/c[3]; ghGraphql(query, variables, token) puts
//      query at c[0], vars at c[1].
//   2. no vi.mock("../auth/installToken") → a faithful impl's getInstallationToken
//      throws before syncRepoBundle. Add the mock when implementing #160.
// ---------------------------------------------------------------------------

describe("runSync — multi-tenant installation sync (#160)", () => {
  // Local makeEnv scoped to this describe so it composes cleanly
  it("deduplicates GraphQL bundle fetches: two tenants sharing repo o/r → exactly 1 REPO_BUNDLE_QUERY issued for o/r", async () => {
    // Two tenants both have access to "o/r" via their install tokens.
    // runSync must deduplicate: one syncRepoBundle call regardless of tenant count.
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    // Both tenants enumerate the same repo "o/r"
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "o/r", isPrivate: false }]);

    const db = makeFakeDb((sql, args) => {
      if (sql.includes("key='halted'")) return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      if (sql.includes("sync_running") && sql.includes("UPDATE"))
        return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [
          { id: 1, installation_id: 10 },
          { id: 2, installation_id: 20 },
        ]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);
    // syncRepoBundle uses REPO_BUNDLE_QUERY — stub returns minimal valid shape
    mockGhGraphql.mockResolvedValue({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
      },
    });

    const env = makeRunSyncEnv({ DB: db });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync(env);

    // Exactly 1 REPO_BUNDLE_QUERY for o/r (probe calls during discovery are separate)
    const bundleCalls = mockGhGraphql.mock.calls.filter((c) => c[0] === "REPO_BUNDLE_QUERY");
    expect(bundleCalls).toHaveLength(1);
  });

  it("advances sync_slot per tick: seed sync_slot=0, after runSync the slot is updated", async () => {
    // sync_control row sync_slot tracks which window of repos was processed.
    // Discovery must yield ≥1 repo so Phase 2 runs and reaches the slot-advance write.
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "o/r", isPrivate: false }]);

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

    let syncSlotWritten = false;
    let nextSlotValue: unknown;
    const db = makeFakeDb((sql, args) => {
      if (sql.includes("key='halted'")) return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      if (sql.includes("sync_running") && sql.includes("UPDATE"))
        return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 10 }]);
      }
      // Return sync_slot=0 on read
      if (sql.includes("sync_slot") && sql.includes("SELECT")) {
        return makeFakeStmt(sql, args, [{ value: "0" }]);
      }
      // Detect the slot-advance write (UPDATE with key=sync_slot); capture bound value.
      if (sql.includes("sync_slot") && sql.includes("UPDATE")) {
        syncSlotWritten = true;
        nextSlotValue = args[0];
        return makeFakeStmt(sql, args, [], 1);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = makeRunSyncEnv({ DB: db });
    await runSync(env);

    // The sync run must advance sync_slot: 0 → (0+1) % NUM_SLOTS = 1.
    expect(syncSlotWritten).toBe(true);
    expect(nextSlotValue).toBe("1");
  });

  it("per-tenant lock isolation: tenant A holding sync_running=1 does NOT prevent tenant B from syncing", async () => {
    // acquireSyncLock(db, tenantId) is per-tenant: tenant A's held lock (changes=0)
    // must not stop discovery from attempting tenant B's own lock.
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    vi.mocked(listInstallationRepos).mockResolvedValue([]);

    let tenantBLockAttempted = false;
    const db = makeFakeDb((sql, args) => {
      if (sql.includes("key='halted'")) return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      if (sql.includes("sync_running") && sql.includes("UPDATE")) {
        // acquireSyncLock binds: .bind(timestamp, tenantId)
        // → args[0] = ISO timestamp (string), args[1] = tenantId (number).
        // CONTRACT: if the lock UPDATE bind order changes, args[1] becomes the ISO
        // timestamp string → Number(...) is NaN → none of the tenantId branches match →
        // tenantBLockAttempted stays false → the final assertion fails loudly.
        const tenantId = Number(args[1]);
        if (tenantId === 0) return makeFakeStmt(sql, args, [], 1); // global tick lock: acquired
        if (tenantId === 1) return makeFakeStmt(sql, args, [], 0); // tenant A: lock held
        if (tenantId === 2) {
          tenantBLockAttempted = true;
          return makeFakeStmt(sql, args, [], 1); // tenant B: lock acquired
        }
        return makeFakeStmt(sql, args, [], 0);
      }
      if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [
          { id: 1, installation_id: 10 },
          { id: 2, installation_id: 20 },
        ]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = makeRunSyncEnv({ DB: db });
    await runSync(env);
    warnSpy.mockRestore();

    // Tenant B's lock attempt must have been made (runSync iterates tenants independently).
    expect(tenantBLockAttempted).toBe(true);
  });

  it("no PAT access: runSync completes via install tokens without reading env.GITHUB_TOKEN", async () => {
    // runSync must use getInstallationToken() and never read env.GITHUB_TOKEN.
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    vi.mocked(listInstallationRepos).mockResolvedValue([
      { repo: "Roxabi/roxabi-factory", isPrivate: false },
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
      if (sql.includes("key='halted'")) return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      if (sql.includes("sync_running") && sql.includes("UPDATE"))
        return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 139542392 }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const base = makeRunSyncEnv({ DB: db });
    // Replace GITHUB_TOKEN with a spy getter that records every access.
    let patAccessCount = 0;
    (base as unknown as Record<string, unknown>).GITHUB_TOKEN = undefined;
    Object.defineProperty(base, "GITHUB_TOKEN", {
      get() {
        patAccessCount++;
        return "tok";
      },
      configurable: true,
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync(base);

    // runSync must not read env.GITHUB_TOKEN — install token is used exclusively.
    expect(patAccessCount).toBe(0);
  });

  it("window-past-end: sync_slot beyond repo count → no REPO_BUNDLE_QUERY fetches and runSync resolves", async () => {
    // WINDOW=20 (sync.ts const), NUM_SLOTS=2 → code only persists slots {0,1}.
    // slot=2 here is a FORCED out-of-range value to exercise the slice-past-end
    // guard defensively (a stale/garbage persisted slot must not crash Phase 2).
    // 21 repos → windowing engages (allRepos.length > WINDOW).
    // slot=2 → windowStart = 2 * 20 = 40 ≥ 21 → windowedRepos=[] → no bundle fetches.
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    // 21 unique repos to exceed WINDOW=20
    vi.mocked(listInstallationRepos).mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({ repo: `o/r${i}`, isPrivate: false })),
    );

    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);
    mockGhGraphql.mockResolvedValue({
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
      if (sql.includes("key='halted'")) return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      if (sql.includes("sync_running") && sql.includes("UPDATE"))
        return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 10 }]);
      }
      // Return slot=2: windowStart = 2*20 = 40 ≥ 21 repos → windowedRepos=[]
      if (sql.includes("sync_slot") && sql.includes("SELECT")) {
        return makeFakeStmt(sql, args, [{ value: "2" }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = makeRunSyncEnv({ DB: db });

    // Must resolve without throwing — windowed-past-end is a valid no-op for Phase 2.
    await expect(runSync(env)).resolves.toBeUndefined();

    // No REPO_BUNDLE_QUERY calls: Phase 2 was skipped entirely.
    const bundleCalls = mockGhGraphql.mock.calls.filter((c) => c[0] === "REPO_BUNDLE_QUERY");
    expect(bundleCalls).toHaveLength(0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
