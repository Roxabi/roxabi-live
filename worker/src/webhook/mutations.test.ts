import { describe, expect, it, vi } from "vitest";
import {
  BUMP_DATA_VERSION_SQL,
  UPSERT_ISSUE_FROM_WEBHOOK_SQL,
  UPSERT_PR_STATE_SQL,
  addEdge,
  bumpDataVersion,
  deleteIssue,
  removeEdge,
  renameMilestone,
  replaceLabels,
  setActiveBranch,
  upsertEdges,
  upsertIssueFromWebhook,
  upsertPrState,
} from "./mutations";
import type { WebhookIssue } from "./mutations";

// ---------------------------------------------------------------------------
// FakeD1 — cloned from src/sync/sync.test.ts
// ---------------------------------------------------------------------------

type FakeResult = { value?: string; changes?: number; [k: string]: unknown };

interface FakeStmt {
  sql: string;
  args: unknown[];
  run: () => Promise<{ meta: { changes: number } }>;
  first: <T = FakeResult>() => Promise<T | null>;
  all: <T = FakeResult>() => Promise<{ results: T[] }>;
}

function makeFakeStmt(
  sql: string,
  args: unknown[],
  rows: FakeResult[],
  changes = 0,
): FakeStmt {
  return {
    sql,
    args,
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
    all: vi.fn().mockResolvedValue({ results: rows }),
  };
}

function makeFakeDb(
  stmtFactory: (sql: string, args: unknown[]) => FakeStmt,
): D1Database {
  const recorded: FakeStmt[] = [];

  const db = {
    prepare(sql: string) {
      let directStmt: FakeStmt | null = null;
      const getDirectStmt = (): FakeStmt => {
        if (!directStmt) {
          directStmt = stmtFactory(sql, []);
          recorded.push(directStmt);
        }
        return directStmt;
      };

      return {
        first<T = FakeResult>(): Promise<T | null> {
          return getDirectStmt().first<T>();
        },
        run(): Promise<{ meta: { changes: number } }> {
          return getDirectStmt().run();
        },
        all<T = FakeResult>(): Promise<{ results: T[] }> {
          return getDirectStmt().all<T>();
        },
        bind(...args: unknown[]) {
          const stmt = stmtFactory(sql, args);
          recorded.push(stmt);
          return stmt;
        },
      };
    },
    batch: vi.fn(async (stmts: FakeStmt[]) => {
      await Promise.all(stmts.map((s) => s.run()));
      return stmts.map(() => ({ results: [], meta: { changes: 0 } }));
    }),
    _recorded: recorded,
  } as unknown as D1Database & { _recorded: FakeStmt[] };

  return db;
}

/** Capture all statements produced via bind() calls on the FakeDb. */
function captureDb(): { db: D1Database; stmts: () => FakeStmt[] } {
  const captured: FakeStmt[] = [];
  const db = makeFakeDb((sql, args) => {
    const stmt = makeFakeStmt(sql, args, [], 0);
    captured.push(stmt);
    return stmt;
  });
  return { db, stmts: () => captured };
}

// ---------------------------------------------------------------------------
// upsertIssueFromWebhook
// ---------------------------------------------------------------------------

describe("upsertIssueFromWebhook", () => {
  const baseIssue: WebhookIssue = {
    key: "Roxabi/lyra#42",
    repo: "Roxabi/lyra",
    number: 42,
    title: "Test issue",
    state: "open",
    url: "https://github.com/Roxabi/lyra/issues/42",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    closed_at: null,
    milestone: "Sprint 1",
    lane: "backend",
    priority: "P1",
    size: "F-lite",
  };

  it("uses UPSERT_ISSUE_FROM_WEBHOOK_SQL constant", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    upsertIssueFromWebhook(db, baseIssue);
    // Assert
    expect(stmts()[0].sql).toBe(UPSERT_ISSUE_FROM_WEBHOOK_SQL);
  });

  it("binds 13 args in the correct order matching WebhookIssue field layout", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    upsertIssueFromWebhook(db, baseIssue);
    // Assert — order: key, repo, number, title, state, url, created_at, updated_at, closed_at, milestone, lane, priority, size
    expect(stmts()[0].args).toEqual([
      "Roxabi/lyra#42",
      "Roxabi/lyra",
      42,
      "Test issue",
      "open",
      "https://github.com/Roxabi/lyra/issues/42",
      "2024-01-01T00:00:00Z",
      "2024-01-02T00:00:00Z",
      null,
      "Sprint 1",
      "backend",
      "P1",
      "F-lite",
    ]);
  });

  it("coerces undefined optional fields to null", () => {
    // Arrange
    const { db, stmts } = captureDb();
    const minimalIssue: WebhookIssue = {
      key: "Roxabi/lyra#1",
      repo: "Roxabi/lyra",
      number: 1,
      title: "Minimal",
      state: "open",
      url: "https://github.com/Roxabi/lyra/issues/1",
    };
    // Act
    upsertIssueFromWebhook(db, minimalIssue);
    // Assert — all optional fields become null
    const args = stmts()[0].args;
    expect(args).toHaveLength(13);
    expect(args[6]).toBeNull(); // created_at
    expect(args[7]).toBeNull(); // updated_at
    expect(args[8]).toBeNull(); // closed_at
    expect(args[9]).toBeNull(); // milestone
    expect(args[10]).toBeNull(); // lane
    expect(args[11]).toBeNull(); // priority
    expect(args[12]).toBeNull(); // size
  });

  it("UPSERT_ISSUE_FROM_WEBHOOK_SQL uses json_object for title column", () => {
    // Assert — SQL constant wraps title in json_object, not a bare column
    expect(UPSERT_ISSUE_FROM_WEBHOOK_SQL).toMatch(/json_object\('title', \?\)/);
  });

  it("UPSERT_ISSUE_FROM_WEBHOOK_SQL sets payload = excluded.payload on conflict", () => {
    // Assert — payload is updated via excluded alias on conflict
    expect(UPSERT_ISSUE_FROM_WEBHOOK_SQL).toMatch(/payload\s*=\s*excluded\.payload/);
  });

  it("UPSERT_ISSUE_FROM_WEBHOOK_SQL does not set title = excluded.title on conflict", () => {
    // Assert — title is not a direct column; it lives inside payload as json_object
    expect(UPSERT_ISSUE_FROM_WEBHOOK_SQL).not.toMatch(/title\s*=\s*excluded\.title/);
  });
});

// ---------------------------------------------------------------------------
// replaceLabels
// ---------------------------------------------------------------------------

describe("replaceLabels", () => {
  it("returns [DELETE stmt, ...INSERT stmts] — DELETE is first", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    const result = replaceLabels(db, "Roxabi/lyra#42", ["bug", "P1-high"]);
    // Assert — 1 DELETE + 2 INSERTs = 3 stmts
    expect(result).toHaveLength(3);
    expect(stmts()[0].sql).toContain("DELETE FROM labels");
    expect(stmts()[1].sql).toContain("INSERT OR IGNORE INTO labels");
    expect(stmts()[2].sql).toContain("INSERT OR IGNORE INTO labels");
  });

  it("DELETE binds only issue_key", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    replaceLabels(db, "Roxabi/lyra#42", ["bug"]);
    // Assert
    expect(stmts()[0].args).toEqual(["Roxabi/lyra#42"]);
  });

  it("each INSERT binds (issue_key, name) in that order", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    replaceLabels(db, "Roxabi/lyra#42", ["bug", "P1-high"]);
    // Assert
    expect(stmts()[1].args).toEqual(["Roxabi/lyra#42", "bug"]);
    expect(stmts()[2].args).toEqual(["Roxabi/lyra#42", "P1-high"]);
  });

  it("returns only DELETE stmt for empty names array", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    const result = replaceLabels(db, "Roxabi/lyra#42", []);
    // Assert
    expect(result).toHaveLength(1);
    expect(stmts()[0].sql).toContain("DELETE FROM labels");
  });
});

// ---------------------------------------------------------------------------
// addEdge
// ---------------------------------------------------------------------------

describe("addEdge", () => {
  it("uses INSERT OR IGNORE SQL", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    addEdge(db, "Roxabi/lyra#1", "Roxabi/lyra#2", "parent");
    // Assert
    expect(stmts()[0].sql).toContain("INSERT OR IGNORE INTO edges");
  });

  it("binds (src, dst, kind) in that order", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    addEdge(db, "Roxabi/lyra#1", "Roxabi/lyra#2", "parent");
    // Assert
    expect(stmts()[0].args).toEqual(["Roxabi/lyra#1", "Roxabi/lyra#2", "parent"]);
  });

  it("passes kind=blocks through to bind list", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    addEdge(db, "Roxabi/lyra#3", "Roxabi/lyra#5", "blocks");
    // Assert
    expect(stmts()[0].args[2]).toBe("blocks");
  });
});

// ---------------------------------------------------------------------------
// removeEdge
// ---------------------------------------------------------------------------

describe("removeEdge", () => {
  it("uses DELETE SQL (not INSERT)", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    removeEdge(db, "Roxabi/lyra#1", "Roxabi/lyra#2", "parent");
    // Assert
    expect(stmts()[0].sql).toContain("DELETE FROM edges");
    expect(stmts()[0].sql).not.toContain("INSERT");
  });

  it("binds (src, dst, kind) in that order", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    removeEdge(db, "Roxabi/lyra#1", "Roxabi/lyra#2", "parent");
    // Assert
    expect(stmts()[0].args).toEqual(["Roxabi/lyra#1", "Roxabi/lyra#2", "parent"]);
  });

  it("passes kind=blocks through to bind list with AND kind=? clause", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    removeEdge(db, "Roxabi/lyra#3", "Roxabi/lyra#5", "blocks");
    // Assert
    expect(stmts()[0].sql).toContain("AND kind");
    expect(stmts()[0].args[2]).toBe("blocks");
  });
});

// ---------------------------------------------------------------------------
// upsertEdges
// ---------------------------------------------------------------------------

describe("upsertEdges", () => {
  it("first stmt is DELETE-by-kind with issueKey bound twice + kind", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    upsertEdges(db, "Roxabi/lyra#5", [], [], "parent");
    // Assert
    const del = stmts()[0];
    expect(del.sql).toContain("DELETE FROM edges");
    expect(del.sql).toContain("src_key = ?");
    expect(del.sql).toContain("dst_key = ?");
    expect(del.args).toEqual(["Roxabi/lyra#5", "Roxabi/lyra#5", "parent"]);
  });

  it("each blockedBy entry produces (src=blocker, dst=issueKey) INSERT", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    upsertEdges(db, "Roxabi/lyra#5", ["Roxabi/lyra#3", "Roxabi/lyra#4"], [], "parent");
    // Assert — stmts: [DELETE, INSERT for #3, INSERT for #4]
    expect(stmts()).toHaveLength(3);
    expect(stmts()[1].args).toEqual(["Roxabi/lyra#3", "Roxabi/lyra#5", "parent"]);
    expect(stmts()[2].args).toEqual(["Roxabi/lyra#4", "Roxabi/lyra#5", "parent"]);
  });

  it("each blocking entry produces (src=issueKey, dst=blockee) INSERT", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    upsertEdges(db, "Roxabi/lyra#5", [], ["Roxabi/lyra#7", "Roxabi/lyra#8"], "blocks");
    // Assert — stmts: [DELETE, INSERT for #7, INSERT for #8]
    expect(stmts()).toHaveLength(3);
    expect(stmts()[1].args).toEqual(["Roxabi/lyra#5", "Roxabi/lyra#7", "blocks"]);
    expect(stmts()[2].args).toEqual(["Roxabi/lyra#5", "Roxabi/lyra#8", "blocks"]);
  });

  it("combines blockedBy and blocking — blockedBy first, blocking after", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    upsertEdges(db, "Roxabi/lyra#5", ["Roxabi/lyra#3"], ["Roxabi/lyra#7"], "parent");
    // Assert — [DELETE, blockedBy INSERT, blocking INSERT]
    expect(stmts()).toHaveLength(3);
    expect(stmts()[1].args).toEqual(["Roxabi/lyra#3", "Roxabi/lyra#5", "parent"]);
    expect(stmts()[2].args).toEqual(["Roxabi/lyra#5", "Roxabi/lyra#7", "parent"]);
  });

  it("defaults kind to 'parent' when omitted", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    upsertEdges(db, "Roxabi/lyra#5", [], []);
    // Assert
    expect(stmts()[0].args[2]).toBe("parent");
  });

  it("returns only DELETE stmt when both arrays are empty", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    const result = upsertEdges(db, "Roxabi/lyra#5", [], [], "blocks");
    // Assert
    expect(result).toHaveLength(1);
    expect(stmts()[0].sql).toContain("DELETE FROM edges");
  });
});

// ---------------------------------------------------------------------------
// deleteIssue
// ---------------------------------------------------------------------------

describe("deleteIssue", () => {
  it("uses DELETE FROM issues WHERE key=? SQL", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    deleteIssue(db, "Roxabi/lyra#42");
    // Assert
    expect(stmts()[0].sql).toContain("DELETE FROM issues");
    expect(stmts()[0].sql).toContain("key");
  });

  it("binds the issue key", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    deleteIssue(db, "Roxabi/lyra#42");
    // Assert
    expect(stmts()[0].args).toEqual(["Roxabi/lyra#42"]);
  });
});

// ---------------------------------------------------------------------------
// setActiveBranch
// ---------------------------------------------------------------------------

describe("setActiveBranch", () => {
  it("uses SET has_active_branch=1 SQL when value=1", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    setActiveBranch(db, "Roxabi/lyra", 42, 1);
    // Assert
    expect(stmts()[0].sql).toContain("has_active_branch=1");
  });

  it("binds (repo, number) for value=1", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    setActiveBranch(db, "Roxabi/lyra", 42, 1);
    // Assert
    expect(stmts()[0].args).toEqual(["Roxabi/lyra", 42]);
  });

  it("uses SET has_active_branch=0 SQL when value=0", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    setActiveBranch(db, "Roxabi/lyra", 7, 0);
    // Assert
    expect(stmts()[0].sql).toContain("has_active_branch=0");
  });

  it("binds (repo, number) for value=0", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    setActiveBranch(db, "Roxabi/lyra", 7, 0);
    // Assert
    expect(stmts()[0].args).toEqual(["Roxabi/lyra", 7]);
  });
});

// ---------------------------------------------------------------------------
// upsertPrState
// ---------------------------------------------------------------------------

describe("upsertPrState", () => {
  it("uses UPSERT_PR_STATE_SQL constant", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    upsertPrState(db, "Roxabi/lyra", 5, "open", 0, "[]", "2024-01-01T00:00:00Z");
    // Assert
    expect(stmts()[0].sql).toBe(UPSERT_PR_STATE_SQL);
  });

  it("binds 6 args in order: repo, number, state, hasReviewedLabel, closingIssueKeysJson, updatedAt", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    upsertPrState(
      db,
      "Roxabi/lyra",
      5,
      "open",
      1,
      '["Roxabi/lyra#42"]',
      "2024-06-01T12:00:00Z",
    );
    // Assert
    expect(stmts()[0].args).toEqual([
      "Roxabi/lyra",
      5,
      "open",
      1,
      '["Roxabi/lyra#42"]',
      "2024-06-01T12:00:00Z",
    ]);
  });

  it("accepts hasReviewedLabel=0 correctly", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    upsertPrState(db, "Roxabi/lyra", 5, "closed", 0, "[]", "2024-06-01T00:00:00Z");
    // Assert
    expect(stmts()[0].args[3]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renameMilestone
// ---------------------------------------------------------------------------

describe("renameMilestone", () => {
  it("uses UPDATE issues SET milestone=? WHERE repo=? AND milestone=? SQL", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    renameMilestone(db, "Roxabi/lyra", "Sprint 1", "Sprint 2");
    // Assert
    expect(stmts()[0].sql).toContain("UPDATE issues");
    expect(stmts()[0].sql).toContain("milestone");
    expect(stmts()[0].sql).toContain("repo");
  });

  it("binds (newTitle, repo, oldTitle) — newTitle first, oldTitle last", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    renameMilestone(db, "Roxabi/lyra", "Sprint 1", "Sprint 2");
    // Assert
    expect(stmts()[0].args).toEqual(["Sprint 2", "Roxabi/lyra", "Sprint 1"]);
  });
});

// ---------------------------------------------------------------------------
// bumpDataVersion
// ---------------------------------------------------------------------------

describe("bumpDataVersion", () => {
  const iso = "2024-06-10T12:00:00.000Z";

  it("uses BUMP_DATA_VERSION_SQL constant", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    bumpDataVersion(db, iso);
    // Assert
    expect(stmts()[0].sql).toBe(BUMP_DATA_VERSION_SQL);
  });

  it("BUMP_DATA_VERSION_SQL has ON CONFLICT(tenant_id, key) clause", () => {
    // Assert — conflict target must include tenant_id for multi-tenant correctness
    expect(BUMP_DATA_VERSION_SQL).toContain("ON CONFLICT(tenant_id, key)");
  });

  it("BUMP_DATA_VERSION_SQL inserts literal 0 tenant_id and 'data_version' key", () => {
    // Assert — VALUES row must start with (0, 'data_version', ...)
    expect(BUMP_DATA_VERSION_SQL).toMatch(/VALUES\s*\(0, 'data_version'/);
  });

  it("binds iso twice — value and updated_at", () => {
    // Arrange
    const { db, stmts } = captureDb();
    // Act
    bumpDataVersion(db, iso);
    // Assert — bind args are [iso, iso] (value = ?, updated_at = ?)
    expect(stmts()[0].args).toEqual([iso, iso]);
  });
});
