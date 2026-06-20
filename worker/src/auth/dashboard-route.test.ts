import { describe, expect, it, vi } from "vitest";
import { app } from "../router";
import type { Env } from "../types";
import { dashboardLoginUrl } from "./dashboard-route";
import type { SessionContext } from "./types";

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
      // Emulate Cloudflare Assets default html_handling ("auto-trailing-slash"):
      // "/dashboard/index.html" → 307 redirect to the canonical "/dashboard/".
      // serveDashboardShell must request "/dashboard/" so it never propagates a
      // 307 back to the browser (which caused ERR_TOO_MANY_REDIRECTS in prod).
      fetch: vi.fn(async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === "/dashboard/index.html") {
          return new Response(null, { status: 307, headers: { Location: "/dashboard/" } });
        }
        expect(url.pathname).toBe("/dashboard/");
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
  it("redirects to /login without install=1 in redirect when no cookie", async () => {
    const db = makeSessionDb(null);
    const env = makeEnv(db);

    const res = await app.request("/dashboard/?install=1", {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?redirect=%2Fdashboard");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
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
    expect(res.headers.get("Set-Cookie") ?? "").toContain("roxabi_session=;");
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
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("never propagates Cloudflare's index.html→dir 307 (no redirect loop)", async () => {
    const db = makeSessionDb(STUB_SESSION);
    const env = makeEnv(db);

    const res = await app.request(
      "/dashboard/",
      { headers: { Cookie: `roxabi_session=${VALID_RAW_TOKEN}` } },
      env,
    );

    // Must serve the shell (200), NOT bounce a 307 back to /dashboard/ → loop.
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).toBe("dashboard-html");
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

  it("redirects to login when ?code present without session", async () => {
    const db = makeSessionDb(null);
    const env = makeEnv(db);

    const res = await app.request("/dashboard/?code=3021f76392ee418d8b6a9d70a5e8cd99", {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?redirect=%2Fdashboard");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("strips ?code when session is already valid (refresh-safe)", async () => {
    const db = makeSessionDb({ ...STUB_SESSION, tenantId: null });
    const env = makeEnv(db);

    const res = await app.request(
      "/dashboard/?code=3021f76392ee418d8b6a9d70a5e8cd99&install=1",
      { headers: { Cookie: `roxabi_session=${VALID_RAW_TOKEN}` } },
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("strips ?code when session is already valid (refresh-safe)", async () => {
    const db = makeSessionDb({ ...STUB_SESSION, tenantId: null });
    const env = makeEnv(db);

    const res = await app.request(
      "/dashboard/?code=3021f76392ee418d8b6a9d70a5e8cd99&install=1",
      { headers: { Cookie: `roxabi_session=${VALID_RAW_TOKEN}` } },
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
});

describe("dashboardLoginUrl", () => {
  it("strips code, state, and install from redirect target", () => {
    const url = new URL(
      "https://live.roxabi.dev/dashboard/?code=abc&state=xyz&install=1&view=graph",
    );
    expect(dashboardLoginUrl(url)).toBe("/login?redirect=%2Fdashboard%3Fview%3Dgraph");
  });
});
