import { describe, expect, it, vi } from "vitest";
import { app } from "../router";
import type { Env } from "../types";
import { authPageRedirectDest } from "./auth-page-route";
import type { SessionContext } from "./types";

const VALID_RAW_TOKEN = "c".repeat(64);

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

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: {
      fetch: vi.fn(async (req: Request) => {
        const url = new URL(req.url);
        expect(["/sign-in/", "/sign-up/"]).toContain(url.pathname);
        return new Response(`auth-page:${url.pathname}`, { status: 200 });
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

describe("authPageRedirectDest", () => {
  it("defaults to / (SPA index)", () => {
    expect(authPageRedirectDest(new URL("https://_/sign-in/"))).toBe("/");
  });

  it("honours a safe redirect query param", () => {
    expect(
      authPageRedirectDest(new URL("https://_/sign-in/?redirect=%2Fdashboard%3Fview%3Dgraph")),
    ).toBe("/dashboard?view=graph");
  });
});

describe.each([
  ["/sign-in", "/sign-in/"],
  ["/sign-in/", "/sign-in/"],
  ["/sign-up", "/sign-up/"],
  ["/sign-up/", "/sign-up/"],
])("GET %s", (path, assetPath) => {
  it("serves the auth page shell when no session cookie", async () => {
    const db = makeSessionDb(null);
    const env = makeEnv(db);

    const res = await app.request(path, {}, env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`auth-page:${assetPath}`);
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("redirects to / (SPA index) when session is valid", async () => {
    const db = makeSessionDb(STUB_SESSION);
    const env = makeEnv(db);

    const res = await app.request(
      path,
      { headers: { Cookie: `roxabi_session=${VALID_RAW_TOKEN}` } },
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("redirects to ?redirect= when session is valid", async () => {
    const db = makeSessionDb(STUB_SESSION);
    const env = makeEnv(db);

    const res = await app.request(
      `${path}?redirect=%2Fdashboard%3Fsettings%3Dopen`,
      { headers: { Cookie: `roxabi_session=${VALID_RAW_TOKEN}` } },
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard?settings=open");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
});
