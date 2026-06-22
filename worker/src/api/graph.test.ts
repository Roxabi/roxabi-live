import { afterEach, describe, expect, it, vi } from "vitest";
import { STUB_SESSION, captureDb, dispatchByTable, makeEnv } from "../test-utils";
import {
  GRAPH_REPO,
  graphIssue,
  makeGraphEnv,
  makeGraphEnvWithCapture,
  makeGraphTestApp,
} from "./graph-test-helpers";

const testApp = makeGraphTestApp();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/graph", () => {
  describe("response shape", () => {
    it("returns {nodes, edges} with correct types", async () => {
      const issue = graphIssue(1, {
        title: "Fix the thing",
        url: "https://github.com/Roxabi/roxabi-live/issues/1",
      });
      const edge = { src_key: "Roxabi/roxabi-live#2", dst_key: issue.key, kind: "blocks" };
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [issue], [edge]));
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: unknown[]; edges: unknown[]; repos: unknown[] }>();
      expect(Array.isArray(body.nodes)).toBe(true);
      expect(Array.isArray(body.edges)).toBe(true);
      expect(Array.isArray(body.repos)).toBe(true);
    });

    it("exposes assignees parsed from the issues row", async () => {
      const issue = graphIssue(3, { title: "Assigned issue", assignees: '["alice","bob"]' });
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Array<{ assignees: string[] }> }>();
      expect(body.nodes[0].assignees).toEqual(["alice", "bob"]);
    });

    it("redacts titles when the current user sealed the issue", async () => {
      const issue = graphIssue(7, { title: "Secret title" });
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [issue], [], [], undefined, false, [issue.key]),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].title).toBeNull();
    });

    it("keeps titles visible when only another user sealed the issue", async () => {
      const issue = graphIssue(8, { title: "Still visible" });
      const { db } = captureDb((sql, args) =>
        dispatchByTable(sql, {
          "from zk_payloads": args?.[0] === STUB_SESSION.userId ? [] : [{ issue_key: issue.key }],
          tenant_repo_access: [{ repo: issue.repo, is_private: 0 }],
          "from labels": [],
          "from pr_state": [],
          "from edges": [],
          "from repos": [],
          "from issues": [issue],
        }),
      );
      const res = await testApp.request("/api/graph", {}, makeEnv(db));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].title).toBe("Still visible");
    });

    it("maps IssueRow fields to Node shape", async () => {
      const issue = graphIssue(42, {
        title: "Hello",
        url: "https://github.com/Roxabi/roxabi-live/issues/42",
        lane: "backlog",
        priority: "P1",
        size: "M",
        status: "in_progress",
      });
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      const node = body.nodes[0];
      expect(node.key).toBe("Roxabi/roxabi-live#42");
      expect(node.repo).toBe(GRAPH_REPO);
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
      const issue = graphIssue(1);
      const edge = { src_key: "Roxabi/roxabi-live#2", dst_key: issue.key, kind: "blocks" };
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [issue], [edge]));
      const body = await res.json<{ edges: Record<string, unknown>[] }>();
      expect(body.edges[0]).toEqual({
        src: "Roxabi/roxabi-live#2",
        dst: issue.key,
        kind: "blocks",
      });
    });
  });

  describe("dev_state priority matrix", () => {
    it("idle when no branch and no open PR", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [graphIssue(1)], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("idle");
    });

    it("dev when has_active_branch=1 and no open PR", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [graphIssue(1, { has_active_branch: 1 })], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("dev");
    });

    it("pr_open when an open PR is linked but not reviewed", async () => {
      const issue = graphIssue(1, { has_active_branch: 1 });
      const prState = [{ closing_issue_keys: `["${issue.key}"]`, has_reviewed_label: 0 }];
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], prState, [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("pr_open");
    });

    it("pr_reviewed when an open PR has has_reviewed_label=1", async () => {
      const issue = graphIssue(1, { has_active_branch: 1 });
      const prState = [{ closing_issue_keys: `["${issue.key}"]`, has_reviewed_label: 1 }];
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], prState, [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("pr_reviewed");
    });

    it("idle for a closed issue even when has_active_branch=1", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [graphIssue(1, { state: "closed", has_active_branch: 1 })], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("idle");
    });
  });

  describe("lane fallback from labels", () => {
    it("uses lane field when set", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [graphIssue(1, { lane: "backlog" })], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].lane).toBe("backlog");
    });

    it("falls back to graph:lane/ label when lane field is null", async () => {
      const issue = graphIssue(1);
      const labels = [{ issue_key: issue.key, name: "graph:lane/active" }];
      const res = await testApp.request("/api/graph", {}, makeGraphEnv(labels, [], [issue], []));
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].lane).toBe("active");
    });

    it("returns null lane when no lane field and no graph:lane/ label", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [graphIssue(1)], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].lane).toBeNull();
    });
  });

  describe("is_stub boolean coercion", () => {
    it("coerces is_stub=1 to true", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [graphIssue(1, { is_stub: 1 })], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].is_stub).toBe(true);
    });

    it("coerces is_stub=0 to false", async () => {
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [graphIssue(1)], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].is_stub).toBe(false);
    });
  });

  describe("invalid JSON in pr_state.closing_issue_keys", () => {
    it("falls back to idle dev_state on invalid closing_issue_keys JSON", async () => {
      const prState = [{ closing_issue_keys: "not-valid-json", has_reviewed_label: 1 }];
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], prState, [graphIssue(1)], []),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("idle");
    });

    it("silently skips rows where closing_issue_keys is null", async () => {
      const prState = [{ closing_issue_keys: null, has_reviewed_label: 1 }];
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], prState, [graphIssue(1)], []),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].dev_state).toBe("idle");
    });
  });

  describe("labels attached per issue", () => {
    it("attaches correct labels to each node", async () => {
      const issue = graphIssue(1);
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
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [graphIssue(1)], []),
      );
      const body = await res.json<{ nodes: Record<string, unknown>[] }>();
      expect(body.nodes[0].labels).toEqual([]);
    });
  });

  describe("empty database", () => {
    it("returns {nodes:[], edges:[], repos:[]} when all tables empty", async () => {
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], [], []));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ nodes: [], edges: [], repos: [] });
    });
  });

  describe("repos field", () => {
    it("returns repo registry rows with per-repo activity stats", async () => {
      const repoRows = [
        { repo: "Roxabi/roxabi-factory", archived: 0 },
        { repo: GRAPH_REPO, archived: 0 },
        { repo: "Roxabi/roxabi-vault", archived: 1 },
      ];
      const issues = [
        graphIssue(1, { title: "Active", updated_at: "2026-06-20T12:00:00Z" }),
        graphIssue(2, { title: "Also active", updated_at: "2026-06-21T08:00:00Z" }),
      ];
      const visibleList = repoRows.map((r) => r.repo);
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], issues, [], repoRows, visibleList),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        repos: {
          repo: string;
          archived: boolean;
          issue_count: number;
          last_updated_at: string | null;
        }[];
      }>();
      expect(body.repos).toEqual(
        expect.arrayContaining([
          {
            repo: GRAPH_REPO,
            archived: false,
            issue_count: 2,
            last_updated_at: "2026-06-21T08:00:00Z",
          },
          {
            repo: "Roxabi/roxabi-factory",
            archived: false,
            issue_count: 0,
            last_updated_at: null,
          },
          {
            repo: "Roxabi/roxabi-vault",
            archived: true,
            issue_count: 0,
            last_updated_at: null,
          },
        ]),
      );
    });
  });

  describe("SQL shape assertions", () => {
    it("issues SELECT uses JSON_EXTRACT(payload,'$.title') AS title", async () => {
      const { env: env2, capturedSqls: sqls2 } = makeGraphEnvWithCapture(
        [],
        [],
        [graphIssue(1)],
        [],
      );
      await testApp.request("/api/graph", {}, env2);
      const issuesSql = sqls2.find((s) => s.toLowerCase().includes("json_extract"));
      expect(issuesSql).toContain("JSON_EXTRACT(payload,'$.title') AS title");
    });
  });

  describe("status query filter", () => {
    const issues = [
      graphIssue(1, { title: "Blocker" }),
      graphIssue(2, { title: "Blocked" }),
      graphIssue(3, { title: "Done", state: "closed" }),
    ];
    const edges = [
      { src_key: `${GRAPH_REPO}#1`, dst_key: `${GRAPH_REPO}#2`, kind: "blocks" },
      { src_key: `${GRAPH_REPO}#1`, dst_key: `${GRAPH_REPO}#3`, kind: "parent" },
    ];

    it("returns only ready and blocked nodes when status=ready,blocked", async () => {
      const res = await testApp.request(
        "/api/graph?status=ready,blocked",
        {},
        makeGraphEnv([], [], issues, edges),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: { key: string }[] }>();
      expect(body.nodes.map((n) => n.key).sort()).toEqual([`${GRAPH_REPO}#1`, `${GRAPH_REPO}#2`]);
    });

    it("includes done child under open epic when closed_under_open_epic=1", async () => {
      const res = await testApp.request(
        "/api/graph?status=ready,blocked&closed_under_open_epic=1",
        {},
        makeGraphEnv([], [], issues, edges),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: { key: string }[] }>();
      expect(body.nodes.map((n) => n.key).sort()).toEqual([
        `${GRAPH_REPO}#1`,
        `${GRAPH_REPO}#2`,
        `${GRAPH_REPO}#3`,
      ]);
    });

    it("omits status param returns all nodes", async () => {
      const res = await testApp.request("/api/graph", {}, makeGraphEnv([], [], issues, edges));
      const body = await res.json<{ nodes: { key: string }[] }>();
      expect(body.nodes).toHaveLength(3);
    });
  });

  describe("tenant scoping", () => {
    const hiddenRepo = "Roxabi/private-repo";

    it("nodes scoped — issue in non-visible repo is absent from nodes", async () => {
      const visibleIssue = graphIssue(1);
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [visibleIssue], [], [], [GRAPH_REPO]),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ nodes: { key: string }[] }>();
      const keys = body.nodes.map((n) => n.key);
      expect(keys).toContain(`${GRAPH_REPO}#1`);
      expect(keys).not.toContain(`${hiddenRepo}#99`);
    });

    it("edges scoped — edge with endpoint in non-visible repo is dropped", async () => {
      const visibleIssue = graphIssue(1);
      const visibleEdge = { src_key: `${GRAPH_REPO}#2`, dst_key: visibleIssue.key, kind: "blocks" };
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [visibleIssue], [visibleEdge], [], [GRAPH_REPO]),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ edges: { src: string; dst: string; kind: string }[] }>();
      expect(body.edges).toContainEqual({
        src: `${GRAPH_REPO}#2`,
        dst: visibleIssue.key,
        kind: "blocks",
      });
      const touchesHidden = body.edges.some(
        (e) => e.src.startsWith(hiddenRepo) || e.dst.startsWith(hiddenRepo),
      );
      expect(touchesHidden).toBe(false);
    });

    it("repos scoped — repos[] lists only visible repos", async () => {
      const repoRows = [{ repo: GRAPH_REPO, archived: 0 }];
      const res = await testApp.request(
        "/api/graph",
        {},
        makeGraphEnv([], [], [], [], repoRows, [GRAPH_REPO]),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ repos: { repo: string; archived: boolean }[] }>();
      expect(body.repos.map((r) => r.repo)).toEqual([GRAPH_REPO]);
      expect(body.repos.map((r) => r.repo)).not.toContain(hiddenRepo);
    });

    it("scopes the issues/edges/repos reads to the visible set via `repo IN` (#148)", async () => {
      const issue = graphIssue(1);
      const { env, capturedSqls } = makeGraphEnvWithCapture(
        [],
        [],
        [issue],
        [],
        [{ repo: GRAPH_REPO, archived: 0 }],
      );
      await testApp.request("/api/graph", {}, env);

      const issuesSql = capturedSqls.find((s) => s.includes("has_active_branch"));
      const edgesSql = capturedSqls.find((s) => s.includes("FROM edges"));
      const reposSql = capturedSqls.find((s) => s.includes("FROM repos"));
      expect(issuesSql).toBeDefined();
      expect(edgesSql).toBeDefined();
      expect(reposSql).toBeDefined();
      expect(issuesSql).toContain("repo IN");
      expect(edgesSql).toContain("repo IN");
      expect(reposSql).toContain("repo IN");
    });

    it("empty visible set short-circuits to {nodes:[], edges:[], repos:[]} and issues NO data reads (#148)", async () => {
      const { env, capturedSqls } = makeGraphEnvWithCapture([], [], [], [], []);
      const res = await testApp.request("/api/graph", {}, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ nodes: [], edges: [], repos: [] });
      expect(capturedSqls.some((s) => s.includes("has_active_branch"))).toBe(false);
      expect(capturedSqls.some((s) => s.includes("FROM edges"))).toBe(false);
      expect(capturedSqls.some((s) => s.includes("FROM repos"))).toBe(false);
    });
  });
});
