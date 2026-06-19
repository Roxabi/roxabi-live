import { describe, it, expect, vi } from "vitest";
import type { Env } from "../types";
import type { SessionContext } from "./types";
import { app } from "../router";

const VALID_RAW_TOKEN = "b".repeat(64);

function makeSessionDb(session: SessionContext | null): D1Database {
  const validRow = session
    ? {
        userId: session.userId,
        tenantId: session.tenantId,
        githubId: session.githubId,
        githubLogin: session.githubLogin,
      }
    : null;

  const bindStmt = {
    first: vi.fn().mockResolvedValue(validRow),
    run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    bind: vi.fn(function (this: unknown) {
      return this;
    }),
  };

  const stmt = {
    first: vi.fn().mockResolvedValue(validRow),
    run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    bind: vi.fn(() => bindStmt),
  };

  return {
    prepare: vi.fn(() => stmt),
    batch: vi.fn().mockResolvedValue([]),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

function makeEnv(db: D1Database, assetsBody = "dashboard-html"): Env {
  return {
    DB: db,
    ASSETS: {
      fetch: vi.fn(async (req: Request) => {
        const url = new URL(req.url);
        expect(url.pathname).toBe("/dashboard/index.html");
        return new Response(assetsBody, { status: 200 });
      }),
    } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

const STUB_SESSION: SessionContext = {
  userId: 1,
  tenantId: 1,
  githubId: 1001,
  githubLogin: "octocat",
};

describe("GET /dashboard", () => {
  it("redirects to /login preserving ?install=1 when no cookie", async () => {
    const db = makeSessionDb(null);
    const env = makeEnv(db);

    const res = await app.request("/dashboard/?install=1", {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/login?redirect=%2Fdashboard%2F%3Finstall%3D1",
    );
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("redirects to /login?redirect=/dashboard when no cookie", async () => {
    const db = makeSessionDb(null);
    const env = makeEnv(db);

    const res = await app.request("/dashboard", {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?redirect=%2Fdashboard");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("redirects to login when session is invalid", async () => {
    const db = makeSessionDb(null);
    const env = makeEnv(db);

    const res = await app.request(
      "/dashboard",
      { headers: { Cookie: `__Host-session=${VALID_RAW_TOKEN}` } },
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?redirect=%2Fdashboard");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-session=;");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("serves dashboard HTML when session is valid", async () => {
    const db = makeSessionDb(STUB_SESSION);
    const env = makeEnv(db);

    const res = await app.request(
      "/dashboard",
      { headers: { Cookie: `__Host-session=${VALID_RAW_TOKEN}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("dashboard-html");
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("allows install-pending sessions (null tenantId)", async () => {
    const db = makeSessionDb({ ...STUB_SESSION, tenantId: null });
    const env = makeEnv(db);

    const res = await app.request(
      "/dashboard/",
      { headers: { Cookie: `__Host-session=${VALID_RAW_TOKEN}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });
});