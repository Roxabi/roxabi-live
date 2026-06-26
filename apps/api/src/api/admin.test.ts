import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";

vi.mock("../sync/sync", () => ({
  runSync: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER the mock is registered
import { app } from "../router";
import { runSync } from "../sync/sync";

const TOKEN = "test-secret-token";

function mockEnv(adminToken?: string): Env {
  return {
    DB: {
      prepare: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }),
      }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    GITHUB_WEBHOOK_SECRET: "",
    ...(adminToken !== undefined ? { ADMIN_TOKEN: adminToken } : {}),
  } as unknown as Env;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// ── ADMIN_TOKEN set — gate active ─────────────────────────────────────────

describe("POST /admin/sync — ADMIN_TOKEN set", () => {
  beforeEach(() => {
    vi.mocked(runSync).mockReset();
    vi.mocked(runSync).mockResolvedValue(undefined);
  });

  it("correct Bearer token → 202 and sync triggered", async () => {
    const waitUntil = vi.fn();
    const res = await app.request(
      "/admin/sync",
      { method: "POST", headers: authHeaders(TOKEN) },
      mockEnv(TOKEN),
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ ok: true, triggered: true });
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(vi.mocked(runSync)).toHaveBeenCalledWith(
      expect.objectContaining({ ADMIN_TOKEN: TOKEN }),
    );
  });

  it("wrong token → 401 and sync NOT called", async () => {
    const waitUntil = vi.fn();
    const res = await app.request(
      "/admin/sync",
      { method: "POST", headers: authHeaders("wrong-token") },
      mockEnv(TOKEN),
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
    expect(vi.mocked(runSync)).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("missing Authorization header → 401 and sync NOT called", async () => {
    const waitUntil = vi.fn();
    const res = await app.request("/admin/sync", { method: "POST" }, mockEnv(TOKEN), {
      waitUntil,
    } as unknown as ExecutionContext);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
    expect(vi.mocked(runSync)).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

// ── ADMIN_TOKEN unset — back-compat / edge-Access-only mode ──────────────

describe("POST /admin/sync — ADMIN_TOKEN unset (back-compat)", () => {
  beforeEach(() => {
    vi.mocked(runSync).mockReset();
    vi.mocked(runSync).mockResolvedValue(undefined);
  });

  it("request without token passes through — gate disabled", async () => {
    const waitUntil = vi.fn();
    const res = await app.request("/admin/sync", { method: "POST" }, mockEnv(undefined), {
      waitUntil,
    } as unknown as ExecutionContext);

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ ok: true, triggered: true });
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("request WITH a token still passes when ADMIN_TOKEN unset", async () => {
    const waitUntil = vi.fn();
    const res = await app.request(
      "/admin/sync",
      { method: "POST", headers: authHeaders("any-token") },
      mockEnv(undefined),
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(202);
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});

// ── Existing regression tests (gate-unset baseline) ─────────────────────

describe("POST /admin/sync — existing behaviour (no ADMIN_TOKEN)", () => {
  beforeEach(() => {
    vi.mocked(runSync).mockReset();
    vi.mocked(runSync).mockResolvedValue(undefined);
  });

  it("returns 202 with {ok:true, triggered:true}", async () => {
    const waitUntil = vi.fn();
    const res = await app.request("/admin/sync", { method: "POST" }, mockEnv(), {
      waitUntil,
    } as unknown as ExecutionContext);

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ ok: true, triggered: true });
  });

  it("calls executionCtx.waitUntil with a Promise", async () => {
    const waitUntil = vi.fn();
    await app.request("/admin/sync", { method: "POST" }, mockEnv(), {
      waitUntil,
    } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledOnce();
    const passedArg = waitUntil.mock.calls[0][0];
    expect(passedArg).toBeInstanceOf(Promise);
  });

  it("passes runSync(env) to waitUntil — does not run real sync", async () => {
    const waitUntil = vi.fn();
    const env = mockEnv();
    vi.mocked(runSync).mockResolvedValueOnce(undefined);

    await app.request("/admin/sync", { method: "POST" }, env, {
      waitUntil,
    } as unknown as ExecutionContext);

    expect(vi.mocked(runSync)).toHaveBeenCalledWith(env);
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});
