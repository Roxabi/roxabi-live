import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "../auth/types";
import {
  type FakeResult,
  STUB_SESSION,
  captureDb,
  dispatchByTable,
  makeEnv,
  makeFakeDb,
  makeFakeStmt,
} from "../test-utils";
import type { Env } from "../types";
import { graphRoute } from "./graph";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test app with session middleware — mirrors me.test.ts pattern
// ---------------------------------------------------------------------------

function makeTestApp() {
  const a = new Hono<AuthEnv>();
  a.use("*", async (c, next) => {
    c.set("session", STUB_SESSION);
    await next();
  });
  a.get("/api/graph", graphRoute);
  return a;
}

const testApp = makeTestApp();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * graph.ts fires 5 prepare().bind(...).all() calls — dispatched by SQL content:
 *   "tenant_repo_access"  → visible repos (all public by default, derived from issues)
 *   "from labels"         → labels fixture
 *   "from pr_state"       → pr_state fixture
 *   "from issues"         → issues fixture
 *   "from edges"          → edges fixture
 *   "from repos"          → repos fixture
 *
 * visibleRepos is derived from the issues fixture (all unique repos treated as public).
 * Override `overrideVisible` to test a custom visibility set.
 */
function makeGraphEnv(
  labels: unknown[],
  prState: unknown[],
  issues: unknown[],
  edges: unknown[],
  repos: unknown[] = [],
  overrideVisible?: string[],
  zkOptIn = false,
  sealedIssueKeys: string[] = [],
): Env {
  const visibleRepos = overrideVisible ?? [
    ...new Set((issues as Array<{ repo: string }>).map((i) => i.repo)),
  ];

  const db = makeFakeDb((sql, args) =>
    makeFakeStmt(
      sql,
      args,
      dispatchByTable(sql, {
        zk_opt_in: [{ zk_opt_in: zkOptIn ? 1 : 0 }],
        "from zk_payloads": sealedIssueKeys.map((issue_key) => ({ issue_key })),
        tenant_repo_access: visibleRepos.map((repo) => ({
          repo,
          is_private: 0,
        })),
        "from labels": labels as FakeResult[],
        "from pr_state": prState as FakeResult[],
        // "from edges" MUST precede "from issues": edges SQL contains "FROM issues"
        // as a subquery, so first-match-wins would otherwise misroute it.
        "from edges": edges as FakeResult[],
        "from repos": repos as FakeResult[],
        "from issues": issues as FakeResult[],
      }),
    ),
  );

  return makeEnv(db);
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

  const visibleRepos = [...new Set((issues as Array<{ repo: string }>).map((i) => i.repo))];

  const { db } = captureDb((sql, _args) => {
    capturedSqls.push(sql);
    return dispatchByTable(sql, {
      tenant_repo_access: visibleRepos.map((repo) => ({
        repo,
        is_private: 0,
      })),
      "from labels": labels as FakeResult[],
      "from pr_state": prState as FakeResult[],
      // "from edges" MUST precede "from issues": edges SQL subquery contains "FROM issues"
      "from edges": edges as FakeResult[],
      "from repos": repos as FakeResult[],
      "from issues": issues as FakeResult[],
    });
  });

  return { env: makeEnv(db), capturedSqls };
}

describe("GET /api/graph", () => {
  describe("response shape", () => {
    it("returns {nodes, edges} with correct types", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#1",
        repo: "Roxabi/roxabi-live",
        number: 1,
        title: "Fix the thing",
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
      const edge = {
        src_key: "Roxabi/roxabi-live#2",
        dst_key: "Roxabi/roxabi-live#1",
        kind: "blocks",
      };
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [issue], [edge]));
      expect(res.status).toBe(200);
      const body = await res.json<{
        nodes: unknown[];
        edges: unknown[];
        repos: unknown[];
      }>();
      expect(Array.isArray(body.nodes)).toBe(true);
      expect(Array.isArray(body.edges)).toBe(true);
      expect(Array.isArray(body.repos)).toBe(true);
    });

    it("redacts titles when issue is zk-sealed", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#7",
        repo: "Roxabi/roxabi-live",
        number: 7,
        title: "Secret title",
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
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [issue], [], [], undefined, false, ["Roxabi/roxabi-live#7"]),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].title).toBeNull();
    });

    it("maps IssueRow fields to Node shape", async () => {
      const issue = {
        key: "Roxabi/roxabi-live#42",
        repo: "Roxabi/roxabi-live",
        number: 42,
        title: "Hello",
        state: "open",
        url: "https://github.com/Roxabi/roxabi-live/issues/42",
        milestone: null,
        lane: "backlog",
        priority: "P1",
        size: "M",
        status: "in_progress",
        is_stub: 0,
        has_active_branch: 0,
      };
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      const node = body.nodes[0];
      expect(node.key).toBe("Roxabi/roxabi-live#42");
      expect(node.repo).toBe("Roxabi/roxabi-live");
      expect(node.number).toBe(42);
      expect(node.title).toBe("Hello");
      expect(node.state).toBe("open");
      expect(node.url).toBe("https://github.com/Roxabi/roxabi-live/issues/42");
      expect(node.lane).toBe("backlog");
      expect(node.priority).toBe("P1");
      expect(node.size).toBe("M");
      expect(node.status).toBe("in_progress");
      expect(node.is_stub).toBe(false);
    });

    it("maps EdgeRow fields to Edge shape", async () => {
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
      const edge = {
        src_key: "Roxabi/roxabi-live#2",
        dst_key: "Roxabi/roxabi-live#1",
        kind: "blocks",
      };
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [issue], [edge]));
      const body = await res.json<{ edges: Record<string, unknown>[] }>();
      expect(body.edges[0]).toEqual({
        src: "Roxabi/roxabi-live#2",
        dst: "Roxabi/roxabi-live#1",
        kind: "blocks",
      });
    });
  });

  describe("dev_state priority matrix", () => {
    const baseIssue = {
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

    it("idle when no branch and no open PR", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [{ ...baseIssue, has_active_branch: 0 }], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("idle");
    });

    it("dev when has_active_branch=1 and no open PR", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [{ ...baseIssue, has_active_branch: 1 }], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("dev");
    });

    it("pr_open when an open PR is linked but not reviewed", async () => {
      const prState = [
        {
          closing_issue_keys: '["Roxabi/roxabi-live#1"]',
          has_reviewed_label: 0,
        },
      ];
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], prState, [{ ...baseIssue, has_active_branch: 1 }], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("pr_open");
    });

    it("pr_reviewed when an open PR has has_reviewed_label=1", async () => {
      const prState = [
        {
          closing_issue_keys: '["Roxabi/roxabi-live#1"]',
          has_reviewed_label: 1,
        },
      ];
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], prState, [{ ...baseIssue, has_active_branch: 1 }], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("pr_reviewed");
    });

    it("idle for a closed issue even when has_active_branch=1", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [{ ...baseIssue, state: "closed", has_active_branch: 1 }], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("idle");
    });
  });

  describe("lane fallback from labels", () => {
    const baseIssue = {
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

    it("uses lane field when set", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [{ ...baseIssue, lane: "backlog" }], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].lane).toBe("backlog");
    });

    it("falls back to graph:lane/ label when lane field is null", async () => {
      const labels = [{ issue_key: baseIssue.key, name: "graph:lane/active" }];
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv(labels, [], [baseIssue], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].lane).toBe("active");
    });

    it("returns null lane when no lane field and no graph:lane/ label", async () => {
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [baseIssue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].lane).toBeNull();
    });
  });

  describe("is_stub boolean coercion", () => {
    const base = {
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
      has_active_branch: 0,
    };

    it("coerces is_stub=1 to true", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [{ ...base, is_stub: 1 }], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].is_stub).toBe(true);
    });

    it("coerces is_stub=0 to false", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [{ ...base, is_stub: 0 }], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].is_stub).toBe(false);
    });
  });

  describe("invalid JSON in pr_state.closing_issue_keys", () => {
    it("falls back to idle dev_state on invalid closing_issue_keys JSON", async () => {
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
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], prState, [issue], []));
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
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], prState, [issue], []));
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
      const res = await testApp.request("/api/graph", {}, makeGraphEnv(labels, [], [issue], []));
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
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].labels).toEqual([]);
    });
  });

  describe("empty database", () => {
    it("returns {nodes:[], edges:[], repos:[]} when all tables empty", async () => {
      // Empty issues → no visible repos → resolveVisibleRepos short-circuits → {nodes:[],edges:[],repos:[]}
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [], []));
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
      // Use overrideVisible to inject visible repos (no issues needed)
      const visibleList = repoRows.map((r) => r.repo);
      const env = makeGraphEnv([], [], [], [], repoRows, visibleList);
      const res = await testApp.request("/api/graph", {}, env);
      expect(res.status).toBe(200);
      const body = await res.json<{
        repos: { repo: string; archived: boolean }[];
      }>();
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
      // Act — empty issues → resolveVisibleRepos returns [] → short-circuit.
      // Use a non-empty issue to ensure issues query fires.
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
      const { env: env2, capturedSqls: sqls2 } = makeGraphEnvWithCapture([], [], [issue], []);
      await testApp.request("/api/graph", {}, env2);
      // Assert — the issues query must project title via JSON_EXTRACT.
      // Use "json_extract" as the finder key so labels/edges subqueries (which also
      // contain "from issues") don't accidentally win the find().
      const issuesSql = sqls2.find((s) => s.toLowerCase().includes("json_extract"));
      expect(issuesSql).toContain("JSON_EXTRACT(payload,'$.title') AS title");
      void env; // suppress unused warning
      void capturedSqls;
    });
  });

  describe("status query filter", () => {
    const repo = "Roxabi/roxabi-live";
    const issues = [
      {
        key: `${repo}#1`,
        repo,
        number: 1,
        title: "Blocker",
        state: "open",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      },
      {
        key: `${repo}#2`,
        repo,
        number: 2,
        title: "Blocked",
        state: "open",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      },
      {
        key: `${repo}#3`,
        repo,
        number: 3,
        title: "Done",
        state: "closed",
        url: null,
        milestone: null,
        lane: null,
        priority: null,
        size: null,
        status: null,
        is_stub: 0,
        has_active_branch: 0,
      },
    ];
    const edges = [
      { src_key: `${repo}#1`, dst_key: `${repo}#2`, kind: "blocks" },
      { src_key: `${repo}#1`, dst_key: `${repo}#3`, kind: "parent" },
    ];

    it("returns only ready and blocked nodes when status=ready,blocked", async () => {
      const env = makeGraphEnv([], [], issues, edges);
      const res = await testApp.request("/api/graph?status=ready,blocked", {}, env);
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: { key: string }[] }>();
      expect(body.nodes.map((n) => n.key).sort()).toEqual([`${repo}#1`, `${repo}#2`]);
    });

    it("includes done child under open epic when closed_under_open_epic=1", async () => {
      const env = makeGraphEnv([], [], issues, edges);
      const res = await testApp.request(
        "/api/graph?status=ready,blocked&closed_under_open_epic=1",
        {},
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: { key: string }[] }>();
      expect(body.nodes.map((n) => n.key).sort()).toEqual([`${repo}#1`, `${repo}#2`, `${repo}#3`]);
    });

    it("omits status param returns all nodes", async () => {
      const env = makeGraphEnv([], [], issues, edges);
      const res = await testApp.request("/api/graph", {}, env);
      const body = await res.json<{ nodes: { key: string }[] }>();
      expect(body.nodes).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant-scoped visibility tests (#148)
  // ---------------------------------------------------------------------------

  describe("tenant scoping", () => {
    const visibleRepo = "Roxabi/roxabi-live";
    const hiddenRepo = "Roxabi/private-repo";

    const makeIssue = (repo: string, n: number) => ({
      key: `${repo}#${n}`,
      repo,
      number: n,
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
    });

    it("nodes scoped — issue in non-visible repo is absent from nodes", async () => {
      // The hidden repo issue is in the issues fixture but NOT in tenant_repo_access.
      // resolveVisibleRepos returns only [visibleRepo].
      // graphRoute WHERE repo IN (?) scopes the issues query — DB stub simulates
      // the filter by only returning the visible issue.
      const visibleIssue = makeIssue(visibleRepo, 1);
      // overrideVisible = only visibleRepo; issues stub returns only visibleIssue
      const env = makeGraphEnv([], [], [visibleIssue], [], [], [visibleRepo]);
      const res = await testApp.request("/api/graph", {}, env);
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: { key: string }[] }>();
      const keys = body.nodes.map((n) => n.key);
      expect(keys).toContain(`${visibleRepo}#1`);
      expect(keys).not.toContain(`${hiddenRepo}#99`);
    });

    it("edges scoped — edge with endpoint in non-visible repo is dropped", async () => {
      // Both endpoints of the edge must be in visible repos.
      // Our stub simulates the SQL filter: only edges where both endpoints are visible.
      const visibleIssue = makeIssue(visibleRepo, 1);
      const visibleEdge = {
        src_key: `${visibleRepo}#2`,
        dst_key: `${visibleRepo}#1`,
        kind: "blocks",
      };
      // dangling edge has dst in hidden repo — DB stub does NOT return it
      const env = makeGraphEnv(
        [],
        [],
        [visibleIssue],
        [visibleEdge], // only the fully-visible edge is returned by issues-scoped query
        [],
        [visibleRepo],
      );
      const res = await testApp.request("/api/graph", {}, env);
      expect(res.status).toBe(200);
      const body = await res.json<{
        edges: { src: string; dst: string; kind: string }[];
      }>();
      // Visible edge is present
      expect(body.edges).toContainEqual({
        src: `${visibleRepo}#2`,
        dst: `${visibleRepo}#1`,
        kind: "blocks",
      });
      // No edge touching hidden repo
      const touchesHidden = body.edges.some(
        (e) => e.src.startsWith(hiddenRepo) || e.dst.startsWith(hiddenRepo),
      );
      expect(touchesHidden).toBe(false);
    });

    it("repos scoped — repos[] lists only visible repos", async () => {
      const repoRows = [{ repo: visibleRepo, archived: 0 }];
      // overrideVisible only includes visibleRepo; repos stub returns only that row
      const env = makeGraphEnv([], [], [], [], repoRows, [visibleRepo]);
      const res = await testApp.request("/api/graph", {}, env);
      expect(res.status).toBe(200);
      const body = await res.json<{
        repos: { repo: string; archived: boolean }[];
      }>();
      expect(body.repos.map((r) => r.repo)).toEqual([visibleRepo]);
      expect(body.repos.map((r) => r.repo)).not.toContain(hiddenRepo);
    });

    it("scopes the issues/edges/repos reads to the visible set via `repo IN` (#148)", async () => {
      // Non-empty issues fixture → visible set non-empty → the data reads fire.
      // This is the discriminating guard: strip the `repo IN` clauses from graphRoute
      // and these assertions fail — i.e. the test actually exercises the scoping.
      const issue = makeIssue(visibleRepo, 1);
      const { env, capturedSqls } = makeGraphEnvWithCapture(
        [],
        [],
        [issue],
        [],
        [{ repo: visibleRepo, archived: 0 }],
      );
      await testApp.request("/api/graph", {}, env);

      const issuesSql = capturedSqls.find((s) => s.includes("has_active_branch"));
      const edgesSql = capturedSqls.find((s) => s.includes("FROM edges"));
      const reposSql = capturedSqls.find((s) => s.includes("FROM repos"));
      expect(issuesSql).toBeDefined();
      expect(edgesSql).toBeDefined();
      expect(reposSql).toBeDefined();
      // Without these filters the graph would expose issues/edges/repos from tenants
      // the caller can't see.
      expect(issuesSql).toContain("repo IN");
      expect(edgesSql).toContain("repo IN");
      expect(reposSql).toContain("repo IN");
    });

    it("empty visible set short-circuits to {nodes:[], edges:[], repos:[]} and issues NO data reads (#148)", async () => {
      // issues fixture empty → tenant_repo_access empty → resolveVisibleRepos returns []
      const { env, capturedSqls } = makeGraphEnvWithCapture([], [], [], [], []);
      const res = await testApp.request("/api/graph", {}, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ nodes: [], edges: [], repos: [] });
      // The short-circuit must run BEFORE any data read — drop it and these fire.
      expect(capturedSqls.some((s) => s.includes("has_active_branch"))).toBe(false);
      expect(capturedSqls.some((s) => s.includes("FROM edges"))).toBe(false);
      expect(capturedSqls.some((s) => s.includes("FROM repos"))).toBe(false);
    });
  });
});
