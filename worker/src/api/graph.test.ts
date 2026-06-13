import { describe, expect, it, afterEach, vi } from "vitest";
import type { Env } from "../types";
import { app } from "../router";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * graph.ts fires 5 prepare().all() calls — dispatched by SQL content:
 *   "FROM labels"   → labels fixture
 *   "FROM pr_state" → pr_state fixture
 *   "FROM issues"   → issues fixture
 *   "FROM edges"    → edges fixture
 *   "FROM repos"    → repos fixture
 */
function makeGraphEnv(
  labels: unknown[],
  prState: unknown[],
  issues: unknown[],
  edges: unknown[],
  repos: unknown[] = [],
): Env {
  return {
    DB: {
      prepare: (sql: string) => ({
        all: async () => {
          if (sql.includes("FROM labels")) return { results: labels };
          if (sql.includes("FROM pr_state")) return { results: prState };
          if (sql.includes("FROM issues")) return { results: issues };
          if (sql.includes("FROM edges")) return { results: edges };
          if (sql.includes("FROM repos")) return { results: repos };
          return { results: [] };
        },
      }),
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

/**
 * Like makeGraphEnv but also accumulates every SQL string passed to prepare()
 * so tests can assert on the exact queries issued by graphRoute.
 */
function makeGraphEnvWithCapture(
  labels: unknown[],
  prState: unknown[],
  issues: unknown[],
  edges: unknown[],
  repos: unknown[] = [],
): { env: Env; capturedSqls: string[] } {
  const capturedSqls: string[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => {
        capturedSqls.push(sql);
        return {
          all: async () => {
            if (sql.includes("FROM labels")) return { results: labels };
            if (sql.includes("FROM pr_state")) return { results: prState };
            if (sql.includes("FROM issues")) return { results: issues };
            if (sql.includes("FROM edges")) return { results: edges };
            if (sql.includes("FROM repos")) return { results: repos };
            return { results: [] };
          },
        };
      },
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
  return { env, capturedSqls };
}

describe("GET /api/graph", () => {
  describe("response shape", () => {
    it("returns {nodes, edges} with correct types", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: "Test issue",
        state: "open",
        url: "https://github.com/Roxabi/roxabi-live/issues/1",
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      };

      const res = await app.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [issue], []),
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: unknown[]; edges: unknown[] }>();
      expect(body).toHaveProperty("nodes");
      expect(body).toHaveProperty("edges");
      expect(Array.isArray(body.nodes)).toBe(true);
      expect(Array.isArray(body.edges)).toBe(true);
    });

    it("maps node fields from issue row", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#7",
        repo: "Roxabi/roxabi-live",
        number: 7,
        title: "My Issue",
        state: "open",
        url: "https://github.com/Roxabi/roxabi-live/issues/7",
        milestone: "M1 — Foundation",
        lane: "infra",
        priority: "P1",
        size: "M",
        status: "In Progress",
        is_stub: 0,
        has_active_branch: 0,
      };

      const res = await app.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      const node = body.nodes[0];

      expect(node.key).toBe("Roxabi/roxabi-live#7");
      expect(node.repo).toBe("Roxabi/roxabi-live");
      expect(node.number).toBe(7);
      expect(node.title).toBe("My Issue");
      expect(node.state).toBe("open");
      expect(node.url).toBe("https://github.com/Roxabi/roxabi-live/issues/7");
      expect(node.milestone).toBe("M1 — Foundation");
      expect(node.milestone_code).toBe("M1");
      expect(node.milestone_name).toBe("Foundation");
      expect(node.milestone_sort_key).toBe(1);
      expect(node.lane).toBe("infra");
      expect(node.priority).toBe("P1");
      expect(node.size).toBe("M");
      expect(node.status).toBe("In Progress");
    });

    it("maps edge fields correctly", async () => {
      const edge = { src_key: "Roxabi/roxabi-live#1", dst_key: "Roxabi/roxabi-live#2", kind: "blocks" };

      const res = await app.request("/api/graph", {}, makeGraphEnv([], [], [], [edge]));
      const body = await res.json<{ edges: Record<string, unknown>[] }>();
      const e = body.edges[0];

      expect(e.src).toBe("Roxabi/roxabi-live#1");
      expect(e.dst).toBe("Roxabi/roxabi-live#2");
      expect(e.kind).toBe("blocks");
    });
  });

  describe("dev_state priority matrix", () => {
    function makeIssue(
      state: string,
      hasActiveBranch: number,
      key = "Roxabi/roxabi-live#1",
    ) {
      return {
        key,
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: null,
        state,
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: hasActiveBranch,
      };
    }

    it("returns idle for a closed issue regardless of branch/PRs", async () => {
      const issue = makeIssue("closed", 1);
      const res = await app.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("idle");
    });

    it("returns pr_reviewed when an open PR has has_reviewed_label=1", async () => {
      const issue = makeIssue("open", 0);
      const prState = [
        { closing_issue_keys: JSON.stringify([issue.key]), has_reviewed_label: 1 },
      ];
      const res = await app.request("/api/graph", {}, makeGraphEnv([], prState, [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("pr_reviewed");
    });

    it("returns pr_open when an open PR exists without reviewed label", async () => {
      const issue = makeIssue("open", 0);
      const prState = [
        { closing_issue_keys: JSON.stringify([issue.key]), has_reviewed_label: 0 },
      ];
      const res = await app.request("/api/graph", {}, makeGraphEnv([], prState, [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("pr_open");
    });

    it("returns dev when no open PRs but has_active_branch=1", async () => {
      const issue = makeIssue("open", 1);
      const res = await app.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("dev");
    });

    it("returns idle when open, no PR, no active branch", async () => {
      const issue = makeIssue("open", 0);
      const res = await app.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("idle");
    });

    it("pr_reviewed takes priority over pr_open when multiple PRs exist", async () => {
      const issue = makeIssue("open", 0);
      const prState = [
        { closing_issue_keys: JSON.stringify([issue.key]), has_reviewed_label: 0 },
        { closing_issue_keys: JSON.stringify([issue.key]), has_reviewed_label: 1 },
      ];
      const res = await app.request("/api/graph", {}, makeGraphEnv([], prState, [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("pr_reviewed");
    });
  });

  describe("lane fallback from labels", () => {
    it("uses lane from DB row when set", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: null,
        state: "open",
        url: null,
        milestone: null,
        lane: "backend",
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      };
      const labels = [{ issue_key: issue.key, name: "graph:lane/frontend" }];
      const res = await app.request("/api/graph", {}, makeGraphEnv(labels, [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      // DB lane wins over label
      expect(body.nodes[0].lane).toBe("backend");
    });

    it("falls back to graph:lane/ label when lane is null in DB", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: null,
        state: "open",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      };
      const labels = [{ issue_key: issue.key, name: "graph:lane/infra" }];
      const res = await app.request("/api/graph", {}, makeGraphEnv(labels, [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].lane).toBe("infra");
    });

    it("returns null lane when no DB lane and no graph:lane/ label", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: null,
        state: "open",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      };
      const labels = [{ issue_key: issue.key, name: "some-other-label" }];
      const res = await app.request("/api/graph", {}, makeGraphEnv(labels, [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].lane).toBeNull();
    });
  });

  describe("is_stub boolean coercion", () => {
    it("coerces is_stub=1 to true", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: null,
        state: "open",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 1,
        has_active_branch: 0,
      };
      const res = await app.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].is_stub).toBe(true);
    });

    it("coerces is_stub=0 to false", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: null,
        state: "open",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      };
      const res = await app.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].is_stub).toBe(false);
    });
  });

  describe("invalid JSON in pr_state.closing_issue_keys", () => {
    it("silently skips rows with invalid JSON", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: null,
        state: "open",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      };
      // One row with invalid JSON — should not throw, issue gets idle dev_state
      const prState = [{ closing_issue_keys: "not-valid-json", has_reviewed_label: 1 }];
      const res = await app.request("/api/graph", {}, makeGraphEnv([], prState, [issue], []));
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("idle");
    });

    it("silently skips rows where closing_issue_keys is null", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: null,
        state: "open",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      };
      const prState = [{ closing_issue_keys: null, has_reviewed_label: 1 }];
      const res = await app.request("/api/graph", {}, makeGraphEnv([], prState, [issue], []));
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("idle");
    });
  });

  describe("labels attached per issue", () => {
    it("attaches correct labels to each node", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: null,
        state: "open",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      };
      const labels = [
        { issue_key: issue.key, name: "bug" },
        { issue_key: issue.key, name: "P1" },
        { issue_key: "other/repo#99", name: "enhancement" },
      ];
      const res = await app.request("/api/graph", {}, makeGraphEnv(labels, [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].labels).toEqual(["bug", "P1"]);
    });

    it("returns empty labels array when no labels for issue", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: null,
        state: "open",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      };
      const res = await app.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].labels).toEqual([]);
    });
  });

  describe("empty database", () => {
    it("returns {nodes:[], edges:[], repos:[]} when all tables empty", async () => {
      const res = await app.request("/api/graph", {}, makeGraphEnv([], [], [], []));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ nodes: [], edges: [], repos: [] });
    });
  });

  describe("repos field", () => {
    it("returns live repos before archived repos, both alpha within group", async () => {
      const repoRows = [
        { repo: "Roxabi/roxabi-factory", archived: 0 },
        { repo: "Roxabi/roxabi-live", archived: 0 },
        { repo: "Roxabi/roxabi-vault", archived: 1 },
      ];
      // SQL ORDER BY archived ASC, repo ASC — fixture already sorted correctly
      const res = await app.request("/api/graph", {}, makeGraphEnv([], [], [], [], repoRows));
      expect(res.status).toBe(200);
      const body = await res.json<{ repos: { repo: string; archived: boolean }[] }>();
      expect(body.repos).toEqual([
        { repo: "Roxabi/roxabi-factory", archived: false },
        { repo: "Roxabi/roxabi-live", archived: false },
        { repo: "Roxabi/roxabi-vault", archived: true },
      ]);
    });
  });

  describe("SQL shape assertions", () => {
    it("issues SELECT uses JSON_EXTRACT(payload,'$.title') AS title", async () => {
      // Arrange
      const { env, capturedSqls } = makeGraphEnvWithCapture([], [], [], []);
      // Act
      await app.request("/api/graph", {}, env);
      // Assert — the issues query must project title via JSON_EXTRACT
      const issuesSql = capturedSqls.find((s) => s.includes("FROM issues"));
      expect(issuesSql).toContain("JSON_EXTRACT(payload,'$.title') AS title");
    });
  });
});
