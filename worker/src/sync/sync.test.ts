import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_ISSUE_RE,
  UPSERT_ISSUE_SQL,
  UPSERT_ISSUE_SQL_STRUCTURE,
  batchChunked,
  canonicalKey,
  collectEdges,
  extractFromLabels,
  flushEdges,
  acquireSyncLock,
  ensureGlobalSyncControlSeeded,
  isHalted,
  haltSync,
  getAuthFailures,
  incrementAuthFailures,
  resetAuthFailures,
  syncRepoIssues,
  syncBranches,
  syncPRs,
  syncRepoBundle,
  runSync,
  writeRunAudit,
} from "./sync";
import type { EdgeData } from "./sync";
import type { Env } from "../types";

import { makeFakeDb, makeFakeStmt, type FakeStmt } from "../test-utils";

// FakeResult kept local: richer variant ({ value?, changes? }) used in local helper casts
type FakeResult = { value?: string; changes?: number; [k: string]: unknown };

// ---------------------------------------------------------------------------
// canonicalKey
// ---------------------------------------------------------------------------

describe("canonicalKey", () => {
  it("converts bare number to full key", () => {
    expect(canonicalKey(42, "Roxabi/lyra")).toBe("Roxabi/lyra#42");
  });

  it("converts string number to full key", () => {
    expect(canonicalKey("42", "Roxabi/lyra")).toBe("Roxabi/lyra#42");
  });

  it("converts short form #N to full key", () => {
    expect(canonicalKey("#9", "Roxabi/lyra")).toBe("Roxabi/lyra#9");
  });

  it("passes through full key unchanged regardless of repo arg", () => {
    expect(canonicalKey("Roxabi/voiceCLI#7", "Roxabi/other")).toBe(
      "Roxabi/voiceCLI#7",
    );
  });

  it("throws on unrecognised ref", () => {
    expect(() => canonicalKey("not-a-ref", "Roxabi/lyra")).toThrow(
      /Cannot canonicalise issue ref/,
    );
  });
});

// ---------------------------------------------------------------------------
// BRANCH_ISSUE_RE
// ---------------------------------------------------------------------------

describe("BRANCH_ISSUE_RE", () => {
  it("matches feat/42-some-feature and captures issue number", () => {
    const m = BRANCH_ISSUE_RE.exec("feat/42-some-feature");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("42");
  });

  it("matches bare 7-fix-thing (no prefix) and captures issue number", () => {
    const m = BRANCH_ISSUE_RE.exec("7-fix-thing");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("7");
  });

  it("does not match a branch without issue number prefix", () => {
    expect(BRANCH_ISSUE_RE.exec("main")).toBeNull();
    expect(BRANCH_ISSUE_RE.exec("staging")).toBeNull();
    expect(BRANCH_ISSUE_RE.exec("feature/no-issue")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractFromLabels
// ---------------------------------------------------------------------------

describe("extractFromLabels", () => {
  it("returns all nulls for empty labels", () => {
    expect(extractFromLabels([])).toEqual({
      lane: null,
      priority: null,
      size: null,
    });
  });

  it("extracts lane from graph:lane/ prefix", () => {
    const { lane } = extractFromLabels(["graph:lane/backend"]);
    expect(lane).toBe("backend");
  });

  it("extracts priority from P1-high", () => {
    const { priority } = extractFromLabels(["P1-high"]);
    expect(priority).toBe("P1");
  });

  it("extracts priority from priority:P2", () => {
    const { priority } = extractFromLabels(["priority:P2"]);
    expect(priority).toBe("P2");
  });

  it("extracts size from size: prefix", () => {
    const { size } = extractFromLabels(["size:F-lite"]);
    expect(size).toBe("F-lite");
  });

  it("maps legacy size:M to F-lite", () => {
    const { size } = extractFromLabels(["size:M"]);
    expect(size).toBe("F-lite");
  });

  it("falls back to bare legacy size label if no size: prefix", () => {
    const { size } = extractFromLabels(["XS"]);
    expect(size).toBe("XS");
  });

  it("first match wins (lane)", () => {
    const { lane } = extractFromLabels([
      "graph:lane/frontend",
      "graph:lane/backend",
    ]);
    expect(lane).toBe("frontend");
  });

  it("extracts all three fields simultaneously", () => {
    const result = extractFromLabels([
      "graph:lane/ops",
      "P0",
      "size:XL",
    ]);
    expect(result).toEqual({ lane: "ops", priority: "P0", size: "XL" });
  });
});

// ---------------------------------------------------------------------------
// collectEdges
// ---------------------------------------------------------------------------

describe("collectEdges", () => {
  it("records children from subIssues", () => {
    const map = new Map<string, EdgeData>();
    collectEdges(
      {
        number: 1,
        subIssues: {
          nodes: [{ number: 2, repository: { nameWithOwner: "Roxabi/lyra" } }],
        },
      },
      "Roxabi/lyra",
      "Roxabi/lyra#1",
      map,
    );
    expect(map.get("Roxabi/lyra#1")?.children).toEqual(["Roxabi/lyra#2"]);
  });

  it("records parents from parent field", () => {
    const map = new Map<string, EdgeData>();
    collectEdges(
      {
        number: 2,
        parent: { number: 1, repository: { nameWithOwner: "Roxabi/lyra" } },
      },
      "Roxabi/lyra",
      "Roxabi/lyra#2",
      map,
    );
    expect(map.get("Roxabi/lyra#2")?.parents).toEqual(["Roxabi/lyra#1"]);
  });

  it("records blockedBy", () => {
    const map = new Map<string, EdgeData>();
    collectEdges(
      {
        number: 5,
        blockedBy: {
          nodes: [{ number: 3, repository: { nameWithOwner: "Roxabi/lyra" } }],
        },
      },
      "Roxabi/lyra",
      "Roxabi/lyra#5",
      map,
    );
    expect(map.get("Roxabi/lyra#5")?.blockedBy).toEqual(["Roxabi/lyra#3"]);
  });

  it("records blocking", () => {
    const map = new Map<string, EdgeData>();
    collectEdges(
      {
        number: 3,
        blocking: {
          nodes: [{ number: 7, repository: { nameWithOwner: "Roxabi/lyra" } }],
        },
      },
      "Roxabi/lyra",
      "Roxabi/lyra#3",
      map,
    );
    expect(map.get("Roxabi/lyra#3")?.blocking).toEqual(["Roxabi/lyra#7"]);
  });

  it("sets empty arrays when no edges", () => {
    const map = new Map<string, EdgeData>();
    collectEdges({ number: 10 }, "Roxabi/lyra", "Roxabi/lyra#10", map);
    expect(map.get("Roxabi/lyra#10")).toEqual({
      parents: [],
      children: [],
      blockedBy: [],
      blocking: [],
    });
  });
});

// ---------------------------------------------------------------------------
// batchChunked
// ---------------------------------------------------------------------------

describe("batchChunked", () => {
  it("never calls db.batch with empty array (no stmts)", async () => {
    const db = makeFakeDb((sql, args) =>
      makeFakeStmt(sql, args, [], 0),
    );
    await batchChunked(db, []);
    expect((db as unknown as { batch: ReturnType<typeof vi.fn> }).batch).not.toHaveBeenCalled();
  });

  it("calls db.batch once for fewer than chunk-size statements", async () => {
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, [], 0));
    const stmts = Array.from({ length: 3 }, (_, i) =>
      (db as unknown as { prepare: (sql: string) => { bind: (...a: unknown[]) => FakeStmt } })
        .prepare(`SELECT ${i}`)
        .bind(),
    );
    await batchChunked(db, stmts as unknown as D1PreparedStatement[]);
    expect((db as unknown as { batch: ReturnType<typeof vi.fn> }).batch).toHaveBeenCalledTimes(1);
  });

  it("splits into multiple chunks when exceeding chunk size", async () => {
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, [], 0));
    const stmts = Array.from({ length: 5 }, (_, i) =>
      (db as unknown as { prepare: (sql: string) => { bind: (...a: unknown[]) => FakeStmt } })
        .prepare(`SELECT ${i}`)
        .bind(),
    );
    await batchChunked(db, stmts as unknown as D1PreparedStatement[], 2);
    // 5 stmts / chunk-size 2 = 3 batches (2+2+1)
    expect((db as unknown as { batch: ReturnType<typeof vi.fn> }).batch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// flushEdges — DELETE guard: parent always, blocks only when non-empty
// ---------------------------------------------------------------------------

describe("flushEdges", () => {
  it("emits 1 DELETE (parent only) per issue key when no block edges", async () => {
    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 0);
      capturedStmts.push(stmt);
      return stmt;
    });

    const edges = new Map<string, EdgeData>([
      ["Roxabi/lyra#1", { parents: [], children: [], blockedBy: [], blocking: [] }],
    ]);

    await flushEdges(db, edges);

    const deleteStmts = capturedStmts.filter((s) =>
      s.sql.trimStart().startsWith("DELETE"),
    );
    // Only parent DELETE; blocks DELETE is guarded and skipped when both arrays are empty
    expect(deleteStmts).toHaveLength(1);
    expect(deleteStmts[0].sql).toContain("kind='parent'");
  });

  it("emits 2 DELETEs (parent + blocks) when block edges are present", async () => {
    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 0);
      capturedStmts.push(stmt);
      return stmt;
    });

    const edges = new Map<string, EdgeData>([
      [
        "Roxabi/lyra#1",
        { parents: [], children: [], blockedBy: ["Roxabi/lyra#2"], blocking: [] },
      ],
    ]);

    await flushEdges(db, edges);

    const deleteStmts = capturedStmts.filter((s) =>
      s.sql.trimStart().startsWith("DELETE"),
    );
    expect(deleteStmts).toHaveLength(2);
    expect(deleteStmts[0].sql).toContain("kind='parent'");
    expect(deleteStmts[1].sql).toContain("kind='blocks'");
  });

  it("emits 1 DELETE per key with no block edges for multiple keys", async () => {
    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 0);
      capturedStmts.push(stmt);
      return stmt;
    });

    const edges = new Map<string, EdgeData>([
      ["Roxabi/lyra#1", { parents: [], children: [], blockedBy: [], blocking: [] }],
      ["Roxabi/lyra#2", { parents: [], children: [], blockedBy: [], blocking: [] }],
    ]);

    await flushEdges(db, edges);

    const deleteStmts = capturedStmts.filter((s) =>
      s.sql.trimStart().startsWith("DELETE"),
    );
    // 2 issue keys × 1 kind (parent only, no blocks) = 2 deletes
    expect(deleteStmts).toHaveLength(2);
  });

  it("emits INSERT statements for actual edges with correct args", async () => {
    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 0);
      capturedStmts.push(stmt);
      return stmt;
    });

    const edges = new Map<string, EdgeData>([
      [
        "Roxabi/lyra#2",
        {
          parents: ["Roxabi/lyra#1"],
          children: [],
          blockedBy: ["Roxabi/lyra#3"],
          blocking: [],
        },
      ],
    ]);

    await flushEdges(db, edges);

    const insertStmts = capturedStmts.filter((s) =>
      s.sql.trimStart().startsWith("INSERT"),
    );
    // 1 parent edge + 1 blockedBy edge = 2 inserts
    expect(insertStmts).toHaveLength(2);
    // Parent edge: src=parent, dst=child
    const parentInsert = insertStmts.find((s) => s.args.includes("Roxabi/lyra#1"));
    expect(parentInsert).toBeDefined();
    expect(parentInsert!.args).toEqual(["Roxabi/lyra#1", "Roxabi/lyra#2"]);
    // Blocks edge: src=blocker, dst=blocked
    const blocksInsert = insertStmts.find((s) => s.args.includes("Roxabi/lyra#3"));
    expect(blocksInsert).toBeDefined();
    expect(blocksInsert!.args).toEqual(["Roxabi/lyra#3", "Roxabi/lyra#2"]);
  });

  it("is a no-op (no batch call) for empty collectedEdges map", async () => {
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, [], 0));
    await flushEdges(db, new Map());
    expect((db as unknown as { batch: ReturnType<typeof vi.fn> }).batch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// UPSERT_ISSUE_SQL shape (TF4)
// ---------------------------------------------------------------------------

describe("UPSERT_ISSUE_SQL", () => {
  it("stores title inside json_object payload (not as a bare column)", () => {
    // Assert the SQL uses json_object('title', ?) — not a raw title column
    expect(UPSERT_ISSUE_SQL).toMatch(/json_object\('title', \?\)/);
  });

  it("updates payload via excluded.payload on conflict", () => {
    // Match regardless of alignment whitespace between column name and = sign
    expect(UPSERT_ISSUE_SQL).toMatch(/payload\s*=\s*excluded\.payload/);
  });

  it("does not expose title as a top-level excluded column", () => {
    // title must not appear as `excluded.title` — it lives inside the JSON payload
    expect(UPSERT_ISSUE_SQL).not.toMatch(/title\s*=\s*excluded\.title/);
  });
});

describe("UPSERT_ISSUE_SQL_STRUCTURE", () => {
  it("uses empty json_object() payload with no title bind arg", () => {
    expect(UPSERT_ISSUE_SQL_STRUCTURE).toMatch(/json_object\(\)/);
    expect(UPSERT_ISSUE_SQL_STRUCTURE).not.toMatch(/json_object\('title', \?\)/);
  });

  it("updates payload via excluded.payload on conflict", () => {
    expect(UPSERT_ISSUE_SQL_STRUCTURE).toMatch(/payload\s*=\s*excluded\.payload/);
  });
});

// ---------------------------------------------------------------------------
// ensureGlobalSyncControlSeeded
// ---------------------------------------------------------------------------

describe("ensureGlobalSyncControlSeeded", () => {
  it("inserts all global sentinel keys at tenant_id=0", async () => {
    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 0);
      capturedStmts.push(stmt);
      return stmt;
    });

    await ensureGlobalSyncControlSeeded(db);

    expect(capturedStmts.length).toBeGreaterThanOrEqual(6);
    for (const stmt of capturedStmts) {
      expect(stmt.sql).toContain("INSERT OR IGNORE INTO sync_control");
      expect(stmt.sql).toContain("VALUES (0, ?, ?, ?)");
    }
    const keys = capturedStmts.map((s) => s.args[0]);
    expect(keys).toContain("sync_running");
    expect(keys).toContain("halted");
    expect(keys).toContain("auth_failures");
  });
});

// ---------------------------------------------------------------------------
// acquireSyncLock
// ---------------------------------------------------------------------------

describe("acquireSyncLock", () => {
  it("returns true when UPDATE affects a row (changes=1)", async () => {
    const db = makeFakeDb((sql, args) =>
      makeFakeStmt(sql, args, [], 1),
    );
    const acquired = await acquireSyncLock(db);
    expect(acquired).toBe(true);
  });

  it("returns false when UPDATE affects no rows (changes=0)", async () => {
    const db = makeFakeDb((sql, args) =>
      makeFakeStmt(sql, args, [], 0),
    );
    const acquired = await acquireSyncLock(db);
    expect(acquired).toBe(false);
  });

  it("scopes UPDATE to tenant_id = 0 (TF3)", async () => {
    // Arrange
    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 1);
      capturedStmts.push(stmt);
      return stmt;
    });
    // Act
    await acquireSyncLock(db);
    // Assert
    expect(capturedStmts).toHaveLength(1);
    expect(capturedStmts[0].sql).toContain("key = 'sync_running'");
    expect(capturedStmts[0].sql).toContain("AND tenant_id = ?");
  });
});

// ---------------------------------------------------------------------------
// isHalted
// ---------------------------------------------------------------------------

describe("isHalted", () => {
  it("returns true when sync_control halted=1", async () => {
    const db = makeFakeDb((sql, args) =>
      makeFakeStmt(sql, args, [{ value: "1" }]),
    );
    expect(await isHalted(db)).toBe(true);
  });

  it("returns false when sync_control halted=0", async () => {
    const db = makeFakeDb((sql, args) =>
      makeFakeStmt(sql, args, [{ value: "0" }]),
    );
    expect(await isHalted(db)).toBe(false);
  });

  it("returns false when row is missing (null)", async () => {
    const db = makeFakeDb((sql, args) =>
      makeFakeStmt(sql, args, []),
    );
    expect(await isHalted(db)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// haltSync
// ---------------------------------------------------------------------------

describe("haltSync", () => {
  it("executes UPDATE setting halted=1", async () => {
    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 1);
      capturedStmts.push(stmt);
      return stmt;
    });
    await haltSync(db);
    expect(capturedStmts).toHaveLength(1);
    // value='1' is a SQL literal, not a bound param — assert the SQL text
    expect(capturedStmts[0].sql).toContain("value='1'");
    expect(capturedStmts[0].sql).toContain("key='halted'");
    // tenant isolation guard must be present (TF3)
    expect(capturedStmts[0].sql).toContain("AND tenant_id = ?");
    // ISO timestamp + tenantId are bound
    expect(capturedStmts[0].args).toHaveLength(2);
    expect(typeof capturedStmts[0].args[0]).toBe("string");
    expect(String(capturedStmts[0].args[0])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// getAuthFailures / incrementAuthFailures / resetAuthFailures
// ---------------------------------------------------------------------------

describe("auth failure helpers", () => {
  it("getAuthFailures returns 0 when row missing", async () => {
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, []));
    expect(await getAuthFailures(db)).toBe(0);
  });

  it("getAuthFailures parses integer from value string", async () => {
    const db = makeFakeDb((sql, args) =>
      makeFakeStmt(sql, args, [{ value: "2" }]),
    );
    expect(await getAuthFailures(db)).toBe(2);
  });

  it("resetAuthFailures calls UPDATE with value=0", async () => {
    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 1);
      capturedStmts.push(stmt);
      return stmt;
    });
    await resetAuthFailures(db);
    // value='0' is a SQL literal, not a bound param — assert the SQL text
    expect(capturedStmts[0].sql).toContain("value='0'");
    expect(capturedStmts[0].sql).toContain("key='auth_failures'");
    // tenant isolation guard must be present (TF3)
    expect(capturedStmts[0].sql).toContain("AND tenant_id = ?");
    // ISO timestamp + tenantId are bound
    expect(capturedStmts[0].args).toHaveLength(2);
    expect(String(capturedStmts[0].args[0])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("incrementAuthFailures increments and returns new count", async () => {
    // First prepare call (UPDATE) → changes=1; second prepare call (SELECT) → value="3"
    let callCount = 0;
    const db = makeFakeDb((sql, args) => {
      callCount++;
      if (callCount === 1) return makeFakeStmt(sql, args, [], 1);
      return makeFakeStmt(sql, args, [{ value: "3" }]);
    });
    const result = await incrementAuthFailures(db);
    expect(result).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// extractFromLabels — priority alias full coverage
// ---------------------------------------------------------------------------

describe("extractFromLabels priority aliases", () => {
  it.each([
    ["P0", "P0"],
    ["priority:P0", "P0"],
    ["P1-high", "P1"],
    ["priority:high", "P1"],
    ["priority:P1", "P1"],
    ["P2-medium", "P2"],
    ["priority:medium", "P2"],
    ["priority:P2", "P2"],
    ["P3-low", "P3"],
    ["priority:low", "P3"],
    ["priority: low", "P3"],
    ["priority:P3", "P3"],
  ])("label %s → priority %s", (label, expected) => {
    const { priority } = extractFromLabels([label]);
    expect(priority).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// syncRepoIssues — basic coverage
// ---------------------------------------------------------------------------

vi.mock("./graphql", () => ({
  ghGraphql: vi.fn(),
  GraphQLError: class GraphQLError extends Error {
    isAuth: boolean;
    constructor(msg: string, isAuth = false) {
      super(msg);
      this.isAuth = isAuth;
    }
  },
}));

vi.mock("./queries", () => ({
  ARCHIVED_REPOS_QUERY: "ARCHIVED_REPOS_QUERY",
  ISSUES_QUERY: "ISSUES_QUERY",
  ISSUES_QUERY_STRUCTURE_ONLY: "ISSUES_QUERY_STRUCTURE_ONLY",
  PRS_QUERY: "PRS_QUERY",
  REFS_QUERY: "REFS_QUERY",
  REPO_BUNDLE_QUERY: "REPO_BUNDLE_QUERY",
  REPO_BUNDLE_QUERY_STRUCTURE_ONLY: "REPO_BUNDLE_QUERY_STRUCTURE_ONLY",
  REPOS_QUERY: "REPOS_QUERY",
  STUB_ISSUE_QUERY: "STUB_ISSUE_QUERY",
  STUB_ISSUE_QUERY_STRUCTURE_ONLY: "STUB_ISSUE_QUERY_STRUCTURE_ONLY",
  pickIssuesQuery: (structureOnly: boolean) =>
    structureOnly ? "ISSUES_QUERY_STRUCTURE_ONLY" : "ISSUES_QUERY",
  pickRepoBundleQuery: (structureOnly: boolean) =>
    structureOnly ? "REPO_BUNDLE_QUERY_STRUCTURE_ONLY" : "REPO_BUNDLE_QUERY",
  pickStubIssueQuery: (structureOnly: boolean) =>
    structureOnly ? "STUB_ISSUE_QUERY_STRUCTURE_ONLY" : "STUB_ISSUE_QUERY",
}));

vi.mock("../auth/installToken", () => ({
  getInstallationToken: vi.fn(),
  resolveInstallToken: vi.fn(),
  listInstallationRepos: vi.fn(),
}));

describe("syncRepoIssues", () => {
  it("upserts issues, deletes+inserts labels, collects edges, writes sync_state", async () => {
    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);

    // Single page response with one issue
    mockGhGraphql.mockResolvedValueOnce({
      data: {
        rateLimit: { cost: 1, remaining: 4999 },
        repository: {
          issues: {
            nodes: [
              {
                number: 42,
                title: "Test issue",
                state: "OPEN",
                url: "https://github.com/Roxabi/lyra/issues/42",
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-02T00:00:00Z",
                closedAt: null,
                milestone: null,
                labels: { nodes: [{ name: "P1-high" }, { name: "size:S" }] },
                subIssues: { nodes: [] },
                parent: null,
                blockedBy: { nodes: [] },
                blocking: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      // sync_state SELECT → return null (first run)
      if (sql.includes("SELECT last_synced_at")) {
        return makeFakeStmt(sql, args, []);
      }
      const stmt = makeFakeStmt(sql, args, [], 1);
      capturedStmts.push(stmt);
      return stmt;
    });

    const edges = new Map<string, EdgeData>();
    await syncRepoIssues(db, "fake-token", "Roxabi", "lyra", edges);

    // Should have called ghGraphql once
    expect(mockGhGraphql).toHaveBeenCalledTimes(1);
    expect(mockGhGraphql).toHaveBeenCalledWith(
      "ISSUES_QUERY",
      { owner: "Roxabi", name: "lyra", cursor: null, since: null },
      "fake-token",
    );

    // batch() should have been called (pageStmts via batchChunked)
    const batchMock = (db as unknown as { batch: ReturnType<typeof vi.fn> }).batch;
    expect(batchMock).toHaveBeenCalled();

    // sync_state INSERT should have been executed
    const syncStateStmt = capturedStmts.find((s) => s.sql.includes("sync_state"));
    expect(syncStateStmt).toBeDefined();
    expect(syncStateStmt!.args[0]).toBe("Roxabi/lyra");

    // Edge collection
    expect(edges.has("Roxabi/lyra#42")).toBe(true);
  });

  it("structureOnly=true uses structure query and empty payload upsert", async () => {
    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);

    mockGhGraphql.mockResolvedValueOnce({
      data: {
        rateLimit: { cost: 1, remaining: 4999 },
        repository: {
          issues: {
            nodes: [
              {
                number: 7,
                state: "OPEN",
                url: "https://github.com/Roxabi/lyra/issues/7",
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-02T00:00:00Z",
                closedAt: null,
                milestone: null,
                labels: { nodes: [] },
                subIssues: { nodes: [] },
                parent: null,
                blockedBy: { nodes: [] },
                blocking: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      if (sql.includes("SELECT last_synced_at")) {
        return makeFakeStmt(sql, args, []);
      }
      const stmt = makeFakeStmt(sql, args, [], 1);
      capturedStmts.push(stmt);
      return stmt;
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await syncRepoIssues(db, "fake-token", "Roxabi", "lyra", new Map(), false, new Set(), true);

    expect(mockGhGraphql).toHaveBeenCalledWith(
      "ISSUES_QUERY_STRUCTURE_ONLY",
      { owner: "Roxabi", name: "lyra", cursor: null, since: null },
      "fake-token",
    );

    const upsertStmt = capturedStmts.find((s) => s.sql.includes("INSERT INTO issues"));
    expect(upsertStmt).toBeDefined();
    expect(upsertStmt!.sql).toContain("json_object()");
    expect(upsertStmt!.args).not.toContain("Test issue");

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        prefix: "[zk]",
        event: "structure_only.title_skipped",
        key: "Roxabi/lyra#7",
        repo: "Roxabi/lyra",
      }),
    );
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// syncBranches — reset-then-set, dedup, atomic batch, D1-safe chunking
// ---------------------------------------------------------------------------

describe("syncBranches", () => {
  it("reset-all-to-0 then set matched=1 (deduped) in a single atomic batch", async () => {
    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);
    mockGhGraphql.mockResolvedValueOnce({
      data: {
        rateLimit: { cost: 1, remaining: 4999 },
        repository: {
          refs: {
            nodes: [
              { name: "feat/42-some-feature" },
              { name: "7-fix-thing" },
              { name: "main" },
              { name: "staging" },
              { name: "feat/42-duplicate" }, // same issue 42 → must dedup
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 1);
      capturedStmts.push(stmt);
      return stmt;
    });

    await syncBranches(db, "fake-token", "Roxabi", "lyra");

    expect(mockGhGraphql).toHaveBeenCalledWith(
      "REFS_QUERY",
      { owner: "Roxabi", name: "lyra", cursor: null },
      "fake-token",
    );

    // One atomic batch ([reset, set]) — no transient all-zero window
    const batchMock = (db as unknown as { batch: ReturnType<typeof vi.fn> }).batch;
    expect(batchMock).toHaveBeenCalledTimes(1);

    // reset-to-0 first, scoped to repo only (no `number` clause)
    const resetStmt = capturedStmts.find(
      (s) =>
        s.sql.includes("has_active_branch=0") &&
        s.sql.includes("WHERE repo=?") &&
        !s.sql.includes("number"),
    );
    expect(resetStmt).toBeDefined();
    expect(resetStmt!.args).toEqual(["Roxabi/lyra"]);

    // set-to-1 with deduped numbers (42 once, 7 once) → [repo, 42, 7]
    const setStmt = capturedStmts.find((s) => s.sql.includes("has_active_branch=1"));
    expect(setStmt).toBeDefined();
    expect(setStmt!.args).toEqual(["Roxabi/lyra", 42, 7]);
  });

  it("zeros all issues in repo (no batch) when no branch matches an issue number", async () => {
    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);
    mockGhGraphql.mockResolvedValueOnce({
      data: {
        rateLimit: { cost: 1, remaining: 4999 },
        repository: {
          refs: {
            nodes: [{ name: "main" }, { name: "feature/no-issue" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      const stmt = makeFakeStmt(sql, args, [], 1);
      capturedStmts.push(stmt);
      return stmt;
    });

    await syncBranches(db, "fake-token", "Roxabi", "lyra");

    // No matched numbers → single reset UPDATE, no batch
    const batchMock = (db as unknown as { batch: ReturnType<typeof vi.fn> }).batch;
    expect(batchMock).not.toHaveBeenCalled();
    const resetStmt = capturedStmts.find((s) => s.sql.includes("has_active_branch=0"));
    expect(resetStmt).toBeDefined();
    expect(resetStmt!.args).toEqual(["Roxabi/lyra"]);
  });
});

// ---------------------------------------------------------------------------
// syncRepoBundle — bundled per-repo fetch (issues + refs + PRs in 1 subreq)
// ---------------------------------------------------------------------------

describe("syncRepoBundle", () => {
  it("processes issues, applies branch flags, applies PR state, writes sync_state, collects edges — 1 ghGraphql call", async () => {
    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);

    // Single-page bundled response
    mockGhGraphql.mockResolvedValueOnce({
      data: {
        rateLimit: { cost: 3, remaining: 4997 },
        repository: {
          issues: {
            nodes: [
              {
                number: 10,
                title: "Bundle test issue",
                state: "OPEN",
                url: "https://github.com/Roxabi/lyra/issues/10",
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-02T00:00:00Z",
                closedAt: null,
                milestone: null,
                labels: { nodes: [{ name: "P2-medium" }] },
                subIssues: { nodes: [] },
                parent: null,
                blockedBy: { nodes: [] },
                blocking: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          refs: {
            nodes: [{ name: "feat/10-bundle-test" }, { name: "main" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          pullRequests: {
            nodes: [
              {
                number: 5,
                state: "OPEN",
                closingIssuesReferences: {
                  nodes: [{ number: 10, repository: { nameWithOwner: "Roxabi/lyra" } }],
                },
                labels: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      // sync_state SELECT → null (first run)
      if (sql.includes("SELECT last_synced_at")) {
        return makeFakeStmt(sql, args, []);
      }
      // applyPrState: SELECT open PRs → PR #5 open
      if (sql.includes("SELECT number FROM pull_requests") && sql.includes("state='open'")) {
        return makeFakeStmt(sql, args, [{ number: 5 }]);
      }
      const stmt = makeFakeStmt(sql, args, [], 1);
      capturedStmts.push(stmt);
      return stmt;
    });

    const edges = new Map<string, EdgeData>();
    await syncRepoBundle(db, "fake-token", "Roxabi", "lyra", edges);

    // Exactly 1 ghGraphql call with REPO_BUNDLE_QUERY
    expect(mockGhGraphql).toHaveBeenCalledTimes(1);
    expect(mockGhGraphql).toHaveBeenCalledWith(
      "REPO_BUNDLE_QUERY",
      expect.objectContaining({ owner: "Roxabi", name: "lyra", since: null }),
      "fake-token",
    );

    // sync_state written
    const syncStateStmt = capturedStmts.find((s) => s.sql.includes("sync_state"));
    expect(syncStateStmt).toBeDefined();
    expect(syncStateStmt!.args[0]).toBe("Roxabi/lyra");

    // Edge collected for issue 10
    expect(edges.has("Roxabi/lyra#10")).toBe(true);

    // Branch apply: batch called (reset+set for issue 10)
    const batchMock = (db as unknown as { batch: ReturnType<typeof vi.fn> }).batch;
    expect(batchMock).toHaveBeenCalled();
  });

  it("structureOnly=true uses structure bundle query and empty payload upsert", async () => {
    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);

    mockGhGraphql.mockResolvedValueOnce({
      data: {
        rateLimit: { cost: 3, remaining: 4997 },
        repository: {
          issues: {
            nodes: [
              {
                number: 11,
                state: "OPEN",
                url: "https://github.com/Roxabi/lyra/issues/11",
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-02T00:00:00Z",
                closedAt: null,
                milestone: null,
                labels: { nodes: [] },
                subIssues: { nodes: [] },
                parent: null,
                blockedBy: { nodes: [] },
                blocking: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          refs: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    });

    const capturedStmts: FakeStmt[] = [];
    const db = makeFakeDb((sql, args) => {
      if (sql.includes("SELECT last_synced_at")) {
        return makeFakeStmt(sql, args, []);
      }
      const stmt = makeFakeStmt(sql, args, [], 1);
      capturedStmts.push(stmt);
      return stmt;
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await syncRepoBundle(db, "fake-token", "Roxabi", "lyra", new Map(), false, new Set(), true);

    expect(mockGhGraphql).toHaveBeenCalledWith(
      "REPO_BUNDLE_QUERY_STRUCTURE_ONLY",
      expect.objectContaining({ owner: "Roxabi", name: "lyra", since: null }),
      "fake-token",
    );

    const upsertStmt = capturedStmts.find((s) => s.sql.includes("INSERT INTO issues"));
    expect(upsertStmt).toBeDefined();
    expect(upsertStmt!.sql).toContain("json_object()");

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        prefix: "[zk]",
        event: "structure_only.title_skipped",
        key: "Roxabi/lyra#11",
        repo: "Roxabi/lyra",
      }),
    );
    logSpy.mockRestore();
  });

  it("fullSync=true forces since=null without reading the watermark, and returns stale PRs closed (#80)", async () => {
    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);

    mockGhGraphql.mockResolvedValueOnce({
      data: {
        rateLimit: { cost: 1, remaining: 4999 },
        repository: {
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          refs: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          pullRequests: {
            nodes: [
              {
                number: 5,
                state: "OPEN",
                closingIssuesReferences: { nodes: [] },
                labels: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const db = makeFakeDb((sql, args) => {
      // Watermark present — must be ignored when fullSync=true.
      if (sql.includes("SELECT last_synced_at")) {
        return makeFakeStmt(sql, args, [{ last_synced_at: "2026-01-01T00:00:00Z" }]);
      }
      // pr_state: #5 and #6 open in D1; GitHub reports only #5 → #6 is stale.
      if (sql.includes("SELECT number FROM pr_state") && sql.includes("state='open'")) {
        return makeFakeStmt(sql, args, [{ number: 5 }, { number: 6 }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const closed = await syncRepoBundle(db, "fake-token", "Roxabi", "lyra", new Map(), true);

    // since passed as null (full reconcile) despite the watermark being present
    expect(mockGhGraphql).toHaveBeenCalledWith(
      "REPO_BUNDLE_QUERY",
      expect.objectContaining({ owner: "Roxabi", name: "lyra", since: null }),
      "fake-token",
    );
    // watermark SELECT never issued when fullSync=true
    expect(db._recorded.find((s) => s.sql.includes("SELECT last_synced_at"))).toBeUndefined();
    // PR #6 (open in D1, absent from GitHub) closed → count returned
    expect(closed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runSync — integration branches
// ---------------------------------------------------------------------------

describe("runSync", () => {
  function makeEnv(overrides: Record<string, unknown> = {}): Env {
    return {
      DB: undefined as unknown as D1Database,
      ...overrides,
    } as unknown as Env;
  }

  it("returns early when isHalted=true", async () => {
    const db = makeFakeDb((sql, args) => {
      // All queries return halted=1
      return makeFakeStmt(sql, args, [{ value: "1" }], 0);
    });
    const env = makeEnv({ DB: db });

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
    const env = makeEnv({ DB: db });

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

    const env = makeEnv({ DB: db });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runSync(env)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no repos discovered across all installations — nothing to sync"),
    );
    warnSpy.mockRestore();
  });

  // Prune + archived-repo tracking (#N) -------------------------------------

  /**
   * Builds a FakeD1 that drives runSync through the prune path:
   *   discoverTenants → [{id:1, installation_id:139542392}] →
   *   lock acquired → getInstallationToken → listInstallationRepos=[Roxabi/roxabi-factory] →
   *   DB SELECT DISTINCT queries return stale=[Roxabi/lyra] in issues/edges/pr_state/sync_state →
   *   batchChunked invoked with DELETE stmts for Roxabi/lyra
   */
  function makeFullSyncDb(opts: {
    issueRepos?: string[];
    edgeSrcRepos?: string[];
    edgeDstRepos?: string[];
    prStateRepos?: string[];
    syncStateRepos?: string[];
  } = {}) {
    const {
      issueRepos = ["Roxabi/lyra", "Roxabi/roxabi-factory"],
      edgeSrcRepos = ["Roxabi/lyra"],
      edgeDstRepos = [],
      prStateRepos = ["Roxabi/lyra"],
      syncStateRepos = ["Roxabi/lyra", "Roxabi/roxabi-factory"],
    } = opts;

    return makeFakeDb((sql, args) => {
      if (sql.includes("key='halted'")) return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      if (sql.includes("sync_running") && sql.includes("UPDATE")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
      // discoverTenants
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 139542392 }]);
      }
      // tenant_repo_access (not used in prune path but respond gracefully)
      if (sql.includes("FROM tenant_repo_access")) {
        return makeFakeStmt(sql, args, [{ owner: "Roxabi", name: "roxabi-factory" }]);
      }
      // Prune SELECT DISTINCT queries
      if (sql.includes("SELECT DISTINCT repo FROM issues")) {
        return makeFakeStmt(sql, args, issueRepos.map((r) => ({ repo: r })));
      }
      if (sql.includes("SELECT DISTINCT substr(src_key")) {
        return makeFakeStmt(sql, args, edgeSrcRepos.map((r) => ({ repo: r })));
      }
      if (sql.includes("SELECT DISTINCT substr(dst_key")) {
        return makeFakeStmt(sql, args, edgeDstRepos.map((r) => ({ repo: r })));
      }
      if (sql.includes("SELECT DISTINCT repo FROM pr_state")) {
        return makeFakeStmt(sql, args, prStateRepos.map((r) => ({ repo: r })));
      }
      if (sql.includes("SELECT repo FROM sync_state")) {
        return makeFakeStmt(sql, args, syncStateRepos.map((r) => ({ repo: r })));
      }
      // releaseSyncLock, writeRunAudit queries
      return makeFakeStmt(sql, args, [], 1);
    });
  }

  it("prunes issues/edges/pr_state/sync_state for a deleted repo (Roxabi/lyra)", async () => {
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    // listInstallationRepos returns only roxabi-factory (lyra is gone)
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "Roxabi/roxabi-factory", isPrivate: false }]);

    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);
    // syncRepoBundle calls for roxabi-factory — empty result
    mockGhGraphql.mockResolvedValue({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
        rateLimit: { cost: 1, remaining: 4998, resetAt: "2026-01-01T00:00:00Z" },
      },
    });

    const db = makeFullSyncDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const env = makeEnv({ DB: db });
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
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "Roxabi/roxabi-factory", isPrivate: false }, { repo: "Roxabi/roxabi-vault", isPrivate: false }]);

    const { ghGraphql } = await import("./graphql");
    const mockGhGraphql = vi.mocked(ghGraphql);
    // syncRepoBundle empty result for each repo
    mockGhGraphql.mockResolvedValue({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
        rateLimit: { cost: 1, remaining: 4998, resetAt: "2026-01-01T00:00:00Z" },
      },
    });

    // DB returns roxabi-vault as present in issues — but it's still in live set, so NOT stale
    const db = makeFullSyncDb({
      issueRepos: ["Roxabi/roxabi-vault", "Roxabi/roxabi-factory"],
      edgeSrcRepos: [],
      edgeDstRepos: [],
      prStateRepos: [],
      syncStateRepos: ["Roxabi/roxabi-vault", "Roxabi/roxabi-factory"],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const env = makeEnv({ DB: db });
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
      if (sql.includes("sync_running") && sql.includes("UPDATE")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 139542392 }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const env = makeEnv({ DB: db });
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

// ---------------------------------------------------------------------------
// writeRunAudit (#120)
// ---------------------------------------------------------------------------

describe("writeRunAudit", () => {
  function auditDb() {
    return makeFakeDb((sql, args) => {
      if (sql.includes("FROM issues")) return makeFakeStmt(sql, args, [{ c: 2650 }]);
      if (sql.includes("FROM edges")) return makeFakeStmt(sql, args, [{ c: 2432 }]);
      if (sql.includes("FROM pr_state")) return makeFakeStmt(sql, args, [{ c: 373 }]);
      if (sql.includes("MAX(last_synced_at)"))
        return makeFakeStmt(sql, args, [{ w: "2026-06-08T09:00:00Z" }]);
      if (sql.includes("sync_control"))
        return makeFakeStmt(sql, args, [
          { key: "halted", value: "0" },
          { key: "auth_failures", value: "0" },
        ]);
      return makeFakeStmt(sql, args, []);
    });
  }

  it("no-ops when LOGS is unbound (never throws)", async () => {
    const env = { DB: auditDb() } as unknown as Env;
    await expect(
      writeRunAudit(env, env.DB, { outcome: "success", stubs: 0, durationMs: 1 }),
    ).resolves.toBeUndefined();
  });

  it("puts a JSON snapshot with counts + watermark when LOGS is bound", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue(undefined);
    const db = auditDb();
    const env = { DB: db, LOGS: { put } } as unknown as Env;

    await writeRunAudit(env, db, { outcome: "success", stubs: 4, durationMs: 1234 });

    expect(put).toHaveBeenCalledTimes(1);
    const [key, body, opts] = put.mock.calls[0];
    expect(key).toMatch(/^runs\/\d{4}-\d{2}-\d{2}\/.+\.json$/);
    expect(opts).toMatchObject({ httpMetadata: { contentType: "application/json" } });
    const snap = JSON.parse(body as string);
    expect(snap).toMatchObject({
      outcome: "success",
      stubs: 4,
      durationMs: 1234,
      issues: 2650,
      edges: 2432,
      prs: 373,
      watermark: "2026-06-08T09:00:00Z",
      halted: false,
      authFailures: 0,
    });
  });

  it("records net deltas + corrections when before-snapshot + corrections supplied (#80)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue(undefined);
    const db = auditDb();
    const env = { DB: db, LOGS: { put } } as unknown as Env;

    await writeRunAudit(env, db, {
      outcome: "success",
      stubs: 2,
      durationMs: 500,
      before: { issues: 2600, edges: 2400, prs: 370 },
      reposSynced: 8,
      reposSkipped: 1,
      corrections: { stalePrsClosed: 3, staleReposPruned: 1, staleTenantReposRemoved: 2 },
    });

    const snap = JSON.parse(put.mock.calls[0][1] as string);
    // after (auditDb) = {2650, 2432, 373}; before = {2600, 2400, 370}
    expect(snap.deltas).toEqual({ issues: 50, edges: 32, prs: 3 });
    expect(snap.reposSynced).toBe(8);
    expect(snap.reposSkipped).toBe(1);
    expect(snap.corrections).toEqual({
      stubsCreated: 2,
      stalePrsClosed: 3,
      staleReposPruned: 1,
      staleTenantReposRemoved: 2,
    });
  });

  it("emits zero deltas when no before-snapshot is supplied", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue(undefined);
    const db = auditDb();
    const env = { DB: db, LOGS: { put } } as unknown as Env;

    await writeRunAudit(env, db, { outcome: "success", stubs: 0, durationMs: 1 });

    const snap = JSON.parse(put.mock.calls[0][1] as string);
    expect(snap.deltas).toEqual({ issues: 0, edges: 0, prs: 0 });
    expect(snap.corrections).toEqual({
      stubsCreated: 0,
      stalePrsClosed: 0,
      staleReposPruned: 0,
      staleTenantReposRemoved: 0,
    });
  });

  it("swallows R2 put failures (audit must not fail the sync)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const put = vi.fn().mockRejectedValue(new Error("R2 down"));
    const db = auditDb();
    const env = { DB: db, LOGS: { put } } as unknown as Env;

    await expect(
      writeRunAudit(env, db, { outcome: "error", stubs: 0, durationMs: 5 }),
    ).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(1);
  });
});

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
  function makeEnv(overrides: Record<string, unknown> = {}): Env {
    return {
      DB: undefined as unknown as D1Database,
      ...overrides,
    } as unknown as Env;
  }

  it("deduplicates GraphQL bundle fetches: two tenants sharing repo o/r → exactly 1 REPO_BUNDLE_QUERY issued for o/r", async () => {
    // Two tenants both have access to "o/r" via their install tokens.
    // runSync must deduplicate: one syncRepoBundle call regardless of tenant count.
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    // Both tenants enumerate the same repo "o/r"
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "o/r", isPrivate: false }]);

    const db = makeFakeDb((sql, args) => {
      if (sql.includes("key='halted'")) return makeFakeStmt(sql, args, [{ value: "0" }], 0);
      if (sql.includes("sync_running") && sql.includes("UPDATE")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 10 }, { id: 2, installation_id: 20 }]);
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

    const env = makeEnv({ DB: db });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync(env);

    // Exactly 1 ghGraphql call for repo o/r (deduplication)
    const bundleCalls = mockGhGraphql.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.owner === "o" && (c[1] as Record<string, unknown>)?.name === "r",
    );
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
      if (sql.includes("sync_running") && sql.includes("UPDATE")) return makeFakeStmt(sql, args, [], 1);
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
    const env = makeEnv({ DB: db });
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
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 10 }, { id: 2, installation_id: 20 }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = makeEnv({ DB: db });
    await runSync(env);
    warnSpy.mockRestore();

    // Tenant B's lock attempt must have been made (runSync iterates tenants independently).
    expect(tenantBLockAttempted).toBe(true);
  });

  it("no PAT access: runSync completes via install tokens without reading env.GITHUB_TOKEN", async () => {
    // runSync must use getInstallationToken() and never read env.GITHUB_TOKEN.
    const { getInstallationToken, listInstallationRepos } = await import("../auth/installToken");
    vi.mocked(getInstallationToken).mockResolvedValue("fake-token");
    vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "Roxabi/roxabi-factory", isPrivate: false }]);

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
      if (sql.includes("sync_running") && sql.includes("UPDATE")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("sync_started_at")) return makeFakeStmt(sql, args, [], 1);
      if (sql.includes("FROM tenants")) {
        return makeFakeStmt(sql, args, [{ id: 1, installation_id: 139542392 }]);
      }
      return makeFakeStmt(sql, args, [], 1);
    });

    const base = makeEnv({ DB: db });
    // Replace GITHUB_TOKEN with a spy getter that records every access.
    let patAccessCount = 0;
    delete (base as unknown as Record<string, unknown>)["GITHUB_TOKEN"];
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
      if (sql.includes("sync_running") && sql.includes("UPDATE")) return makeFakeStmt(sql, args, [], 1);
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
    const env = makeEnv({ DB: db });

    // Must resolve without throwing — windowed-past-end is a valid no-op for Phase 2.
    await expect(runSync(env)).resolves.toBeUndefined();

    // No REPO_BUNDLE_QUERY calls: Phase 2 was skipped entirely.
    const bundleCalls = mockGhGraphql.mock.calls.filter((c) => c[0] === "REPO_BUNDLE_QUERY");
    expect(bundleCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runSync — breaker + discovery (#160)
// ---------------------------------------------------------------------------

describe("runSync — breaker + discovery (#160)", () => {
  function makeEnv(overrides: Record<string, unknown> = {}): Env {
    return {
      DB: undefined as unknown as D1Database,
      ...overrides,
    } as unknown as Env;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
      if (sql.includes("key='auth_failures'") && sql.includes("SELECT") && !sql.includes("UPDATE")) {
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

    const env = makeEnv({ DB: db });

    // Act
    await runSync(env);

    // Assert — auth_failures UPDATE was issued bound to tenant_id=1
    const recorded = db._recorded;
    const authFailureUpdate = recorded.find(
      (s) =>
        s.sql.includes("auth_failures") &&
        s.sql.includes("UPDATE") &&
        s.args.includes(1),
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
      if (sql.includes("key='auth_failures'") && sql.includes("SELECT") && !sql.includes("UPDATE")) {
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

    const env = makeEnv({ DB: db });

    // Act
    await runSync(env);

    // Assert — INSERT for "o/keep"
    const recorded = db._recorded;
    const insertKeep = recorded.find(
      (s) =>
        s.sql.includes("INSERT INTO tenant_repo_access") &&
        s.args.includes("o/keep"),
    );
    expect(insertKeep).toBeDefined();
    // #148: is_private written (o/keep mocked private → bound 1; args = [tenantId, repo, is_private])
    expect(insertKeep?.args[2]).toBe(1);

    // Assert — DELETE for "o/stale" (not for "o/keep")
    const deleteStale = recorded.find(
      (s) =>
        s.sql.includes("DELETE FROM tenant_repo_access") &&
        s.args.includes("o/stale"),
    );
    expect(deleteStale).toBeDefined();

    const deleteKeep = recorded.find(
      (s) =>
        s.sql.includes("DELETE FROM tenant_repo_access") &&
        s.args.includes("o/keep"),
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
      if (sql.includes("key='auth_failures'") && sql.includes("SELECT") && !sql.includes("UPDATE")) {
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

    const env = makeEnv({ DB: db });

    // Act
    await runSync(env);

    // Assert — INSERT for "o/pub" with is_private=0
    const recorded = db._recorded;
    const insertPub = recorded.find(
      (s) =>
        s.sql.includes("INSERT INTO tenant_repo_access") &&
        s.args.includes("o/pub"),
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
      if (sql.includes("key='auth_failures'") && sql.includes("SELECT") && !sql.includes("UPDATE")) {
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

    const env = makeEnv({ DB: db });

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
      if (sql.includes("key='auth_failures'") && sql.includes("SELECT") && !sql.includes("UPDATE")) {
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

    const env = makeEnv({ DB: db });

    // Act + Assert — runSync resolves (does not throw)
    await expect(runSync(env)).resolves.toBeUndefined();

    // ghGraphql must NOT have been called with REPO_BUNDLE_QUERY for o/a
    const bundleCalls = vi.mocked(ghGraphql).mock.calls.filter(
      (c) => c[0] === "REPO_BUNDLE_QUERY",
    );
    expect(bundleCalls).toHaveLength(0);
  });

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
      if (sql.includes("key='auth_failures'") && sql.includes("SELECT") && !sql.includes("UPDATE")) {
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

    const env = makeEnv({ DB: db, NOTIFY_URL: "https://notify.example.com/hook" });

    // Act
    await runSync(env);

    // Assert — a halted-related UPDATE was fired (haltSync writes to sync_control)
    // The SQL sets halted='1' or value='1' where key='halted'
    const recorded = db._recorded;
    const haltUpdate = recorded.find(
      (s) =>
        s.sql.includes("halted") &&
        s.sql.includes("UPDATE"),
    );
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
      if (sql.includes("key='auth_failures'") && sql.includes("SELECT") && !sql.includes("UPDATE")) {
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

    const env = makeEnv({ DB: db, NOTIFY_URL: "https://notify.example.com/hook" });

    // Act
    await runSync(env);

    // Assert — NO halted UPDATE issued
    const recorded = db._recorded;
    const haltUpdate = recorded.find(
      (s) =>
        s.sql.includes("halted") &&
        s.sql.includes("UPDATE"),
    );
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
      if (sql.includes("key='auth_failures'") && sql.includes("SELECT") && !sql.includes("UPDATE")) {
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

    const env = makeEnv({ DB: db });

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

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});
