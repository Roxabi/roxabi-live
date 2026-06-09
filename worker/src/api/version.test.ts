import { describe, expect, it } from "vitest";
import { app } from "../router";
import type { Env } from "../types";

/**
 * Minimal D1/ASSETS stub for version endpoint tests.
 * The UNION ALL query calls .first() on a single prepared statement, so we
 * only need to intercept that one call and return the row we want.
 */
function mockEnv(row: Record<string, unknown> | null): Env {
  return {
    DB: {
      prepare: () => ({ first: async () => row }),
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_TOKEN: "",
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

describe("GET /api/version", () => {
  it("returns the MAX version token when cron sync is newest", async () => {
    // Simulates: cron ran at 12:00, last webhook at 11:00 — cron wins
    const res = await app.request(
      "/api/version",
      {},
      mockEnv({ version: "2026-06-05T12:00:00.000Z" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "2026-06-05T12:00:00.000Z" });
  });

  it("returns the MAX version token when webhook mutation is newest", async () => {
    // Simulates: data_version bumped at 12:30 after a webhook, cron only at 12:00
    const res = await app.request(
      "/api/version",
      {},
      mockEnv({ version: "2026-06-05T12:30:00.000Z" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "2026-06-05T12:30:00.000Z" });
  });

  it("returns an empty version when no sync or webhook mutation has run yet", async () => {
    const res = await app.request("/api/version", {}, mockEnv({ version: null }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "" });
  });

  it("returns an empty string when the db returns a null row", async () => {
    const res = await app.request("/api/version", {}, mockEnv(null));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "" });
  });
});

describe("GET /health", () => {
  it("reports ok + issue count when the db is reachable", async () => {
    const res = await app.request("/health", {}, mockEnv({ n: 42 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db_reachable: true, issue_count: 42 });
  });
});

describe("unmatched routes", () => {
  it("falls through to the ASSETS binding", async () => {
    const res = await app.request("/index.html", {}, mockEnv(null));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset");
  });
});
