import { describe, expect, it, afterEach, vi } from "vitest";
import type { Env } from "../types";
import { app } from "../router";

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Env builders ─────────────────────────────────────────────────────────────

/**
 * listIssuesRoute uses:
 *   1. DB.batch([countStmt.bind(...), dataStmt.bind(...)]) → [countResult, dataResult]
 *   2. DB.prepare(labelSql).bind(...keys).all() → label rows
 *
 * getIssueRoute uses 4 sequential prepare().bind().first()/all():
 *   1. .bind(key).first()         → issue row
 *   2. .bind(key).all()           → label rows
 *   3. .bind(key).all()           → blocking edge rows
 *   4. .bind(key).all()           → blocked_by edge rows
 */

interface ListEnvOptions {
  countN: number;
  rows: unknown[];
  labels?: unknown[];
}

function makeListEnv(opts: ListEnvOptions): Env {
  const { countN, rows, labels = [] } = opts;

  // After batch(), there is one more prepare().bind().all() for labels.
  // We use a call counter on `.all()` to distinguish the label call from batch internals.
  // The batch returns a mocked result directly.

  // Track how many times .all() is called on a bound stmt OUTSIDE batch
  let labelCallCount = 0;

  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => null,
          all: async () => {
            // labels query is the only .bind().all() called after batch
            labelCallCount++;
            if (labelCallCount === 1) {
              return { results: labels };
            }
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
    GITHUB_TOKEN: "",
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

  // getIssueRoute calls prepare().bind() 4 times in this order:
  //   0 → .first() → issue row
  //   1 → .all()   → label rows
  //   2 → .all()   → blocking
  //   3 → .all()   → blocked_by
  let bindCallCount = 0;

  return {
    DB: {
      prepare: (_sql: string) => ({
        bind: (..._args: unknown[]) => {
          const callIndex = bindCallCount++;
          return {
            first: async () => {
              if (callIndex === 0) return issueRow;
              return null;
            },
            all: async () => {
              if (callIndex === 1) return { results: labels };
              if (callIndex === 2) return { results: blocking };
              if (callIndex === 3) return { results: blockedBy };
              return { results: [] };
            },
          };
        },
        // fallback — should not be called for getIssue
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
      batch: async () => [],
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_TOKEN: "",
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
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
