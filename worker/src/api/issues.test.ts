import { describe, expect, it, afterEach, vi } from "vitest";
import type { Env } from "../types";
import { app } from "../router";

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Env builders ─────────────────────────────────────────────────────────────

/**
 * listIssuesRoute uses:
 *   1. DB.batch([countStmt, dataStmt]) — dispatched by SQL content:
 *      "SELECT COUNT" → count result
 *      "FROM issues"  → data rows
 *   2. DB.prepare("FROM labels WHERE issue_key IN").bind(...keys).all() → label rows
 *
 * getIssueRoute uses prepare().bind() dispatched by SQL content:
 *   "FROM issues WHERE key"    → .first() → issue row
 *   "FROM labels WHERE issue_key = ?" (single) → .all() → label rows
 *   "e.src_key = ?"            → .all() → blocking edge rows
 *   "e.dst_key = ?"            → .all() → blocked_by edge rows
 */

interface ListEnvOptions {
  countN: number;
  rows: unknown[];
  labels?: unknown[];
}

interface CapturedCall {
  sql: string;
  args: unknown[];
}

/**
 * Returns {env, captured}. captured accumulates {sql, args} for every
 * prepare(sql).bind(...args) call (including stmts passed to batch),
 * enabling FIX 4 filter assertions.
 *
 * The .bind() return value is what gets passed to DB.batch([...]), so
 * we embed _sql/_args on the bound object and read them back in batch().
 */
function makeListEnvWithCapture(
  opts: ListEnvOptions,
): { env: Env; captured: CapturedCall[] } {
  const { countN, rows, labels = [] } = opts;
  const captured: CapturedCall[] = [];

  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          // Capture immediately for direct .bind().all() calls (e.g. labels query)
          captured.push({ sql, args });
          return {
            _sql: sql,
            _args: args,
            first: async () => null,
            all: async () => {
              if (sql.includes("FROM labels")) return { results: labels };
              return { results: [] };
            },
          };
        },
      }),
      batch: async (_stmts: unknown[]) => {
        // sql/args already captured in bind() above
        return [
          { results: [{ n: countN }] },
          { results: rows },
        ];
      },
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;

  return { env, captured };
}

function makeListEnv(opts: ListEnvOptions): Env {
  const { countN, rows, labels = [] } = opts;

  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => null,
          all: async () => {
            if (sql.includes("FROM labels")) return { results: labels };
            return { results: [] };
          },
        }),
      }),
      batch: async (_stmts: unknown[]) => [
        { results: [{ n: countN }] },
        { results: rows },
      ],
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

interface GetEnvOptions {
  issueRow: unknown | null;
  labels?: unknown[];
  blocking?: unknown[];
  blockedBy?: unknown[];
}

function makeGetEnv(opts: GetEnvOptions): Env {
  const {
    issueRow,
    labels = [],
    blocking = [],
    blockedBy = [],
  } = opts;

  // Dispatch by SQL content — robust to query reordering:
  //   "FROM issues WHERE key"  → .first() → issue row
  //   "FROM labels WHERE issue_key" → .all() → label rows (single-issue variant)
  //   "e.src_key = ?"          → .all() → blocking edges
  //   "e.dst_key = ?"          → .all() → blocked_by edges

  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM issues WHERE key")) return issueRow;
            return null;
          },
          all: async () => {
            if (sql.includes("FROM labels WHERE issue_key")) return { results: labels };
            if (sql.includes("e.src_key = ?")) return { results: blocking };
            if (sql.includes("e.dst_key = ?")) return { results: blockedBy };
            return { results: [] };
          },
        }),
        // fallback — should not be called for getIssue
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
      batch: async () => [],
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

/**
 * Like makeGetEnv but captures every prepare(sql) call so tests can assert
 * on the exact SQL issued for the single-issue path.
 */
function makeGetEnvWithCapture(opts: GetEnvOptions): {
  env: Env;
  capturedSqls: string[];
} {
  const {
    issueRow,
    labels = [],
    blocking = [],
    blockedBy = [],
  } = opts;
  const capturedSqls: string[] = [];

  const env = {
    DB: {
      prepare: (sql: string) => {
        capturedSqls.push(sql);
        return {
          bind: (..._args: unknown[]) => ({
            first: async () => {
              if (sql.includes("FROM issues WHERE key")) return issueRow;
              return null;
            },
            all: async () => {
              if (sql.includes("FROM labels WHERE issue_key")) return { results: labels };
              if (sql.includes("e.src_key = ?")) return { results: blocking };
              if (sql.includes("e.dst_key = ?")) return { results: blockedBy };
              return { results: [] };
            },
          }),
          first: async () => null,
          all: async () => ({ results: [] }),
        };
      },
      batch: async () => [],
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;

  return { env, capturedSqls };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeIssueRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    key: "Roxabi/roxabi-live#1",
    repo: "Roxabi/roxabi-live",
    number: 1,
    title: "Test issue",
    state: "open",
    url: "https://github.com/Roxabi/roxabi-live/issues/1",
    milestone: null,
    is_stub: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    ...overrides,
  };
}

// ── GET /api/issues (list) ────────────────────────────────────────────────────

describe("GET /api/issues", () => {
  describe("response shape", () => {
    it("returns {issues, total, limit, offset}", async () => {
      const res = await app.request(
        "/api/issues",
        {},
        makeListEnv({ countN: 0, rows: [] }),
      );

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body).toHaveProperty("issues");
      expect(body).toHaveProperty("total");
      expect(body).toHaveProperty("limit");
      expect(body).toHaveProperty("offset");
    });

    it("returns total from count query", async () => {
      const res = await app.request(
        "/api/issues",
        {},
        makeListEnv({ countN: 42, rows: [] }),
      );
      const body = await res.json<{ total: number }>();
      expect(body.total).toBe(42);
    });

    it("uses default limit=100 and offset=0", async () => {
      const res = await app.request(
        "/api/issues",
        {},
        makeListEnv({ countN: 0, rows: [] }),
      );
      const body = await res.json<{ limit: number; offset: number }>();
      expect(body.limit).toBe(100);
      expect(body.offset).toBe(0);
    });

    it("respects explicit limit and offset params", async () => {
      const res = await app.request(
        "/api/issues?limit=25&offset=50",
        {},
        makeListEnv({ countN: 0, rows: [] }),
      );
      const body = await res.json<{ limit: number; offset: number }>();
      expect(body.limit).toBe(25);
      expect(body.offset).toBe(50);
    });
  });

  describe("issue rows mapping", () => {
    it("maps issue row fields", async () => {
      const row = makeIssueRow({ title: "My Issue", state: "closed", is_stub: 0 });
      const res = await app.request(
        "/api/issues",
        {},
        makeListEnv({ countN: 1, rows: [row] }),
      );
      const body = await res.json<{ issues: Record<string, unknown>[] }>();
      const issue = body.issues[0];

      expect(issue.key).toBe("Roxabi/roxabi-live#1");
      expect(issue.repo).toBe("Roxabi/roxabi-live");
      expect(issue.number).toBe(1);
      expect(issue.title).toBe("My Issue");
      expect(issue.state).toBe("closed");
    });

    it("coerces is_stub=1 to true", async () => {
      const row = makeIssueRow({ is_stub: 1 });
      const res = await app.request(
        "/api/issues",
        {},
        makeListEnv({ countN: 1, rows: [row] }),
      );
      const body = await res.json<{ issues: Record<string, unknown>[] }>();
      expect(body.issues[0].is_stub).toBe(true);
    });

    it("coerces is_stub=0 to false", async () => {
      const row = makeIssueRow({ is_stub: 0 });
      const res = await app.request(
        "/api/issues",
        {},
        makeListEnv({ countN: 1, rows: [row] }),
      );
      const body = await res.json<{ issues: Record<string, unknown>[] }>();
      expect(body.issues[0].is_stub).toBe(false);
    });
  });

  describe("labels per issue", () => {
    it("attaches labels to matching issue", async () => {
      const row = makeIssueRow();
      const labels = [
        { issue_key: row.key, name: "bug" },
        { issue_key: row.key, name: "P1" },
      ];
      const res = await app.request(
        "/api/issues",
        {},
        makeListEnv({ countN: 1, rows: [row], labels }),
      );
      const body = await res.json<{ issues: Record<string, unknown>[] }>();
      expect(body.issues[0].labels).toEqual(["bug", "P1"]);
    });

    it("returns empty labels array when no labels for issue", async () => {
      const row = makeIssueRow();
      const res = await app.request(
        "/api/issues",
        {},
        makeListEnv({ countN: 1, rows: [row], labels: [] }),
      );
      const body = await res.json<{ issues: Record<string, unknown>[] }>();
      expect(body.issues[0].labels).toEqual([]);
    });

    it("does not attach other issues' labels", async () => {
      const row = makeIssueRow();
      const labels = [{ issue_key: "other/repo#99", name: "unrelated" }];
      const res = await app.request(
        "/api/issues",
        {},
        makeListEnv({ countN: 1, rows: [row], labels }),
      );
      const body = await res.json<{ issues: Record<string, unknown>[] }>();
      expect(body.issues[0].labels).toEqual([]);
    });
  });

  describe("empty result set — no labels query", () => {
    it("skips labels query when no rows returned", async () => {
      const res = await app.request(
        "/api/issues",
        {},
        makeListEnv({ countN: 0, rows: [] }),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ issues: unknown[] }>();
      expect(body.issues).toEqual([]);
    });
  });
});

// ── GET /api/issues/* (single) ────────────────────────────────────────────────

describe("GET /api/issues/:key", () => {
  describe("400 on invalid key format", () => {
    it("returns 400 for bare string key", async () => {
      const res = await app.request(
        "/api/issues/invalid-key",
        {},
        makeGetEnv({ issueRow: null }),
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ detail: string }>();
      expect(body.detail).toMatch(/invalid issue key/i);
    });

    it("returns 400 when no #number in key", async () => {
      const res = await app.request(
        "/api/issues/Roxabi/roxabi-live",
        {},
        makeGetEnv({ issueRow: null }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty key", async () => {
      // /api/issues/ — matches list route, not wildcard; just validate the guard logic
      const res = await app.request(
        "/api/issues/noslash",
        {},
        makeGetEnv({ issueRow: null }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("404 when issue not found", () => {
    it("returns 404 for a valid key that is not in DB", async () => {
      const res = await app.request(
        "/api/issues/Roxabi/roxabi-live%231",
        {},
        makeGetEnv({ issueRow: null }),
      );
      expect(res.status).toBe(404);
      const body = await res.json<{ detail: string }>();
      expect(body.detail).toMatch(/not found/i);
    });
  });

  describe("valid key — happy path", () => {
    it("returns 200 with full issue shape", async () => {
      const row = makeIssueRow();
      const res = await app.request(
        "/api/issues/Roxabi/roxabi-live%231",
        {},
        makeGetEnv({ issueRow: row }),
      );

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.key).toBe("Roxabi/roxabi-live#1");
      expect(body.repo).toBe("Roxabi/roxabi-live");
      expect(body.number).toBe(1);
      expect(body.title).toBe("Test issue");
      expect(body.state).toBe("open");
      expect(Array.isArray(body.labels)).toBe(true);
      expect(Array.isArray(body.blocking)).toBe(true);
      expect(Array.isArray(body.blocked_by)).toBe(true);
    });

    it("issues SELECT uses JSON_EXTRACT(payload,'$.title') AS title", async () => {
      // Arrange
      const row = makeIssueRow();
      const { env, capturedSqls } = makeGetEnvWithCapture({ issueRow: row });
      // Act
      await app.request("/api/issues/Roxabi/roxabi-live%231", {}, env);
      // Assert — the single-issue SELECT must project title via JSON_EXTRACT
      const issueSql = capturedSqls.find((s) => s.includes("FROM issues WHERE key"));
      expect(issueSql).toContain("JSON_EXTRACT(payload,'$.title') AS title");
    });

    it("attaches labels from DB", async () => {
      const row = makeIssueRow();
      const labels = [{ name: "bug" }, { name: "P1" }];
      const res = await app.request(
        "/api/issues/Roxabi/roxabi-live%231",
        {},
        makeGetEnv({ issueRow: row, labels }),
      );
      const body = await res.json<{ labels: string[] }>();
      expect(body.labels).toEqual(["bug", "P1"]);
    });

    it("maps blocking edges", async () => {
      const row = makeIssueRow();
      const blocking = [
        { key: "Roxabi/roxabi-live#2", number: 2, repo: "Roxabi/roxabi-live" },
      ];
      const res = await app.request(
        "/api/issues/Roxabi/roxabi-live%231",
        {},
        makeGetEnv({ issueRow: row, blocking }),
      );
      const body = await res.json<{ blocking: Record<string, unknown>[] }>();
      expect(body.blocking).toHaveLength(1);
      expect(body.blocking[0].key).toBe("Roxabi/roxabi-live#2");
      expect(body.blocking[0].number).toBe(2);
    });

    it("maps blocked_by edges", async () => {
      const row = makeIssueRow();
      const blockedBy = [
        { key: "Roxabi/roxabi-live#3", number: 3, repo: "Roxabi/roxabi-live" },
      ];
      const res = await app.request(
        "/api/issues/Roxabi/roxabi-live%231",
        {},
        makeGetEnv({ issueRow: row, blockedBy }),
      );
      const body = await res.json<{ blocked_by: Record<string, unknown>[] }>();
      expect(body.blocked_by).toHaveLength(1);
      expect(body.blocked_by[0].key).toBe("Roxabi/roxabi-live#3");
    });

    it("coerces is_stub=1 to true", async () => {
      const row = makeIssueRow({ is_stub: 1 });
      const res = await app.request(
        "/api/issues/Roxabi/roxabi-live%231",
        {},
        makeGetEnv({ issueRow: row }),
      );
      const body = await res.json<{ is_stub: boolean }>();
      expect(body.is_stub).toBe(true);
    });

    it("coerces is_stub=0 to false", async () => {
      const row = makeIssueRow({ is_stub: 0 });
      const res = await app.request(
        "/api/issues/Roxabi/roxabi-live%231",
        {},
        makeGetEnv({ issueRow: row }),
      );
      const body = await res.json<{ is_stub: boolean }>();
      expect(body.is_stub).toBe(false);
    });
  });

  describe("edgeItem fallback when join returns null number/repo", () => {
    it("parses number and repo from key when join columns are null", async () => {
      const row = makeIssueRow();
      // Edge join returned null for number+repo (orphan edge row)
      const blocking = [
        { key: "Roxabi/roxabi-live#5", number: null, repo: null },
      ];
      const res = await app.request(
        "/api/issues/Roxabi/roxabi-live%231",
        {},
        makeGetEnv({ issueRow: row, blocking }),
      );
      const body = await res.json<{ blocking: Record<string, unknown>[] }>();
      expect(body.blocking[0].key).toBe("Roxabi/roxabi-live#5");
      expect(body.blocking[0].number).toBe(5);
      expect(body.blocking[0].repo).toBe("Roxabi/roxabi-live");
    });
  });
});

// ── FIX 4: filter params + limit/offset clamping ─────────────────────────────

describe("GET /api/issues — filter SQL params and clamping (FIX 4)", () => {
  describe("filter SQL dispatch", () => {
    it("?repo=foo binds repo param in WHERE clause", async () => {
      const { env, captured } = makeListEnvWithCapture({ countN: 0, rows: [] });
      await app.request("/api/issues?repo=foo", {}, env);

      const batchSqls = captured.map((c) => c.sql);
      const countCall = captured.find((c) => c.sql.includes("SELECT COUNT"));
      const dataCall = captured.find(
        (c) => c.sql.includes("FROM issues") && !c.sql.includes("SELECT COUNT"),
      );

      expect(batchSqls.some((s) => s.includes("issues.repo = ?"))).toBe(true);
      expect(countCall?.args).toContain("foo");
      expect(dataCall?.args).toContain("foo");
      expect(dataCall?.sql).toContain("JSON_EXTRACT(issues.payload,'$.title') AS title");
    });

    it("?state=open binds state param in WHERE clause", async () => {
      const { env, captured } = makeListEnvWithCapture({ countN: 0, rows: [] });
      await app.request("/api/issues?state=open", {}, env);

      expect(captured.some((c) => c.sql.includes("issues.state = ?"))).toBe(true);
      expect(captured.some((c) => c.args.includes("open"))).toBe(true);
    });

    it("?label=bug inserts EXISTS subquery and binds label param", async () => {
      const { env, captured } = makeListEnvWithCapture({ countN: 0, rows: [] });
      await app.request("/api/issues?label=bug", {}, env);

      expect(
        captured.some((c) => c.sql.includes("EXISTS") && c.sql.includes("labels")),
      ).toBe(true);
      expect(captured.some((c) => c.args.includes("bug"))).toBe(true);
    });

    it("combined ?repo=x&state=open&label=y includes all three conditions", async () => {
      const { env, captured } = makeListEnvWithCapture({ countN: 0, rows: [] });
      await app.request("/api/issues?repo=x&state=open&label=y", {}, env);

      const allSqls = captured.map((c) => c.sql).join(" ");
      expect(allSqls).toMatch(/issues\.repo = \?/);
      expect(allSqls).toMatch(/issues\.state = \?/);
      expect(allSqls).toMatch(/EXISTS/);
      // All three params present in at least one call
      const allArgs = captured.flatMap((c) => c.args);
      expect(allArgs).toContain("x");
      expect(allArgs).toContain("open");
      expect(allArgs).toContain("y");
    });
  });

  describe("limit/offset clamping", () => {
    it("?limit=abc falls back to default 100", async () => {
      const res = await app.request(
        "/api/issues?limit=abc",
        {},
        makeListEnv({ countN: 0, rows: [] }),
      );
      const body = await res.json<{ limit: number }>();
      expect(body.limit).toBe(100);
    });

    it("?limit=999999999 is clamped to 500", async () => {
      const res = await app.request(
        "/api/issues?limit=999999999",
        {},
        makeListEnv({ countN: 0, rows: [] }),
      );
      const body = await res.json<{ limit: number }>();
      expect(body.limit).toBe(500);
    });

    it("?offset=-5 is clamped to 0", async () => {
      const res = await app.request(
        "/api/issues?offset=-5",
        {},
        makeListEnv({ countN: 0, rows: [] }),
      );
      const body = await res.json<{ offset: number }>();
      expect(body.offset).toBe(0);
    });
  });
});
