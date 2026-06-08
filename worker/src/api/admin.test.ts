import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";

vi.mock("../sync/sync", () => ({
  runSync: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER the mock is registered
import { app } from "../router";
import { runSync } from "../sync/sync";

function mockEnv(): Env {
  return {
    DB: {
      prepare: () => ({ first: async () => null, all: async () => ({ results: [] }), bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_TOKEN: "",
    GITHUB_ORG: "",
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

describe("POST /admin/sync", () => {
  it("returns 202 with {ok:true, triggered:true}", async () => {
    const waitUntil = vi.fn();
    const res = await app.request(
      "/admin/sync",
      { method: "POST" },
      mockEnv(),
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ ok: true, triggered: true });
  });

  it("calls executionCtx.waitUntil with a Promise", async () => {
    const waitUntil = vi.fn();
    await app.request(
      "/admin/sync",
      { method: "POST" },
      mockEnv(),
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(waitUntil).toHaveBeenCalledOnce();
    // waitUntil receives the Promise returned by runSync(env)
    const passedArg = waitUntil.mock.calls[0][0];
    expect(passedArg).toBeInstanceOf(Promise);
  });

  it("passes runSync(env) to waitUntil — does not run real sync", async () => {
    const waitUntil = vi.fn();
    const env = mockEnv();
    vi.mocked(runSync).mockResolvedValueOnce(undefined);

    await app.request(
      "/admin/sync",
      { method: "POST" },
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(vi.mocked(runSync)).toHaveBeenCalledWith(env);
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});
