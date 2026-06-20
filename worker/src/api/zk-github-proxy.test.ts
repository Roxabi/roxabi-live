import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv, SessionContext } from "../auth/types";
import { captureDb } from "../test-utils";
import type { Env } from "../types";
import { zkGithubGraphqlRoute } from "./zk-github-proxy";

afterEach(() => {
  vi.restoreAllMocks();
});

const STUB_SESSION: SessionContext = {
  userId: 7,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

function makeApp(_db: D1Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("session", STUB_SESSION);
    await next();
  });
  app.post("/api/zk/github/graphql", zkGithubGraphqlRoute);
  return app;
}

describe("zkGithubGraphqlRoute", () => {
  it("returns 403 when zk_opt_in is off", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_opt_in")) return [{ zk_opt_in: 0 }];
      return [];
    });
    const res = await makeApp(db).request(
      "/api/zk/github/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-User-Token": "gho_test",
        },
        body: JSON.stringify({ query: "{ viewer { login } }" }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(403);
  });

  it("forwards GraphQL to GitHub when zk_opt_in is on", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { login: "alice" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_opt_in")) return [{ zk_opt_in: 1 }];
      return [];
    });
    const res = await makeApp(db).request(
      "/api/zk/github/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-User-Token": "gho_test_token",
        },
        body: JSON.stringify({ query: "{ viewer { login } }" }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/graphql");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gho_test_token");
  });

  it("rejects mutation operations (read-only relay) without calling GitHub", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_opt_in")) return [{ zk_opt_in: 1 }];
      return [];
    });
    const res = await makeApp(db).request(
      "/api/zk/github/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-User-Token": "gho_test_token",
        },
        body: JSON.stringify({
          query: "mutation { addComment(input: {}) { clientMutationId } }",
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("read_only");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects subscription operations without calling GitHub", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_opt_in")) return [{ zk_opt_in: 1 }];
      return [];
    });
    const res = await makeApp(db).request(
      "/api/zk/github/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-User-Token": "gho_test_token",
        },
        body: JSON.stringify({
          query: "subscription { issueEvent { id } }",
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("read_only");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows a query whose selection set contains a field named like a keyword", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_opt_in")) return [{ zk_opt_in: 1 }];
      return [];
    });
    const res = await makeApp(db).request(
      "/api/zk/github/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-User-Token": "gho_test_token",
        },
        // "mutation" appears only as a nested field name, not a top-level op.
        body: JSON.stringify({ query: "query { repository { mutation } }" }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
