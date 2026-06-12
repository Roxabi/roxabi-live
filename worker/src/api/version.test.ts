import { describe, expect, it } from "vitest";
import { app } from "../router";
import type { Env } from "../types";

/**
 * Minimal D1/ASSETS stub for version endpoint tests.
 * The UNION ALL query calls .first() on a single prepared statement, so we
 * only need to intercept that one call and return the row we want.
 * capturedSql is set to the SQL string passed to prepare() so tests can assert
 * on the exact query issued.
 */
function mockEnv(row: Record<string, unknown> | null): { env: Env; getCapturedSql: () => string } {
  let capturedSql = "";
  const env = {
    DB: {
      prepare: (sql: string) => {
        capturedSql = sql;
        return { first: async () => row };
      },
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
  return { env, getCapturedSql: () => capturedSql };
}

describe("GET /api/version", () => {
  it("returns the MAX version token when cron sync is newest", async () => {
    // Simulates: cron ran at 12:00, last webhook at 11:00 — cron wins
    const { env } = mockEnv({ version: "2026-06-05T12:00:00.000Z" });
    const res = await app.request("/api/version", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "2026-06-05T12:00:00.000Z" });
  });

  it("returns the MAX version token when webhook mutation is newest", async () => {
    // Simulates: data_version bumped at 12:30 after a webhook, cron only at 12:00
    const { env } = mockEnv({ version: "2026-06-05T12:30:00.000Z" });
    const res = await app.request("/api/version", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "2026-06-05T12:30:00.000Z" });
  });

  it("returns an empty version when no sync or webhook mutation has run yet", async () => {
    const { env } = mockEnv({ version: null });
    const res = await app.request("/api/version", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "" });
  });

  it("returns an empty string when the db returns a null row", async () => {
    const { env } = mockEnv(null);
    const res = await app.request("/api/version", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "" });
  });

  it("version SQL filters sync_control row with AND tenant_id = 0", async () => {
    // Arrange
    const { env, getCapturedSql } = mockEnv({ version: "2026-06-05T12:00:00.000Z" });
    // Act
    await app.request("/api/version", {}, env);
    // Assert — the UNION ALL query must scope sync_control to tenant 0
    const capturedSql = getCapturedSql();
    expect(capturedSql).toContain("AND tenant_id = 0");
  });
});

describe("GET /health", () => {
  it("reports ok + issue count when the db is reachable", async () => {
    const { env } = mockEnv({ n: 42 });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db_reachable: true, issue_count: 42 });
  });
});

describe("unmatched routes", () => {
  it("falls through to the ASSETS binding", async () => {
    const { env } = mockEnv(null);
    const res = await app.request("/index.html", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset");
  });
});
