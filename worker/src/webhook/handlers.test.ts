import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleDeps,
  handleIssues,
  handleMilestone,
  handlePullRequest,
  handleRefCreate,
  handleRefDelete,
  handleSubIssues,
  webhookRoute,
} from "./handlers";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Module mocks — must be at top level before imports resolve
// ---------------------------------------------------------------------------

vi.mock("../sync/graphql", () => ({
  fetchIssueDeps: vi.fn(),
  GraphQLError: class GraphQLError extends Error {
    isAuth: boolean;
    constructor(msg: string, isAuth = false) {
      super(msg);
      this.name = "GraphQLError";
      this.isAuth = isAuth;
    }
  },
}));

vi.mock("../sync/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sync/sync")>();
  return {
    ...actual,
    syncBranches: vi.fn(),
  };
});

// RED (S3): resolveInstallToken does not exist yet — import fails at runtime → test fails
vi.mock("../auth/installToken", () => ({
  resolveInstallToken: vi.fn(),
}));

import { fetchIssueDeps } from "../sync/graphql";
import { syncBranches } from "../sync/sync";
import { resolveInstallToken } from "../auth/installToken";

// ---------------------------------------------------------------------------
// FakeD1 — cloned from mutations.test.ts / sync.test.ts pattern
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
): D1Database & { _recorded: FakeStmt[] } {
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
      return stmts.map(() => ({ results: [], meta: { changes: 1 } }));
    }),
    _recorded: recorded,
  } as unknown as D1Database & { _recorded: FakeStmt[] };

  return db;
}

/** Capture all statements produced via bind() calls on the FakeDb. */
function captureDb(): {
  db: D1Database & { _recorded: FakeStmt[] };
  stmts: () => FakeStmt[];
} {
  const captured: FakeStmt[] = [];
  const db = makeFakeDb((sql, args) => {
    const stmt = makeFakeStmt(sql, args, [], 1);
    captured.push(stmt);
    return stmt;
  });
  return { db, stmts: () => captured };
}

// ---------------------------------------------------------------------------
// Helpers — HMAC for dispatch tests
// ---------------------------------------------------------------------------

async function computeHmac(body: ArrayBuffer, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, body);
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

function makeRequest(
  body: string,
  sig: string,
  event: string,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request("https://example.com/webhook/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sig,
      "x-github-event": event,
      ...extraHeaders,
    },
    body,
  });
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: captureDb().db,
    GITHUB_TOKEN: "ghp_test",
    GITHUB_ORG: "Roxabi",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    ASSETS: {} as Fetcher,
    GITHUB_APP_ID: "0",
    GITHUB_APP_CLIENT_ID: "placeholder",
    GITHUB_APP_CLIENT_SECRET: "placeholder",
    GITHUB_APP_PRIVATE_KEY: "placeholder",
    GITHUB_APP_WEBHOOK_SECRET: "placeholder",
    INSTALL_TOKEN_KEY: "placeholder",
    ...overrides,
  };
}

/** Build a minimal Hono-like Context for webhookRoute tests. */
function makeContext(
  req: Request,
  env: Env,
): { c: Parameters<typeof webhookRoute>[0]; db: D1Database & { _recorded: FakeStmt[] } } {
  const { db, stmts: _stmts } = captureDb();
  const envWithDb: Env = { ...env, DB: db };

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  const c = {
    env: envWithDb,
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? undefined,
      arrayBuffer: () => req.arrayBuffer(),
    },
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as Parameters<typeof webhookRoute>[0];

  return { c, db };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "Roxabi/lyra";

function makeIssuePayload(action: string, issueOverrides: Record<string, unknown> = {}) {
  return {
    action,
    issue: {
      number: 42,
      title: "Test issue",
      state: "open",
      html_url: "https://github.com/Roxabi/lyra/issues/42",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      closed_at: null,
      milestone: null,
      labels: [{ name: "bug" }, { name: "P1-high" }],
      ...issueOverrides,
    },
    repository: { full_name: REPO },
  };
}

// ---------------------------------------------------------------------------
// handleIssues
// ---------------------------------------------------------------------------

describe("handleIssues", () => {
  afterEach(() => vi.clearAllMocks());

  describe("opened / edited (upsert path)", () => {
    it("calls db.batch (not loose .run) with issue upsert + label statements", async () => {
      // Arrange
      const { db } = captureDb();
      const payload = makeIssuePayload("opened");

      // Act
      await handleIssues(payload, db);

      // Assert — batch was called (SC9 atomic requirement)
      expect(vi.mocked(db.batch)).toHaveBeenCalledOnce();
      const batchArgs = vi.mocked(db.batch).mock.calls[0][0] as unknown as FakeStmt[];
      // First stmt = issue upsert (INSERT INTO issues)
      expect(batchArgs[0].sql).toContain("INSERT INTO issues");
      // Remaining stmts = label ops (DELETE + INSERT per label)
      expect(batchArgs.length).toBeGreaterThan(1);
      const labelSqls = batchArgs.slice(1).map((s) => s.sql);
      expect(labelSqls.some((s) => s.includes("DELETE FROM labels"))).toBe(true);
    });

    it("batch contains label INSERT stmts for each label name", async () => {
      // Arrange
      const { db } = captureDb();
      const payload = makeIssuePayload("edited", {
        labels: [{ name: "enhancement" }, { name: "F-lite" }],
      });

      // Act
      await handleIssues(payload, db);

      // Assert
      const batchArgs = vi.mocked(db.batch).mock.calls[0][0] as unknown as FakeStmt[];
      const labelInserts = batchArgs.filter((s) => s.sql.includes("INSERT OR IGNORE INTO labels"));
      expect(labelInserts).toHaveLength(2);
      const names = labelInserts.map((s) => s.args[1]);
      expect(names).toContain("enhancement");
      expect(names).toContain("F-lite");
    });

    it("does NOT call db.batch when action=deleted", async () => {
      // Arrange — guard: deleted path must NOT run upsert batch
      const { db } = captureDb();
      const payload = makeIssuePayload("deleted");

      // Act
      await handleIssues(payload, db);

      // Assert
      expect(vi.mocked(db.batch)).not.toHaveBeenCalled();
    });
  });

  describe("deleted / transferred (delete path)", () => {
    it("runs DELETE FROM issues for action=deleted", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const payload = makeIssuePayload("deleted");

      // Act
      await handleIssues(payload, db);

      // Assert — a stmt with DELETE FROM issues was run
      const deletedStmt = stmts().find((s) => s.sql.includes("DELETE FROM issues"));
      expect(deletedStmt).toBeDefined();
      expect(vi.mocked(deletedStmt!.run)).toHaveBeenCalled();
      expect(deletedStmt!.args).toContain(`${REPO}#42`);
    });

    it("runs DELETE FROM issues for action=transferred", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const payload = makeIssuePayload("transferred");

      // Act
      await handleIssues(payload, db);

      // Assert
      const deletedStmt = stmts().find((s) => s.sql.includes("DELETE FROM issues"));
      expect(deletedStmt).toBeDefined();
      expect(vi.mocked(deletedStmt!.run)).toHaveBeenCalled();
    });

    it("guard: deleting the deleted/transferred check would break test — no batch called", async () => {
      // Negative: batch must NOT be called on deleted action
      const { db } = captureDb();
      await handleIssues(makeIssuePayload("deleted"), db);
      expect(vi.mocked(db.batch)).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// handleDeps
// ---------------------------------------------------------------------------

describe("handleDeps", () => {
  afterEach(() => vi.clearAllMocks());

  const baseEnv: Env = makeEnv();

  describe("same-repo blocked_by_added", () => {
    it("calls addEdge with kind=blocks and runs it (src=blocker, dst=blocked)", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const payload = {
        action: "blocked_by_added",
        blocking_issue: { number: 10 },
        blocked_issue: { number: 42 },
        blocking_issue_repo: { full_name: REPO },
        repository: { full_name: REPO },
      };

      // Act
      await handleDeps(payload, db, baseEnv);

      // Assert — INSERT OR IGNORE INTO edges with kind=blocks
      const edgeStmt = stmts().find((s) => s.sql.includes("INSERT OR IGNORE INTO edges"));
      expect(edgeStmt).toBeDefined();
      expect(edgeStmt!.args).toEqual([`${REPO}#10`, `${REPO}#42`, "blocks"]);
      expect(vi.mocked(edgeStmt!.run)).toHaveBeenCalled();
    });
  });

  describe("same-repo blocked_by_removed", () => {
    it("calls removeEdge with kind=blocks (DELETE FROM edges)", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const payload = {
        action: "blocked_by_removed",
        blocking_issue: { number: 10 },
        blocked_issue: { number: 42 },
        blocking_issue_repo: { full_name: REPO },
        repository: { full_name: REPO },
      };

      // Act
      await handleDeps(payload, db, baseEnv);

      // Assert
      const edgeStmt = stmts().find((s) => s.sql.includes("DELETE FROM edges"));
      expect(edgeStmt).toBeDefined();
      expect(edgeStmt!.args).toEqual([`${REPO}#10`, `${REPO}#42`, "blocks"]);
      expect(vi.mocked(edgeStmt!.run)).toHaveBeenCalled();
    });
  });

  describe("blocking_* actions (ignored)", () => {
    it.each(["blocking_added", "blocking_removed"])(
      "returns 0 and touches no DB for action=%s",
      async (action) => {
        // Arrange
        const { db, stmts } = captureDb();
        const payload = { action, blocking_issue: { number: 5 }, repository: { full_name: REPO } };

        // Act
        const result = await handleDeps(payload, db, baseEnv);

        // Assert — no-op
        expect(result).toBe(0);
        expect(stmts()).toHaveLength(0);
        expect(vi.mocked(db.batch)).not.toHaveBeenCalled();
      },
    );
  });

  describe("cross-repo (blocking_issue absent)", () => {
    it("calls fetchIssueDeps then db.batch with upsertEdges stmts", async () => {
      // Arrange
      const { db } = captureDb();
      vi.mocked(fetchIssueDeps).mockResolvedValue({
        blocked_by: [`${REPO}#7`],
        blocking: [],
      });
      const payload = {
        action: "blocked_by_added",
        blocked_issue: { number: 42 },
        repository: { full_name: REPO },
        // no blocking_issue key → cross-repo path
      };

      // Act
      await handleDeps(payload, db, { ...baseEnv, DB: db });

      // Assert — fetchIssueDeps was called
      expect(vi.mocked(fetchIssueDeps)).toHaveBeenCalled();
      // db.batch was called with the upsertEdges stmts
      expect(vi.mocked(db.batch)).toHaveBeenCalled();
    });

    it("swallows GraphQLError — handler resolves without throwing", async () => {
      // Arrange
      const { db } = captureDb();
      const { GraphQLError } = await import("../sync/graphql");
      vi.mocked(fetchIssueDeps).mockRejectedValue(new GraphQLError("rate limited"));
      const payload = {
        action: "blocked_by_added",
        blocked_issue: { number: 42 },
        repository: { full_name: REPO },
      };

      // Act — must NOT throw
      const result = await handleDeps(payload, db, { ...baseEnv, DB: db });

      // Assert — returns 0, does not propagate error
      expect(result).toBe(0);
    });

    it("swallows non-GraphQLError — catch-all returns 0 for any error type", async () => {
      // Arrange — generic Error (not GraphQLError); source catch returns 0 for all errors,
      // only the log level differs (warn for GraphQLError, error for everything else).
      const { db } = captureDb();
      vi.mocked(fetchIssueDeps).mockRejectedValue(new Error("boom"));
      const payload = {
        action: "blocked_by_added",
        blocked_issue: { number: 42 },
        repository: { full_name: REPO },
      };

      // Act — must NOT throw
      const result = await handleDeps(payload, db, { ...baseEnv, DB: db });

      // Assert — catch swallows all errors, not just GraphQLError
      expect(result).toBe(0);
    });

    // RED (S3 — future multi-tenant): handleDeps cross-repo path must use resolveInstallToken,
    // NOT env.GITHUB_TOKEN. Current impl calls fetchIssueDeps(db, env.GITHUB_TOKEN, ...) at
    // handlers.ts line ~209. Future impl must call resolveInstallToken(db, env, owner, name)
    // and pass the resulting token to fetchIssueDeps.
    it("cross-repo path resolves token via resolveInstallToken(db, env, owner, name) — NOT env.GITHUB_TOKEN", async () => {
      // Arrange
      const { db } = captureDb();
      vi.mocked(fetchIssueDeps).mockResolvedValue({ blocked_by: [], blocking: [] });
      // Future: resolveInstallToken returns an install token
      vi.mocked(resolveInstallToken).mockResolvedValue("ghs_install_token");

      // Use REPO which is "Roxabi/roxabi-live" → owner="Roxabi", name="roxabi-live"
      const [owner, name] = REPO.split("/");

      let patAccessCount = 0;
      const envWithSpy: Env = { ...baseEnv, DB: db };
      delete (envWithSpy as unknown as Record<string, unknown>)["GITHUB_TOKEN"];
      Object.defineProperty(envWithSpy, "GITHUB_TOKEN", {
        get() {
          patAccessCount++;
          return "ghp_test";
        },
        configurable: true,
      });

      const payload = {
        action: "blocked_by_added",
        blocked_issue: { number: 42 },
        repository: { full_name: REPO },
        // no blocking_issue key → cross-repo path
      };

      // Act
      await handleDeps(payload, db, envWithSpy);

      // Assert 1: resolveInstallToken called with the right db + env + owner/name.
      // Compare via mock.calls indices, NOT toHaveBeenCalledWith(db, envWithSpy, ...): the
      // structural matcher enumerates envWithSpy's own property names, which trips the
      // GITHUB_TOKEN getter-spy and inflates patAccessCount. Reference-identity (toBe) and
      // index access do not enumerate, so they measure the impl's access only.
      const call = vi.mocked(resolveInstallToken).mock.calls[0];
      expect(call?.[0]).toBe(db);
      expect(call?.[1]).toBe(envWithSpy);
      expect(call?.[2]).toBe(owner);
      expect(call?.[3]).toBe(name);

      // Assert 2: env.GITHUB_TOKEN must NOT be accessed by the impl (PAT bypass)
      expect(patAccessCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// handleSubIssues
// ---------------------------------------------------------------------------

describe("handleSubIssues", () => {
  afterEach(() => vi.clearAllMocks());

  describe("sub_issue_added", () => {
    it("calls addEdge with kind=parent (src=parent, dst=child)", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const payload = {
        action: "sub_issue_added",
        parent_issue: { number: 10 },
        parent_issue_repo: { full_name: REPO },
        sub_issue: { number: 42 },
        sub_issue_repo: { full_name: REPO },
        repository: { full_name: REPO },
      };

      // Act
      await handleSubIssues(payload, db);

      // Assert — INSERT OR IGNORE INTO edges with kind=parent
      const edgeStmt = stmts().find((s) => s.sql.includes("INSERT OR IGNORE INTO edges"));
      expect(edgeStmt).toBeDefined();
      expect(edgeStmt!.args).toEqual([`${REPO}#10`, `${REPO}#42`, "parent"]);
      expect(vi.mocked(edgeStmt!.run)).toHaveBeenCalled();
    });
  });

  describe("sub_issue_removed", () => {
    it("calls removeEdge with kind=parent (DELETE FROM edges)", async () => {
      // Arrange
      const { db, stmts } = captureDb();
      const payload = {
        action: "sub_issue_removed",
        parent_issue: { number: 10 },
        parent_issue_repo: { full_name: REPO },
        sub_issue: { number: 42 },
        sub_issue_repo: { full_name: REPO },
        repository: { full_name: REPO },
      };

      // Act
      await handleSubIssues(payload, db);

      // Assert
      const edgeStmt = stmts().find((s) => s.sql.includes("DELETE FROM edges"));
      expect(edgeStmt).toBeDefined();
      expect(edgeStmt!.args).toEqual([`${REPO}#10`, `${REPO}#42`, "parent"]);
      expect(vi.mocked(edgeStmt!.run)).toHaveBeenCalled();
    });
  });

  describe("parent_* actions (ignored)", () => {
    it.each(["parent_issue_added", "parent_issue_removed"])(
      "returns 0 and touches no DB for action=%s",
      async (action) => {
        // Arrange
        const { db, stmts } = captureDb();
        const payload = { action, repository: { full_name: REPO } };

        // Act
        const result = await handleSubIssues(payload, db);

        // Assert — no-op
        expect(result).toBe(0);
        expect(stmts()).toHaveLength(0);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// handleRefCreate
// ---------------------------------------------------------------------------

describe("handleRefCreate", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls setActiveBranch(db, repo, issueNumber, 1) for matching branch", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = {
      ref_type: "branch",
      ref: "42-some-feature",
      repository: { full_name: REPO },
    };

    // Act
    await handleRefCreate(payload, db);

    // Assert — UPDATE issues SET has_active_branch=1
    const branchStmt = stmts().find((s) => s.sql.includes("has_active_branch=1"));
    expect(branchStmt).toBeDefined();
    expect(branchStmt!.args).toEqual([REPO, 42]);
    expect(vi.mocked(branchStmt!.run)).toHaveBeenCalled();
  });

  it("no-op for non-matching branch name", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = {
      ref_type: "branch",
      ref: "dependabot/npm/lodash-4.17.21",
      repository: { full_name: REPO },
    };

    // Act
    await handleRefCreate(payload, db);

    // Assert — no DB statements
    expect(stmts()).toHaveLength(0);
  });

  it("no-op for tag ref_type", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = {
      ref_type: "tag",
      ref: "42-tagged",
      repository: { full_name: REPO },
    };

    // Act
    await handleRefCreate(payload, db);

    // Assert
    expect(stmts()).toHaveLength(0);
  });

  it("guard: setActiveBranch is called — if guard removed, matching branch still calls it", async () => {
    // Negative: if BRANCH_ISSUE_RE guard is removed, a non-matching ref would still hit setActiveBranch
    // Verify matching ref hits it
    const { db, stmts } = captureDb();
    await handleRefCreate(
      { ref_type: "branch", ref: "97-cf-webhook", repository: { full_name: REPO } },
      db,
    );
    expect(stmts().some((s) => s.sql.includes("has_active_branch=1"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleRefDelete
// ---------------------------------------------------------------------------

describe("handleRefDelete", () => {
  afterEach(() => vi.clearAllMocks());

  const baseEnv: Env = makeEnv();

  it("calls syncBranches(db, token, owner, name) for matching branch", async () => {
    // Arrange
    const { db } = captureDb();
    vi.mocked(syncBranches).mockResolvedValue(undefined);
    // S3: handleRefDelete resolves the install token, then passes it to syncBranches
    // (no longer env.GITHUB_TOKEN).
    vi.mocked(resolveInstallToken).mockResolvedValue("ghs_install_token");
    const payload = {
      ref_type: "branch",
      ref: "42-done",
      repository: { full_name: "Roxabi/lyra" },
    };

    // Act
    await handleRefDelete(payload, db, { ...baseEnv, DB: db });

    // Assert — syncBranches called with the resolved install token + correct owner/name split
    expect(vi.mocked(syncBranches)).toHaveBeenCalledWith(db, "ghs_install_token", "Roxabi", "lyra");
  });

  it("no-op for non-matching branch name", async () => {
    // Arrange
    const { db } = captureDb();
    const payload = {
      ref_type: "branch",
      ref: "release-please/branches/main",
      repository: { full_name: REPO },
    };

    // Act
    await handleRefDelete(payload, db, { ...baseEnv, DB: db });

    // Assert — syncBranches not called
    expect(vi.mocked(syncBranches)).not.toHaveBeenCalled();
  });

  it("no-op for tag ref_type", async () => {
    // Arrange
    const { db } = captureDb();
    const payload = {
      ref_type: "tag",
      ref: "97-tagged",
      repository: { full_name: REPO },
    };

    // Act
    await handleRefDelete(payload, db, { ...baseEnv, DB: db });

    // Assert
    expect(vi.mocked(syncBranches)).not.toHaveBeenCalled();
  });

  // RED (S3 — future multi-tenant): handleRefDelete must resolve the token for the
  // deleted-branch repo via resolveInstallToken(db, env, owner, name), NOT env.GITHUB_TOKEN.
  // Current impl calls syncBranches(db, env.GITHUB_TOKEN, owner, name) at handlers.ts line ~364.
  // Future impl must call resolveInstallToken and pass the install token to syncBranches.
  it("resolves token via resolveInstallToken for deleted-branch repo — NOT env.GITHUB_TOKEN", async () => {
    // Arrange
    const { db } = captureDb();
    vi.mocked(syncBranches).mockResolvedValue(undefined);
    // Future: resolveInstallToken returns an install token for this repo
    vi.mocked(resolveInstallToken).mockResolvedValue("ghs_install_token");

    // Use "Roxabi/lyra" so owner="Roxabi", name="lyra"
    const repoFullName = "Roxabi/lyra";
    const [owner, name] = repoFullName.split("/");

    let patAccessCount = 0;
    const envWithSpy: Env = { ...baseEnv, DB: db };
    delete (envWithSpy as unknown as Record<string, unknown>)["GITHUB_TOKEN"];
    Object.defineProperty(envWithSpy, "GITHUB_TOKEN", {
      get() {
        patAccessCount++;
        return "ghp_test";
      },
      configurable: true,
    });

    const payload = {
      ref_type: "branch",
      ref: "42-done",
      repository: { full_name: repoFullName },
    };

    // Act
    await handleRefDelete(payload, db, envWithSpy);

    // Assert 1: resolveInstallToken called with the right db + env + owner/name.
    // Compare via mock.calls indices, NOT toHaveBeenCalledWith(db, envWithSpy, ...): the
    // structural matcher enumerates envWithSpy's own property names, which trips the
    // GITHUB_TOKEN getter-spy and inflates patAccessCount. Reference-identity (toBe) and
    // index access do not enumerate, so they measure the impl's access only.
    const call = vi.mocked(resolveInstallToken).mock.calls[0];
    expect(call?.[0]).toBe(db);
    expect(call?.[1]).toBe(envWithSpy);
    expect(call?.[2]).toBe(owner);
    expect(call?.[3]).toBe(name);

    // Assert 2: env.GITHUB_TOKEN must NOT be accessed by the impl (PAT bypass)
    expect(patAccessCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handlePullRequest
// ---------------------------------------------------------------------------

describe("handlePullRequest", () => {
  afterEach(() => vi.clearAllMocks());

  function makePrPayload(prOverrides: Record<string, unknown> = {}) {
    return {
      action: "closed",
      pull_request: {
        number: 5,
        state: "closed",
        merged: false,
        labels: [],
        body: "",
        ...prOverrides,
      },
      repository: { full_name: REPO },
    };
  }

  it("upserts pr_state with state=closed when merged=true", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = makePrPayload({ state: "open", merged: true });

    // Act
    await handlePullRequest(payload, db);

    // Assert — upsertPrState ran with state=closed
    const prStmt = stmts().find((s) => s.sql.includes("INSERT INTO pr_state"));
    expect(prStmt).toBeDefined();
    expect(prStmt!.args[2]).toBe("closed"); // state
    expect(vi.mocked(prStmt!.run)).toHaveBeenCalled();
  });

  it("upserts pr_state with has_reviewed_label=1 when reviewed label present", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = makePrPayload({
      state: "open",
      merged: false,
      labels: [{ name: "reviewed" }, { name: "bug" }],
    });

    // Act
    await handlePullRequest(payload, db);

    // Assert
    const prStmt = stmts().find((s) => s.sql.includes("INSERT INTO pr_state"));
    expect(prStmt).toBeDefined();
    expect(prStmt!.args[3]).toBe(1); // has_reviewed_label
  });

  it("upserts pr_state with has_reviewed_label=0 when reviewed label absent", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = makePrPayload({ labels: [{ name: "bug" }] });

    // Act
    await handlePullRequest(payload, db);

    // Assert
    const prStmt = stmts().find((s) => s.sql.includes("INSERT INTO pr_state"));
    expect(prStmt!.args[3]).toBe(0); // has_reviewed_label
  });

  it("extracts closing issue keys from body 'fixes #12' keyword", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = makePrPayload({
      body: "This PR fixes #12 and closes #34.",
      state: "open",
    });

    // Act
    await handlePullRequest(payload, db);

    // Assert — closing_issue_keys JSON contains repo#12 and repo#34
    const prStmt = stmts().find((s) => s.sql.includes("INSERT INTO pr_state"));
    expect(prStmt).toBeDefined();
    const closingJson = prStmt!.args[4] as string;
    const closing = JSON.parse(closingJson) as string[];
    expect(closing).toContain(`${REPO}#12`);
    expect(closing).toContain(`${REPO}#34`);
  });

  it("upserts pr_state with empty closing_issue_keys when no keywords in body", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = makePrPayload({ body: "No closing keywords here." });

    // Act
    await handlePullRequest(payload, db);

    // Assert
    const prStmt = stmts().find((s) => s.sql.includes("INSERT INTO pr_state"));
    const closingJson = prStmt!.args[4] as string;
    expect(JSON.parse(closingJson)).toEqual([]);
  });

  it("guard: upsertPrState is always called — if guard removed, no DB write would occur", async () => {
    // Negative: calling with a valid PR must always run the INSERT INTO pr_state
    const { db, stmts } = captureDb();
    await handlePullRequest(makePrPayload(), db);
    expect(stmts().some((s) => s.sql.includes("INSERT INTO pr_state"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleMilestone
// ---------------------------------------------------------------------------

describe("handleMilestone", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls renameMilestone when action=edited with changes.title", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = {
      action: "edited",
      changes: { title: { from: "Sprint 1" } },
      milestone: { title: "Sprint 2" },
      repository: { full_name: REPO },
    };

    // Act
    await handleMilestone(payload, db);

    // Assert — UPDATE issues SET milestone
    const renameStmt = stmts().find((s) => s.sql.includes("UPDATE issues") && s.sql.includes("milestone"));
    expect(renameStmt).toBeDefined();
    // binds (newTitle, repo, oldTitle)
    expect(renameStmt!.args).toEqual(["Sprint 2", REPO, "Sprint 1"]);
    expect(vi.mocked(renameStmt!.run)).toHaveBeenCalled();
  });

  it("no-op when action=edited but no changes.title (description-only edit)", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = {
      action: "edited",
      changes: { description: { from: "old desc" } },
      milestone: { title: "Sprint 1" },
      repository: { full_name: REPO },
    };

    // Act
    await handleMilestone(payload, db);

    // Assert
    expect(stmts()).toHaveLength(0);
  });

  it("no-op for non-edited actions (created, closed, deleted)", async () => {
    // Arrange
    const { db, stmts } = captureDb();
    const payload = {
      action: "created",
      milestone: { title: "Sprint 3" },
      repository: { full_name: REPO },
    };

    // Act
    await handleMilestone(payload, db);

    // Assert
    expect(stmts()).toHaveLength(0);
  });

  it("guard: no-op on edited without title change — if guard removed, renameMilestone would run erroneously", async () => {
    // Negative: ensures the titleChange guard is active
    const { db, stmts } = captureDb();
    await handleMilestone(
      {
        action: "edited",
        changes: {},
        milestone: { title: "Sprint 1" },
        repository: { full_name: REPO },
      },
      db,
    );
    expect(stmts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// webhookRoute (dispatch)
// ---------------------------------------------------------------------------

describe("webhookRoute", () => {
  const SECRET = "test-secret";

  afterEach(() => vi.clearAllMocks());

  async function dispatchRequest(
    body: string,
    event: string,
    envOverrides: Partial<Env> = {},
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const bodyBytes = new TextEncoder().encode(body).buffer as ArrayBuffer;
    const sig = await computeHmac(bodyBytes, SECRET);
    const req = makeRequest(body, sig, event, extraHeaders);
    const env = makeEnv({ ...envOverrides });
    const { c } = makeContext(req, env);
    return webhookRoute(c);
  }

  describe("missing GITHUB_WEBHOOK_SECRET", () => {
    it("returns 503", async () => {
      // Arrange
      const body = JSON.stringify({ action: "opened" });
      const bodyBytes = new TextEncoder().encode(body).buffer as ArrayBuffer;
      const sig = await computeHmac(bodyBytes, SECRET);
      const req = makeRequest(body, sig, "issues");
      const env = makeEnv({ GITHUB_WEBHOOK_SECRET: "" });
      const { c } = makeContext(req, env);

      // Act
      const res = await webhookRoute(c);

      // Assert
      expect(res.status).toBe(503);
    });
  });

  describe("bad signature", () => {
    it("returns 401 when signature does not match", async () => {
      // Arrange
      const body = JSON.stringify({ action: "opened" });
      const bodyBytes = new TextEncoder().encode(body).buffer as ArrayBuffer;
      // Compute sig with WRONG secret
      const wrongSig = await computeHmac(bodyBytes, "wrong-secret");
      const req = makeRequest(body, wrongSig, "issues");
      const env = makeEnv();
      const { c } = makeContext(req, env);

      // Act
      const res = await webhookRoute(c);

      // Assert
      expect(res.status).toBe(401);
    });
  });

  describe("malformed JSON body", () => {
    it("returns 400 when body is not valid JSON", async () => {
      // Arrange
      const body = "not-json{{";
      const bodyBytes = new TextEncoder().encode(body).buffer as ArrayBuffer;
      const sig = await computeHmac(bodyBytes, SECRET);
      const req = makeRequest(body, sig, "issues");
      const env = makeEnv();
      const { c } = makeContext(req, env);

      // Act
      const res = await webhookRoute(c);

      // Assert
      expect(res.status).toBe(400);
    });
  });

  describe("unknown x-github-event", () => {
    it("returns 200 with { ok: true, ignored: <event> } for unknown event", async () => {
      // Arrange
      const body = JSON.stringify({ action: "foobar" });
      const bodyBytes = new TextEncoder().encode(body).buffer as ArrayBuffer;
      const sig = await computeHmac(bodyBytes, SECRET);
      const req = makeRequest(body, sig, "unknown_event_xyz");
      const env = makeEnv();
      const { c } = makeContext(req, env);

      // Act
      const res = await webhookRoute(c);
      const json = (await res.json()) as Record<string, unknown>;

      // Assert
      expect(res.status).toBe(200);
      expect(json["ok"]).toBe(true);
      expect(json["ignored"]).toBe("unknown_event_xyz");
    });
  });

  describe("body exceeding 25 MB cap", () => {
    it("returns 413 when actual body byteLength exceeds 25 MB", async () => {
      // Arrange — build a real oversized body (26 MB + 1 byte)
      const huge = new Uint8Array(26 * 1024 * 1024 + 1);
      const bodyBuffer = huge.buffer as ArrayBuffer;
      // Valid secret in env so the 503 gate passes; no valid signature needed —
      // the byteLength guard fires before HMAC verification.
      const env = makeEnv({ GITHUB_WEBHOOK_SECRET: SECRET });

      const headers: Record<string, string> = {};
      const c = {
        env: { ...env, DB: captureDb().db },
        req: {
          header: (name: string) => headers[name.toLowerCase()] ?? undefined,
          arrayBuffer: () => Promise.resolve(bodyBuffer),
        },
        json: (data: unknown, status?: number) =>
          new Response(JSON.stringify(data), {
            status: status ?? 200,
            headers: { "content-type": "application/json" },
          }),
      } as unknown as Parameters<typeof webhookRoute>[0];

      // Act
      const res = await webhookRoute(c);

      // Assert — byteLength guard fires, no Content-Length header needed
      expect(res.status).toBe(413);
    });
  });

  describe("known event dispatched successfully", () => {
    it("returns 200 { ok: true } for a valid issues opened event", async () => {
      // Arrange
      const payload = makeIssuePayload("opened");
      const res = await dispatchRequest(JSON.stringify(payload), "issues");

      // Assert
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json["ok"]).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // data_version bump (#133)
  // -------------------------------------------------------------------------

  describe("data_version bump", () => {
    /** Build a context that exposes the db so we can inspect db.batch calls. */
    async function dispatchWithDb(
      body: string,
      event: string,
      envOverrides: Partial<Env> = {},
    ): Promise<{ res: Response; db: D1Database & { _recorded: FakeStmt[] } }> {
      const bodyBytes = new TextEncoder().encode(body).buffer as ArrayBuffer;
      const sig = await computeHmac(bodyBytes, SECRET);
      const req = makeRequest(body, sig, event);
      const env = makeEnv({ ...envOverrides });
      const { c, db } = makeContext(req, env);
      const res = await webhookRoute(c);
      return { res, db };
    }

    it("bumps data_version after a mutating issues event", async () => {
      // Arrange
      const payload = makeIssuePayload("opened");

      // Act
      const { res, db } = await dispatchWithDb(JSON.stringify(payload), "issues");

      // Assert — response OK
      expect(res.status).toBe(200);

      // db.batch should have been called at least once; verify a sync_control
      // statement (the data_version bump) was recorded among all prepared stmts.
      expect(vi.mocked(db.batch)).toHaveBeenCalled();

      const recorded = db._recorded;
      const bumpStmt = recorded.find(
        (s) => s.sql.includes("sync_control") && s.args.length >= 1,
      );
      expect(bumpStmt).toBeDefined();
      // First arg is the ISO timestamp — must be a non-empty string.
      expect(typeof bumpStmt!.args[0]).toBe("string");
      expect((bumpStmt!.args[0] as string).length).toBeGreaterThan(0);
    });

    it("does NOT bump data_version for an unknown (ignored) event", async () => {
      // Arrange — unknown event short-circuits before setting mutated=true
      const body = JSON.stringify({ action: "something" });

      // Act
      const { res, db } = await dispatchWithDb(body, "unknown_event_xyz");

      // Assert — response carries ignored flag
      const json = (await res.json()) as Record<string, unknown>;
      expect(json["ignored"]).toBe("unknown_event_xyz");

      // db.batch must NOT have been called (no bump, no handler writes)
      expect(vi.mocked(db.batch)).not.toHaveBeenCalled();
    });

    it("does NOT bump data_version for issue_dependencies blocking_added (returns 0 changes)", async () => {
      // blocking_added is ignored by handleDeps (returns 0 immediately) →
      // mutated stays false → no db.batch call for the bump.
      const payload = {
        action: "blocking_added",
        issue: {
          number: 10,
          title: "Blocker",
          state: "open",
          html_url: "https://github.com/Roxabi/lyra/issues/10",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          closed_at: null,
          milestone: null,
          labels: [],
        },
        repository: { full_name: REPO },
      };

      const { res, db } = await dispatchWithDb(
        JSON.stringify(payload),
        "issue_dependencies",
      );

      expect(res.status).toBe(200);

      // db.batch must NOT have been called (no handler writes, no version bump)
      expect(vi.mocked(db.batch)).not.toHaveBeenCalled();
    });
  });
});
