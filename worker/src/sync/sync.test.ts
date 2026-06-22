import "./sync-test-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_ISSUE_RE,
  UPSERT_ISSUE_SQL,
  UPSERT_ISSUE_SQL_STRUCTURE,
  acquireSyncLock,
  batchChunked,
  canonicalKey,
  collectEdges,
  edgesForRepo,
  ensureGlobalSyncControlSeeded,
  extractFromLabels,
  flushEdges,
  getAuthFailures,
  haltSync,
  incrementAuthFailures,
  isHalted,
  resetAuthFailures,
  syncBranches,
  syncRepoBundle,
  syncRepoIssues,
} from "./sync";
import type { EdgeData } from "./sync";

import { type FakeStmt, makeFakeDb, makeFakeStmt } from "../test-utils";

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
    expect(canonicalKey("Roxabi/voiceCLI#7", "Roxabi/other")).toBe("Roxabi/voiceCLI#7");
  });

  it("throws on unrecognised ref", () => {
    expect(() => canonicalKey("not-a-ref", "Roxabi/lyra")).toThrow(/Cannot canonicalise issue ref/);
  });
});

// ---------------------------------------------------------------------------
// BRANCH_ISSUE_RE
// ---------------------------------------------------------------------------

describe("BRANCH_ISSUE_RE", () => {
  it("matches feat/42-some-feature and captures issue number", () => {
    const m = BRANCH_ISSUE_RE.exec("feat/42-some-feature");
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe("42");
  });

  it("matches bare 7-fix-thing (no prefix) and captures issue number", () => {
    const m = BRANCH_ISSUE_RE.exec("7-fix-thing");
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe("7");
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
    const { lane } = extractFromLabels(["graph:lane/frontend", "graph:lane/backend"]);
    expect(lane).toBe("frontend");
  });

  it("extracts all three fields simultaneously", () => {
    const result = extractFromLabels(["graph:lane/ops", "P0", "size:XL"]);
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
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, [], 0));
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
// edgesForRepo — per-repo edge flush subset
// ---------------------------------------------------------------------------

describe("edgesForRepo", () => {
  it("keeps only keys for the given repo", () => {
    const all = new Map<string, EdgeData>([
      ["Roxabi/lyra#1", { parents: [], children: [], blockedBy: ["Roxabi/core#2"], blocking: [] }],
      ["Roxabi/core#2", { parents: [], children: [], blockedBy: [], blocking: ["Roxabi/lyra#1"] }],
    ]);
    const lyra = edgesForRepo(all, "Roxabi/lyra");
    expect([...lyra.keys()]).toEqual(["Roxabi/lyra#1"]);
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

    const deleteStmts = capturedStmts.filter((s) => s.sql.trimStart().startsWith("DELETE"));
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
      ["Roxabi/lyra#1", { parents: [], children: [], blockedBy: ["Roxabi/lyra#2"], blocking: [] }],
    ]);

    await flushEdges(db, edges);

    const deleteStmts = capturedStmts.filter((s) => s.sql.trimStart().startsWith("DELETE"));
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

    const deleteStmts = capturedStmts.filter((s) => s.sql.trimStart().startsWith("DELETE"));
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

    const insertStmts = capturedStmts.filter((s) => s.sql.trimStart().startsWith("INSERT"));
    // 1 parent edge + 1 blockedBy edge = 2 inserts
    expect(insertStmts).toHaveLength(2);
    // Parent edge: src=parent, dst=child
    const parentInsert = insertStmts.find((s) => s.args.includes("Roxabi/lyra#1"));
    expect(parentInsert).toBeDefined();
    expect(parentInsert?.args).toEqual(["Roxabi/lyra#1", "Roxabi/lyra#2"]);
    // Blocks edge: src=blocker, dst=blocked
    const blocksInsert = insertStmts.find((s) => s.args.includes("Roxabi/lyra#3"));
    expect(blocksInsert).toBeDefined();
    expect(blocksInsert?.args).toEqual(["Roxabi/lyra#3", "Roxabi/lyra#2"]);
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
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, [], 1));
    const acquired = await acquireSyncLock(db);
    expect(acquired).toBe(true);
  });

  it("returns false when UPDATE affects no rows (changes=0)", async () => {
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, [], 0));
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
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, [{ value: "1" }]));
    expect(await isHalted(db)).toBe(true);
  });

  it("returns false when sync_control halted=0", async () => {
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, [{ value: "0" }]));
    expect(await isHalted(db)).toBe(false);
  });

  it("returns false when row is missing (null)", async () => {
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, []));
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
    const db = makeFakeDb((sql, args) => makeFakeStmt(sql, args, [{ value: "2" }]));
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
                assignees: { nodes: [{ login: "alice" }] },
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
    expect(syncStateStmt?.args[0]).toBe("Roxabi/lyra");

    // Edge collection
    expect(edges.has("Roxabi/lyra#42")).toBe(true);

    const upsertStmt = capturedStmts.find((s) => s.sql.includes("INSERT INTO issues"));
    expect(upsertStmt?.args).toContain('["alice"]');
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
    expect(upsertStmt?.sql).toContain("json_object()");
    expect(upsertStmt?.args).not.toContain("Test issue");

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
    expect(resetStmt?.args).toEqual(["Roxabi/lyra"]);

    // set-to-1 with deduped numbers (42 once, 7 once) → [repo, 42, 7]
    const setStmt = capturedStmts.find((s) => s.sql.includes("has_active_branch=1"));
    expect(setStmt).toBeDefined();
    expect(setStmt?.args).toEqual(["Roxabi/lyra", 42, 7]);
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
    expect(resetStmt?.args).toEqual(["Roxabi/lyra"]);
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
    expect(syncStateStmt?.args[0]).toBe("Roxabi/lyra");

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
    expect(upsertStmt?.sql).toContain("json_object()");

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

afterEach(() => {
  vi.restoreAllMocks();
});
