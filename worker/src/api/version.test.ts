import { describe, expect, it } from "vitest";
import { app } from "../router";
import type { Env } from "../types";

/** Minimal D1/ASSETS stub — returns a fixed row for the first() query. */
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
  it("returns MAX(last_synced_at) as the version token", async () => {
    const res = await app.request("/api/version", {}, mockEnv({ ts: "2026-06-05T12:00:00Z" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "2026-06-05T12:00:00Z" });
  });

  it("returns an empty version when no sync has run yet", async () => {
    const res = await app.request("/api/version", {}, mockEnv({ ts: null }));
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
